// Dev tool: run the stash scanner on screenshot files and log the results to <dataDir>/scan-test.log.
//   TIMMY_SERVER=<server url> npx electron scripts/scan-test.cjs <room> <dataDir> <screenshot.png> [more.png...]
// (The server goes in an env var: Electron treats a URL on the command line as something to open.)
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith("scan-test.cjs")) + 1);
const [room, dataDir, ...files] = args;
const server = process.env.TIMMY_SERVER;
fs.mkdirSync(dataDir, { recursive: true });
const logFile = path.join(dataDir, "scan-test.log");
fs.writeFileSync(logFile, "");
// Electron's stdout isn't visible on Windows, so everything goes to the log file.
const log = (...a) => fs.appendFileSync(logFile, a.join(" ") + "\n");
process.on("uncaughtException", (e) => log("uncaught:", e.stack || e));
process.on("unhandledRejection", (e) => log("rejection:", (e && e.stack) || e));

const { scanStash, shutdown } = require("../src/scanner/stash-scan");

app.whenReady().then(async () => {
  try {
    const res = await fetch(`${server}/api/data/items?room=${room}`);
    const { items } = await res.json();
    log(`items: ${items.length}`);
    for (const file of files) {
      const r = await scanStash(file, items, dataDir);
      if (!r.ok) { log(path.basename(file), "->", r.reason); continue; }
      log(`\n${path.basename(file)}: ${r.items.length} labels in ${r.ms} ms, grid ${r.grid.cols}x${r.grid.rows} @ ${r.grid.c}px origin (${r.grid.x0}, ${r.grid.y0}) strength ${r.grid.strength}`);
      for (const it of r.items) {
        log(`  r${it.row}c${it.col}`.padEnd(8), JSON.stringify(it.label).padEnd(16), "->", (it.name || "??").padEnd(52),
          `${it.how || ""} ${it.confidence.toFixed(2)}${it.fir ? "  FIR" : ""}`);
      }
      fs.writeFileSync(path.join(dataDir, path.basename(file) + ".json"), JSON.stringify({ ...r, image: undefined }, null, 1));
      fs.writeFileSync(path.join(dataDir, path.basename(file) + ".crop.jpg"), Buffer.from(r.image.split(",")[1], "base64"));
    }
  } catch (e) {
    log("FAILED:", e.stack || e);
  }
  await shutdown();
  app.quit();
});
