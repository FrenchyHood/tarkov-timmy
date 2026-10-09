"use strict";

// ---------- small helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const PLAYER_COLORS = ["#ffd166", "#ef476f", "#06d6a0", "#4cc9f0", "#f78c6b", "#c77dff"];
const FACTION_COLOR = { pmc: "var(--pmc)", scav: "var(--scav)", shared: "var(--shared)" };
const HAZARD_LABEL = { minefield: "Minefield", sniper: "Sniper zone", radiation: "Radiation" };
const PING_KINDS = {
  go: { label: "Go here", icon: "➜", color: "#5fd38a" },
  enemy: { label: "Enemy", icon: "✖", color: "#ff5a5a" },
  loot: { label: "Loot", icon: "★", color: "#e8c547" },
  danger: { label: "Danger", icon: "!", color: "#ff9b3d" },
};
// Maps whose calibration lives under another key in calibration.json.
const CALIBRATION_ALIAS = { "ground-zero-21": "ground-zero", "ground-zero-tutorial": "ground-zero", "night-factory": "factory", "the-lab-dark": "the-lab" };
// Set when running inside the Tarkov Timmy desktop app (see desktop/src/preload-site.js).
const desktop = window.timmyDesktop ?? null;
const OVERLAY = new URLSearchParams(location.search).has("overlay");
// Only one window should beep/notify: the browser tab, or the desktop app's main window.
const ALERTS = !desktop || desktop.role === "main";

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// ---------- app state ----------

const app = {
  room: null,
  name: store.get("name", ""),
  ws: null,
  server: null,          // last room state from the server
  clockSkew: 0,          // server now - local now
  maps: [],              // tarkov.dev maps
  tasks: [],             // tarkov.dev tasks
  calibration: {},
  mapId: null,           // current tarkov.dev map id
  followMe: true,        // switch map automatically when my raid map changes
  lastMyMap: null,
  floor: "",
  floorMode: "auto",     // "auto" follows my screenshot height; "manual" once a floor is picked
  leaflet: null,
  layers: {},
  svgRoot: null,
  tab: store.get("tab", "extracts"),
  questFilter: "",
  questThisMapOnly: true,
  local: null,           // desktop companion status
  seenPings: null,
  timerAlerts: new Set(),
};

const me = () => app.server?.players?.[app.name.toLowerCase()] ?? null;
const currentMap = () => app.maps.find((m) => m.id === app.mapId) ?? null;
const myFaction = () => me()?.faction ?? "pmc";
function playerColor(key) {
  const keys = Object.keys(app.server?.players ?? {}).sort();
  const i = keys.indexOf(key);
  return PLAYER_COLORS[(i < 0 ? 0 : i) % PLAYER_COLORS.length];
}

// ---------- routing / landing ----------

async function boot() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]{4,40})\/?$/);
  if (!m) return showLanding();
  app.room = m[1];
  if (OVERLAY) document.body.classList.add("overlay");
  if (desktop) {
    document.body.classList.add("desktop");
    const id = await desktop.identity();
    if (id?.name) app.name = id.name;
    desktop.onStatus((s) => { app.local = s; if (app.tab === "squad") renderSquadTab(); });
    desktop.status().then((s) => (app.local = s));
    desktop.onOverlay((s) => document.body.classList.toggle("click-through", s.clickThrough));
  }
  if (!app.name) return askName();
  enterRoom();
}

function showLanding() {
  $("#landing").hidden = false;
  $("#create-form").onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#create-error");
    err.hidden = true;
    $("#create-room").disabled = true;
    try {
      const res = await fetch("/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: $("#squad-password").value }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      location.href = `/r/${body.room}`;
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      $("#create-room").disabled = false;
    }
  };
  $("#join-form").onsubmit = (e) => {
    e.preventDefault();
    const raw = $("#join-code").value.trim();
    const code = raw.match(/([A-Za-z0-9_-]{4,40})\/?$/)?.[1];
    if (code) location.href = `/r/${code}`;
  };
}

function askName() {
  const dlg = $("#name-dialog");
  $("#name-input").value = app.name;
  dlg.showModal();
  $("#name-form").onsubmit = () => {
    const v = $("#name-input").value.trim().slice(0, 24);
    if (!v) return;
    app.name = v;
    store.set("name", v);
    if (!app.ws) enterRoom();
    else { send({ t: "hello", name: app.name }); renderAll(); }
  };
}

// ---------- room ----------

async function enterRoom() {
  $("#room").hidden = false;
  wireUi();
  connect();
  loadData();
}

// Used when tarkov.dev is down: map art, players and pings still work; extracts etc. fill in later.
const FALLBACK_MAPS = [
  ["bigmap", "Customs", "customs"], ["factory4_day", "Factory", "factory"], ["factory4_night", "Night Factory", "night-factory"],
  ["Interchange", "Interchange", "interchange"], ["laboratory", "The Lab", "the-lab"], ["Labyrinth", "The Labyrinth", "the-labyrinth"],
  ["Lighthouse", "Lighthouse", "lighthouse"], ["RezervBase", "Reserve", "reserve"], ["Sandbox", "Ground Zero", "ground-zero"],
  ["Sandbox_high", "Ground Zero 21+", "ground-zero-21"], ["Shoreline", "Shoreline", "shoreline"],
  ["TarkovStreets", "Streets of Tarkov", "streets-of-tarkov"], ["Woods", "Woods", "woods"],
].map(([nameId, name, normalizedName]) => ({ id: `fallback:${nameId}`, nameId, name, normalizedName }));

function useMaps(maps) {
  const currentNameId = currentMap()?.nameId;
  app.maps = maps.filter((m) => calibrationFor(m)).sort((a, b) => a.name.localeCompare(b.name));
  fillMapSelect();
  const saved = store.get("mapNameId", null);
  const pick = (nameId) => app.maps.find((m) => m.nameId === nameId)?.id;
  // Prefer the map I'm in, then whatever was on screen, then the last map viewed.
  const mine = app.followMe ? myMapNameId() : null;
  if (mine) app.lastMyMap = mine;
  selectMap(pick(mine) ?? pick(currentNameId) ?? pick(saved) ?? pick("bigmap") ?? app.maps[0]?.id);
}

async function loadData(attempt = 0) {
  if (!attempt) setStatus("Loading map data…");
  try {
    if (!Object.keys(app.calibration).length) app.calibration = await fetch("/calibration.json").then((r) => r.json());
    const maps = await fetchData("maps");
    useMaps(maps.maps);
    setStatus(null);
  } catch (err) {
    console.warn("map data:", err);
    if (app.dead) return;
    if (!app.maps.length && Object.keys(app.calibration).length) useMaps(FALLBACK_MAPS);
    setStatus(`<b>Extracts, bosses and quests are temporarily unavailable.</b><br><span class="muted">tarkov.dev isn't responding. Positions and pings still work. Retrying automatically…</span>`);
    setTimeout(() => loadData(attempt + 1), Math.min(60000, 10000 * (attempt + 1)));
    return;
  }
  // Tasks are big and optional; load after the map is up.
  fetchData("tasks").then((d) => { app.tasks = d.tasks || []; renderQuestsTab(); drawQuests(); }).catch(() => {
    $("#tab-quests").innerHTML = `<div class="hint">Couldn't load quest data from tarkov.dev right now.</div>`;
  });
}

async function fetchData(name) {
  const res = await fetch(`/api/data/${name}?room=${encodeURIComponent(app.room)}`);
  if (res.status === 403) { roomNotFound(); throw new Error("unknown room"); }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function calibrationFor(map) {
  const key = CALIBRATION_ALIAS[map.normalizedName] ?? map.normalizedName;
  return app.calibration[key] ?? null;
}

function roomNotFound() {
  app.dead = true;
  app.ws?.close();
  setStatus(`<b>This room doesn't exist.</b><br><span class="muted">Check the invite link, or <a href="/">create a new room</a>.</span>`);
}

function connect() {
  if (app.dead) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/room/${app.room}/ws`);
  app.ws = ws;
  ws.onopen = () => { app.retries = 0; $("#conn").classList.add("ok"); send({ t: "hello", name: app.name }); };
  ws.onclose = () => {
    $("#conn").classList.remove("ok");
    // Back off so a dead connection doesn't burn through the server's request allowance.
    app.retries = (app.retries ?? 0) + 1;
    setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(app.retries, 5)));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t !== "state") return;
    app.server = msg.state;
    app.clockSkew = msg.now - Date.now();
    onServerState();
  };
}
function send(obj) {
  if (app.ws?.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(obj));
}
const serverNow = () => Date.now() + app.clockSkew;

// The map I'm in (or last sent a position from), as a tarkov.dev nameId.
function myMapNameId() {
  const mine = me();
  return mine?.raid && mine.raid.state !== "ended" && mine.raid.map ? mine.raid.map : mine?.pos?.map ?? null;
}

function onServerState() {
  // Follow my raid onto its map (once the map list has loaded).
  const mapNameId = myMapNameId();
  if (mapNameId && mapNameId !== app.lastMyMap && app.maps.length) {
    app.lastMyMap = mapNameId;
    const target = app.maps.find((m) => m.nameId === mapNameId);
    if (target && app.followMe && target.id !== app.mapId) selectMap(target.id);
  }
  renderFaction();
  drawPlayers();
  drawPings();
  drawExtracts();
  drawQuests();
  renderActiveTab();
  updateTimer();
  alertNewPings();
  autoFloor();
  if (OVERLAY) followMe();
}

// ---------- alerts ----------

let audioCtx = null;
function beep(pattern) {
  try {
    audioCtx ??= new AudioContext();
    let t = audioCtx.currentTime;
    for (const [freq, dur] of pattern) {
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur);
      t += dur + 0.04;
    }
  } catch {}
}
const PING_SOUNDS = { enemy: [[880, 0.09], [880, 0.09], [660, 0.14]], danger: [[520, 0.12], [520, 0.12]], go: [[660, 0.08], [990, 0.12]], loot: [[990, 0.08], [1320, 0.12]] };

function alertNewPings() {
  const pings = app.server?.pings ?? [];
  const firstLoad = app.seenPings === null;
  app.seenPings ??= new Set();
  for (const p of pings) {
    if (app.seenPings.has(p.id)) continue;
    app.seenPings.add(p.id);
    if (firstLoad || !ALERTS || p.by.toLowerCase() === app.name.toLowerCase()) continue;
    beep(PING_SOUNDS[p.kind] ?? PING_SOUNDS.go);
    const mapName = app.maps.find((m) => m.nameId === p.map)?.name ?? "";
    desktop?.notify(`${p.by}: ${PING_KINDS[p.kind].label}`, mapName ? `Pinged on ${mapName}` : "");
  }
}

function timerAlert(raidKey, left) {
  for (const mins of [10, 5]) {
    const key = `${raidKey}:${mins}`;
    if (left <= mins * 60 && left > mins * 60 - 30 && !app.timerAlerts.has(key)) {
      app.timerAlerts.add(key);
      if (!ALERTS) continue;
      beep([[440, 0.15], [440, 0.15], [440, 0.3]]);
      desktop?.notify(`${mins} minutes left in raid`, "Start heading to your extract.");
    }
  }
}

function followMe() {
  const p = me()?.pos;
  if (!p || !app.leaflet || p.map !== currentMap()?.nameId) return;
  if (p.ts === app.lastFollowTs) return;
  app.lastFollowTs = p.ts;
  app.leaflet.setView(pos(p), Math.max(app.leaflet.getZoom(), 3));
}

// ---------- UI wiring ----------

function wireUi() {
  $("#map-select").onchange = (e) => { app.followMe = false; selectMap(e.target.value); };
  $("#floor-select").onchange = (e) => {
    app.floorMode = e.target.value === "auto" ? "auto" : "manual";
    if (app.floorMode === "auto") autoFloor();
    else setFloor(e.target.value);
  };
  for (const b of document.querySelectorAll("#faction-toggle button")) {
    b.onclick = () => send({ t: "faction", name: app.name, faction: b.dataset.faction });
  }
  for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => setTab(b.dataset.tab);
  setTab(app.tab);
  $("#share-btn").onclick = async () => {
    const link = `${location.origin}/r/${app.room}`;
    try { await navigator.clipboard.writeText(link); flash($("#share-btn"), "Copied!"); }
    catch { prompt("Room link:", link); }
  };
  $("#panel-toggle").onclick = () => { $("#panel").classList.toggle("collapsed"); app.leaflet?.invalidateSize(); };
  $("#overlay-btn").onclick = () => desktop?.toggleOverlay();
  if (OVERLAY && desktop) {
    desktop.identity().then((id) => {
      if (id?.hotkeys) $("#ov-hint").textContent = `${id.hotkeys.overlay} hide · ${id.hotkeys.clickThrough} click-through`;
    });
  }
  setInterval(() => { updateTimer(); if (app.tab === "squad") renderSquadTab(); drawPlayers(); }, 1000);
}

function flash(el, text) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = old), 1200);
}

function setStatus(html) {
  const el = $("#map-status");
  el.hidden = !html;
  el.innerHTML = html ?? "";
}

function setTab(tab) {
  app.tab = tab;
  store.set("tab", tab);
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const t of ["extracts", "bosses", "quests", "squad"]) $(`#tab-${t}`).hidden = t !== tab;
  renderActiveTab();
}

function renderActiveTab() {
  ({ extracts: renderExtractsTab, bosses: renderBossesTab, quests: renderQuestsTab, squad: renderSquadTab })[app.tab]?.();
}

function renderAll() {
  renderFaction();
  renderActiveTab();
  drawExtracts();
  drawQuests();
  drawPlayers();
}

function fillMapSelect() {
  $("#map-select").innerHTML = app.maps.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
}

function renderFaction() {
  for (const b of document.querySelectorAll("#faction-toggle button")) b.classList.toggle("active", b.dataset.faction === myFaction());
}

function updateTimer() {
  const el = $("#raid-timer");
  const map = currentMap();
  const players = Object.values(app.server?.players ?? {});
  // Prefer my raid; fall back to any squadmate's raid on this map.
  const raid = [me(), ...players].map((p) => p?.raid).find((r) => r?.state === "started" && r.startedAt && r.map === map?.nameId);
  if (!raid || !map?.raidDuration) { el.hidden = true; return; }
  const left = map.raidDuration * 60 - (serverNow() - raid.startedAt) / 1000;
  if (left < -300) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = left > 0 ? `⏱ ${fmtClock(left)}` : "⏱ 0:00";
  el.classList.toggle("low", left < 600);
  timerAlert(raid.startedAt, left);
}

// ---------- map setup ----------

function applyRotation(latLng, rotation) {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
  if (!rotation) return latLng;
  const a = (rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const { lng: x, lat: y } = latLng;
  return L.latLng(x * s + y * c, x * c - y * s);
}

// Same projection tarkov.dev uses, so game coordinates land on their map art.
function makeCRS(cal) {
  const [sx, mx, sy, my] = cal.transform ?? [1, 0, 1, 0];
  const rot = cal.coordinateRotation ?? 0;
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(sx, mx, -sy, my),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (ll) => L.Projection.LonLat.project(applyRotation(ll, rot)),
      unproject: (pt) => applyRotation(L.Projection.LonLat.unproject(pt), -rot),
    }),
  });
}
const toBounds = (b) => L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]);
const pos = (p) => [p.z, p.x];

function selectMap(id) {
  const map = app.maps.find((m) => m.id === id);
  if (!map) return;
  app.mapId = id;
  store.set("mapNameId", map.nameId);
  $("#map-select").value = id;
  $("#ov-map").textContent = map.name;
  const cal = calibrationFor(map);

  app.leaflet?.remove();
  const bounds = toBounds(cal.bounds);
  const lm = L.map("map", {
    crs: makeCRS(cal),
    minZoom: cal.minZoom ?? 1,
    maxZoom: Math.max(cal.maxZoom ?? 6, 7),
    zoomSnap: 0.25,
    attributionControl: false,
    maxBounds: bounds.pad(0.5),
  });
  app.leaflet = lm;
  lm.fitBounds(bounds);

  // Base art: SVG (most maps) or tiles (Labs etc).
  app.svgRoot = null;
  if (cal.svgPath) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    L.svgOverlay(svg, cal.svgBounds ? toBounds(cal.svgBounds) : bounds, { interactive: false }).addTo(lm);
    fetch(cal.svgPath).then((r) => r.text()).then((text) => {
      svg.innerHTML = text;
      svg.setAttribute("viewBox", svg.children[0].getAttribute("viewBox"));
      app.svgRoot = svg.children[0];
      setFloor(app.floor);
    });
  } else if (cal.tilePath) {
    app.baseTiles = L.tileLayer(cal.tilePath, { tileSize: cal.tileSize ?? 256, bounds, maxNativeZoom: cal.maxZoom, maxZoom: 8 }).addTo(lm);
  }

  // Floors
  const floors = cal.layers ?? [];
  $("#floor-select").hidden = floors.length === 0;
  $("#floor-select").innerHTML = `<option value="auto">Auto floor</option><option value="">Ground level</option>` +
    floors.map((f, i) => `<option value="${i}">${esc(f.name)}</option>`).join("");
  $("#floor-select").value = app.floorMode === "auto" ? "auto" : "";
  app.floor = "";
  autoFloor();

  // Overlay groups + toggle control
  const L_ = (on) => { const g = L.layerGroup(); if (on) g.addTo(lm); return g; };
  app.layers = {
    labels: L_(true), extracts: L_(true), transits: L_(true), bosses: L_(true), hazards: L_(true),
    quests: L_(true), spawns: L_(false), locks: L_(false), switches: L_(false), btr: L_(false),
    pings: L_(true), players: L_(true),
  };
  L.control.layers(null, {
    "Extracts": app.layers.extracts,
    "Transits": app.layers.transits,
    "Bosses": app.layers.bosses,
    "Danger zones": app.layers.hazards,
    "Quest objectives": app.layers.quests,
    "PMC spawns": app.layers.spawns,
    "Locked doors": app.layers.locks,
    "Switches / levers": app.layers.switches,
    "BTR stops": app.layers.btr,
    "Place names": app.layers.labels,
  }, { collapsed: true, position: "topright" }).addTo(lm);

  lm.on("contextmenu", (e) => openPingMenu(e.latlng));

  drawStatic(map, cal);
  drawExtracts();
  drawQuests();
  drawPlayers(true);
  drawPings();
  renderActiveTab();
  updateTimer();
}

// Which floor a game position is on, using tarkov.dev's floor extents: a height range,
// optionally limited to areas given as [[x1, z1], [x2, z2]] corners. "" = ground level.
function floorAt(cal, p) {
  for (const [i, layer] of (cal?.layers ?? []).entries()) {
    for (const ext of layer.extents ?? []) {
      if (!(p.y >= ext.height[0] && p.y < ext.height[1])) continue;
      if (!ext.bounds) return String(i);
      const inside = ext.bounds.some(([[x1, z1], [x2, z2]]) =>
        p.x >= Math.min(x1, x2) && p.x <= Math.max(x1, x2) && p.z >= Math.min(z1, z2) && p.z <= Math.max(z1, z2));
      if (inside) return String(i);
    }
  }
  return "";
}

// In auto mode, show the floor my last screenshot was taken on.
function autoFloor() {
  if (app.floorMode !== "auto") return;
  const p = me()?.pos;
  const map = currentMap();
  if (!p || !map || p.map !== map.nameId || p.source !== "screenshot") return;
  const floor = floorAt(calibrationFor(map), p);
  if (floor !== app.floor) setFloor(floor);
}

function setFloor(value) {
  app.floor = value;
  const cal = calibrationFor(currentMap());
  const floor = value === "" ? null : cal.layers[Number(value)];
  if (app.svgRoot) {
    for (const g of app.svgRoot.children) {
      if (g.nodeName !== "g" || !g.id) continue;
      const isBase = g.id === cal.svgLayer || g.dataset.keepWithGroup === cal.svgLayer;
      g.classList.toggle("hidden-layer", !isBase && g.id !== floor?.svgLayer);
      g.classList.toggle("off-level", isBase && !!floor);
    }
  }
  if (app.floorTiles) { app.floorTiles.remove(); app.floorTiles = null; }
  if (floor?.tilePath) {
    app.floorTiles = L.tileLayer(floor.tilePath, { tileSize: cal.tileSize ?? 256, bounds: toBounds(cal.bounds), maxNativeZoom: cal.maxZoom, maxZoom: 8 }).addTo(app.leaflet);
  }
}

// ---------- markers ----------

function pinIcon({ color, label, cls = "", title = "" }) {
  return L.divIcon({
    className: "",
    iconSize: [0, 0],
    html: `<div class="mk ${cls}" style="color:${color}" title="${esc(title)}"><div class="mk-pin" style="background:${color}"></div>${label ? `<div class="mk-label">${esc(label)}</div>` : ""}</div>`,
  });
}
function outline(points, color, group, opts = {}) {
  if (!points?.length) return;
  L.polygon(points.map(pos), { color, weight: 1.5, fillOpacity: 0.15, interactive: false, ...opts }).addTo(group);
}

function drawStatic(map, cal) {
  const { labels, transits, bosses, hazards, spawns, locks, switches, btr } = app.layers;

  for (const label of cal.labels ?? []) {
    L.marker(pos({ x: label.position[0], z: label.position[1] }), {
      interactive: false, zIndexOffset: -1000,
      icon: L.divIcon({ className: "map-area-label", iconSize: [0, 0],
        html: `<div class="label" style="font-size:${label.size ?? 100}%;transform:translate(-50%,-50%) rotate(${label.rotation ?? 0}deg)">${esc(label.text)}</div>` }),
    }).addTo(labels);
  }

  for (const t of map.transits ?? []) {
    if (!t.position) continue;
    outline(t.outline, "#b48cff", transits);
    L.marker(pos(t.position), { icon: pinIcon({ color: "var(--transit)", label: `→ ${t.map?.name ?? "Transit"}` }) })
      .bindPopup(`<h4>Transit to ${esc(t.map?.name)}</h4><div>${esc(t.description)}</div>${t.conditions ? `<div class="muted">${esc(t.conditions)}</div>` : ""}`)
      .addTo(transits);
  }

  for (const z of map.hazards ?? []) {
    if (!z.position) continue;
    outline(z.outline, "#ff9b3d", hazards, { dashArray: "4 4" });
    L.marker(pos(z.position), { icon: pinIcon({ color: "var(--hazard)", label: HAZARD_LABEL[z.hazardType] ?? z.name ?? z.hazardType }) })
      .bindPopup(`<h4>${esc(HAZARD_LABEL[z.hazardType] ?? z.hazardType)}</h4><div class="muted">${esc(z.name)}</div>`)
      .addTo(hazards);
  }

  for (const b of map.bosses ?? []) {
    for (const loc of b.spawnLocations ?? []) {
      for (const p of bossPoints(map, loc)) {
        L.marker(pos(p), { icon: pinIcon({ color: "var(--boss)", cls: "mk-boss", label: `${b.boss.name} ${Math.round(b.spawnChance * 100)}%` }) })
          .bindPopup(bossPopup(b, loc))
          .addTo(bosses);
      }
    }
  }

  for (const s of map.spawns ?? []) {
    if (!s.categories?.includes("player") || !(s.sides?.includes("pmc") || s.sides?.includes("all"))) continue;
    L.circleMarker(pos(s.position), { radius: 4, color: "#9aa0a6", weight: 1, fillOpacity: 0.6 }).bindTooltip("PMC spawn").addTo(spawns);
  }

  for (const l of map.locks ?? []) {
    if (!l.position || !l.key) continue;
    L.circleMarker(pos(l.position), { radius: 4, color: "#e4e1d8", weight: 1, fillColor: "#8d9198", fillOpacity: 0.8 })
      .bindPopup(`<h4>${esc(l.key.name)}</h4><div class="muted">${esc(l.lockType ?? "Lock")}${l.needsPower ? " · needs power" : ""}</div>`)
      .addTo(locks);
  }

  for (const s of map.switches ?? []) {
    if (!s.position) continue;
    L.circleMarker(pos(s.position), { radius: 5, color: "#4cc9f0", weight: 2, fillOpacity: 0.3 })
      .bindPopup(`<h4>${esc(s.name)}</h4><div class="muted">${esc(s.switchType ?? "Switch")}</div>`)
      .addTo(switches);
  }

  for (const s of map.btrStops ?? []) {
    L.marker(pos(s), { icon: pinIcon({ color: "#9aa0a6", label: `BTR: ${s.name}` }) }).addTo(btr);
  }
}

// A boss spawn location's points: given directly by the JSON API, or (GraphQL data) the map's
// "boss" spawn points whose zone matches the location's spawnKey.
function bossPoints(map, loc) {
  if (loc.positions?.length) return loc.positions;
  return (map.spawns ?? []).filter((s) => s.zoneName === loc.spawnKey && s.categories?.includes("boss")).map((s) => s.position);
}

function bossPopup(b, loc) {
  const escorts = (b.escorts ?? []).map((e) => {
    const n = e.amount?.length ? Math.max(...e.amount.map((a) => a.count)) : 0;
    return `${esc(e.boss?.name)}${n ? ` ×${n}` : ""}`;
  }).join(", ");
  return `<h4>${esc(b.boss.name)}</h4>
    <div><span class="pct">${Math.round(b.spawnChance * 100)}%</span> chance to spawn this raid</div>
    ${loc ? `<div class="muted">${esc(loc.name)} — ${Math.round(loc.chance * 100)}% of spawns</div>` : ""}
    ${escorts ? `<div class="muted">Escorts: ${escorts}</div>` : ""}
    ${b.spawnTrigger ? `<div class="muted">Trigger: ${esc(b.spawnTrigger)}</div>` : ""}`;
}

// ---------- extracts ----------

function extractsForFaction(map) {
  const f = myFaction();
  return (map?.extracts ?? []).filter((e) => e.faction === f || e.faction === "shared");
}
function chosenExtracts() {
  return new Set(app.server?.extracts?.[currentMap()?.nameId] ?? []);
}
function extractRequirements(e) {
  const req = [];
  if (e.transferItem) req.push(`Pay ${e.transferItem.count.toLocaleString()} ${e.transferItem.item.shortName ?? e.transferItem.item.name}`);
  for (const s of e.switches ?? []) req.push(`Needs: ${s.name}`);
  if (e.faction === "shared") req.push("PMC & Scav");
  return req;
}

function drawExtracts() {
  const map = currentMap();
  const group = app.layers.extracts;
  if (!map || !group) return;
  group.clearLayers();
  const chosen = chosenExtracts();
  for (const e of extractsForFaction(map)) {
    if (!e.position) continue;
    const isChosen = chosen.has(e.id);
    const color = FACTION_COLOR[e.faction] ?? "var(--shared)";
    outline(e.outline, e.faction === "scav" ? "#5aa9ff" : e.faction === "pmc" ? "#5fd38a" : "#e8c547", group);
    const cls = chosen.size ? (isChosen ? "chosen" : "faded") : "";
    const req = extractRequirements(e);
    L.marker(pos(e.position), { icon: pinIcon({ color, label: e.name, cls }), zIndexOffset: isChosen ? 500 : 0 })
      .bindPopup(() => {
        const div = document.createElement("div");
        div.innerHTML = `<h4>${esc(e.name)}</h4>${req.map((r) => `<div class="muted">${esc(r)}</div>`).join("")}
          <button class="btn" style="margin-top:8px">${isChosen ? "Unmark" : "We have this extract"}</button>`;
        div.querySelector("button").onclick = () => { toggleExtract(e.id); app.leaflet.closePopup(); };
        return div;
      })
      .addTo(group);
  }
}

function toggleExtract(id) {
  const map = currentMap();
  const chosen = chosenExtracts();
  chosen.has(id) ? chosen.delete(id) : chosen.add(id);
  send({ t: "extracts", map: map.nameId, ids: [...chosen] });
}

function renderExtractsTab() {
  const el = $("#tab-extracts");
  const map = currentMap();
  if (!map) { el.innerHTML = ""; return; }
  const chosen = chosenExtracts();
  const list = extractsForFaction(map);
  const order = { [myFaction()]: 0, shared: 1 };
  list.sort((a, b) => (order[a.faction] ?? 2) - (order[b.faction] ?? 2) || a.name.localeCompare(b.name));
  const transits = map.transits ?? [];
  el.innerHTML = `
    <div class="hint">In raid, double-tap <b>O</b> to see your extracts, then tick them here so the whole squad sees them.</div>
    <div class="section-title">${myFaction() === "scav" ? "Scav" : "PMC"} extracts · ${esc(map.name)}</div>
    ${list.map((e) => `
      <label class="row ${chosen.size && !chosen.has(e.id) ? "dim" : ""}" data-extract="${esc(e.id)}">
        <input type="checkbox" ${chosen.has(e.id) ? "checked" : ""} />
        <span class="dot" style="background:${FACTION_COLOR[e.faction]}"></span>
        <span class="main"><div class="title">${esc(e.name)}</div>
          <div class="sub">${extractRequirements(e).map((r) => `<span class="tag ${r.startsWith("Pay") || r.startsWith("Needs") ? "warn" : ""}">${esc(r)}</span>`).join("")}</div></span>
      </label>`).join("") || `<div class="muted">No extract data for this map.</div>`}
    ${transits.length ? `<div class="section-title">Transits</div>` + transits.map((t, i) => `
      <div class="row" data-transit="${i}"><span class="dot" style="background:var(--transit)"></span>
        <span class="main"><div class="title">→ ${esc(t.map?.name)}</div><div class="sub">${esc(t.conditions || t.description || "")}</div></span></div>`).join("") : ""}
    ${map.wiki ? `<p class="muted" style="font-size:12px">Some extracts have extra requirements (keys, gear limits). Check the <a href="${esc(map.wiki)}" target="_blank" rel="noopener">wiki</a>.</p>` : ""}
  `;
  for (const row of el.querySelectorAll("[data-extract]")) {
    const ex = list.find((e) => e.id === row.dataset.extract);
    row.querySelector("input").onchange = () => toggleExtract(ex.id);
    row.querySelector(".main").onclick = (ev) => { ev.preventDefault(); flyTo(ex.position); };
  }
  for (const row of el.querySelectorAll("[data-transit]")) row.onclick = () => flyTo(transits[row.dataset.transit].position);
}

function flyTo(p, zoom) {
  if (!p || !app.leaflet) return;
  app.leaflet.flyTo(pos(p), Math.max(app.leaflet.getZoom(), zoom ?? 3), { duration: 0.6 });
  if (window.innerWidth <= 760) { $("#panel").classList.add("collapsed"); setTimeout(() => app.leaflet.invalidateSize(), 50); }
}

// ---------- bosses tab ----------

function renderBossesTab() {
  const el = $("#tab-bosses");
  const map = currentMap();
  if (!map) { el.innerHTML = ""; return; }
  const bosses = [...(map.bosses ?? [])].sort((a, b) => b.spawnChance - a.spawnChance);
  const hazards = map.hazards ?? [];
  el.innerHTML = `
    <div class="section-title">Bosses & special spawns · ${esc(map.name)}</div>
    ${bosses.map((b, i) => `
      <div class="row" data-boss="${i}">
        <span class="dot" style="background:var(--boss);border-radius:2px"></span>
        <span class="main"><div class="title">${esc(b.boss.name)} <span class="pct" style="float:right">${Math.round(b.spawnChance * 100)}%</span></div>
          <div class="sub">${(b.spawnLocations ?? []).map((l) => `${esc(l.name)} ${Math.round(l.chance * 100)}%`).join(" · ") || "Location varies"}</div>
          ${b.spawnTrigger ? `<div class="sub">Trigger: ${esc(b.spawnTrigger)}</div>` : ""}</span>
      </div>`).join("") || `<div class="muted">No bosses on this map.</div>`}
    ${hazards.length ? `<div class="section-title">Danger zones</div>` + hazards.map((h, i) => `
      <div class="row" data-hazard="${i}"><span class="dot" style="background:var(--hazard)"></span>
        <span class="main"><div class="title">${esc(HAZARD_LABEL[h.hazardType] ?? h.hazardType)}</div><div class="sub">${esc(h.name ?? "")}</div></span></div>`).join("") : ""}
    <p class="muted" style="font-size:12px">Spawn chances are tarkov.dev's current PvP values. ${map.players ? `Players: ${esc(map.players)}.` : ""}</p>
  `;
  for (const row of el.querySelectorAll("[data-boss]")) {
    row.onclick = () => {
      const b = bosses[row.dataset.boss];
      const p = (b.spawnLocations ?? []).flatMap((l) => bossPoints(map, l))[0];
      if (p) flyTo(p);
    };
  }
  for (const row of el.querySelectorAll("[data-hazard]")) row.onclick = () => flyTo(hazards[row.dataset.hazard].position);
}

// ---------- quests ----------

function objectiveOnMap(o, mapId) {
  return o.maps?.some((m) => m.id === mapId)
    || o.zones?.some((z) => z.map?.id === mapId)
    || o.possibleLocations?.some((l) => l.map?.id === mapId);
}
function taskOnMap(t, mapId) {
  return t.map?.id === mapId || t.objectives.some((o) => objectiveOnMap(o, mapId));
}

function renderQuestsTab() {
  const el = $("#tab-quests");
  if (app.tab !== "quests") return;
  const map = currentMap();
  if (!app.tasks.length) { el.innerHTML = `<div class="muted">Loading quests…</div>`; return; }
  const mine = new Set(me()?.quests ?? []);
  const q = app.questFilter.toLowerCase();
  let list = app.tasks.filter((t) => (!q || t.name.toLowerCase().includes(q) || t.trader?.name.toLowerCase().includes(q)));
  if (app.questThisMapOnly && map) list = list.filter((t) => mine.has(t.id) || taskOnMap(t, map.id));
  list.sort((a, b) => (mine.has(b.id) - mine.has(a.id)) || a.trader.name.localeCompare(b.trader.name) || a.name.localeCompare(b.name));

  // Squadmates' quests (read-only) so you can help each other.
  const others = Object.entries(app.server?.players ?? {}).filter(([k, p]) => k !== app.name.toLowerCase() && p.quests?.length);

  const prevScroll = el.scrollTop;
  const hadFocus = document.activeElement?.id === "quest-search";
  el.innerHTML = `
    <div class="hint">${me()?.questsAuto
      ? "Your quests are <b>ticked automatically</b> from the game: accepted ones appear, finished ones drop off. You can still tick extras by hand."
      : "Tick your active quests, or let the Tarkov Timmy app detect them from the game. Their objectives show on the map for the whole squad."}</div>
    <input id="quest-search" class="search" placeholder="Search quests or traders" value="${esc(app.questFilter)}" />
    <label class="row" style="padding:2px 6px"><input type="checkbox" id="quest-mapfilter" ${app.questThisMapOnly ? "checked" : ""}/><span class="sub">Only quests with objectives on ${esc(map?.name ?? "this map")}</span></label>
    ${others.map(([k, p]) => {
      const names = p.quests.map((id) => app.tasks.find((t) => t.id === id)).filter(Boolean).filter((t) => !map || taskOnMap(t, map.id));
      return names.length ? `<div class="section-title" style="color:${playerColor(k)}">${esc(p.name)}'s quests here</div>` +
        names.map((t) => `<div class="row"><span class="dot" style="background:${playerColor(k)}"></span><span class="main"><div class="title">${esc(t.name)}</div><div class="sub">${esc(t.trader.name)}</div></span></div>`).join("") : "";
    }).join("")}
    <div class="section-title">Quests</div>
    ${list.slice(0, 150).map((t) => `
      <label class="row" data-task="${esc(t.id)}">
        <input type="checkbox" ${mine.has(t.id) ? "checked" : ""} />
        <span class="main"><div class="title">${esc(t.name)}</div>
          <div class="sub">${esc(t.trader.name)}${t.minPlayerLevel ? ` · lvl ${t.minPlayerLevel}` : ""}${t.kappaRequired ? ` · <span class="tag">Kappa</span>` : ""}
          ${t.wikiLink ? ` · <a href="${esc(t.wikiLink)}" target="_blank" rel="noopener">wiki</a>` : ""}</div>
          ${mine.has(t.id) && map ? `<div class="sub">${t.objectives.filter((o) => objectiveOnMap(o, map.id)).map((o) => `• ${esc(o.description)}`).join("<br>")}</div>` : ""}
        </span>
      </label>`).join("") || `<div class="muted">No matching quests.</div>`}
  `;
  el.scrollTop = prevScroll;
  const search = $("#quest-search");
  search.oninput = () => { app.questFilter = search.value; renderQuestsTab(); };
  if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  $("#quest-mapfilter").onchange = (e) => { app.questThisMapOnly = e.target.checked; renderQuestsTab(); };
  for (const row of el.querySelectorAll("[data-task]")) {
    row.querySelector("input").onchange = (e) => {
      const ids = new Set(me()?.quests ?? []);
      e.target.checked ? ids.add(row.dataset.task) : ids.delete(row.dataset.task);
      send({ t: "quests", name: app.name, ids: [...ids] });
    };
  }
}

function drawQuests() {
  const map = currentMap();
  const group = app.layers.quests;
  if (!map || !group) return;
  group.clearLayers();
  if (!app.tasks.length) return;
  for (const [key, player] of Object.entries(app.server?.players ?? {})) {
    const color = playerColor(key);
    for (const id of player.quests ?? []) {
      const task = app.tasks.find((t) => t.id === id);
      if (!task) continue;
      for (const o of task.objectives) {
        const label = `${task.name}`;
        const popup = `<h4>${esc(task.name)}</h4><div>${esc(o.description)}</div><div class="muted">${esc(player.name)} · ${esc(task.trader.name)}</div>`;
        for (const z of o.zones ?? []) {
          if (z.map?.id !== map.id || !z.position) continue;
          outline(z.outline, color, group, { dashArray: "2 4" });
          L.marker(pos(z.position), { icon: pinIcon({ color, cls: "mk-quest", label }) }).bindPopup(popup).addTo(group);
        }
        for (const loc of o.possibleLocations ?? []) {
          if (loc.map?.id !== map.id) continue;
          for (const p of loc.positions ?? []) {
            L.marker(pos(p), { icon: pinIcon({ color, cls: "mk-quest", label: o.questItem?.name ?? label }) }).bindPopup(popup).addTo(group);
          }
        }
      }
    }
  }
}

// ---------- players ----------

function playerIcon(color, yaw, label, stale) {
  const cal = calibrationFor(currentMap());
  let add = cal?.coordinateRotation ?? 0;
  if (add === 90 || add === 270) add += 180;
  const arrow = yaw === null || yaw === undefined
    ? `<circle cx="12" cy="12" r="7" fill="${color}" stroke="#000" stroke-width="2"/>`
    : `<path d="M12 2 L20 21 L12 16 L4 21 Z" fill="${color}" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>`;
  return L.divIcon({
    className: "", iconSize: [24, 24], iconAnchor: [12, 12],
    html: `<div class="mk mk-player ${stale ? "stale" : ""}"><svg width="24" height="24" viewBox="0 0 24 24" style="transform:rotate(${(yaw ?? 0) + add}deg)">${arrow}</svg><div class="mk-label">${esc(label)}</div></div>`,
  });
}

function drawPlayers(recenter) {
  const map = currentMap();
  const group = app.layers.players;
  if (!map || !group) return;
  group.clearLayers();
  for (const [key, p] of Object.entries(app.server?.players ?? {})) {
    if (!p.pos || p.pos.map !== map.nameId) continue;
    const age = serverNow() - p.pos.ts;
    const label = `${p.name} · ${ago(age)}`;
    L.marker(pos(p.pos), { icon: playerIcon(playerColor(key), p.pos.yaw, label, age > 5 * 60 * 1000), zIndexOffset: 2000 }).addTo(group);
    if (recenter && key === app.name.toLowerCase()) app.leaflet.setView(pos(p.pos), Math.max(app.leaflet.getZoom(), 2));
  }
}

// ---------- pings ----------

function openPingMenu(latlng) {
  const map = currentMap();
  const div = document.createElement("div");
  div.innerHTML = `<div class="ping-menu">${Object.entries(PING_KINDS).map(([k, v]) => `<button class="btn" data-kind="${k}" style="color:${v.color}">${v.icon} ${v.label}</button>`).join("")}
    <button class="btn" data-kind="me" style="grid-column:span 2">📍 I'm here</button></div>`;
  const popup = L.popup({ closeButton: false }).setLatLng(latlng).setContent(div).openOn(app.leaflet);
  for (const b of div.querySelectorAll("button")) {
    b.onclick = () => {
      const msg = { map: map.nameId, x: latlng.lng, z: latlng.lat, name: app.name };
      if (b.dataset.kind === "me") send({ t: "manualpos", ...msg });
      else send({ t: "ping", kind: b.dataset.kind, ...msg });
      app.leaflet.closePopup(popup);
    };
  }
}

function drawPings() {
  const map = currentMap();
  const group = app.layers.pings;
  if (!map || !group) return;
  group.clearLayers();
  for (const p of app.server?.pings ?? []) {
    if (p.map !== map.nameId) continue;
    const k = PING_KINDS[p.kind];
    L.marker([p.z, p.x], {
      zIndexOffset: 1500,
      icon: L.divIcon({ className: "", iconSize: [0, 0],
        html: `<div class="mk mk-ping" style="color:${k.color}"><div class="ring"></div><div class="ico">${k.icon}</div><div class="mk-label" style="left:34px;top:6px">${esc(k.label)} · ${esc(p.by)}</div></div>` }),
    }).on("click", () => send({ t: "unping", id: p.id })).addTo(group);
  }
}

// ---------- squad tab ----------

function renderSquadTab() {
  const el = $("#tab-squad");
  const players = Object.entries(app.server?.players ?? {});
  const link = `${location.origin}/r/${app.room}`;
  el.innerHTML = `
    <div class="section-title">Squad</div>
    ${players.map(([k, p]) => {
      const companion = p.companionSeen && serverNow() - p.companionSeen < 3 * 60 * 1000;
      const mapName = app.maps.find((m) => m.nameId === (p.raid?.map ?? p.pos?.map))?.name;
      const raid = p.raid && p.raid.state !== "ended" ? `${p.raid.state === "started" ? "In raid" : "Loading"}${mapName ? ` · ${esc(mapName)}` : ""}` : "In menus";
      return `<div class="row" data-player="${esc(k)}"><span class="dot" style="background:${playerColor(k)}"></span>
        <span class="main"><div class="title">${esc(p.name)}${k === app.name.toLowerCase() ? " (you)" : ""} <span class="tag">${p.faction === "scav" ? "Scav" : "PMC"}</span></div>
          <div class="sub">${raid}</div>
          <div class="sub">${p.pos ? `Position ${ago(serverNow() - p.pos.ts)} (${p.pos.source})` : "No position yet"} · ${companion ? "Timmy app connected" : "Timmy app offline"}</div></span></div>`;
    }).join("") || `<div class="muted">Nobody here yet.</div>`}
    <div class="section-title">Invite your squad</div>
    <span class="code">${esc(link)}</span>
    ${desktop ? desktopStatusHtml() : `
      <div class="section-title">Live position</div>
      <div class="hint">Get the <b>Tarkov Timmy</b> Windows app on your gaming PC. It shares your position automatically, switches maps for you and adds an overlay over the game.
        In raid, press your <b>screenshot key</b> (Print Screen by default) and your marker updates.</div>
      <a class="btn primary" href="/api/download" target="_blank" rel="noopener">Download for Windows</a>
      <a class="btn" href="tarkovtimmy://join/${esc(app.room)}?server=${encodeURIComponent(location.origin)}">Open this room in the app</a>`}
    <div style="margin-top:10px"><button class="btn" id="rename">${desktop ? "App settings" : "Change callsign"}</button></div>
  `;
  for (const row of el.querySelectorAll("[data-player]")) {
    row.onclick = () => {
      const p = app.server.players[row.dataset.player];
      if (!p?.pos) return;
      const target = app.maps.find((m) => m.nameId === p.pos.map);
      if (target && target.id !== app.mapId) { app.followMe = false; selectMap(target.id); }
      flyTo(p.pos, 4);
    };
  }
  $("#rename").onclick = desktop ? () => desktop.openSettings() : askName;
}

function desktopStatusHtml() {
  const s = app.local;
  if (!s) return "";
  const line = (ok, text) => `<div class="sub"><span class="dot" style="display:inline-block;margin:0 6px 0 0;width:8px;height:8px;background:${ok ? "var(--pmc)" : ok === false ? "var(--boss)" : "var(--muted)"}"></span>${text}</div>`;
  return `
    <div class="section-title">This PC</div>
    ${line(s.game, s.game ? (s.raid === "started" ? "In raid" : "Tarkov is running") : "Tarkov isn't running")}
    ${line(!!s.logsDir, s.logsDir ? "Auto map switching on" : "Tarkov logs not found (set in App settings)")}
    ${line(s.server === "ok" ? true : s.server === "idle" ? null : false, s.server === "ok" ? "Sharing your position" : esc(s.lastError || "Not connected yet"))}
    ${s.lastPosition ? line(true, `Last screenshot position ${ago(Date.now() - s.lastPosition.at)}`) : line(null, "Press your screenshot key in raid to share your position")}
    <div style="margin-top:8px"><button class="btn" onclick="window.timmyDesktop.toggleOverlay()">Toggle overlay</button></div>`;
}

boot();
