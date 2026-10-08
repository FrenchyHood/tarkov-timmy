import { DurableObject } from "cloudflare:workers";

const TARKOV_API = "https://api.tarkov.dev/graphql";
const DATA_FRESH_MS = 60 * 60 * 1000; // refetch upstream at most hourly
const PING_TTL_MS = 3 * 60 * 1000;
const ROOM_RE = /^[A-Za-z0-9_-]{4,40}$/;
const NAME_RE = /^[\p{L}\p{N} _.-]{1,24}$/u;

// Everything the map draws, for every map, in one request. PvP data (gameMode: regular).
const MAPS_QUERY = `{
  maps(gameMode: regular) {
    id name nameId normalizedName raidDuration players wiki
    extracts {
      id name faction
      position { x y z } outline { x y z } top bottom
      switches { id name }
      transferItem { item { name shortName } count }
    }
    transits { id description conditions map { name normalizedName } position { x y z } outline { x y z } }
    bosses {
      boss { name normalizedName imagePortraitLink }
      spawnChance spawnTime spawnTimeRandom spawnTrigger
      spawnLocations { spawnKey name chance }
      escorts { boss { name } amount { count chance } }
    }
    spawns { zoneName position { x y z } sides categories }
    hazards { hazardType name position { x y z } outline { x y z } top bottom }
    switches { id name switchType position { x y z } }
    locks { lockType needsPower key { name shortName } position { x y z } }
    btrStops { name x y z }
  }
}`;

const ZONES = "zones { map { id } position { x y z } outline { x y z } top bottom }";
const KEYS = "requiredKeys { name shortName }";
const TASKS_QUERY = `{
  tasks(gameMode: regular) {
    id name wikiLink minPlayerLevel kappaRequired lightkeeperRequired
    trader { name }
    map { id }
    objectives {
      id type description optional maps { id }
      ... on TaskObjectiveBasic { ${ZONES} ${KEYS} }
      ... on TaskObjectiveMark { markerItem { shortName } ${ZONES} ${KEYS} }
      ... on TaskObjectiveQuestItem { questItem { name } possibleLocations { map { id } positions { x y z } } ${ZONES} ${KEYS} }
      ... on TaskObjectiveShoot { targetNames count ${ZONES} ${KEYS} }
      ... on TaskObjectiveItem { count foundInRaid items { shortName } ${ZONES} ${KEYS} }
      ... on TaskObjectiveUseItem { ${ZONES} ${KEYS} }
      ... on TaskObjectiveExtract { exitName count ${KEYS} }
    }
  }
}`;

const DATASETS = { maps: MAPS_QUERY, tasks: TASKS_QUERY };

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

    // GET /api/data/:dataset — tarkov.dev data, cached in a Durable Object so an upstream outage doesn't break us.
    if (parts[1] === "data" && DATASETS[parts[2]] && request.method === "GET") {
      const stub = env.ROOMS.get(env.ROOMS.idFromName("__data_cache__"));
      return stub.getDataset(parts[2]).then(
        (body) => new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } }),
        (err) => json({ error: String(err.message || err) }, 503),
      );
    }

    // GET /api/download — latest Windows installer (DOWNLOAD_URL in wrangler.jsonc).
    if (parts[1] === "download") {
      if (env.DOWNLOAD_URL) return Response.redirect(env.DOWNLOAD_URL, 302);
      return new Response("The Tarkov Timmy app isn't published yet. Ask your squad leader for the installer.", { status: 404 });
    }

    // /api/room/:room/ws (browser) and /api/room/:room/event (companion)
    if (parts[1] === "room" && ROOM_RE.test(parts[2] || "") && !parts[2].startsWith("__")) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(`room:${parts[2]}`));
      if (parts[3] === "ws") {
        if (request.headers.get("Upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
        return stub.fetch(request);
      }
      if (parts[3] === "event" && request.method === "POST") {
        let event;
        try {
          event = await request.json();
        } catch {
          return json({ error: "bad json" }, 400);
        }
        const result = await stub.companionEvent(event);
        return json(result, result.ok ? 200 : 400);
      }
    }

    return json({ error: "not found" }, 404);
  },
};

export class RaidRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) || { players: {}, pings: [], extracts: {} };
    });
  }

  // ---------- room state ----------

  playerFor(name) {
    if (typeof name !== "string" || !NAME_RE.test(name.trim())) return null;
    const key = name.trim().toLowerCase();
    this.state.players[key] ??= { name: name.trim(), quests: [], faction: "pmc" };
    return this.state.players[key];
  }

  async commit() {
    const now = Date.now();
    this.state.pings = this.state.pings.filter((p) => now - p.ts < PING_TTL_MS);
    await this.ctx.storage.put("state", this.state);
    const msg = JSON.stringify({ t: "state", state: this.state, now });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }

  async companionEvent(ev) {
    const player = this.playerFor(ev?.name);
    if (!player) return { ok: false, error: "invalid name" };
    const map = typeof ev.map === "string" ? ev.map.slice(0, 40) : null;
    const now = Date.now();
    player.companionSeen = now;

    if (ev.type === "position") {
      const n = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
      player.pos = { map, x: n(ev.x), y: n(ev.y), z: n(ev.z), yaw: n(ev.yaw), ts: now, source: "screenshot" };
    } else if (ev.type === "raid") {
      const state = ["matching", "loading", "started", "ended"].includes(ev.state) ? ev.state : null;
      if (!state) return { ok: false, error: "invalid raid state" };
      const prev = player.raid;
      player.raid = { state, map: map ?? prev?.map ?? null, ts: now, startedAt: state === "started" ? (ev.startedAt ?? now) : prev?.startedAt ?? null };
      if (state === "loading" && map) {
        // New raid: forget last raid's extract picks and stale positions on this map.
        delete this.state.extracts[map];
        if (player.pos?.map !== map) player.pos = null;
      }
    } else if (ev.type === "heartbeat") {
      // nothing beyond companionSeen
    } else {
      return { ok: false, error: "unknown type" };
    }
    await this.commit();
    return { ok: true };
  }

  // ---------- browser websockets (hibernation API) ----------

  async fetch(request) {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ t: "state", state: this.state, now: Date.now() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    const num = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
    const map = typeof m.map === "string" ? m.map.slice(0, 40) : null;

    switch (m.t) {
      case "ping": {
        const x = num(m.x), z = num(m.z);
        const kinds = ["go", "enemy", "loot", "danger"];
        if (!map || x === null || z === null || !kinds.includes(m.kind)) return;
        const by = this.playerFor(m.name)?.name ?? "?";
        this.state.pings.push({ id: crypto.randomUUID().slice(0, 8), map, x, z, kind: m.kind, by, ts: now });
        this.state.pings = this.state.pings.slice(-30);
        break;
      }
      case "unping":
        this.state.pings = this.state.pings.filter((p) => p.id !== m.id);
        break;
      case "extracts":
        if (!map || !Array.isArray(m.ids)) return;
        this.state.extracts[map] = m.ids.filter((i) => typeof i === "string").slice(0, 40);
        break;
      case "quests": {
        const player = this.playerFor(m.name);
        if (!player || !Array.isArray(m.ids)) return;
        player.quests = m.ids.filter((i) => typeof i === "string").slice(0, 100);
        break;
      }
      case "faction": {
        const player = this.playerFor(m.name);
        if (!player || !["pmc", "scav"].includes(m.faction)) return;
        player.faction = m.faction;
        break;
      }
      case "manualpos": {
        // "I'm here" from the map, for when the screenshot companion isn't running.
        const player = this.playerFor(m.name);
        const x = num(m.x), z = num(m.z);
        if (!player || !map || x === null || z === null) return;
        player.pos = { map, x, y: 0, z, yaw: null, ts: now, source: "manual" };
        break;
      }
      case "hello":
        this.playerFor(m.name);
        break;
      default:
        return;
    }
    await this.commit();
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code, "bye");
    } catch {}
  }

  // ---------- tarkov.dev data cache (only used by the "__data_cache__" instance) ----------

  async getDataset(name) {
    const meta = (await this.ctx.storage.get(`data:${name}:meta`)) || null;
    if (meta && Date.now() - meta.fetchedAt < DATA_FRESH_MS) return this.readDataset(name, meta);
    try {
      const body = await fetchTarkovDev(DATASETS[name]);
      await this.writeDataset(name, body);
      return body;
    } catch (err) {
      if (meta) return this.readDataset(name, meta); // serve stale rather than nothing
      throw err;
    }
  }

  // Values are capped at ~2 MB, so store gzip'd chunks.
  async writeDataset(name, body) {
    const gz = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const CHUNK = 1_000_000;
    const chunks = Math.ceil(gz.byteLength / CHUNK);
    const entries = { [`data:${name}:meta`]: { fetchedAt: Date.now(), chunks } };
    for (let i = 0; i < chunks; i++) entries[`data:${name}:${i}`] = gz.slice(i * CHUNK, (i + 1) * CHUNK);
    await this.ctx.storage.put(entries);
  }

  async readDataset(name, meta) {
    const keys = Array.from({ length: meta.chunks }, (_, i) => `data:${name}:${i}`);
    const got = await this.ctx.storage.get(keys);
    const blob = new Blob(keys.map((k) => got.get(k)));
    return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
}

async function fetchTarkovDev(query) {
  const res = await fetch(TARKOV_API, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "tarkov-squad-map (personal project)" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tarkov.dev HTTP ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text);
  if (!parsed.data) throw new Error(`tarkov.dev error: ${JSON.stringify(parsed.errors).slice(0, 300)}`);
  return JSON.stringify(parsed.data);
}
