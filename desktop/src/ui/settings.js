"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let detectedLogs = null;
let lastStatus = {};
function renderStatus(s) {
  lastStatus = s;
  const logs = s.logsDir || detectedLogs;
  const item = (ok, text) => `<div class="st ${ok === true ? "ok" : ok === false ? "bad" : "na"}"><i></i>${text}</div>`;
  $("status").innerHTML = [
    item(logs ? true : detectedLogs === null ? null : false, logs ? "Found Tarkov's logs (auto map switching)" : detectedLogs === null ? "Looking for Tarkov…" : "Couldn't find Tarkov's logs. Set the folder under More options → Advanced"),
    item(s.game, s.game === true ? "Tarkov is running" : "Tarkov isn't running"),
    item(s.server === "ok" ? true : s.server === "idle" ? null : false, s.server === "ok" ? "Connected to your squad" : s.server === "idle" ? "Not connected yet" : esc(s.lastError || "Can't reach the server")),
    s.lastPosition ? item(true, `Last position sent ${new Date(s.lastPosition.at).toLocaleTimeString()}`) : "",
  ].join("");
}

// Turn a keydown into an Electron accelerator like "F9" or "Ctrl+Shift+M".
function accelerator(e) {
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if (!/^(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9])$/.test(key)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
  if (/^[A-Z0-9]$/.test(key) && !mods.length) return null; // bare letters would fire while typing in chat
  return [...mods, key].join("+");
}
for (const input of document.querySelectorAll(".hotkey")) {
  input.addEventListener("keydown", (e) => {
    e.preventDefault();
    const acc = accelerator(e);
    if (acc) input.value = acc;
  });
  input.addEventListener("focus", () => input.select());
}

async function init() {
  const { settings, status, version, configured } = await window.timmySettings.get();
  $("version").textContent = `v${version}`;
  if (configured) {
    $("more").open = true;
    $("heading").textContent = "Settings";
    $("subheading").textContent = `Room ${settings.room} as ${settings.name}`;
    $("save").textContent = "Save";
    $("link").value = `${settings.server}/r/${settings.room}`;
    $("link-help").textContent = "Paste a different invite link to switch rooms.";
  }
  $("name").value = settings.name;
  $("hk-overlay").value = settings.hotkeys.overlay;
  $("hk-click").value = settings.hotkeys.clickThrough;
  $("opacity").value = settings.overlay.opacity;
  $("opacity-val").textContent = `${Math.round(settings.overlay.opacity * 100)}%`;
  $("opacity").oninput = (e) => ($("opacity-val").textContent = `${Math.round(e.target.value * 100)}%`);
  $("delete").checked = settings.deleteScreenshots;
  $("startup").checked = settings.startWithWindows;
  $("logs").value = settings.logsDir;
  renderStatus(status);
  window.timmySettings.detectLogs().then((dir) => {
    $("logs-detected").textContent = dir ? `Detected: ${dir}` : "Not detected automatically.";
    detectedLogs = dir || "";
    renderStatus(lastStatus);
  });
  window.timmySettings.onStatus(renderStatus);
  (configured ? $("name") : $("link")).focus();
}

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const link = $("link").value.trim();
  const res = await window.timmySettings.save({
    link: link || null,
    name: $("name").value,
    hotkeys: { overlay: $("hk-overlay").value, clickThrough: $("hk-click").value },
    opacity: Number($("opacity").value),
    deleteScreenshots: $("delete").checked,
    startWithWindows: $("startup").checked,
    logsDir: $("logs").value,
  });
  $("error").hidden = res.ok;
  $("error").textContent = res.error || "";
  if (res.ok) {
    $("save").textContent = "Saved ✓";
    setTimeout(() => ($("save").textContent = "Save"), 1200);
  }
};

init();
