// Loads map and quest data from tarkov.dev's JSON API (https://json.tarkov.dev/endpoints) and converts it
// into the shape the map page uses. The JSON API stores names as translation keys and links objects by id,
// so we resolve both here. Shared by the Worker and the daily snapshot job (scripts/snapshot-data.mjs).

const JSON_API = "https://json.tarkov.dev/regular";

async function getJson(path) {
  const res = await fetch(`${JSON_API}/${path}`, { headers: { "user-agent": "tarkov-timmy (personal project)" } });
  if (!res.ok) throw new Error(`json.tarkov.dev/${path}: HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.data) throw new Error(`json.tarkov.dev/${path}: no data`);
  return body.data;
}

const pos = (p) => (p ? { x: p.x, y: p.y, z: p.z } : null);
const outline = (o) => (Array.isArray(o) && o.length ? o.map(pos) : null);

export async function loadMaps() {
  const [data, en, itemsEn] = await Promise.all([getJson("maps"), getJson("maps_en"), getJson("items_en")]);
  const t = (k) => (k == null ? null : en[k] ?? k);
  const item = (id) => (id ? { name: itemsEn[`${id} Name`] ?? id, shortName: itemsEn[`${id} ShortName`] ?? null } : null);
  const mob = (id) => ({ name: t(data.mobs?.[id]?.name ?? id) });
  const allMaps = Object.values(data.maps);
  const mapRef = (id) => {
    const m = data.maps[id];
    return m ? { name: t(m.name), normalizedName: m.normalizedName } : null;
  };

  const maps = allMaps.map((m) => {
    const switchName = Object.fromEntries((m.switches ?? []).map((s) => [s.id, t(s.name)]));
    // Upstream data sometimes tags every extract on a map with the same switch (e.g. all 28 on Customs).
    // A switch shared by every extract isn't a real requirement, so drop it.
    const extracts = m.extracts ?? [];
    const onEvery = new Set(extracts.length > 2 ? (extracts[0].switches ?? []).filter((id) => extracts.every((e) => e.switches?.includes(id))) : []);
    return {
      id: m.id,
      name: t(m.name),
      nameId: m.nameId,
      normalizedName: m.normalizedName,
      raidDuration: m.raidDuration,
      players: m.players,
      wiki: m.wiki,
      extracts: (m.extracts ?? []).map((e) => ({
        id: e.id,
        name: t(e.name),
        faction: e.faction,
        position: pos(e.position),
        outline: outline(e.outline),
        top: e.top,
        bottom: e.bottom,
        switches: (e.switches ?? []).filter((id) => !onEvery.has(id)).map((id) => ({ id, name: switchName[id] ?? "a switch" })),
        transferItem: e.transferItem ? { item: item(e.transferItem.item), count: e.transferItem.count } : null,
      })),
      transits: (m.transits ?? []).map((tr) => ({
        id: tr.id,
        description: t(tr.description),
        conditions: t(tr.conditions),
        map: mapRef(tr.map),
        position: pos(tr.position),
        outline: outline(tr.outline),
      })),
      bosses: (m.bosses ?? []).map((b) => ({
        boss: mob(b.mob),
        spawnChance: b.spawnChance,
        spawnTime: b.spawnTime,
        spawnTimeRandom: b.spawnTimeRandom,
        spawnTrigger: t(b.spawnTrigger),
        spawnLocations: (b.spawnLocations ?? []).map((l) => ({
          spawnKey: l.spawnKey,
          name: t(l.name),
          chance: l.chance,
          positions: (l.positions ?? []).map(pos),
        })),
        escorts: (b.escorts ?? []).map((e) => ({ boss: mob(e.mob), amount: e.amount })),
      })),
      spawns: (m.spawns ?? []).map((s) => ({ zoneName: s.zoneName, position: pos(s.position), sides: s.sides, categories: s.categories })),
      hazards: (m.hazards ?? []).map((h) => ({ hazardType: h.hazardType, name: t(h.name), position: pos(h.position), outline: outline(h.outline), top: h.top, bottom: h.bottom })),
      switches: (m.switches ?? []).map((s) => ({ id: s.id, name: t(s.name), switchType: s.switchType, position: pos(s.position) })),
      locks: (m.locks ?? []).map((l) => ({ lockType: l.lockType, needsPower: l.needsPower, key: item(l.key), position: pos(l.position) })),
      btrStops: (m.btrStops ?? []).map((s) => ({ name: t(s.name), x: s.x, y: s.y, z: s.z })),
    };
  });
  if (!maps.length) throw new Error("json.tarkov.dev returned no maps");
  return { maps };
}

export async function loadTasks() {
  const [data, en, itemsEn, tradersEn] = await Promise.all([getJson("tasks"), getJson("tasks_en"), getJson("items_en"), getJson("traders_en")]);
  const t = (k) => (k == null ? null : en[k] ?? k);
  const short = (id) => ({ shortName: itemsEn[`${id} ShortName`] ?? itemsEn[`${id} Name`] ?? id, name: itemsEn[`${id} Name`] ?? id });
  const questItem = (id) => ({ name: t(data.questItems?.[id]?.name ?? id) });
  const ref = (id) => ({ id });

  const tasks = Object.values(data.tasks).map((task) => ({
    id: task.id,
    name: t(task.name),
    wikiLink: task.wikiLink,
    minPlayerLevel: task.minPlayerLevel,
    kappaRequired: task.kappaRequired,
    lightkeeperRequired: task.lightkeeperRequired,
    trader: { name: tradersEn[`${task.trader} Nickname`] ?? task.trader },
    map: task.map ? ref(task.map) : null,
    objectives: (task.objectives ?? []).map((o) => ({
      id: o.id,
      type: o.type,
      description: t(o.description),
      optional: o.optional,
      maps: (o.maps ?? []).map(ref),
      zones: (o.zones ?? []).map((z) => ({ map: ref(z.map), position: pos(z.position), outline: outline(z.outline), top: z.top, bottom: z.bottom })),
      possibleLocations: (o.possibleLocations ?? []).map((l) => ({ map: ref(l.map), positions: (l.positions ?? []).map(pos) })),
      questItem: o.questItem ? questItem(o.questItem) : undefined,
      markerItem: o.markerItem ? short(o.markerItem) : undefined,
      items: o.items ? o.items.map(short) : undefined,
      requiredKeys: o.requiredKeys ? o.requiredKeys.map((alts) => alts.map(short)) : undefined,
      targetNames: o.targetNames,
      count: o.count,
      exitName: o.exitName ? t(o.exitName) : undefined,
    })),
  }));
  if (!tasks.length) throw new Error("json.tarkov.dev returned no tasks");
  return { tasks };
}

export const LOADERS = { maps: loadMaps, tasks: loadTasks };
