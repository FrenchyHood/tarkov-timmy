"""
Squad Map companion: sends your Tarkov position and raid state to your squad's map.

How it works (no game memory reading, nothing injected, so it's BattlEye-safe):
  * When you press the in-game screenshot key, Tarkov names the screenshot file
    after your coordinates and facing. We read that filename.
  * Tarkov's own log files say which map you queued into and when the raid starts/ends.

Standard library only. Run:  python tarkov_companion.py
"""

import ctypes
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

APP_DIR = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
CONFIG_PATH = APP_DIR / "config.json"
POLL_SECONDS = 0.5
HEARTBEAT_SECONDS = 60

# Same patterns TarkovMonitor uses (github.com/the-hideout/TarkovMonitor, MIT).
SCREENSHOT_RE = re.compile(r"\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]_?(?P<position>.+) \(\d\)\.png$")
POSITION_RE = re.compile(
    r"(?P<x>-?\d+\.\d{2}), (?P<y>-?\d+\.\d{2}), (?P<z>-?\d+\.\d{2})_?"
    r"(?P<rx>-?[\d.]\.\d{1,5}), (?P<ry>-?[\d.]\.\d{1,5}), (?P<rz>-?[\d.]\.\d{1,5}), (?P<rw>-?[\d.]\.\d{1,5})"
)
LOCATION_RE = re.compile(r"Location: (?P<map>[^,]+)")
SCENE_RE = re.compile(r"scene preset path:maps/(?P<scene>[A-Za-z0-9_]+)\.bundle")
# Scene bundle -> tarkov.dev map nameId, for the ones seen in real logs. profileStatus fills in the rest.
SCENE_TO_MAP = {
    "sandbox_preset": "Sandbox",
    "sandbox_start_preset": "Sandbox",
    "sandbox_high_preset": "Sandbox_high",
    "shopping_mall": "Interchange",
}
ROOM_LINK_RE =re.compile(r"^(?P<server>https?://[^/]+)/r/(?P<room>[A-Za-z0-9_-]{4,40})/?$")


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


# ---------------------------------------------------------------- paths

def documents_dir():
    """Real Documents folder, even when OneDrive or the user has moved it."""
    try:
        class GUID(ctypes.Structure):
            _fields_ = [("d1", ctypes.c_ulong), ("d2", ctypes.c_ushort), ("d3", ctypes.c_ushort), ("d4", ctypes.c_ubyte * 8)]

        u = uuid.UUID("FDD39AD0-238F-46AF-ADB4-6C85480369C7")  # FOLDERID_Documents
        guid = GUID(u.fields[0], u.fields[1], u.fields[2], (ctypes.c_ubyte * 8).from_buffer_copy(u.bytes[8:]))
        out = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) == 0:
            path = out.value
            ctypes.windll.ole32.CoTaskMemFree(out)
            return Path(path)
    except Exception:
        pass
    return Path.home() / "Documents"


def _reg_value(root, key, name):
    try:
        import winreg
        with winreg.OpenKey(root, key) as k:
            return winreg.QueryValueEx(k, name)[0]
    except Exception:
        return None


def find_logs_dir():
    """Locate <Tarkov install>/build/Logs for the BSG launcher or Steam version."""
    import winreg

    installs = []
    bsg = _reg_value(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\EscapeFromTarkov", "InstallLocation")
    if bsg:
        installs.append(Path(bsg))

    steam_roots = {
        _reg_value(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
        _reg_value(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
    }
    for root in filter(None, steam_roots):
        vdf = Path(root) / "steamapps" / "libraryfolders.vdf"
        libraries = [Path(root)]
        if vdf.exists():
            libraries += [Path(p.replace("\\\\", "\\")) for p in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(errors="replace"))]
        for lib in libraries:
            installs.append(lib / "steamapps" / "common" / "Escape from Tarkov")

    installs += [Path(r"C:\Battlestate Games\EFT"), Path(r"C:\Battlestate Games\Escape from Tarkov")]
    for install in installs:
        for logs in (install / "build" / "Logs", install / "Logs"):
            if logs.is_dir():
                return logs
    return None


# ---------------------------------------------------------------- config

def load_config():
    cfg = {}
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            log(f"config.json is invalid ({e}); let's set it up again.")
    changed = False

    while not cfg.get("server") or not cfg.get("room"):
        link = input("Paste your squad room link (e.g. https://xxxx.workers.dev/r/ABCD1234): ").strip()
        m = ROOM_LINK_RE.match(link)
        if m:
            cfg["server"], cfg["room"] = m.group("server"), m.group("room")
            changed = True
        else:
            print("  That doesn't look like a room link. Copy it from the Invite button on the map.")

    while not cfg.get("name"):
        name = input("Your callsign (same as on the map): ").strip()[:24]
        if name:
            cfg["name"] = name
            changed = True

    if "delete_screenshots" not in cfg:
        ans = input("Delete position screenshots after reading them, so they don't pile up? [Y/n]: ").strip().lower()
        cfg["delete_screenshots"] = ans in ("", "y", "yes")
        changed = True

    cfg.setdefault("logs_dir", "")
    cfg.setdefault("screenshots_dir", "")
    if changed:
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        log(f"Saved settings to {CONFIG_PATH}")
    return cfg


# ---------------------------------------------------------------- sending

class Sender(threading.Thread):
    """Posts events in the background so a slow network never stalls file watching."""

    def __init__(self, cfg):
        super().__init__(daemon=True)
        self.url = f"{cfg['server'].rstrip('/')}/api/room/{cfg['room']}/event"
        self.name_ = cfg["name"]
        self.q = queue.Queue()
        self.last_error = None

    def send(self, event):
        self.q.put({"name": self.name_, **event})

    def run(self):
        while True:
            event = self.q.get()
            for attempt in range(3):
                try:
                    req = urllib.request.Request(self.url, data=json.dumps(event).encode(), headers={"content-type": "application/json", "user-agent": "squad-map-companion"})
                    with urllib.request.urlopen(req, timeout=10) as res:
                        res.read()
                    if self.last_error:
                        log("Reconnected to the squad map.")
                        self.last_error = None
                    break
                except urllib.error.HTTPError as e:
                    msg = f"Server rejected update: HTTP {e.code} {e.read()[:200]!r}"
                    if msg != self.last_error:
                        log(msg)
                    self.last_error = msg
                    break
                except Exception as e:
                    msg = f"Can't reach the squad map ({e}); retrying..."
                    if msg != self.last_error:
                        log(msg)
                    self.last_error = msg
                    time.sleep(2 * (attempt + 1))


# ---------------------------------------------------------------- screenshots

def quaternion_to_yaw(rx, ry, rz, rw):
    # Mirrors TarkovMonitor's QuarternionsToYaw(x, z, y, w) argument order, which tarkov.dev's map expects.
    x, z, y, w = rx, ry, rz, rw
    import math
    return math.degrees(math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)))


def parse_screenshot(filename):
    m = SCREENSHOT_RE.search(filename)
    if not m:
        return None
    p = POSITION_RE.search(m.group("position"))
    if not p:
        return None
    f = {k: float(v) for k, v in p.groupdict().items()}
    return {"x": f["x"], "y": f["y"], "z": f["z"], "yaw": round(quaternion_to_yaw(f["rx"], f["ry"], f["rz"], f["rw"]), 1)}


class ScreenshotWatcher:
    def __init__(self, folder, delete):
        self.folder = folder
        self.delete = delete
        self.seen = None  # filled on first poll so old screenshots are ignored
        self.pending_delete = {}

    def poll(self):
        if not self.folder.is_dir():
            return []
        try:
            names = {e.name for e in os.scandir(self.folder) if e.name.endswith(".png")}
        except OSError:
            return []
        if self.seen is None:
            self.seen = names
            return []
        new = sorted(names - self.seen)
        self.seen = names
        found = []
        for name in new:
            pos = parse_screenshot(name)
            if pos:
                found.append(pos)
                if self.delete:
                    self.pending_delete[name] = time.time()
        self._delete_pending()
        return found

    def _delete_pending(self):
        # The game may still be writing the file, so give it a few seconds and retry.
        for name, t in list(self.pending_delete.items()):
            if time.time() - t < 3:
                continue
            try:
                (self.folder / name).unlink()
                self.pending_delete.pop(name)
            except FileNotFoundError:
                self.pending_delete.pop(name)
            except OSError:
                if time.time() - t > 60:
                    self.pending_delete.pop(name)


# ---------------------------------------------------------------- logs

class LogTailer:
    """Follows the newest application and push-notification logs and turns lines into raid events."""

    def __init__(self, logs_dir):
        self.logs_dir = logs_dir
        self.session = None
        self.files = {}  # path -> [offset, partial line]
        self.last_scan = 0
        self.map = None
        self.raid_state = None

    def _newest_session(self):
        try:
            sessions = [d for d in self.logs_dir.iterdir() if d.is_dir() and d.name.startswith("log_")]
        except OSError:
            return None
        return max(sessions, key=lambda d: d.stat().st_mtime, default=None)

    def _scan(self, initial):
        session = self._newest_session()
        if session != self.session:
            self.session = session
            self.files = {}
            if session and not initial:
                log(f"Game started a new log session: {session.name}")
        if not session:
            return
        for f in session.iterdir():
            if f not in self.files and ("application" in f.name or "push-notifications" in f.name) and f.suffix == ".log":
                # Read new files from the start (they belong to this game session).
                self.files[f] = [0, ""]

    def poll(self, initial=False):
        """Returns a list of events. With initial=True, replays the current log silently to learn the current state."""
        if initial or time.time() - self.last_scan > 3:
            self._scan(initial)
            self.last_scan = time.time()
        events = []
        for path, st in self.files.items():
            try:
                size = path.stat().st_size
                if size < st[0]:
                    st[0], st[1] = 0, ""
                if size == st[0]:
                    continue
                with open(path, "rb") as fh:
                    fh.seek(st[0])
                    chunk = fh.read()
                st[0] += len(chunk)
            except OSError:
                continue
            text = st[1] + chunk.decode("utf-8", errors="replace")
            lines = text.split("\n")
            st[1] = lines.pop()  # keep the incomplete last line for next time
            for line in lines:
                ev = self._handle(line)
                if ev:
                    events.append(ev)
        return events

    def _handle(self, line):
        if "TRACE-NetworkGameCreate profileStatus" in line:
            m = LOCATION_RE.search(line)
            if m:
                self.map = m.group("map").strip()
                return self._state("loading")
        elif "application|GameStarted" in line:
            return self._state("started")
        elif "Network game matching aborted" in line or "Network game matching cancelled" in line:
            return self._state("ended")
        elif "Got notification | UserMatchOver" in line:
            return self._state("ended")
        elif "application|scene preset path:" in line:
            # Comes before profileStatus; gives the map early for the scene bundles we know.
            m = SCENE_RE.search(line)
            if m and m.group("scene") in SCENE_TO_MAP:
                self.map = SCENE_TO_MAP[m.group("scene")]
            if self.raid_state in (None, "ended"):
                return self._state("matching")
        elif "application|Matching with group id" in line:
            if self.raid_state in (None, "ended"):
                return self._state("matching")
        return None

    def _state(self, state):
        if state == self.raid_state:
            return None
        self.raid_state = state
        ev = {"type": "raid", "state": state, "map": self.map}
        if state == "started":
            ev["startedAt"] = int(time.time() * 1000)
        return ev


# ---------------------------------------------------------------- main

def game_running():
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq EscapeFromTarkov.exe", "/NH"],
                             capture_output=True, text=True, timeout=10,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        return "EscapeFromTarkov.exe" in out
    except Exception:
        return True  # can't tell; trust the logs


def main():
    print("Squad Map companion - keep this window open while you play.\n")
    cfg = load_config()
    sender = Sender(cfg)
    sender.start()

    screens = Path(cfg["screenshots_dir"]) if cfg.get("screenshots_dir") else documents_dir() / "Escape From Tarkov" / "Screenshots"
    logs_dir = Path(cfg["logs_dir"]) if cfg.get("logs_dir") else find_logs_dir()

    log(f"Room {cfg['room']} on {cfg['server']} as '{cfg['name']}'")
    log(f"Watching screenshots in {screens}" + ("" if screens.is_dir() else " (folder will appear after your first in-game screenshot)"))
    tailer = None
    if logs_dir:
        log(f"Watching game logs in {logs_dir}")
        tailer = LogTailer(logs_dir)
        tailer.poll(initial=True)  # catch up silently, then report where we are now
        if not game_running():
            # The last log can end mid-raid if the game was closed; don't report a stale raid.
            tailer.raid_state = "ended"
        if tailer.raid_state and tailer.raid_state != "ended":
            log(f"Currently: {tailer.raid_state} on {tailer.map}")
            sender.send({"type": "raid", "state": tailer.raid_state, "map": tailer.map})
    else:
        log("Couldn't find Tarkov's Logs folder, so the map won't switch automatically. Set \"logs_dir\" in config.json.")

    watcher = ScreenshotWatcher(screens, cfg.get("delete_screenshots", True))
    watcher.poll()
    sender.send({"type": "heartbeat"})
    last_beat = time.time()
    log("Ready. In raid, press your screenshot key (Print Screen by default) to update your position.")

    while True:
        if tailer:
            for ev in tailer.poll():
                log(f"Raid: {ev['state']}" + (f" on {ev['map']}" if ev.get("map") else ""))
                sender.send(ev)
        for pos in watcher.poll():
            current_map = tailer.map if tailer else None
            log(f"Position x={pos['x']:.0f} z={pos['z']:.0f} facing {pos['yaw']:.0f} deg" + (f" on {current_map}" if current_map else ""))
            sender.send({"type": "position", "map": current_map, **pos})
        if time.time() - last_beat > HEARTBEAT_SECONDS:
            sender.send({"type": "heartbeat"})
            last_beat = time.time()
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
