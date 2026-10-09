// Watches Tarkov's screenshots and logs and reports position / raid state to the squad room.
// No memory reading or injection: only files the game writes on its own.
// Parsing follows TarkovMonitor (github.com/the-hideout/TarkovMonitor, MIT).

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { EventEmitter } = require("events");

const SCREENSHOT_RE = /\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]_?(.+) \(\d\)\.png$/;
const POSITION_RE =
  /(-?\d+\.\d{2}), (-?\d+\.\d{2}), (-?\d+\.\d{2})_?(-?[\d.]\.\d{1,5}), (-?[\d.]\.\d{1,5}), (-?[\d.]\.\d{1,5}), (-?[\d.]\.\d{1,5})/;
const LOCATION_RE = /Location: ([^,]+)/;
const SCENE_RE = /scene preset path:maps\/([A-Za-z0-9_]+)\.bundle/;
// Scene bundle -> tarkov.dev nameId for bundles seen in real logs; profileStatus fills in the rest.
const SCENE_TO_MAP = {
  sandbox_preset: "Sandbox",
  sandbox_start_preset: "Sandbox",
  sandbox_high_preset: "Sandbox_high",
  shopping_mall: "Interchange",
};

function parseScreenshot(filename) {
  const m = SCREENSHOT_RE.exec(filename);
  if (!m) return null;
  const p = POSITION_RE.exec(m[1]);
  if (!p) return null;
  const [x, y, z, rx, ry, rz, rw] = p.slice(1).map(Number);
  // Same argument order as TarkovMonitor's QuarternionsToYaw(x, z, y, w).
  const [qx, qz, qy, qw] = [rx, ry, rz, rw];
  const yaw = (Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * 180) / Math.PI;
  return { x, y, z, yaw: Math.round(yaw * 10) / 10 };
}

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/v", value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`));
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function findLogsDir() {
  const installs = [];
  const bsg = await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EscapeFromTarkov", "InstallLocation");
  if (bsg) installs.push(bsg);
  const steamRoots = [
    await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
    await regQuery("HKCU\\Software\\Valve\\Steam", "SteamPath"),
  ].filter(Boolean);
  for (const root of new Set(steamRoots)) {
    const libs = [root];
    try {
      const vdf = fs.readFileSync(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8");
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, "\\"));
    } catch {}
    for (const lib of libs) installs.push(path.join(lib, "steamapps", "common", "Escape from Tarkov"));
  }
  installs.push("C:\\Battlestate Games\\EFT", "C:\\Battlestate Games\\Escape from Tarkov");
  for (const install of installs) {
    for (const logs of [path.join(install, "build", "Logs"), path.join(install, "Logs")]) {
      try {
        if (fs.statSync(logs).isDirectory()) return logs;
      } catch {}
    }
  }
  return null;
}

function gameRunning() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq EscapeFromTarkov.exe", "/NH"], { windowsHide: true }, (err, out) => {
      resolve(err ? null : out.includes("EscapeFromTarkov.exe"));
    });
  });
}

// Quest progress from push-notification logs: a "ChatMessageReceived" line followed by a multi-line JSON
// message whose type is 10 (started), 11 (failed) or 12 (finished) and whose templateId starts with the
// quest id (same ids as tarkov.dev). Feed it lines in order; it returns { id, status } when a message completes.
const LOG_LINE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;
const QUEST_STATUS = { 10: "started", 11: "failed", 12: "finished" };
const QUEST_ID_RE = /^[0-9a-f]{24}$/;

class QuestParser {
  constructor() {
    this.buf = null;
  }

  feed(line) {
    if (this.buf) {
      if (LOG_LINE_RE.test(line)) {
        const ev = this.flush();
        return this.start(line) ?? ev;
      }
      this.buf.push(line);
      // Messages end with a closing brace on its own line; parse as soon as the JSON is complete.
      if (line.trim() === "}") {
        const ev = this.flush(true);
        if (ev !== undefined) return ev;
      }
      return null;
    }
    return this.start(line);
  }

  start(line) {
    if (line.includes("Got notification | ChatMessageReceived")) this.buf = [];
    return null;
  }

  // Returns the quest event, null if the message isn't a quest update, or undefined if the JSON is still incomplete.
  flush(onlyIfComplete = false) {
    let msg;
    try {
      msg = JSON.parse(this.buf.join("\n"))?.message;
    } catch {
      if (onlyIfComplete) return undefined;
      this.buf = null;
      return null;
    }
    this.buf = null;
    const status = QUEST_STATUS[msg?.type];
    const id = String(msg?.templateId ?? "").split(" ")[0];
    return status && QUEST_ID_RE.test(id) ? { id, status } : null;
  }
}

// Replays every Tarkov log session on disk (oldest first) to work out which quests are active.
function readQuestHistory(logsDir) {
  const active = new Set();
  const ended = new Set();
  let sessions = [];
  try {
    sessions = fs.readdirSync(logsDir).filter((n) => n.startsWith("log_")).sort(); // names start with the date
  } catch {
    return { active, ended };
  }
  for (const session of sessions) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(logsDir, session)).filter((f) => f.includes("push-notifications") && f.endsWith(".log")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(path.join(logsDir, session, f), "utf8");
      } catch {
        continue;
      }
      const parser = new QuestParser();
      for (const line of [...text.split("\n"), "0000-00-00 00:00:00"]) {
        const ev = parser.feed(line);
        if (!ev) continue;
        if (ev.status === "started") {
          active.add(ev.id);
          ended.delete(ev.id);
        } else {
          active.delete(ev.id);
          ended.add(ev.id);
        }
      }
    }
  }
  return { active, ended };
}

class LogTailer {
  constructor(dir) {
    this.dir = dir;
    this.session = null;
    this.files = new Map(); // path -> { offset, partial }
    this.map = null;
    this.raidState = null;
  }

  scan() {
    let sessions = [];
    try {
      sessions = fs.readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("log_"))
        .map((d) => path.join(this.dir, d.name));
    } catch {
      return;
    }
    const newest = sessions.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
    if (newest !== this.session) {
      this.session = newest;
      this.files.clear();
    }
    if (!newest) return;
    for (const f of fs.readdirSync(newest)) {
      const full = path.join(newest, f);
      if (f.endsWith(".log") && (f.includes("application") || f.includes("push-notifications")) && !this.files.has(full)) {
        this.files.set(full, { offset: 0, partial: "", quests: f.includes("push-notifications") ? new QuestParser() : null });
      }
    }
  }

  poll() {
    const events = [];
    for (const [file, st] of this.files) {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size < st.offset) Object.assign(st, { offset: 0, partial: "", quests: st.quests && new QuestParser() });
      if (size === st.offset) continue;
      const buf = Buffer.alloc(size - st.offset);
      try {
        const fd = fs.openSync(file, "r");
        fs.readSync(fd, buf, 0, buf.length, st.offset);
        fs.closeSync(fd);
      } catch {
        continue;
      }
      st.offset = size;
      const lines = (st.partial + buf.toString("utf8")).split("\n");
      st.partial = lines.pop();
      for (const line of lines) {
        const ev = this.handle(line);
        if (ev) events.push(ev);
        const quest = st.quests?.feed(line);
        if (quest) events.push({ type: "quest", ...quest });
      }
    }
    return events;
  }

  handle(line) {
    if (line.includes("TRACE-NetworkGameCreate profileStatus")) {
      const m = LOCATION_RE.exec(line);
      if (m) {
        this.map = m[1].trim();
        return this.state("loading");
      }
    } else if (line.includes("application|GameStarted")) {
      return this.state("started");
    } else if (line.includes("Network game matching aborted") || line.includes("Network game matching cancelled") || line.includes("Got notification | UserMatchOver")) {
      return this.state("ended");
    } else if (line.includes("application|scene preset path:")) {
      const m = SCENE_RE.exec(line);
      if (m && SCENE_TO_MAP[m[1]]) this.map = SCENE_TO_MAP[m[1]];
      if (this.raidState === null || this.raidState === "ended") return this.state("matching");
    } else if (line.includes("application|Matching with group id")) {
      if (this.raidState === null || this.raidState === "ended") return this.state("matching");
    }
    return null;
  }

  state(s) {
    if (s === this.raidState) return null;
    this.raidState = s;
    const ev = { type: "raid", state: s, map: this.map };
    if (s === "started") ev.startedAt = Date.now();
    return ev;
  }
}

class Companion extends EventEmitter {
  constructor() {
    super();
    this.timers = [];
    this.status = { running: false, game: null, logsDir: null, screenshotsDir: null, raid: null, map: null, lastPosition: null, server: "idle", lastError: null };
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit("status", { ...this.status });
  }

  async start(settings, documentsDir) {
    this.stop();
    this.settings = settings;
    this.url = `${settings.server.replace(/\/$/, "")}/api/room/${settings.room}/event`;
    const screenshotsDir = settings.screenshotsDir || path.join(documentsDir, "Escape From Tarkov", "Screenshots");
    const logsDir = settings.logsDir || (await findLogsDir());
    this.setStatus({ running: true, logsDir, screenshotsDir });

    this.seen = null;
    this.pendingDelete = new Map();
    this.pollScreenshots();

    if (logsDir) {
      this.tailer = new LogTailer(logsDir);
      this.tailer.scan();
      this.tailer.poll(); // catch up silently
      const running = await gameRunning();
      if (running === false) {
        // The log can end mid-raid if the game was closed; don't report a stale raid or map.
        this.tailer.raidState = "ended";
        this.tailer.map = null;
      }
      this.setStatus({ game: running, raid: this.tailer.raidState, map: this.tailer.map });
      if (this.tailer.raidState && this.tailer.raidState !== "ended") {
        this.send({ type: "raid", state: this.tailer.raidState, map: this.tailer.map });
      }
      // Rebuild active quests from every log on disk, then keep them in sync live (see tick).
      const history = readQuestHistory(logsDir);
      this.setStatus({ questsDetected: history.active.size });
      this.send({ type: "quests", active: [...history.active], ended: [...history.ended] });
    }
    this.send({ type: "heartbeat" });

    this.timers.push(setInterval(() => this.tick(), 500));
    this.timers.push(setInterval(() => this.tailer?.scan(), 3000));
    this.timers.push(setInterval(async () => {
      const running = await gameRunning();
      if (running !== this.status.game) {
        this.setStatus({ game: running });
        this.emit("game", running);
      }
    }, 5000));
    this.timers.push(setInterval(() => this.send({ type: "heartbeat" }), 60000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.tailer = null;
    this.status.running = false;
  }

  tick() {
    if (this.tailer) {
      for (const ev of this.tailer.poll()) {
        if (ev.type === "quest") {
          const started = ev.status === "started";
          this.send({ type: "quests", active: started ? [ev.id] : [], ended: started ? [] : [ev.id] });
          this.emit("quest", ev);
          continue;
        }
        this.setStatus({ raid: ev.state, map: ev.map });
        this.send(ev);
      }
    }
    this.pollScreenshots();
  }

  pollScreenshots() {
    const dir = this.status.screenshotsDir;
    let names;
    try {
      names = new Set(fs.readdirSync(dir).filter((n) => n.endsWith(".png")));
    } catch {
      // Folder doesn't exist yet: Tarkov creates it with the first screenshot, which must count as new.
      this.seen ??= new Set();
      return;
    }
    if (this.seen === null) {
      this.seen = names; // ignore screenshots from before we started
      return;
    }
    for (const name of names) {
      if (this.seen.has(name)) continue;
      const pos = parseScreenshot(name);
      if (!pos) continue;
      const map = this.tailer?.map ?? null;
      this.setStatus({ lastPosition: { ...pos, map, at: Date.now() } });
      this.send({ type: "position", map, ...pos });
      if (this.settings.deleteScreenshots) this.pendingDelete.set(name, Date.now());
    }
    this.seen = names;
    // The game may still be writing the file; wait a few seconds before deleting.
    for (const [name, t] of this.pendingDelete) {
      if (Date.now() - t < 3000) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        this.pendingDelete.delete(name);
      } catch (e) {
        if (e.code === "ENOENT" || Date.now() - t > 60000) this.pendingDelete.delete(name);
      }
    }
  }

  async send(event) {
    const body = JSON.stringify({ name: this.settings.name, ...event });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body });
        if (!res.ok) {
          this.setStatus({ server: "error", lastError: `Server said ${res.status}: ${(await res.text()).slice(0, 120)}` });
          return;
        }
        this.setStatus({ server: "ok", lastError: null });
        return;
      } catch (e) {
        this.setStatus({ server: "offline", lastError: `Can't reach the server (${e.message})` });
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
}

module.exports = { Companion, parseScreenshot, LogTailer, QuestParser, readQuestHistory, findLogsDir };
