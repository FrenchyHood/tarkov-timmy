import { DurableObject } from "cloudflare:workers";
import { LOADERS } from "./tarkov-data.js";

const TARKOV_API = "https://api.tarkov.dev/graphql";
const DATA_FRESH_MS = 60 * 60 * 1000; // refetch upstream at most hourly
const UPSTREAM_RETRY_MS = 10 * 60 * 1000; // after a failed refresh, wait before trying upstream again
// Bump when the converted data format changes, so cached copies are refetched right after a deploy.
const DATA_VERSION = 6;
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

// ---------- room codes: 8 random chars + 8-char HMAC tag, so only this server can mint them ----------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const toCode = (bytes, n) => Array.from(bytes.slice(0, n), (b) => ALPHABET[b % ALPHABET.length]).join("");

async function roomTag(rand, key) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toCode(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(rand))), 8);
}
async function signRoom(key) {
  const rand = toCode(crypto.getRandomValues(new Uint8Array(8)), 8);
  return rand + (await roomTag(rand, key));
}
async function verifyRoom(code, key) {
  if (code.length !== 16) return false;
  return sameSecret(code.slice(8), await roomTag(code.slice(0, 8), key));
}
// Constant-time comparison (hash both so lengths match).
async function sameSecret(a, b) {
  const [ha, hb] = await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

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

    // POST /api/rooms {password} — create a room. Only people with the squad password can make rooms.
    if (parts[1] === "rooms" && request.method === "POST") {
      if (!env.SQUAD_PASSWORD || !env.ROOM_KEY) return json({ error: "Room creation isn't set up on this server." }, 503);
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const guard = env.ROOMS.get(env.ROOMS.idFromName(`guard:${ip}`));
      if (!(await guard.attemptAllowed())) return json({ error: "Too many wrong passwords. Try again in an hour." }, 429);
      const body = await request.json().catch(() => ({}));
      if (!(await sameSecret(String(body.password ?? ""), env.SQUAD_PASSWORD))) {
        await guard.recordFailure();
        return json({ error: "Wrong squad password." }, 403);
      }
      return json({ room: await signRoom(env.ROOM_KEY) });
    }

    // Everything below needs a room code this server signed: random people can't invent rooms or hammer the data proxy.
    const roomCode = parts[1] === "room" ? parts[2] : url.searchParams.get("room");
    const validRoom = roomCode && ROOM_RE.test(roomCode) && env.ROOM_KEY && (await verifyRoom(roomCode, env.ROOM_KEY));

    // GET /api/data/:dataset?room=CODE — tarkov.dev data, cached in a Durable Object so an upstream outage doesn't break us.
    if (parts[1] === "data" && LOADERS[parts[2]] && request.method === "GET") {
      if (!validRoom) return json({ error: "unknown room" }, 403);
      const stub = env.ROOMS.get(env.ROOMS.idFromName("__data_cache__"));
      return stub.getDataset(parts[2]).then(
        (body) => new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } }),
        (err) => json({ error: String(err.message || err) }, 503),
      );
    }

    // GET /api/download — newest installer from the GitHub repo's latest release (GITHUB_REPO in wrangler.jsonc).
    if (parts[1] === "download") {
      if (!env.GITHUB_REPO) return new Response("The Tarkov Timmy app isn't published yet.", { status: 404 });
      const releases = `https://github.com/${env.GITHUB_REPO}/releases/latest`;
      try {
        const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/releases/latest`, {
          headers: { "user-agent": "tarkov-timmy", accept: "application/vnd.github+json" },
          cf: { cacheTtl: 600, cacheEverything: true },
        });
        const exe = res.ok && (await res.json()).assets?.find((a) => /Setup.*\.exe$/i.test(a.name));
        return Response.redirect(exe ? exe.browser_download_url : releases, 302);
      } catch {
        return Response.redirect(releases, 302);
      }
    }

    // /api/room/:room/ws (browser) and /api/room/:room/event (companion)
    if (parts[1] === "room") {
      if (!validRoom) return json({ error: "unknown room" }, 403);
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
      // The app tells PMC from Scav raids by the start countdown; switch which extracts this player sees.
      if (state === "started" && (ev.faction === "pmc" || ev.faction === "scav")) player.faction = ev.faction;
      if (state === "loading" && map) {
        // New raid: forget last raid's extract picks and stale positions on this map.
        delete this.state.extracts[map];
        if (player.pos?.map !== map) player.pos = null;
      }
    } else if (ev.type === "quests") {
      // From the game's logs: add quests started in game, drop ones finished/failed. Manual ticks are kept.
      const ids = (a) => (Array.isArray(a) ? a.filter((i) => typeof i === "string" && /^[0-9a-f]{24}$/.test(i)).slice(0, 2000) : []);
      const ended = new Set(ids(ev.ended));
      const merged = new Set([...(player.quests ?? []), ...ids(ev.active)]);
      player.quests = [...merged].filter((id) => !ended.has(id)).slice(0, 100);
      // Finished/failed quests, so the stash helper can tell "needed later" from "already done".
      player.questsEnded = [...new Set([...(player.questsEnded ?? []), ...ended])].slice(-600);
      player.questsAuto = now;
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

  // ---------- password guessing guard (only used by "guard:<ip>" instances) ----------

  async attemptAllowed() {
    const fails = ((await this.ctx.storage.get("fails")) || []).filter((t) => Date.now() - t < 3600_000);
    return fails.length < 10;
  }

  async recordFailure() {
    const fails = ((await this.ctx.storage.get("fails")) || []).filter((t) => Date.now() - t < 3600_000);
    fails.push(Date.now());
    await this.ctx.storage.put("fails", fails);
  }

  // ---------- tarkov.dev data cache (only used by the "__data_cache__" instance) ----------

  // Freshness order: cached copy (< 1 h old) → tarkov.dev JSON API → tarkov.dev GraphQL API →
  // older cached copy → daily snapshot committed to the GitHub repo. Any one of them is enough.
  async getDataset(name) {
    const meta = (await this.ctx.storage.get(`data:v${DATA_VERSION}:${name}:meta`)) || null;
    if (meta && Date.now() - meta.fetchedAt < DATA_FRESH_MS) return this.readDataset(name, meta);

    // While upstream is failing, don't retry it on every request.
    const lastFail = (await this.ctx.storage.get(`data:v${DATA_VERSION}:${name}:lastFail`)) || 0;
    const errors = [];
    if (Date.now() - lastFail > UPSTREAM_RETRY_MS) {
      const sources = [
        ["json.tarkov.dev", async () => JSON.stringify(await LOADERS[name]())],
        ...(DATASETS[name] ? [["api.tarkov.dev", () => fetchTarkovDev(DATASETS[name])]] : []),
      ];
      for (const [label, load] of sources) {
        try {
          const body = await load();
          await this.writeDataset(name, body);
          await this.ctx.storage.delete(`data:v${DATA_VERSION}:${name}:lastFail`);
          return body;
        } catch (err) {
          errors.push(`${label}: ${err.message || err}`);
        }
      }
      await this.ctx.storage.put(`data:v${DATA_VERSION}:${name}:lastFail`, Date.now());
    }

    if (meta) return this.readDataset(name, meta); // stale beats nothing
    if (this.env.GITHUB_REPO) {
      const res = await fetch(`https://raw.githubusercontent.com/${this.env.GITHUB_REPO}/main/data/${name}.json`);
      if (res.ok) {
        const body = await res.text();
        await this.writeDataset(name, body, Date.now() - DATA_FRESH_MS); // counts as stale: retry upstream next time
        return body;
      }
      errors.push(`GitHub snapshot: HTTP ${res.status}`);
    }
    throw new Error(errors.join("; ") || "no data source available");
  }

  // Values are capped at ~2 MB, so store gzip'd chunks.
  async writeDataset(name, body, fetchedAt = Date.now()) {
    const gz = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const CHUNK = 1_000_000;
    const chunks = Math.ceil(gz.byteLength / CHUNK);
    const entries = { [`data:v${DATA_VERSION}:${name}:meta`]: { fetchedAt, chunks } };
    for (let i = 0; i < chunks; i++) entries[`data:v${DATA_VERSION}:${name}:${i}`] = gz.slice(i * CHUNK, (i + 1) * CHUNK);
    await this.ctx.storage.put(entries);
  }

  async readDataset(name, meta) {
    const keys = Array.from({ length: meta.chunks }, (_, i) => `data:v${DATA_VERSION}:${name}:${i}`);
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
