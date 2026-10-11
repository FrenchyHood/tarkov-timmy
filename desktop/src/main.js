const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, Notification, shell, screen, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { Companion, findLogsDir } = require("./companion");

// The server comes from the invite link, so nothing account-specific is baked into the app.
const DEFAULT_SERVER = "";
const PROTOCOL = "tarkovtimmy";
const OVERLAY_MIN = 220;
const ICON = path.join(__dirname, "..", "assets", "icon.png");

// Dev/testing only: isolated profile and window snapshots. Inert unless these env vars are set.
if (process.env.TIMMY_USER_DATA) app.setPath("userData", process.env.TIMMY_USER_DATA);
const SNAP_DIR = process.env.TIMMY_SNAP_DIR;
app.on("browser-window-created", (_e, win) => {
  if (!SNAP_DIR) return;
  win.webContents.on("did-finish-load", () => {
    setTimeout(async () => {
      if (win.isDestroyed()) return;
      if (win === overlayWin && process.env.TIMMY_TEST_RESIZE) {
        // Drive the corner grip's resize call from the page and record the result.
        const before = win.getBounds();
        await win.webContents.executeJavaScript("window.timmyDesktop.resizeOverlay(640, 520); window.timmyDesktop.resizeOverlayDone(); !!document.querySelector('#ov-grip') && getComputedStyle(document.querySelector('#ov-grip')).display");
        await new Promise((r) => setTimeout(r, 500));
        const grip = await win.webContents.executeJavaScript("getComputedStyle(document.querySelector('#ov-grip')).display");
        fs.writeFileSync(path.join(SNAP_DIR, "resize.json"), JSON.stringify({ before, after: win.getBounds(), resizable: win.isResizable(), grip, saved: loadSettings().overlay.bounds }));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SNAP_DIR, `${win.getTitle().replace(/[^\w]+/g, "_")}-${win.id}.png`), img.toPNG());
    }, 3500);
  });
});

// ---------- settings ----------

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const DEFAULTS = {
  server: DEFAULT_SERVER,
  room: "",
  name: "",
  deleteScreenshots: true,
  logsDir: "",
  screenshotsDir: "",
  startWithWindows: false,
  hotkeys: { overlay: "F9", clickThrough: "F10" },
  overlay: { bounds: null, opacity: 0.9, clickThrough: false, visible: false },
  trayHintShown: false,
};
let settings = loadSettings();

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    return { ...DEFAULTS, ...saved, hotkeys: { ...DEFAULTS.hotkeys, ...saved.hotkeys }, overlay: { ...DEFAULTS.overlay, ...saved.overlay } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
const configured = () => Boolean(settings.room && settings.name && settings.server);
const roomUrl = (extra = "") => `${settings.server.replace(/\/$/, "")}/r/${settings.room}${extra}`;
const serverOrigin = () => new URL(settings.server).origin;

// Accepts https://host/r/ROOM or tarkovtimmy://join/ROOM?server=https://host
function parseJoinLink(link) {
  try {
    const u = new URL(String(link).trim());
    if (u.protocol === `${PROTOCOL}:` && u.hostname === "join") {
      const room = u.pathname.replace(/^\/+|\/+$/g, "");
      const server = u.searchParams.get("server") || settings.server;
      if (/^[A-Za-z0-9_-]{4,40}$/.test(room) && /^https?:\/\//.test(server)) return { server: new URL(server).origin, room };
    }
    if (u.protocol === "https:" || u.protocol === "http:") {
      const m = u.pathname.match(/^\/r\/([A-Za-z0-9_-]{4,40})\/?$/);
      if (m) return { server: u.origin, room: m[1] };
    }
  } catch {}
  return null;
}

// ---------- single instance + join links ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleJoinLink(link);
    else showMain();
  });
}
if (process.defaultApp) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

function handleJoinLink(link) {
  const join = parseJoinLink(link);
  if (!join) return;
  settings.server = join.server;
  settings.room = join.room;
  saveSettings();
  if (!settings.name) return openSettings();
  restartAll();
}

// ---------- windows ----------

let mainWin = null;
let overlayWin = null;
let settingsWin = null;
let tray = null;
const companion = new Companion();

function secureSiteWindow(win) {
  // Our site only: anything else opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== serverOrigin()) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (e.g. redirect)
    win.loadFile(path.join(__dirname, "ui", "offline.html"), { query: { retry: url } });
  });
}

function sitePrefs(role) {
  return {
    preload: path.join(__dirname, "preload-site.js"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [`--timmy-role=${role}`],
  };
}

function showMain() {
  if (!configured()) return openSettings();
  if (mainWin) {
    mainWin.show();
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    width: 1400, height: 900, minWidth: 720, minHeight: 500,
    title: "Tarkov Timmy", icon: ICON, backgroundColor: "#14161a", autoHideMenuBar: true,
    webPreferences: sitePrefs("main"),
  });
  secureSiteWindow(mainWin);
  mainWin.loadURL(roomUrl());
  mainWin.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault(); // keep running in the tray so position sharing keeps working
    mainWin.hide();
    if (!settings.trayHintShown) {
      notify("Tarkov Timmy is still running", "It keeps sharing your position from the tray. Right-click the tray icon to quit.");
      settings.trayHintShown = true;
      saveSettings();
    }
  });
  mainWin.on("closed", () => (mainWin = null));
}

function createOverlay() {
  const area = screen.getPrimaryDisplay().workArea;
  const b = settings.overlay.bounds ?? { width: 420, height: 420, x: area.x + area.width - 440, y: area.y + 80 };
  // Not `transparent`: Windows can't resize transparent frameless windows from their edges.
  // The see-through look comes from setOpacity instead.
  overlayWin = new BrowserWindow({
    ...b, minWidth: OVERLAY_MIN, minHeight: OVERLAY_MIN,
    frame: false, resizable: true, thickFrame: true, skipTaskbar: true, show: false,
    alwaysOnTop: true, focusable: true, backgroundColor: "#0e1013", icon: ICON,
    webPreferences: sitePrefs("overlay"),
  });
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setVisibleOnAllWorkspaces(true);
  secureSiteWindow(overlayWin);
  overlayWin.loadURL(roomUrl("?overlay=1"));
  const saveBounds = () => {
    settings.overlay.bounds = overlayWin.getBounds();
    saveSettings();
  };
  overlayWin.on("moved", saveBounds);
  overlayWin.on("resized", saveBounds);
  overlayWin.on("closed", () => (overlayWin = null));
  applyOverlayState();
}

function applyOverlayState() {
  if (!overlayWin) return;
  const { opacity, clickThrough, visible } = settings.overlay;
  overlayWin.setOpacity(Math.min(1, Math.max(0.3, opacity)));
  overlayWin.setIgnoreMouseEvents(clickThrough, { forward: true });
  overlayWin.setFocusable(!clickThrough);
  if (visible) overlayWin.showInactive();
  else overlayWin.hide();
  overlayWin.webContents.send("timmy:overlay", { clickThrough, visible });
  updateTray();
}

function toggleOverlay(force) {
  if (!configured()) return openSettings();
  if (!overlayWin) createOverlay();
  settings.overlay.visible = typeof force === "boolean" ? force : !settings.overlay.visible;
  saveSettings();
  applyOverlayState();
}

function toggleClickThrough() {
  if (!overlayWin || !settings.overlay.visible) return;
  settings.overlay.clickThrough = !settings.overlay.clickThrough;
  saveSettings();
  applyOverlayState();
  notifyQuiet(settings.overlay.clickThrough ? "Overlay: clicks go to the game" : "Overlay: you can click the map");
}

function openSettings() {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 560, height: 720, resizable: false, title: "Tarkov Timmy — Settings", icon: ICON,
    backgroundColor: "#14161a", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload-settings.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, "ui", "settings.html"));
  settingsWin.on("closed", () => {
    settingsWin = null;
    if (!configured() && !mainWin) app.quit(); // closed first-run setup without finishing
  });
}

// ---------- notifications ----------

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show();
}
function notifyQuiet(title) {
  if (Notification.isSupported()) new Notification({ title, silent: true, icon: ICON }).show();
}

// ---------- tray ----------

function updateTray() {
  if (!tray) return;
  const s = companion.status;
  const game = s.game === true ? (s.raid === "started" ? `In raid${s.map ? ` (${s.map})` : ""}` : "Tarkov running") : "Tarkov not running";
  tray.setToolTip(`Tarkov Timmy — ${game}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: game, enabled: false },
    { label: configured() ? `Room ${settings.room} as ${settings.name}` : "Not set up yet", enabled: false },
    { type: "separator" },
    { label: "Open map", click: showMain },
    { label: `Overlay (${settings.hotkeys.overlay})`, type: "checkbox", checked: settings.overlay.visible, click: () => toggleOverlay() },
    { label: `Click-through (${settings.hotkeys.clickThrough})`, type: "checkbox", checked: settings.overlay.clickThrough, enabled: settings.overlay.visible, click: toggleClickThrough },
    { type: "separator" },
    { label: "Settings…", click: openSettings },
    { label: "Check for updates", click: () => checkForUpdates(true) },
    { type: "separator" },
    { label: "Quit Tarkov Timmy", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ---------- hotkeys ----------

function registerHotkeys() {
  if (SNAP_DIR) return; // test runs must not grab F9/F10 from a real copy of the app
  globalShortcut.unregisterAll();
  const failed = [];
  const reg = (accel, fn) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) failed.push(accel);
    } catch {
      failed.push(accel);
    }
  };
  reg(settings.hotkeys.overlay, () => toggleOverlay());
  reg(settings.hotkeys.clickThrough, toggleClickThrough);
  if (failed.length) notify("Hotkey unavailable", `${failed.join(", ")} is used by another app. Pick a different key in Settings.`);
}

// ---------- updates ----------

let autoUpdater = null;
function checkForUpdates(manual) {
  if (!app.isPackaged) {
    if (manual) notify("Updates", "Update checks only run in the installed app.");
    return;
  }
  autoUpdater ??= require("electron-updater").autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.removeAllListeners();
  autoUpdater.on("update-downloaded", (info) => {
    notify("Update ready", `Tarkov Timmy ${info.version} will install when you quit the app.`);
  });
  if (manual) {
    autoUpdater.on("update-not-available", () => notify("You're up to date", `Tarkov Timmy ${app.getVersion()} is the latest version.`));
    autoUpdater.on("error", (e) => notify("Update check failed", String(e.message || e).slice(0, 150)));
  }
  autoUpdater.checkForUpdates().catch(() => {});
}

// ---------- companion ----------

function startCompanion() {
  if (!configured()) return;
  companion.start(settings, app.getPath("documents"));
}
companion.on("status", (status) => {
  for (const w of [mainWin, overlayWin]) w?.webContents.send("timmy:status", status);
  settingsWin?.webContents.send("settings:status", status);
  updateTray();
});
companion.on("game", (running) => {
  if (running) notifyQuiet("Tarkov detected — Timmy is watching for your position screenshots");
});

function restartAll() {
  startCompanion();
  if (mainWin) mainWin.loadURL(roomUrl());
  else showMain();
  if (overlayWin) overlayWin.loadURL(roomUrl("?overlay=1"));
  updateTray();
}

// ---------- stash scanner ----------
// Out of raid, a screenshot of the stash (taken with Tarkov's own screenshot key) is read for items.
// Everything happens on this PC; the screenshot is never uploaded.

let lastScan = null;
let stashItems = null; // { at, items }
let scanQueue = Promise.resolve();
const lastScanPath = () => path.join(app.getPath("userData"), "last-scan.json");
try { lastScan = JSON.parse(fs.readFileSync(lastScanPath(), "utf8")); } catch {}

async function getStashItems() {
  if (stashItems && Date.now() - stashItems.at < 60 * 60 * 1000) return stashItems.items;
  const res = await fetch(`${settings.server.replace(/\/$/, "")}/api/data/items?room=${settings.room}`);
  if (!res.ok) throw new Error(`item data: HTTP ${res.status}`);
  stashItems = { at: Date.now(), items: (await res.json()).items };
  return stashItems.items;
}

function scanScreenshot(file, { manual = false } = {}) {
  scanQueue = scanQueue.then(async () => {
    try {
      await new Promise((r) => setTimeout(r, 1500)); // let Tarkov finish writing the file
      mainWin?.webContents.send("timmy:stash-scanning", true);
      const { scanStash } = require("./scanner/stash-scan");
      const result = await scanStash(file, await getStashItems(), app.getPath("userData"));
      const found = result.ok ? result.items.filter((i) => i.id).length : 0;
      if (!result.ok || found < 3) {
        if (manual) notify("No stash found", "That screenshot doesn't look like your stash. Open the stash and press your screenshot key.");
        return;
      }
      lastScan = result;
      fs.writeFileSync(lastScanPath(), JSON.stringify(result));
      // The scan (including the stash picture) is saved, so the 5 MB screenshot isn't needed any more.
      // Only stash screenshots that scanned successfully are removed; anything else is left alone.
      if (settings.deleteScreenshots) fs.promises.unlink(file).catch(() => {});
      mainWin?.webContents.send("timmy:stash-scan", result);
      notify("Stash scanned", `${found} items recognised. Open Tarkov Timmy → Stash to see what to keep and sell.`);
    } catch (e) {
      notify("Stash scan failed", String(e.message || e).slice(0, 150));
    } finally {
      mainWin?.webContents.send("timmy:stash-scanning", false);
    }
  });
  return scanQueue;
}

// "Scan my latest screenshot" button: newest screenshot without a map position in its name.
function latestMenuScreenshot() {
  const dir = companion.status.screenshotsDir;
  try {
    return fs.readdirSync(dir)
      .filter((n) => n.endsWith(".png") && !/_-?\d+\.\d{2}, -?\d+\.\d{2}, -?\d+\.\d{2}_/.test(n))
      .map((n) => ({ file: path.join(dir, n), t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0]?.file ?? null;
  } catch {
    return null;
  }
}

companion.on("menu-screenshot", (file) => scanScreenshot(file));

// ---------- IPC ----------

function fromSite(e) {
  try {
    return new URL(e.senderFrame.url).origin === serverOrigin();
  } catch {
    return false;
  }
}
function fromSettings(e) {
  return settingsWin && e.sender === settingsWin.webContents;
}

ipcMain.handle("timmy:identity", (e) => (fromSite(e) ? { name: settings.name, room: settings.room, version: app.getVersion(), hotkeys: settings.hotkeys } : null));
ipcMain.handle("timmy:status", (e) => (fromSite(e) ? companion.status : null));
ipcMain.on("timmy:notify", (e, { title, body }) => {
  if (fromSite(e)) notify(String(title).slice(0, 80), String(body ?? "").slice(0, 200));
});
ipcMain.on("timmy:open-settings", (e) => fromSite(e) && openSettings());
ipcMain.handle("timmy:last-scan", (e) => (fromSite(e) ? lastScan : null));
ipcMain.handle("timmy:scan-latest", async (e) => {
  if (!fromSite(e)) return { ok: false };
  const file = latestMenuScreenshot();
  if (!file) return { ok: false, error: "No stash screenshot found yet. Open your stash in Tarkov and press your screenshot key." };
  scanScreenshot(file, { manual: true });
  return { ok: true };
});
ipcMain.on("timmy:toggle-overlay", (e) => fromSite(e) && toggleOverlay());
ipcMain.on("timmy:toggle-click-through", (e) => fromSite(e) && toggleClickThrough());
// Resize grip in the overlay's corner: the page sends the size it wants while dragging.
ipcMain.on("timmy:overlay-resize", (e, { width, height }) => {
  if (!fromSite(e) || !overlayWin || e.sender !== overlayWin.webContents) return;
  const area = screen.getDisplayMatching(overlayWin.getBounds()).workArea;
  const w = Math.round(Math.min(area.width, Math.max(OVERLAY_MIN, Number(width) || 0)));
  const h = Math.round(Math.min(area.height, Math.max(OVERLAY_MIN, Number(height) || 0)));
  overlayWin.setSize(w, h);
});
ipcMain.on("timmy:overlay-resize-done", (e) => {
  if (!fromSite(e) || !overlayWin) return;
  settings.overlay.bounds = overlayWin.getBounds();
  saveSettings();
});
ipcMain.on("timmy:set-opacity", (e, value) => {
  if (!fromSite(e) || !Number.isFinite(value)) return;
  settings.overlay.opacity = value;
  saveSettings();
  applyOverlayState();
});

ipcMain.handle("settings:get", (e) => (fromSettings(e) ? { settings, status: companion.status, version: app.getVersion(), configured: configured() } : null));
ipcMain.handle("settings:detect-logs", async (e) => (fromSettings(e) ? findLogsDir() : null));
ipcMain.handle("settings:parse-link", (e, link) => (fromSettings(e) ? parseJoinLink(link) : null));
ipcMain.handle("settings:save", (e, next) => {
  if (!fromSettings(e)) return { ok: false };
  const join = next.link ? parseJoinLink(next.link) : null;
  if (next.link && !join) return { ok: false, error: "That doesn't look like a room link. Copy it from the Invite button on the map." };
  const name = String(next.name ?? "").trim().slice(0, 24);
  if (!/^[\p{L}\p{N} _.-]{1,24}$/u.test(name)) return { ok: false, error: "Callsign can use letters, numbers, spaces, - _ and . (max 24)." };
  const hotkeys = { overlay: String(next.hotkeys?.overlay || "F9"), clickThrough: String(next.hotkeys?.clickThrough || "F10") };
  if (hotkeys.overlay === hotkeys.clickThrough) return { ok: false, error: "The two hotkeys need to be different." };

  const wasConfigured = configured();
  if (join) Object.assign(settings, join);
  Object.assign(settings, {
    name,
    deleteScreenshots: Boolean(next.deleteScreenshots),
    logsDir: String(next.logsDir ?? "").trim(),
    startWithWindows: Boolean(next.startWithWindows),
    hotkeys,
  });
  settings.overlay.opacity = Math.min(1, Math.max(0.3, Number(next.opacity) || 0.9));
  saveSettings();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, args: ["--hidden"] });
  registerHotkeys();
  restartAll();
  applyOverlayState();
  if (!wasConfigured) settingsWin?.close();
  return { ok: true };
});
ipcMain.on("settings:open-external", (e, url) => {
  if (fromSettings(e) && /^https:\/\//.test(url)) shell.openExternal(url);
});

// ---------- lifecycle ----------

app.whenReady().then(() => {
  app.setAppUserModelId("com.frenchyhood.tarkovtimmy");
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on("click", showMain);
  updateTray();
  registerHotkeys();

  const link = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (link) handleJoinLink(link);
  if (!configured()) openSettings();
  else {
    startCompanion();
    if (!process.argv.includes("--hidden")) showMain();
    if (settings.overlay.visible) createOverlay();
  }
  // Dev/testing only: scan a given screenshot at startup and save the result (checks packaged builds).
  if (SNAP_DIR && process.env.TIMMY_TEST_SCAN) {
    getStashItems()
      .then((items) => require("./scanner/stash-scan").scanStash(process.env.TIMMY_TEST_SCAN, items, app.getPath("userData")))
      .then((r) => fs.writeFileSync(path.join(SNAP_DIR, "scan.json"), JSON.stringify({ ...r, image: r.image ? "(jpeg)" : null })))
      .catch((e) => fs.writeFileSync(path.join(SNAP_DIR, "scan-error.txt"), String(e.stack || e)));
  }
  checkForUpdates(false);
  // The app lives in the tray for days, so keep checking (it downloads quietly and installs on quit).
  setInterval(() => checkForUpdates(false), 4 * 60 * 60 * 1000);
});

app.on("window-all-closed", () => {
  // Stay alive in the tray.
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  try { require("./scanner/stash-scan").shutdown(); } catch {}
});
