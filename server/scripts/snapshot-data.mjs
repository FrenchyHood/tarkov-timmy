// Saves today's tarkov.dev data (converted to the map page's format) into data/*.json at the repo root.
// The server falls back to these files if every live source is down. Run weekly by
// .github/workflows/snapshot-data.yml; run by hand with: node server/scripts/snapshot-data.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { LOADERS } from "../src/tarkov-data.js";

const outDir = fileURLToPath(new URL("../../data/", import.meta.url));
await mkdir(outDir, { recursive: true });

// Item prices change constantly, so they're not worth committing every week; maps and quests are.
for (const [name, load] of Object.entries(LOADERS).filter(([n]) => n !== "items")) {
  const data = await load();
  const count = data[name]?.length ?? 0;
  if (count < (name === "maps" ? 10 : 100)) throw new Error(`${name}: only ${count} entries, refusing to overwrite the snapshot`);
  await writeFile(`${outDir}${name}.json`, JSON.stringify(data));
  console.log(`${name}: ${count} entries`);
}
