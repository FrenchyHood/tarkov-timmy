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
const FOLLOW_KEY = OVERLAY ? "follow:overlay" : "follow:main";
// Map layers and whether they start switched on (the user's choices override these).
const LAYER_DEFAULTS = {
  labels: true, extracts: true, transits: true, bosses: true, hazards: true, quests: true, route: true,
  spawns: false, locks: false, switches: false, btr: false, loot: false,
};

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
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
  follow: store.get(FOLLOW_KEY, true),
  layerOn: { ...LAYER_DEFAULTS, ...store.get("layers", {}) },
  hiddenQuestPlayers: new Set(store.get("hiddenQuestPlayers", [])),
  route: { on: true, squad: true, stops: 6, minValue: 3, ...store.get("route", {}) },
  trail: [],             // my positions this raid (for skipping route stops I've already visited)
  local: null,           // desktop companion status
  seenPings: null,
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
    if (id?.version) {
      $("#app-version").textContent = `v${id.version}`;
      $("#app-version").hidden = false;
    }
    desktop.onStatus((s) => { app.local = s; if (app.tab === "squad") renderSquadTab(); });
    desktop.status().then((s) => (app.local = s));
    desktop.onOverlay((s) => document.body.classList.toggle("click-through", s.clickThrough));
    if (desktop.lastScan && !OVERLAY) {
      desktop.lastScan().then((r) => { if (r) stash.scan = r; });
      // A new scan opens the scanned-stash view so the results are right there.
      desktop.onStashScan((r) => { stash.scan = r; stash.selected = null; openStash("scan"); });
      desktop.onStashScanning((busy) => {
        stash.scanning = busy;
        const b = $("#scan-latest");
        if (b) b.textContent = busy ? "Scanning…" : "Scan my latest screenshot";
      });
    }
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
  alertNewPings();
  autoFloor();
  trackTrail();
  drawRoute();
  followMe();
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

// ---------- follow me ----------
// While following, the map keeps my pin centred at whatever zoom I picked (also after a refresh).
// Panning by hand or jumping to something from the side panel pauses it; the ◎ button resumes.

function myPosHere() {
  const p = me()?.pos;
  return p && p.map === currentMap()?.nameId ? p : null;
}

function followMe(force) {
  if (!app.follow || !app.leaflet) return;
  const p = myPosHere();
  if (!p || (!force && p.ts === app.lastFollowTs)) return;
  app.lastFollowTs = p.ts;
  app.leaflet.setView(pos(p), app.leaflet.getZoom(), { animate: !force });
}

function setFollow(on) {
  app.follow = on;
  store.set(FOLLOW_KEY, on);
  app.followBtn?.classList.toggle("on", on);
  if (on) followMe(true);
}

const FollowControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const bar = L.DomUtil.create("div", "leaflet-bar follow-control");
    const a = L.DomUtil.create("a", app.follow ? "on" : "", bar);
    a.href = "#";
    a.title = "Follow me: keep my pin centred";
    a.innerHTML = "◎";
    L.DomEvent.on(a, "click", (e) => { L.DomEvent.stop(e); setFollow(!app.follow); });
    L.DomEvent.disableClickPropagation(bar);
    app.followBtn = a;
    return bar;
  },
});

// ---------- main window ⇄ overlay sync ----------
// Both windows share localStorage, and the browser fires "storage" in the *other* window when one changes
// it. So map, floor, layers, route options and hidden quest players stay identical in both, instantly.
// Zoom and Follow stay per window (the overlay is much smaller).

function applyFloorChoice(value) {
  app.floorMode = value === "auto" ? "auto" : "manual";
  $("#floor-select").value = value;
  if (app.floorMode === "auto") autoFloor();
  else setFloor(value);
}

function onSharedSettingChanged(e) {
  const val = (() => { try { return JSON.parse(e.newValue); } catch { return null; } })();
  if (val === null) return;
  switch (e.key) {
    case "layers":
      app.layerOn = { ...LAYER_DEFAULTS, ...val };
      app.applyingView = true; // don't echo these back
      for (const [key, on] of Object.entries(app.layerOn)) {
        const g = app.layers[key];
        if (!g || !app.leaflet) continue;
        if (on && !app.leaflet.hasLayer(g)) g.addTo(app.leaflet);
        if (!on && app.leaflet.hasLayer(g)) g.remove();
      }
      app.applyingView = false;
      break;
    case "mapNameId": {
      const target = app.maps.find((m) => m.nameId === val);
      if (target && target.id !== app.mapId) selectMap(target.id);
      break;
    }
    case "floorChoice":
      applyFloorChoice(val.value);
      break;
    case "route":
      app.route = { ...app.route, ...val };
      drawRoute();
      break;
    case "hiddenQuestPlayers":
      app.hiddenQuestPlayers = new Set(val);
      drawQuests();
      drawRoute();
      if (app.tab === "quests") renderQuestsTab();
      break;
  }
}

// ---------- UI wiring ----------

function wireUi() {
  $("#map-select").onchange = (e) => { app.followMe = false; selectMap(e.target.value); };
  $("#floor-select").onchange = (e) => {
    applyFloorChoice(e.target.value);
    store.set("floorChoice", { value: e.target.value, at: Date.now() }); // mirrored to the other window
  };
  window.addEventListener("storage", onSharedSettingChanged);
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
  $("#stash-btn").onclick = () => openStash();
  $("#stash-close").onclick = () => { $("#stash").hidden = true; app.leaflet?.invalidateSize(); };
  for (const b of document.querySelectorAll("#stash-tabs button")) b.onclick = () => openStash(b.dataset.stab);
  if (OVERLAY && desktop?.resizeOverlay) {
    // Corner grip: resize the overlay window by dragging (edges work too).
    const grip = $("#ov-grip");
    grip.onpointerdown = (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = { x: e.screenX, y: e.screenY, w: window.outerWidth, h: window.outerHeight };
      grip.onpointermove = (m) => desktop.resizeOverlay(start.w + m.screenX - start.x, start.h + m.screenY - start.y);
      grip.onpointerup = () => {
        grip.onpointermove = grip.onpointerup = null;
        desktop.resizeOverlayDone();
        app.leaflet?.invalidateSize();
        followMe(true);
      };
    };
    window.addEventListener("resize", () => app.leaflet?.invalidateSize());
  }
  if (OVERLAY && desktop) {
    desktop.identity().then((id) => {
      if (id?.hotkeys) $("#ov-hint").textContent = `${id.hotkeys.overlay} hide · ${id.hotkeys.clickThrough} click-through`;
    });
  }
  setInterval(() => { if (app.tab === "squad") renderSquadTab(); drawPlayers(); }, 1000);
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
  for (const t of ["extracts", "bosses", "quests", "route", "squad"]) $(`#tab-${t}`).hidden = t !== tab;
  renderActiveTab();
}

function renderActiveTab() {
  ({ extracts: renderExtractsTab, bosses: renderBossesTab, quests: renderQuestsTab, route: renderRouteTab, squad: renderSquadTab })[app.tab]?.();
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
  // Come back to my pin at my last zoom for this map (so a refresh lands where I was looking).
  const zoomKey = `zoom:${OVERLAY ? "overlay" : "main"}:${map.nameId}`;
  const savedZoom = store.get(zoomKey, null);
  const here = myPosHere();
  if (app.follow && here) lm.setView(pos(here), savedZoom ?? Math.max(lm.getZoom(), 3), { animate: false });
  app.lastFollowTs = here?.ts;
  lm.on("zoomend", () => store.set(zoomKey, lm.getZoom()));
  lm.on("dragstart", () => app.follow && setFollow(false));
  new FollowControl().addTo(lm);

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

  // Overlay groups + toggle control. Which ones are on is remembered and shared with the other window.
  app.layers = {};
  for (const key of Object.keys(LAYER_DEFAULTS)) {
    app.layers[key] = L.layerGroup();
    if (app.layerOn[key]) app.layers[key].addTo(lm);
  }
  app.layers.pings = L.layerGroup().addTo(lm);
  app.layers.players = L.layerGroup().addTo(lm);
  lm.on("overlayadd overlayremove", (e) => {
    if (app.applyingView) return;
    const key = Object.keys(app.layers).find((k) => app.layers[k] === e.layer);
    if (!key) return;
    app.layerOn[key] = e.type === "overlayadd";
    store.set("layers", app.layerOn);
  });
  L.control.layers(null, {
    "Extracts": app.layers.extracts,
    "Transits": app.layers.transits,
    "Bosses": app.layers.bosses,
    "Danger zones": app.layers.hazards,
    "Quest objectives": app.layers.quests,
    "Suggested route": app.layers.route,
    "Loot containers": app.layers.loot,
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
  drawPlayers();
  drawPings();
  drawRoute();
  renderActiveTab();
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

  // Danger zones come in many small pieces: draw every outline, but label each group of nearby
  // same-type pieces once (e.g. Lighthouse: 116 pieces → 13 labels).
  for (const group of clusterBy((map.hazards ?? []).filter((z) => z.position), (z) => z.position, 80, (z) => z.hazardType)) {
    for (const z of group) outline(z.outline, "#ff9b3d", hazards, { dashArray: "4 4" });
    const type = HAZARD_LABEL[group[0].hazardType] ?? group[0].hazardType;
    L.marker(pos(centroid(group.map((z) => z.position))), { icon: pinIcon({ color: "var(--hazard)", label: type }) })
      .bindPopup(`<h4>${esc(type)}</h4><div class="muted">${group.length > 1 ? `${group.length} areas close together` : esc(group[0].name ?? "")}</div>`)
      .addTo(hazards);
  }

  // Bosses: one marker per spawn area listing everyone who can spawn there, instead of one per boss per
  // spawn point (The Lab: 168 stacked markers → 37).
  for (const spot of bossSpots(map)) {
    const top = spot.entries[0];
    const label = `${top.b.boss.name} ${Math.round(top.b.spawnChance * 100)}%${spot.entries.length > 1 ? ` +${spot.entries.length - 1}` : ""}`;
    L.marker(pos(spot.at), { icon: pinIcon({ color: "var(--boss)", cls: "mk-boss", label }) })
      .bindPopup(spot.entries.map(({ b, loc }) => bossPopup(b, loc)).join('<hr class="pop-sep">'))
      .addTo(bosses);
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

  for (const l of map.loot ?? []) {
    if (l.value < 2) continue;
    L.circleMarker(pos(l.position), { radius: 2 + l.value, color: "#0d0f12", weight: 1, fillColor: LOOT_COLOR[l.value], fillOpacity: 0.85 })
      .bindTooltip(`${l.name} ${"★".repeat(l.value)}`).addTo(app.layers.loot);
  }

  for (const s of map.btrStops ?? []) {
    L.marker(pos(s), { icon: pinIcon({ color: "#9aa0a6", label: `BTR: ${s.name}` }) }).addTo(btr);
  }
}

// Groups items (sharing `keyOf`, if given) that are within `radius` metres of each other. "chain" joins an
// item to a group if it's near ANY member, so pieces of one long zone merge; "center" only if it's near the
// group's centre, so groups stay compact and can't chain across a whole map.
function clusterBy(items, posOf, radius, keyOf = () => "", linkage = "chain") {
  const groups = [];
  const near = (g, it) => linkage === "center"
    ? dist(centroid(g.items.map(posOf)), posOf(it)) < radius
    : g.items.some((o) => dist(posOf(o), posOf(it)) < radius);
  for (const it of items) {
    const close = groups.filter((g) => g.key === keyOf(it) && near(g, it));
    const nearGroups = linkage === "center" ? close.slice(0, 1) : close;
    if (nearGroups.length) {
      const [first, ...rest] = nearGroups;
      first.items.push(it);
      for (const g of rest) { first.items.push(...g.items); groups.splice(groups.indexOf(g), 1); }
      continue;
    }
    groups.push({ key: keyOf(it), items: [it] });
  }
  return groups.map((g) => g.items);
}
const centroid = (ps) => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + (p.y ?? 0), 0) / ps.length, z: ps.reduce((s, p) => s + p.z, 0) / ps.length });

// Boss spawn spots: every boss spawn point on the map, clustered (within 30 m of a spot's centre) so bosses sharing an area get one
// marker. Entries are sorted by spawn chance and listed once per boss.
function bossSpots(map) {
  const points = [];
  for (const b of map.bosses ?? []) for (const loc of b.spawnLocations ?? []) for (const p of bossPoints(map, loc)) points.push({ b, loc, p });
  const spots = clusterBy(points, (x) => x.p, 30, () => "", "center").map((group) => {
    const seen = new Map();
    for (const x of group) if (!seen.has(x.b.boss.name)) seen.set(x.b.boss.name, x);
    const entries = [...seen.values()].sort((a, c) => c.b.spawnChance - a.b.spawnChance);
    return { at: centroid(group.map((x) => x.p)), entries };
  });
  // Neighbouring spots with exactly the same bosses (e.g. Customs' Fortress) read as one place.
  return clusterBy(spots, (s) => s.at, 50, (s) => s.entries.map((e) => e.b.boss.name).join("|"), "center")
    .map((g) => ({ at: centroid(g.map((s) => s.at)), entries: g[0].entries }));
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
  if (app.follow) setFollow(false); // looking somewhere else on purpose
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
  // Everyone with quest markers on this map, for the show/hide legend.
  const legend = Object.entries(app.server?.players ?? {}).filter(([k]) => questTargets(map, [k]).length);

  const prevScroll = el.scrollTop;
  const hadFocus = document.activeElement?.id === "quest-search";
  el.innerHTML = `
    <div class="hint">${me()?.questsAuto
      ? "Your quests are <b>ticked automatically</b> from the game: accepted ones appear, finished ones drop off. You can still tick extras by hand."
      : "Tick your active quests, or let the Tarkov Timmy app detect them from the game. Their objectives show on the map for the whole squad."}</div>
    ${legend.length ? `<div class="section-title">Showing on the map</div><div class="legend">${legend.map(([k, p]) => `
      <label class="chip" style="--c:${playerColor(k)}"><input type="checkbox" data-legend="${esc(k)}" ${app.hiddenQuestPlayers.has(k) ? "" : "checked"} />
        <span class="dot" style="background:${playerColor(k)}"></span>${esc(p.name)}${k === app.name.toLowerCase() ? " (you)" : ""}</label>`).join("")}</div>` : ""}
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
  for (const box of el.querySelectorAll("[data-legend]")) {
    box.onchange = () => {
      box.checked ? app.hiddenQuestPlayers.delete(box.dataset.legend) : app.hiddenQuestPlayers.add(box.dataset.legend);
      store.set("hiddenQuestPlayers", [...app.hiddenQuestPlayers]);
      drawQuests();
      drawRoute();
    };
  }
  for (const row of el.querySelectorAll("[data-task]")) {
    row.querySelector("input").onchange = (e) => {
      const ids = new Set(me()?.quests ?? []);
      e.target.checked ? ids.add(row.dataset.task) : ids.delete(row.dataset.task);
      send({ t: "quests", name: app.name, ids: [...ids] });
    };
  }
}

// Every quest objective on this map that has a location, for the given players.
// Each has one or more candidate points (quest items can spawn in several places).
function questTargets(map, playerKeys) {
  const out = [];
  if (!map || !app.tasks.length) return out;
  for (const key of playerKeys) {
    const player = app.server?.players?.[key];
    for (const id of player?.quests ?? []) {
      const task = app.tasks.find((t) => t.id === id);
      if (!task) continue;
      for (const o of task.objectives) {
        const zones = (o.zones ?? []).filter((z) => z.map?.id === map.id && z.position);
        const items = (o.possibleLocations ?? []).filter((l) => l.map?.id === map.id).flatMap((l) => l.positions ?? []);
        if (!zones.length && !items.length) continue;
        out.push({ key, player, task, objective: o, zones, points: [...zones.map((z) => z.position), ...items], itemName: items.length ? o.questItem?.name : null });
      }
    }
  }
  return out;
}

function drawQuests() {
  const map = currentMap();
  const group = app.layers.quests;
  if (!map || !group) return;
  group.clearLayers();
  const keys = Object.keys(app.server?.players ?? {}).filter((k) => !app.hiddenQuestPlayers.has(k));
  const targets = questTargets(map, keys);
  // With more than one person's quests showing, say whose each marker is.
  const named = new Set(targets.map((t) => t.key)).size > 1;
  // Squadmates often share an objective spot; give each spot one marker naming everyone it's for.
  const points = [];
  for (const t of targets) {
    for (const z of t.zones) outline(z.outline, playerColor(t.key), group, { dashArray: "2 4" });
    for (const p of t.points) points.push({ t, p });
  }
  for (const spot of clusterBy(points, (x) => x.p, 3, (x) => x.t.itemName ?? x.t.task.name)) {
    const first = spot[0].t;
    const people = [...new Map(spot.map((x) => [x.t.key, x.t.player])).values()];
    const label = `${named ? `${people.map((p) => p.name).join(" + ")}: ` : ""}${first.itemName ?? first.task.name}`;
    const popup = `<h4>${esc(first.task.name)}</h4>` + [...new Map(spot.map((x) => [`${x.t.key}|${x.t.objective.id}`, x.t])).values()]
      .map((t) => `<div>${esc(t.objective.description)}</div><div class="muted" style="color:${playerColor(t.key)}">${esc(t.player.name)} · ${esc(t.task.trader.name)}</div>`).join("");
    L.marker(pos(spot[0].p), { icon: pinIcon({ color: playerColor(first.key), cls: "mk-quest", label }) }).bindPopup(popup).addTo(group);
  }
}

// ---------- suggested route ----------
// Plans the order to visit things, not a walking path: there's no walkable-area data for Tarkov, so legs
// are straight lines. From my last position: squad quest objectives (nearest first, then 2-opt to remove
// backtracking), plus the loot containers worth the least detour, ending at the extract we ticked.

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const VISITED_M = 12;     // a stop counts as done once I've screenshotted within this many metres of it
const MAX_DETOUR_M = 150; // never add loot that costs more extra walking than this
const LOOT_COLOR = { 5: "#ffd166", 4: "#f4a259", 3: "#e4e1d8", 2: "#9aa0a6", 1: "#5c6168" };

// My positions this raid, so route stops I've already been to drop off.
function trackTrail() {
  const raid = me()?.raid;
  if (raid && raid.state !== app.lastRaidState && (raid.state === "matching" || raid.state === "loading")) app.trail = [];
  app.lastRaidState = raid?.state;
  const p = me()?.pos;
  if (p && p.source === "screenshot" && p.ts !== app.trail.at(-1)?.ts) app.trail.push({ x: p.x, z: p.z, map: p.map, ts: p.ts });
}
function visited(p, map) {
  return app.trail.some((t) => t.map === map.nameId && dist(t, p) < VISITED_M);
}

// Reverse stretches of the stop order while that shortens the trip (classic 2-opt).
function twoOpt(start, stops, end) {
  const at = (i) => (i < 0 ? start : i >= stops.length ? end : stops[i].at);
  const leg = (a, b) => (a && b ? dist(a, b) : 0);
  for (let pass = 0, improved = true; improved && pass < 50; pass++) {
    improved = false;
    for (let i = 0; i < stops.length - 1; i++) {
      for (let k = i + 1; k < stops.length; k++) {
        const [a, b, c, d] = [at(i - 1), at(i), at(k), at(k + 1)];
        if (leg(a, c) + leg(b, d) + 0.01 < leg(a, b) + leg(c, d)) {
          stops.splice(i, k - i + 1, ...stops.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
}

function computeRoute() {
  const map = currentMap();
  if (!map || !app.route.on) return null;
  const start = myPosHere();
  const keys = app.route.squad
    ? Object.keys(app.server?.players ?? {}).filter((k) => !app.hiddenQuestPlayers.has(k))
    : [app.name.toLowerCase()];
  const left = questTargets(map, keys)
    .map((t) => ({ ...t, points: t.points.filter((p) => !visited(p, map)) }))
    .filter((t) => t.points.length);
  if (!start && !left.length) return { start, stops: [], end: null, length: 0, map };

  // 1. Quest objectives, nearest first (using whichever candidate point is closest).
  const stops = [];
  let cur = start;
  while (left.length) {
    let best = null;
    left.forEach((o, i) => o.points.forEach((p) => {
      const d = cur ? dist(cur, p) : 0;
      if (!best || d < best.d) best = { i, p, d };
    }));
    const [o] = left.splice(best.i, 1);
    // Objectives at the same spot (often shared between squadmates' quests) become one stop.
    const same = stops.find((s) => dist(s.at, best.p) < 10);
    if (same) same.targets.push(o);
    else stops.push({ type: "quest", targets: [o], at: best.p });
    cur = best.p;
  }

  // 2. End at the ticked extract closest to where the quests leave us.
  const chosen = chosenExtracts();
  const last = stops.at(-1)?.at ?? start;
  const end = (map.extracts ?? []).filter((e) => chosen.has(e.id) && e.position)
    .sort((a, b) => dist(last, a.position) - dist(last, b.position))[0] ?? null;
  twoOpt(start, stops, end?.position);

  // 3. Loot: repeatedly add the container with the best value per metre of detour.
  const candidates = (map.loot ?? []).filter((l) => l.value >= app.route.minValue && !visited(l.position, map));
  for (let n = 0; n < app.route.stops && candidates.length; n++) {
    const pts = [start, ...stops.map((s) => s.at), end?.position].filter(Boolean);
    let best = null;
    candidates.forEach((c, ci) => {
      let cost = Infinity, insertAt = pts.length;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = dist(pts[i], c.position) + dist(c.position, pts[i + 1]) - dist(pts[i], pts[i + 1]);
        if (d < cost) [cost, insertAt] = [d, i + 1];
      }
      if (!end && pts.length) {
        const d = dist(pts.at(-1), c.position); // or tack it on at the end
        if (d < cost) [cost, insertAt] = [d, pts.length];
      }
      if (cost > MAX_DETOUR_M) return;
      const score = c.value / (cost + 25);
      if (!best || score > best.score) best = { ci, insertAt, score };
    });
    if (!best) break;
    const [c] = candidates.splice(best.ci, 1);
    stops.splice(Math.min(best.insertAt - (start ? 1 : 0), stops.length), 0, { type: "loot", loot: c, at: c.position });
  }

  const pts = [start, ...stops.map((s) => s.at), end?.position].filter(Boolean);
  const length = pts.slice(1).reduce((sum, p, i) => sum + dist(pts[i], p), 0);
  return { start, stops, end, length, map };
}

// Labels for a route stop (a quest stop can cover several objectives at one spot).
const stopColor = (s) => (s.type === "quest" ? playerColor(s.targets[0].key) : LOOT_COLOR[s.loot.value]);
const stopTitle = (s) => (s.type === "quest" ? [...new Set(s.targets.map((t) => t.task.name))].join(" + ") : s.loot.name);
const stopDetails = (s) => (s.type === "quest"
  ? s.targets.map((t) => `${t.player.name}: ${t.objective.description}`)
  : [`Loot ${"★".repeat(s.loot.value)}`]);

function stepIcon(n, color) {
  return L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="mk-step" style="--c:${color}">${n}</div>` });
}

function drawRoute() {
  const group = app.layers.route;
  if (!group) return;
  group.clearLayers();
  const r = (app.lastRoute = computeRoute());
  if (app.tab === "route") renderRouteTab();
  if (!r || !r.stops.length && !r.end) return;
  const pts = [r.start, ...r.stops.map((s) => s.at), r.end?.position].filter(Boolean);
  L.polyline(pts.map(pos), { color: "#d6b25e", weight: 3, opacity: 0.85, dashArray: "8 7", interactive: false }).addTo(group);
  r.stops.forEach((s, i) => {
    L.marker(pos(s.at), { icon: stepIcon(i + 1, stopColor(s)), zIndexOffset: 1200 })
      .bindPopup(`<h4>${i + 1}. ${esc(stopTitle(s))}</h4>${stopDetails(s).map((d) => `<div class="muted">${esc(d)}</div>`).join("")}`).addTo(group);
  });
}

function renderRouteTab() {
  const el = $("#tab-route");
  const r = app.lastRoute;
  const o = app.route;
  const map = currentMap();
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? "selected" : ""}>${label}</option>`;
  const start = myPosHere();
  let prev = r?.start;
  el.innerHTML = `
    <div class="hint">The order to hit things, drawn as straight lines: it doesn't know about walls, water or fences, so pick your own way between stops.</div>
    <label class="row" style="padding:2px 6px"><input type="checkbox" id="route-on" ${o.on ? "checked" : ""}/><span class="main"><div class="title">Show suggested route</div></span></label>
    <label class="row" style="padding:2px 6px"><input type="checkbox" id="route-squad" ${o.squad ? "checked" : ""}/><span class="sub">Include my squad's quest objectives</span></label>
    <div class="route-opts">
      <label>Loot stops <select id="route-stops">${[0, 3, 6, 10].map((v) => opt(v, v === 0 ? "None" : v, o.stops)).join("")}</select></label>
      <label>Loot worth <select id="route-min">${opt(4, "Best only", o.minValue)}${opt(3, "Good+", o.minValue)}${opt(2, "Decent+", o.minValue)}${opt(1, "Anything", o.minValue)}</select></label>
    </div>
    ${!o.on || !map ? "" : `
      <div class="section-title">Plan · ${esc(map.name)}${r?.length ? ` · ~${Math.round(r.length)} m` : ""}</div>
      <div class="sub" style="margin:0 6px 6px">${start ? `Starting from your last screenshot (${ago(serverNow() - start.ts)}).` : "Press your screenshot key in raid so the route starts from where you are."}</div>
      ${(r?.stops ?? []).map((s, i) => {
        const d = prev ? Math.round(dist(prev, s.at)) : null;
        prev = s.at;
        return `<div class="row" data-step="${i}"><span class="mk-step static" style="--c:${stopColor(s)}">${i + 1}</span>
          <span class="main"><div class="title">${esc(stopTitle(s))}${d !== null ? ` <span class="pct" style="float:right">${d} m</span>` : ""}</div>
          ${stopDetails(s).map((x) => `<div class="sub">${esc(x)}</div>`).join("")}</span></div>`;
      }).join("") || `<div class="muted" style="margin:6px">${start ? "Nothing worth a detour nearby. Try more loot stops or a lower loot bar." : ""}</div>`}
      ${r?.end ? `<div class="row" data-end="1"><span class="mk-step static" style="--c:var(--pmc)">⇥</span><span class="main"><div class="title">Extract: ${esc(r.end.name)}</div>
        <div class="sub">${prev ? `${Math.round(dist(prev, r.end.position))} m` : ""}</div></span></div>`
        : `<div class="hint" style="margin-top:8px">Tick your extract in the <b>Extracts</b> tab and the route will end there.</div>`}
    `}
  `;
  const save = () => { store.set("route", app.route); drawRoute(); };
  $("#route-on").onchange = (e) => { o.on = e.target.checked; save(); };
  $("#route-squad").onchange = (e) => { o.squad = e.target.checked; save(); };
  $("#route-stops").onchange = (e) => { o.stops = Number(e.target.value); save(); };
  $("#route-min").onchange = (e) => { o.minValue = Number(e.target.value); save(); };
  for (const row of el.querySelectorAll("[data-step]")) row.onclick = () => flyTo(r.stops[row.dataset.step].at);
  el.querySelector("[data-end]")?.addEventListener("click", () => flyTo(r.end.position));
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

function drawPlayers() {
  const map = currentMap();
  const group = app.layers.players;
  if (!map || !group) return;
  group.clearLayers();
  for (const [key, p] of Object.entries(app.server?.players ?? {})) {
    if (!p.pos || p.pos.map !== map.nameId) continue;
    const age = serverNow() - p.pos.ts;
    const label = `${p.name} · ${ago(age)}`;
    L.marker(pos(p.pos), { icon: playerIcon(playerColor(key), p.pos.yaw, label, age > 5 * 60 * 1000), zIndexOffset: 2000 }).addTo(group);
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
          <div class="sub">${p.pos ? `Position ${ago(serverNow() - p.pos.ts)} (${p.pos.source})` : "No position yet"} · ${companion ? "Timmy app connected" : "Timmy app offline"}</div></span>
        ${k === app.name.toLowerCase() ? "" : `<button class="btn small remove-player" data-remove="${esc(k)}" title="Remove from the squad list">Remove</button>`}</div>`;
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
  for (const b of el.querySelectorAll("[data-remove]")) {
    b.onclick = (e) => {
      e.stopPropagation();
      const p = app.server.players[b.dataset.remove];
      if (p && confirm(`Remove ${p.name} from the squad list? If their Tarkov Timmy app is still running, they'll reappear.`)) send({ t: "remove", player: b.dataset.remove });
    };
  }
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

// ---------- stash helper ----------
// Nothing reads your stash (only memory reading could, and that's bannable), so you search items yourself.
// Verdicts combine what your squad's quests and your next hideout upgrades need with trader/flea prices.

const CURRENCY_IDS = new Set(["5449016a4bdc2d6f028b456f", "5696686a4bdc2da3298b456a", "569668774bdc2da2298b4568"]); // ₽ $ €
const VALUABLE_PER_SLOT = 40000;
// Tarkov has no public rarity stat; market price is the best stand-in (people pay more for what's hard to
// find). An item needed found-in-raid later is worth holding only if it's at least this valuable.
const RARE_PRICE = 40000;
const JUNK_PER_SLOT = 5000;
const stash = {
  data: null, loading: null, tab: desktop ? "scan" : "check", query: "", squad: store.get("stashSquad", true), hideout: store.get("hideoutLevels", {}),
  scan: null, scanning: false, selected: null, fixes: store.get("scanFixes", {}), // stash scanner (desktop app only)
  guns: store.get("mainGuns", []), gunGear: null, // "main guns": their ammo and attachments are kept, not sold
};

// Item id → names of my main guns it's ammo or an attachment for. Attachments are found by following
// "fits in this slot" links from each gun (gun → handguard → sight mount → sight ...).
function gunGear() {
  if (stash.gunGear) return stash.gunGear;
  const d = stash.data, gear = new Map();
  const add = (n, gunName) => {
    const id = d.items[n]?.id;
    if (id) gear.set(id, [...new Set([...(gear.get(id) ?? []), gunName])]);
  };
  for (const gunId of stash.guns) {
    const g = d.items.findIndex((i) => i.id === gunId);
    if (g < 0) continue;
    const gunName = d.items[g].short || d.items[g].name;
    const seen = new Set([g]), queue = [g];
    while (queue.length) for (const c of d.compat?.slots[queue.shift()] ?? []) if (!seen.has(c)) { seen.add(c); queue.push(c); add(c, gunName); }
    for (const n of d.compat?.ammo[g] ?? []) add(n, gunName);
  }
  return (stash.gunGear = gear);
}

function setGuns(ids) {
  stash.guns = ids;
  stash.gunGear = null;
  store.set("mainGuns", ids);
}

// "My guns" bar shown above the scan and the item checker.
function gunsBar() {
  const d = stash.data;
  const chips = stash.guns.map((id) => d.byId.get(id)).filter(Boolean)
    .map((g) => `<span class="gun-chip">${esc(g.short || g.name)}<button data-ungun="${esc(g.id)}" title="Remove">×</button></span>`).join("");
  return `<div class="guns-bar"><span class="sub">My main guns:</span>${chips || `<span class="sub">none yet</span>`}
    <input id="gun-search" class="search" placeholder="Add a gun (e.g. M4A1)…" autocomplete="off" spellcheck="false" />
    <div id="gun-results" class="gun-results"></div>
    <div class="sub gun-hint">Ammo and attachments that fit them get a purple <b>For your gun</b> tag and stay off the sell list.</div></div>`;
}
function wireGunsBar(rerender) {
  for (const b of document.querySelectorAll("[data-ungun]")) b.onclick = () => { setGuns(stash.guns.filter((g) => g !== b.dataset.ungun)); rerender(); };
  const input = $("#gun-search");
  if (!input) return;
  input.oninput = () => {
    const guns = searchItems(input.value).filter((i) => i.types?.includes("gun") && !stash.guns.includes(i.id)).slice(0, 6);
    $("#gun-results").innerHTML = guns.map((g) => `<button class="btn small" data-addgun="${esc(g.id)}">${esc(g.name)}</button>`).join("");
    for (const b of document.querySelectorAll("[data-addgun]")) b.onclick = () => { setGuns([...stash.guns, b.dataset.addgun]); rerender(); };
  };
}

const rub = (n) => (n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M ₽` : n >= 1e4 ? `${Math.round(n / 1e3)}k ₽` : `${Math.round(n).toLocaleString()} ₽`);

async function loadStashData() {
  if (stash.data) return stash.data;
  stash.loading ??= fetchData("items").then((d) => {
    d.byId = new Map(d.items.map((i) => [i.id, i]));
    return (stash.data = d);
  });
  return stash.loading;
}

// Quests that count as "active" for verdicts: mine, plus my squad's if that's switched on.
function stashActiveQuests() {
  const players = Object.entries(app.server?.players ?? {}).filter(([k]) => stash.squad || k === app.name.toLowerCase());
  const active = new Map(); // task id -> player names
  for (const [, p] of players) for (const id of p.quests ?? []) active.set(id, [...(active.get(id) ?? []), p.name]);
  return active;
}
const myEndedQuests = () => new Set(me()?.questsEnded ?? []);

function itemVerdict(item) {
  const d = stash.data;
  const active = stashActiveQuests();
  const ended = myEndedQuests();
  const keep = [], later = [];
  let laterNeedsFir = false; // a later need that only a found-in-raid copy can fill (can't just buy it then)
  for (const q of d.quests[item.id] ?? []) {
    const who = active.get(q.task);
    const what = q.key ? `key for ${q.taskName}` : `${q.taskName} needs ${q.count}${q.fir ? " found in raid" : ""}${q.alternatives > 1 ? " (one of several items)" : ""}`;
    if (who) keep.push(`${what} · ${who.join(", ")}`);
    else if (!ended.has(q.task)) { later.push(`${what}${q.kappa ? " · Kappa" : ""}`); laterNeedsFir ||= q.fir; }
  }
  for (const s of d.stations) {
    const cur = Number(stash.hideout[s.id] ?? 0);
    for (const l of s.levels) {
      if (l.level <= cur) continue;
      const r = l.items.find((x) => x.id === item.id);
      if (!r) continue;
      (l.level === cur + 1 ? keep : later).push(`Hideout: ${s.name} ${l.level} needs ${r.count}${r.fir ? " found in raid" : ""}`);
      if (l.level > cur + 1) laterNeedsFir ||= r.fir;
    }
  }
  const slots = item.w * item.h;
  const fleaOk = item.flea && !item.noFlea;
  const best = Math.max(item.trader?.price ?? 0, fleaOk ? item.flea : 0);
  const perSlot = best / slots;
  const forGuns = gunGear().get(item.id) ?? [];
  // "Needed later" only means hold it if you couldn't easily get another: a later found-in-raid need for
  // something valuable. Anything you can buy then (no FIR needed, or a trader sells it) or that's cheap and
  // common can be used or sold now.
  const market = (fleaOk ? item.flea : 0) || (item.trader ? item.trader.price * 2 : 0);
  const holdLater = !keep.length && later.length > 0 && laterNeedsFir && market >= RARE_PRICE;
  const replaceable = !keep.length && later.length > 0 && !holdLater;
  const replaceNote = !replaceable ? null
    : !laterNeedsFir ? (item.buyable ? "a trader sells it, buy one when you need it" : "found in raid isn't required, so you can buy one when you need it")
    : `common enough to find again (~${rub(market)})`;
  const tags = [];
  if (keep.length) tags.push(["keep", "Keep"]);
  if (forGuns.length) tags.push(["gun", `For your ${forGuns.join(", ")}`]);
  if (holdLater) tags.push(["later", "Hold: needed later, hard to replace"]);
  if (replaceable) tags.push(["replace", "Needed later, easy to replace"]);
  if (perSlot >= VALUABLE_PER_SLOT) tags.push(["valuable", "Valuable"]);
  if (!keep.length && !later.length && !forGuns.length && best && perSlot < JUNK_PER_SLOT) tags.push(["junk", "Low value"]);
  // Where to sell, if you're selling: flea only wins when it pays clearly more than the best trader.
  let sell = null;
  if (item.trader && fleaOk && item.flea > item.trader.price * 1.2) sell = `Flea ~${rub(item.flea)}${item.fleaLevel ? ` (from level ${item.fleaLevel})` : ""}, or ${item.trader.name} ${rub(item.trader.price)}`;
  else if (item.trader) sell = `${item.trader.name} ${rub(item.trader.price)}${fleaOk ? ` · flea ~${rub(item.flea)}` : ""}`;
  else if (fleaOk) sell = `Flea ~${rub(item.flea)}${item.fleaLevel ? ` (from level ${item.fleaLevel})` : ""}`;
  return { keep, later, forGuns, holdLater, replaceable, replaceNote, tags, sell, perSlot, slots };
}

function itemCard(item, extra = "") {
  const v = itemVerdict(item);
  const list = (arr, cls, max = 4) => arr.length
    ? `<ul class="why ${cls}">${arr.slice(0, max).map((x) => `<li>${esc(x)}</li>`).join("")}${arr.length > max ? `<li class="muted">+${arr.length - max} more</li>` : ""}</ul>` : "";
  return `<div class="item-card">
    ${item.icon ? `<img class="item-icon" src="${esc(item.icon)}" alt="" loading="lazy" />` : `<div class="item-icon"></div>`}
    <div class="item-main">
      <div class="item-title">${esc(item.name)} ${v.tags.map(([c, t]) => `<span class="verdict ${c}">${t}</span>`).join("")}${extra}</div>
      <div class="item-sub">${v.sell ? `Sell: ${esc(v.sell)}` : "No sell price"} · ${v.slots} slot${v.slots > 1 ? "s" : ""}${v.perSlot ? ` · ${rub(v.perSlot)}/slot` : ""}
        ${item.wiki ? ` · <a href="${esc(item.wiki)}" target="_blank" rel="noopener">wiki</a>` : ""}</div>
      ${list(v.keep, "keep")}${list(v.later, "later", 2)}${v.replaceNote ? `<div class="item-sub">Fine to use or sell now: ${esc(v.replaceNote)}.</div>` : ""}
    </div>
  </div>`;
}

function searchItems(q) {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const scored = [];
  for (const i of stash.data.items) {
    const n = i.name.toLowerCase(), sh = (i.short ?? "").toLowerCase();
    const score = sh === s ? 0 : n.startsWith(s) ? 1 : sh.startsWith(s) ? 2 : n.includes(s) ? 3 : sh.includes(s) ? 4 : -1;
    if (score >= 0) scored.push([score, n.length, i]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 30).map((x) => x[2]);
}

async function openStash(tab) {
  if (tab) stash.tab = tab;
  $("#stash").hidden = false;
  for (const b of document.querySelectorAll("#stash-tabs button")) b.classList.toggle("active", b.dataset.stab === stash.tab);
  const body = $("#stash-body");
  if (!stash.data) {
    // Let people start typing while the item data loads; their search runs once it arrives.
    body.innerHTML = stash.tab === "check"
      ? `<div class="stash-tools"><input id="stash-search" class="search" placeholder="Type an item name, e.g. bolts, gpu, salewa…" value="${esc(stash.query)}" autocomplete="off" spellcheck="false" /></div><div class="muted">Loading item data…</div>`
      : `<div class="muted">Loading item data…</div>`;
    const early = $("#stash-search");
    if (early) { early.focus(); early.oninput = () => (stash.query = early.value); }
    try {
      await loadStashData();
    } catch (err) {
      body.innerHTML = `<div class="hint">Couldn't load item data right now (${esc(err.message)}). Try again in a bit.</div>`;
      return;
    }
  }
  ({ scan: renderScan, check: renderStashCheck, keep: renderKeepList, hideout: renderHideoutLevels })[stash.tab]();
}

// ---------- scanned stash (desktop app) ----------
// The app reads items off a stash screenshot (Tarkov's screenshot key, out of raid). Here we draw the
// results over that picture with a verdict colour per item, and let people correct mistakes.

const scanFixKey = (label) => String(label ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

function scanItems() {
  const d = stash.data, s = stash.scan;
  return (s?.items ?? []).map((it) => {
    const fixId = stash.fixes[scanFixKey(it.label)];
    const id = fixId ?? it.id;
    const item = id ? d.byId.get(id) : null;
    const v = item ? itemVerdict(item) : null;
    const unsure = !fixId && (!item || it.confidence < 0.5);
    const kind = !item ? "unknown" : v.keep.length ? "keep" : v.forGuns.length ? "gun" : v.holdLater ? "later" : v.tags.some(([c]) => c === "valuable") ? "valuable" : "sell";
    return { ...it, id, item, v, unsure, fixed: !!fixId, kind };
  });
}

function bestSale(item) {
  const fleaOk = item.flea && !item.noFlea;
  if (item.trader && fleaOk && item.flea > item.trader.price * 1.2) return { where: `Flea${item.fleaLevel ? ` (lvl ${item.fleaLevel}+)` : ""}`, price: item.flea };
  if (item.trader) return { where: item.trader.name, price: item.trader.price };
  if (fleaOk) return { where: "Flea", price: item.flea };
  return null;
}

function renderScan() {
  const body = $("#stash-body");
  const s = stash.scan;
  const intro = `<div class="hint">Out of raid, open your stash in Tarkov and press your <b>screenshot key</b>. Tarkov Timmy reads the items off the picture
    (on this PC, nothing is uploaded) and shows what to keep and sell. Scroll and press it again for the next part of your stash.</div>`;
  const scanBtn = `<button class="btn" id="scan-latest">${stash.scanning ? "Scanning…" : "Scan my latest screenshot"}</button>`;
  if (!s) {
    body.innerHTML = `${intro}${scanBtn}`;
    $("#scan-latest").onclick = scanLatest;
    return;
  }
  const items = scanItems();
  const known = items.filter((i) => i.item);
  const count = (k) => items.filter((i) => i.kind === k).length;
  const total = known.reduce((sum, i) => sum + (bestSale(i.item)?.price ?? 0), 0);
  // Sell list: everything not needed for quests/hideout, grouped by where it sells best.
  const sell = new Map();
  for (const i of known) {
    if (i.kind === "keep" || i.kind === "later" || i.kind === "gun") continue;
    const b = bestSale(i.item);
    if (!b) continue;
    const g = sell.get(b.where) ?? { total: 0, items: new Map() };
    g.total += b.price;
    const e = g.items.get(i.item.id) ?? { item: i.item, n: 0, price: b.price };
    e.n++;
    g.items.set(i.item.id, e);
    sell.set(b.where, g);
  }
  const sel = items[stash.selected] ?? null;
  const { cols, rows } = s.grid;

  body.innerHTML = `
    <div class="scan-head">
      <div class="scan-chips">
        <span class="verdict keep">${count("keep")} keep</span>${stash.guns.length ? `<span class="verdict gun">${count("gun")} for your guns</span>` : ""}<span class="verdict later">${count("later")} hold for later</span>
        <span class="verdict valuable">${count("valuable")} valuable</span><span class="verdict junk">${count("sell")} safe to sell</span>
        ${items.filter((i) => i.unsure).length ? `<span class="verdict unsure">${items.filter((i) => i.unsure).length} unsure</span>` : ""}
        <span class="sub">· ${known.length} items worth ~${rub(total)} · scanned ${new Date(s.at).toLocaleTimeString()}</span>
      </div>
      ${scanBtn}
    </div>
    ${gunsBar()}
    <div class="scan-cols">
      <div>
        <div class="scan-img" style="aspect-ratio:${cols} / ${rows}">
          <img src="${s.image}" alt="Your stash" />
          ${items.map((i, n) => {
            const w = Math.min(i.item?.w ?? 1, i.col + 1), h = Math.min(i.item?.h ?? 1, rows - i.row);
            return `<button class="scan-box ${i.kind}${i.unsure ? " unsure" : ""}${n === stash.selected ? " sel" : ""}" data-n="${n}"
              style="left:${((i.col + 1 - w) / cols) * 100}%;top:${(i.row / rows) * 100}%;width:${(w / cols) * 100}%;height:${(h / rows) * 100}%"
              title="${esc(i.item?.name ?? `Unrecognised: ${i.label}`)}"></button>`;
          }).join("")}
        </div>
        <div class="sub" style="margin-top:6px">Click an item for details. Outline: <span class="legend-k keep">keep</span> <span class="legend-k gun">for your guns</span> <span class="legend-k later">hold for later</span>
          <span class="legend-k valuable">valuable</span> <span class="legend-k sell">safe to sell</span> <span class="legend-k unsure">unsure</span></div>
      </div>
      <div class="scan-side">
        ${sel ? scanDetail(sel) : `<div class="hint">Click an item in the picture to see why, or to fix it if it's wrong.</div>`}
        <div class="section-title">Sell list</div>
        ${[...sell].sort((a, b) => b[1].total - a[1].total).map(([where, g]) => `
          <div class="keep-station">${esc(where)} · ${rub(g.total)}</div>
          ${[...g.items.values()].sort((a, b) => b.price * b.n - a.price * a.n).map((e) => `
            <div class="keep-row">${e.item.icon ? `<img class="item-icon sm" src="${esc(e.item.icon)}" alt="" loading="lazy" />` : ""}
              <span class="keep-count">×${e.n}</span><span class="keep-main">${esc(e.item.name)}</span><span class="sub keep-price">${rub(e.price * e.n)}</span></div>`).join("")}
        `).join("") || `<div class="muted">Nothing here you should sell. Everything's needed for quests or the hideout.</div>`}
      </div>
    </div>`;

  $("#scan-latest").onclick = scanLatest;
  wireGunsBar(renderScan);
  for (const b of body.querySelectorAll(".scan-box")) b.onclick = () => { stash.selected = Number(b.dataset.n); renderScan(); };
  wireScanDetail(sel);
}

function scanDetail(i) {
  const firNote = i.item && i.v?.keep.some((k) => k.includes("found in raid")) && !i.fir
    ? `<div class="hint warn">This one isn't marked found in raid, so it won't count for quests that need found-in-raid items.</div>` : "";
  const alts = (i.alternatives ?? []).filter((id) => id !== i.id).map((id) => stash.data.byId.get(id)).filter(Boolean);
  return `
    <div class="section-title">Selected · label read as “${esc(i.label)}”${i.fixed ? " · corrected by you" : ""}</div>
    ${i.item ? itemCard(i.item, i.fir ? ` <span class="verdict fir">✓ found in raid</span>` : "") : `<div class="hint">Couldn't recognise this one.</div>`}
    ${firNote}
    <div class="scan-fix">
      <div class="sub">${i.unsure ? "Not sure about this one." : "Wrong item?"} Pick the right one${alts.length ? "" : " by searching"}:</div>
      ${alts.slice(0, 6).map((a) => `<button class="btn small" data-fix="${esc(a.id)}">${esc(a.name)}</button>`).join("")}
      <input id="scan-fix-search" class="search" placeholder="Search for the right item…" autocomplete="off" spellcheck="false" />
      <div id="scan-fix-results"></div>
      ${i.fixed ? `<button class="btn small" id="scan-unfix">Undo my correction</button>` : ""}
    </div>`;
}

function wireScanDetail(sel) {
  if (!sel) return;
  const setFix = (id) => {
    stash.fixes[scanFixKey(sel.label)] = id;
    store.set("scanFixes", stash.fixes);
    renderScan();
  };
  for (const b of document.querySelectorAll("[data-fix]")) b.onclick = () => setFix(b.dataset.fix);
  $("#scan-unfix")?.addEventListener("click", () => { delete stash.fixes[scanFixKey(sel.label)]; store.set("scanFixes", stash.fixes); renderScan(); });
  const input = $("#scan-fix-search");
  input.oninput = () => {
    $("#scan-fix-results").innerHTML = searchItems(input.value).slice(0, 8)
      .map((it) => `<button class="btn small" data-fix="${esc(it.id)}">${esc(it.name)}</button>`).join("");
    for (const b of document.querySelectorAll("#scan-fix-results [data-fix]")) b.onclick = () => setFix(b.dataset.fix);
  };
}

async function scanLatest() {
  const r = await desktop?.scanLatest();
  if (r && !r.ok) alert(r.error);
}

function squadToggle() {
  return `<label class="row" style="padding:2px 0"><input type="checkbox" id="stash-squad" ${stash.squad ? "checked" : ""}/><span class="sub">Count my squad's quests too</span></label>`;
}
function wireSquadToggle(rerender) {
  $("#stash-squad").onchange = (e) => { stash.squad = e.target.checked; store.set("stashSquad", stash.squad); rerender(); };
}

function renderStashCheck() {
  const body = $("#stash-body");
  const results = searchItems(stash.query);
  body.innerHTML = `
    <div class="stash-tools">
      <input id="stash-search" class="search" placeholder="Type an item name, e.g. bolts, gpu, salewa…" value="${esc(stash.query)}" autocomplete="off" spellcheck="false" />
      ${squadToggle()}
    </div>
    ${gunsBar()}
    <div class="hint">Hover an item in your stash, read its name, and type a few letters here. <b>Keep</b> = your active quests or next hideout upgrade need it.
      <b>Valuable</b> = worth ${rub(VALUABLE_PER_SLOT)}+ per slot. Items marked <i>found in raid</i> must be ones you brought out of a raid yourself.</div>
    <div id="stash-results">${stash.query.trim().length < 2 ? "" : results.map((i) => itemCard(i)).join("") || `<div class="muted">No items match “${esc(stash.query)}”.</div>`}</div>`;
  const input = $("#stash-search");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.oninput = () => {
    stash.query = input.value;
    $("#stash-results").innerHTML = stash.query.trim().length < 2 ? "" : searchItems(stash.query).map((i) => itemCard(i)).join("") || `<div class="muted">No items match.</div>`;
  };
  wireSquadToggle(renderStashCheck);
  wireGunsBar(renderStashCheck);
}

function renderKeepList() {
  const d = stash.data;
  const active = stashActiveQuests();
  // Quest hand-ins for active quests. A specific item is grouped across quests; an objective that accepts
  // any of several items (e.g. "hand in 3 meds") is one row listing the options.
  const questNeeds = new Map();
  const anyOf = new Map();
  for (const [itemId, needs] of Object.entries(d.quests)) {
    for (const q of needs) {
      if (q.key || !active.has(q.task) || CURRENCY_IDS.has(itemId)) continue;
      const who = `${q.taskName} (${active.get(q.task).join(", ")})`;
      if (q.alternatives > 1) {
        const k = `${q.task}|${q.objective}`;
        const e = anyOf.get(k) ?? { count: q.count, fir: q.fir, why: who, ids: [] };
        e.ids.push(itemId);
        anyOf.set(k, e);
        continue;
      }
      const e = questNeeds.get(itemId) ?? { count: 0, fir: false, why: [] };
      e.count += q.count;
      e.fir ||= q.fir;
      e.why.push(who);
      questNeeds.set(itemId, e);
    }
  }
  // Next hideout level for every station.
  const hideoutNeeds = [];
  for (const s of d.stations) {
    const cur = Number(stash.hideout[s.id] ?? 0);
    const next = s.levels.find((l) => l.level === cur + 1);
    if (next?.items.length) hideoutNeeds.push({ s, next });
  }
  const row = (id, count, fir, why) => {
    const item = d.byId.get(id);
    if (!item) return "";
    return `<div class="keep-row">${item.icon ? `<img class="item-icon sm" src="${esc(item.icon)}" alt="" loading="lazy" />` : ""}
      <span class="keep-count">×${count.toLocaleString()}</span>
      <span class="keep-main"><b>${esc(item.name)}</b>${fir ? ` <span class="verdict fir">found in raid</span>` : ""}<div class="sub">${esc(why)}</div></span>
      <span class="sub keep-price">${item.trader ? rub(item.trader.price) : ""}</span></div>`;
  };
  $("#stash-body").innerHTML = `
    <div class="stash-tools">${squadToggle()}</div>
    <div class="keep-cols">
      <section>
        <div class="section-title">For active quests</div>
        ${[...questNeeds].sort((a, b) => (d.byId.get(a[0])?.name ?? "").localeCompare(d.byId.get(b[0])?.name ?? ""))
          .map(([id, e]) => row(id, e.count, e.fir, [...new Set(e.why)].join(" · "))).join("")}
        ${[...anyOf.values()].map((e) => {
          const opts = e.ids.map((id) => d.byId.get(id)).filter(Boolean).sort((a, b) => (a.trader?.price ?? 0) - (b.trader?.price ?? 0));
          return `<div class="keep-row">${opts.slice(0, 3).map((i) => i.icon ? `<img class="item-icon sm" src="${esc(i.icon)}" alt="" loading="lazy" />` : "").join("")}
            <span class="keep-count">×${e.count}</span>
            <span class="keep-main"><b>Any of ${opts.length} items</b>${e.fir ? ` <span class="verdict fir">found in raid</span>` : ""}
              <div class="sub">${esc(e.why)}: ${esc(opts.slice(0, 5).map((i) => i.name).join(", "))}${opts.length > 5 ? `, +${opts.length - 5} more` : ""}</div></span></div>`;
        }).join("")}
        ${questNeeds.size || anyOf.size ? "" : `<div class="muted">No hand-ins for your active quests. (Quests are picked up from the game by the Tarkov Timmy app, or tick them in the Quests tab.)</div>`}
      </section>
      <section>
        <div class="section-title">For your next hideout upgrades</div>
        ${Object.keys(stash.hideout).length ? "" : `<div class="hint">Set your station levels in the <a href="#" id="go-hideout">Hideout</a> tab so this shows the right next upgrades.</div>`}
        ${hideoutNeeds.map(({ s, next }) => `<div class="keep-station">${esc(s.name)} → level ${next.level}</div>` +
          next.items.map((r) => CURRENCY_IDS.has(r.id) ? `<div class="keep-row money"><span class="keep-count">${rub(r.count)}</span><span class="keep-main sub">money</span></div>` : row(r.id, r.count, r.fir, "")).join("")).join("")}
      </section>
    </div>`;
  $("#go-hideout")?.addEventListener("click", (e) => { e.preventDefault(); openStash("hideout"); });
  wireSquadToggle(renderKeepList);
}

function renderHideoutLevels() {
  const d = stash.data;
  $("#stash-body").innerHTML = `
    <div class="hint">Tarkov doesn't log your hideout, so set each station's current level once (Hideout screen in game). The keep list then shows what your next upgrades need.</div>
    <div class="hideout-grid">${d.stations.map((s) => {
      const cur = Number(stash.hideout[s.id] ?? 0);
      const max = Math.max(0, ...s.levels.map((l) => l.level));
      return `<label class="hideout-cell"><span>${esc(s.name)}</span><select data-station="${esc(s.id)}">${Array.from({ length: max + 1 }, (_, n) =>
        `<option value="${n}" ${n === cur ? "selected" : ""}>${n === 0 ? "Not built" : `Level ${n}`}${n === max ? " (max)" : ""}</option>`).join("")}</select></label>`;
    }).join("")}</div>`;
  for (const sel of document.querySelectorAll("[data-station]")) {
    sel.onchange = () => { stash.hideout[sel.dataset.station] = Number(sel.value); store.set("hideoutLevels", stash.hideout); };
  }
}

boot();
