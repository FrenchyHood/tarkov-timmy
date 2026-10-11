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

// Rough "worth a detour" score per container type (1 = filler, 5 = always check). Unlisted types are skipped.
const LOOT_VALUE = {
  safe: 5, "bank-safe": 5, "shturmans-stash": 5, "pc-block": 4, "technical-supply-crate": 4, "buried-barrel-cache": 3, "ground-cache": 3,
  medcase: 3, "medical-supply-crate": 3, "weapon-box": 3, toolbox: 3, "plastic-suitcase": 3, "lab-technician-body": 3,
  jacket: 2, "duffle-bag": 2, "dead-scav": 2, "scav-body": 2, "pmc-body": 2, "civilian-body": 2, "ration-supply-crate": 2,
  "grenade-box": 2, "cash-register": 2, "bank-cash-register": 2,
  medbag: 1, "wooden-ammo-box": 1, drawer: 1, "wooden-crate": 1,
};

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
      // Loot containers, tagged with how worthwhile they usually are (used for the suggested route).
      loot: (m.lootContainers ?? []).flatMap((c) => {
        const type = data.lootContainers?.[c.lootContainer];
        const value = LOOT_VALUE[type?.normalizedName];
        return value && c.position ? [{ kind: type.normalizedName, name: t(type.name), value, position: pos(c.position) }] : [];
      }),
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

// Items for the stash helper: prices, best trader, flea rules, and what each item is needed for
// (quest hand-ins and hideout upgrades), all keyed by item id.
export async function loadItems() {
  const [itemsData, itemsEn, tasksData, tasksEn, tradersEn, hideout, hideoutEn] = await Promise.all([
    getJson("items"), getJson("items_en"), getJson("tasks"), getJson("tasks_en"), getJson("traders_en"), getJson("hideout"), getJson("hideout_en"),
  ]);
  const name = (id) => itemsEn[`${id} Name`] ?? id;
  const trader = (id) => tradersEn[`${id} Nickname`] ?? id;

  const items = Object.values(itemsData.items)
    .filter((i) => !i.types?.includes("preset") && !i.types?.includes("disabled"))
    .map((i) => {
      const best = (i.sellToTrader ?? []).filter((s) => s.priceRUB > 0).sort((a, b) => b.priceRUB - a.priceRUB)[0];
      return {
        id: i.id,
        name: name(i.id),
        short: itemsEn[`${i.id} ShortName`] ?? null,
        w: i.width ?? 1,
        h: i.height ?? 1,
        flea: i.avg24hPrice || i.lastLowPrice || null,
        fleaLevel: i.minLevelForFlea ?? null,
        noFlea: i.types?.includes("noFlea") ?? false,
        trader: best ? { name: trader(best.trader), price: best.priceRUB } : null,
        buyable: (i.buyFromTrader ?? []).length > 0, // a trader sells it: always replaceable
        types: (i.types ?? []).filter((t) => ["barter", "keys", "ammo", "meds", "provisions", "gun", "mods", "armor", "rig", "backpack", "container", "headphones", "glasses", "helmet", "wearable", "grenade"].includes(t)),
        icon: i.iconLink ?? null,
        grid: i.gridImageLink ?? null, // full-size stash icon, used by the desktop app's stash scanner
        wiki: i.wikiLink ?? null,
      };
    });

  // Quest needs: hand-ins (giveItem/plantItem) and keys a quest requires.
  const quests = {};
  const add = (id, need) => (quests[id] ??= []).push(need);
  for (const task of Object.values(tasksData.tasks)) {
    const taskName = tasksEn[task.name] ?? task.name;
    for (const o of task.objectives ?? []) {
      if ((o.type === "giveItem" || o.type === "plantItem") && o.items?.length) {
        for (const id of o.items) add(id, { task: task.id, taskName, objective: o.id, count: o.count ?? 1, fir: !!o.foundInRaid, kappa: !!task.kappaRequired, alternatives: o.items.length });
      }
      for (const alts of o.requiredKeys ?? []) for (const id of alts) add(id, { task: task.id, taskName, count: 1, fir: false, key: true });
    }
  }

  const stations = Object.values(hideout).map((s) => ({
    id: s.id,
    name: hideoutEn[s.name] ?? s.name,
    levels: (s.levels ?? []).map((l) => ({
      level: l.level,
      items: (l.itemRequirements ?? []).map((r) => ({ id: r.item, count: r.count, fir: !!r.attributes?.foundInRaid })),
    })),
  })).sort((a, b) => a.name.localeCompare(b.name));

  // Gun compatibility, as indexes into `items` to keep it small: which parts fit each item's slots
  // (follow these from a gun to find every attachment for it), and which ammo each gun takes.
  const index = new Map(items.map((it, n) => [it.id, n]));
  const slots = {}, ammo = {};
  for (const raw of Object.values(itemsData.items)) {
    const n = index.get(raw.id);
    if (n === undefined) continue;
    const fits = new Set();
    for (const s of raw.properties?.slots ?? []) for (const id of s.filters?.allowedItems ?? []) if (index.has(id)) fits.add(index.get(id));
    if (fits.size) slots[n] = [...fits];
    const rounds = (raw.properties?.allowedAmmo ?? []).map((id) => index.get(id)).filter((x) => x !== undefined);
    if (rounds.length) ammo[n] = rounds;
  }

  if (items.length < 1000) throw new Error(`json.tarkov.dev returned only ${items.length} items`);
  return { items, quests, stations, compat: { slots, ammo }, fleaLevel: itemsData.fleaMarket?.minPlayerLevel ?? 15 };
}

export const LOADERS = { maps: loadMaps, tasks: loadTasks, items: loadItems };
