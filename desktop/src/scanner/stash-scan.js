// Stash scanner: reads items off a screenshot of the Tarkov stash. Nothing touches the game; it only looks
// at the screenshot Tarkov saved. Steps:
//   1. find the stash grid (its position is fixed relative to the screen size, then fine-tuned)
//   2. OCR the strip at the top of every grid row, where each item prints its short name (top-right)
//   3. match those labels to tarkov.dev items, treating lookalike characters (8/B, 0/O/D...) as equal
//   4. when several items share a short name (e.g. "PS" ammo in 10 calibers), compare the screenshot with
//      each candidate's official stash icon and pick the closest; guns with attachments get a size rule
//   5. check each item's bottom-right corner for the found-in-raid mark
const { nativeImage, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const FIR = require("./fir-template.json");

// ---------- images (BGRA bitmaps from nativeImage) ----------

function loadImage(file) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`can't read ${file}`);
  const { width: w, height: h } = img.getSize();
  return { w, h, px: img.toBitmap() };
}
const lum = (img, x, y) => {
  const i = (y * img.w + x) * 4;
  return 0.114 * img.px[i] + 0.587 * img.px[i + 1] + 0.299 * img.px[i + 2];
};

// ---------- 1. grid ----------

// The stash UI is laid out for 1920x1080 and scaled to the screen height, centred horizontally on wider
// screens. At 1080p the grid starts at (1265, 78) with 63 px cells; we then search nearby for the exact fit.
function detectGrid(img) {
  const s = Math.min(img.h / 1080, img.w / 1920);
  const uiX = (img.w - 1920 * s) / 2, uiY = (img.h - 1080 * s) / 2;
  const expect = { x0: uiX + 1265.25 * s, y0: uiY + 78 * s, c: 63 * s };
  const c0 = Math.round(expect.c);

  // Gradient profiles across the expected grid area; grid lines show up as periodic peaks.
  const rx0 = Math.max(1, Math.round(expect.x0 - c0)), rx1 = Math.min(img.w - 1, Math.round(expect.x0 + 11 * c0));
  const ry0 = Math.max(1, Math.round(expect.y0 - c0)), ry1 = Math.min(img.h - 1, Math.round(expect.y0 + 9 * c0));
  const gx = new Float64Array(rx1 - rx0), gy = new Float64Array(ry1 - ry0);
  for (let y = ry0; y < ry1; y += 2) for (let x = rx0; x < rx1; x++) gx[x - rx0] += Math.abs(lum(img, x, y) - lum(img, x - 1, y));
  for (let x = rx0; x < rx1; x += 2) for (let y = ry0; y < ry1; y++) gy[y - ry0] += Math.abs(lum(img, x, y) - lum(img, x, y - 1));

  // Best period near the expected cell size, then the offset nearest the expected origin.
  const fit = (prof, start, expectOrigin) => {
    const mean = prof.reduce((a, b) => a + b, 0) / prof.length;
    let best = null;
    for (let T = c0 - 2; T <= c0 + 2; T++) {
      for (let off = 0; off < T; off++) {
        let sum = 0, n = 0;
        for (let i = off; i < prof.length; i += T) { sum += prof[i] + (prof[i + 1] ?? 0); n++; }
        const strength = sum / n / (2 * mean || 1);
        // Prefer origins close to where the layout says the grid should be.
        let origin = start + off;
        while (origin - T > expectOrigin - T / 2) origin -= T;
        while (origin < expectOrigin - T / 2) origin += T;
        const score = strength - Math.abs(origin - expectOrigin) / T * 0.3;
        if (!best || score > best.score) best = { T, origin, strength, score };
      }
    }
    return best;
  };
  const fx = fit(gx, rx0, expect.x0), fy = fit(gy, ry0, expect.y0);
  if (!fx || !fy || fx.strength < 1.3 || fy.strength < 1.3) return null; // no grid here: not a stash screenshot
  const c = Math.round((fx.T + fy.T) / 2);
  const bottom = Math.min(img.h - 2, uiY + 949 * s);
  // Candidate row positions. In a scrolled stash the edges of big items (armour, backpacks) can out-vote the
  // real grid lines, so we collect a few plausible positions here and let the OCR pick (see pickRows):
  // the grid-line peaks within half a cell, plus where label text starts (text below, gap above), each +-3 px.
  const x0 = fx.origin, w = 10 * c;
  const textPx = (y) => {
    if (y < 0 || y >= img.h) return 0;
    let n = 0;
    for (let x = x0; x < x0 + w; x += 2) {
      const i = (y * img.w + x) * 4;
      const b = img.px[i], gr = img.px[i + 1], r = img.px[i + 2];
      const mn = Math.min(r, gr, b), mx = Math.max(r, gr, b);
      if (mn > 150 && mx - mn < 45) n++;
    }
    return n;
  };
  const cache = new Map();
  const px = (y) => (cache.has(y) ? cache.get(y) : (cache.set(y, textPx(y)), cache.get(y)));
  const panelTop = expect.y0 - 0.15 * c;
  const lineAt = (y0) => {
    let sum = 0, n = 0;
    for (let y = y0; y < ry1 - 1; y += c) { sum += (gy[y - ry0] ?? 0) + (gy[y - ry0 + 1] ?? 0); n++; }
    return n ? sum / n : 0;
  };
  const edgeAt = (y0) => {
    let s = 0;
    for (let top = y0; top + 20 < bottom; top += c) {
      if (top < panelTop) continue;
      for (let y = top + 1; y < top + 13; y++) s += px(y);
      for (let y = top - 6; y < top; y++) s -= 2 * px(y);
    }
    return s;
  };
  const half = Math.floor(c / 2), base = Math.round(expect.y0);
  const offs = [];
  for (let o = -half; o <= half; o++) offs.push({ y: base + o, line: lineAt(base + o), edge: edgeAt(base + o) });
  const lineTop = Math.max(...offs.map((x) => x.line));
  const cands = new Set([fy.origin]);
  offs.forEach((x, i) => {
    if (x.line >= lineTop * 0.5 && x.line >= (offs[i - 1]?.line ?? 0) && x.line >= (offs[i + 1]?.line ?? 0)) cands.add(x.y);
  });
  cands.add(offs.reduce((a, b2) => (b2.edge > a.edge ? b2 : a)).y);
  const rowCandidates = [...cands].filter((y) => y >= base - half && y <= base + half);
  const rows = Math.max(1, Math.ceil((bottom - fy.origin) / c));
  return { x0: fx.origin, y0: fy.origin, c, cols: 10, rows, bottom, scale: s, strength: Math.min(fx.strength, fy.strength), rowCandidates };
}

// ---------- 2. OCR ----------

let ocrWorker = null;
async function getOcr(cacheDir) {
  if (ocrWorker) return ocrWorker;
  const { createWorker, PSM } = require("tesseract.js");
  fs.mkdirSync(cacheDir, { recursive: true });
  // English model downloads once (~10 MB) into the app's data folder.
  ocrWorker = await createWorker("eng", 1, { cachePath: cacheDir });
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-./ ()\"'+",
    preserve_interword_spaces: "1",
  });
  return ocrWorker;
}

// The label strip of one grid row, cleaned up for OCR: bright grey text kept, coloured icon art dimmed,
// inverted to dark-on-light and enlarged 3x.
function labelStrip(img, g, row) {
  const y0 = Math.round(g.y0 + row * g.c + g.c / 84), h = Math.round(20 * g.c / 84), w = g.cols * g.c;
  if (y0 + h >= img.h) return null;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * img.w + g.x0 + x) * 4;
      const b = img.px[i], gr = img.px[i + 1], r = img.px[i + 2];
      const mn = Math.min(r, gr, b), mx = Math.max(r, gr, b);
      const v = 255 - Math.max(0, Math.min(255, (mn - 0.8 * (mx - mn) - 70) * 2.2));
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
    }
  }
  const png = nativeImage.createFromBitmap(out, { width: w, height: h }).resize({ width: w * 3, height: h * 3, quality: "best" }).toPNG();
  return png;
}

// Try each candidate row position on a few rows and keep the one whose labels are real Tarkov short names.
async function pickRows(img, g, cacheDir, byKey) {
  if (!g.rowCandidates?.length) return g;
  const worker = await getOcr(cacheDir);
  const tried = new Map();
  const scoreAt = async (y0) => {
    if (tried.has(y0)) return tried.get(y0);
    const trial = { ...g, y0 };
    let score = 0;
    for (const row of [1, 2]) {
      const png = labelStrip(img, trial, row);
      if (!png) break;
      const { data } = await worker.recognize(png, {}, { blocks: true });
      const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
      for (const l of groupLabels(words.map((w) => ({ text: w.text, x0: w.bbox.x0 / 3, x1: w.bbox.x1 / 3 })))) {
        const k = clean(l.text);
        if (byKey.has(k)) score += 2;
        else if (k.length >= 3 && candidatesFor(l.text, byKey).length) score += 1;
      }
    }
    tried.set(y0, score);
    return score;
  };
  // Quick vote over the candidates, then fine-tune a few pixels around the winner.
  // Ties go to the position closest to what the grid lines said.
  const better = (y, s, best) => !best || s > best.s || (s === best.s && Math.abs(y - g.y0) < Math.abs(best.y - g.y0));
  let best = null;
  for (const y of new Set([g.y0, ...g.rowCandidates])) { const sc = await scoreAt(y); if (better(y, sc, best)) best = { y, s: sc }; }
  for (const d of [-4, -2, 2, 4]) { const y = best.y + d, sc = await scoreAt(y); if (better(y, sc, best)) best = { y, s: sc }; }
  const rows = Math.max(1, Math.ceil((g.bottom - best.y) / g.c));
  return { ...g, y0: best.y, rows };
}

async function ocrRows(img, g, cacheDir) {
  const worker = await getOcr(cacheDir);
  const rows = [];
  for (let r = 0; r < g.rows; r++) {
    const png = labelStrip(img, g, r);
    if (!png) break;
    const { data } = await worker.recognize(png, {}, { blocks: true });
    const words = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
    rows.push(words.map((w) => ({ text: w.text, x0: w.bbox.x0 / 3, x1: w.bbox.x1 / 3 })));
  }
  return rows;
}

// ---------- 3. matching ----------

// Edit distance where swapping lookalike characters is only a fraction of a mistake. Tarkov's label font
// makes 0/8/B/E/6 easy to confuse (M600U was read as "MBEBBU"), so those cost little.
const clean = (s) => s.toUpperCase().replace(/[\s\-."']/g, "");
const TIGHT = ["0ODQ", "8B", "6G", "1IL|", "5S", "2Z", "UV"]; // nearly identical glyphs
const LOOSE = ["0ODQ8BE6G93", "59S"]; // glyphs the OCR mixes up with each other in this font
function subCost(a, b) {
  if (a === b) return 0;
  if (TIGHT.some((g) => g.includes(a) && g.includes(b))) return 0.25;
  if (LOOSE.some((g) => g.includes(a) && g.includes(b))) return 0.45;
  return 1;
}
function fuzzyCost(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + subCost(a[i - 1], b[j - 1]));
      prev = cur;
    }
  }
  return d[b.length];
}

function buildIndex(items) {
  const byKey = new Map();
  for (const it of items) {
    const k = clean(it.short ?? "");
    if (k) (byKey.get(k) ?? byKey.set(k, []).get(k)).push(it);
  }
  return byKey;
}

// Every item whose short name is close enough to what the OCR read, best first, each with its text cost.
// The picture then decides between them (see the scan loop), so near-misses aren't thrown away.
function candidatesFor(label, byKey) {
  const n = clean(label);
  if (!n) return [];
  // Reading an exact, real short name is strong evidence: only items with that name compete (otherwise a
  // look-alike name like MP9 could win on a lucky picture match). Near-misses only when nothing is exact.
  if (byKey.has(n)) return byKey.get(n).map((item) => ({ item, cost: 0 }));
  const limit = n.length <= 2 ? 0.25 : n.length === 3 ? 0.5 : n.length <= 5 ? 1.4 : 2.2;
  const hits = [];
  for (const [k, items] of byKey) {
    if (Math.abs(k.length - n.length) > 2) continue;
    const cost = fuzzyCost(n, k);
    if (cost <= limit) for (const item of items) hits.push({ item, cost });
  }
  if (!hits.length && n.length >= 5) {
    // Tarkov cuts long short names to fit the item ("BigTittyTa"), and icon art sometimes sticks to the front
    // of a label ("EE4Apolio" for Apollo): accept names the reading starts, or names hidden inside it.
    for (const [k, items] of byKey) {
      if (k.length >= 5 && k.startsWith(n)) for (const item of items) hits.push({ item, cost: 0.3 });
      else if (k.length >= 5 && n.length > k.length && fuzzyCost(n.slice(n.length - k.length), k) <= 0.5) for (const item of items) hits.push({ item, cost: 0.6 });
    }
  }
  if (!hits.length) return [];
  const best = Math.min(...hits.map((h) => h.cost));
  return hits.filter((h) => h.cost <= best + 0.8).sort((a, b) => a.cost - b.cost).slice(0, 15);
}

// Words close together are one label ("Alu" + "splint"); drop icon noise the OCR picks up as letters.
function groupLabels(words) {
  const labels = [];
  for (const w of words) {
    const t = w.text.replace(/^["'\-]+|["'\-]+$/g, "");
    if (!/[A-Za-z0-9]/.test(t)) continue;
    // Words right next to the previous one belong to the same label ("MCX" + "8"), even digits.
    const prev = labels.at(-1);
    if (prev && w.x0 - prev.x1 < 9) { prev.text += " " + t; prev.x1 = w.x1; continue; }
    // A word on its own: skip the usual OCR noise from icon art.
    if (/^(o+|w+|a|n|i|l|\.)$/i.test(t)) continue;
    if (t.length <= 2 && t !== t.toUpperCase()) continue; // short real labels (PS, T, PP) are upper-case
    if (/^\d$/.test(t)) continue; // a lone digit is a stack count or icon detail, never a label
    labels.push({ text: t, x0: w.x0, x1: w.x1 });
  }
  return labels;
}

// ---------- 4. icons ----------

let decoder = null;
// WebP icons are decoded by a hidden Chromium window (Electron's nativeImage only reads PNG/JPEG),
// then cached as PNG in the app's data folder.
async function iconImage(item, cacheDir) {
  const file = path.join(cacheDir, `${item.id}.png`);
  if (!fs.existsSync(file)) {
    if (!item.grid) return null;
    if (!decoder || decoder.isDestroyed()) {
      decoder = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
      await decoder.loadURL("about:blank");
    }
    // Download here (the icon host sends no CORS header, so a page couldn't read the pixels), then let the
    // hidden window decode the bytes from a data: URL.
    const res = await fetch(item.grid, { headers: { "user-agent": "tarkov-timmy" } });
    if (!res.ok) return null;
    const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    const dataUrl = await decoder.webContents.executeJavaScript(`new Promise((ok, fail) => {
      const im = new Image();
      im.onload = () => { const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext("2d").drawImage(im, 0, 0); ok(c.toDataURL("image/png")); };
      im.onerror = () => fail(new Error("icon decode failed")); im.src = "data:image/webp;base64,${b64}";
    })`);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, nativeImage.createFromDataURL(dataUrl).toPNG());
  }
  return nativeImage.createFromPath(file);
}

// Correlation between a candidate's icon and the screenshot area it would cover (label = its top-right).
async function iconScore(img, g, item, row, col, cacheDir) {
  const right = g.x0 + (col + 1) * g.c, top = g.y0 + row * g.c;
  const w = item.w * g.c, h = item.h * g.c, left = right - w;
  if (left < g.x0 - 2 || top + h > img.h) return -1;
  const icon = await iconImage(item, cacheDir).catch(() => null);
  if (!icon) return -1;
  // Compare at 1/3 scale for speed; skip the label strip and the count corner, which icons don't have.
  const k = 3, sw = Math.floor(w / k), sh = Math.floor(h / k);
  const ref = icon.resize({ width: sw, height: sh, quality: "good" }).toBitmap();
  let sa = 0, sb = 0, n = 0;
  const A = [], B = [];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (y * k < 22 * g.c / 84) continue;
      if (y * k > h - 20 * g.c / 84 && x * k > w - 40 * g.c / 84) continue;
      for (let ch = 0; ch < 3; ch++) {
        const a = img.px[((top + y * k) * img.w + left + x * k) * 4 + ch];
        const b = ref[(y * sw + x) * 4 + ch];
        A.push(a); B.push(b); sa += a; sb += b; n++;
      }
    }
  }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const a = A[i] - ma, b = B[i] - mb; num += a * b; da += a * a; db += b * b; }
  return num / (Math.sqrt(da * db) + 1e-6);
}

// ---------- 5. found in raid ----------

// Best match of the found-in-raid mark in the bottom-right of the item's last cell.
function firScore(img, g, row, col, h) {
  const t = FIR, scale = g.c / t.cell;
  const tw = Math.max(6, Math.round(t.w * scale)), th = Math.max(6, Math.round(t.h * scale));
  const tpl = new Float64Array(tw * th);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tpl[y * tw + x] = t.px[Math.min(t.h - 1, Math.floor(y / scale)) * t.w + Math.min(t.w - 1, Math.floor(x / scale))];
  const tm = tpl.reduce((a, b) => a + b, 0) / tpl.length;
  let tv = 0;
  for (let i = 0; i < tpl.length; i++) { tpl[i] -= tm; tv += tpl[i] * tpl[i]; }
  const cellX = g.x0 + col * g.c, cellY = g.y0 + (row + h - 1) * g.c;
  const x0 = Math.round(cellX + g.c * 0.45), y0 = Math.round(cellY + g.c * 0.45);
  const x1 = Math.round(cellX + g.c) - tw, y1 = Math.min(img.h - th, Math.round(cellY + g.c) - th);
  let best = -1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let pm = 0;
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) pm += lum(img, x + i, y + j);
      pm /= tw * th;
      let num = 0, pv = 0;
      for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) { const p = lum(img, x + i, y + j) - pm; num += p * tpl[j * tw + i]; pv += p * p; }
      best = Math.max(best, num / (Math.sqrt(pv * tv) + 1e-6));
    }
  }
  return best;
}

// ---------- scan ----------

async function scanStash(file, items, dataDir) {
  const t0 = Date.now();
  const img = loadImage(file);
  const byKey = buildIndex(items);
  const tessDir = path.join(dataDir, "tessdata");
  const g0 = detectGrid(img);
  if (!g0) return { ok: false, reason: "no-grid" };
  const g = await pickRows(img, g0, tessDir, byKey);
  const rows = await ocrRows(img, g, tessDir);
  const iconDir = path.join(dataDir, "icon-cache");

  // Labels → candidate items (with how far each short name is from what the OCR read).
  const found = [];
  rows.forEach((words, row) => {
    for (const l of groupLabels(words)) {
      const col = Math.min(g.cols - 1, Math.max(0, Math.floor(l.x1 / g.c)));
      found.push({ row, col, label: l.text, cands: candidatesFor(l.text, byKey) });
    }
  });
  const labelAt = new Set(found.map((f) => `${f.row},${f.col}`));
  // How many cells to the left of a label are free of other labels: a gun with attachments covers several.
  const span = (row, col) => {
    let n = 1;
    for (let c = col - 1; c >= 0 && !labelAt.has(`${row},${c}`); c--) n++;
    return n;
  };

  const out = [];
  for (const f of found) {
    if (!f.cands.length) {
      // Unrecognised: keep it (so it can be fixed by hand) only if it looks like a real label, not icon art.
      if (clean(f.label).length >= 5 && /^[A-Z0-9]/.test(f.label.trim())) out.push({ row: f.row, col: f.col, label: f.label, id: null, confidence: 0 });
      continue;
    }
    let pick = f.cands[0].item, confidence = 0.95, how = "label";
    // An exact, unique label needs nothing else. Otherwise text and picture decide together: every plausible
    // match is compared with the screenshot, and a bigger text mismatch costs a little picture score.
    if (f.cands.length > 1 || f.cands[0].cost > 0) {
      const scored = [];
      for (const c of f.cands.slice(0, 12)) {
        const icon = await iconScore(img, g, c.item, f.row, f.col, iconDir);
        scored.push({ item: c.item, icon, cost: c.cost, score: icon - 0.25 * c.cost });
      }
      scored.sort((a, b) => b.score - a.score);
      pick = scored[0].item;
      const margin = scored[0].score - (scored[1]?.score ?? -1);
      if (f.cands.length > 1) {
        // Several possibilities: confident only if the picture really looks like the winner and beats the rest.
        confidence = scored[0].icon >= 0.3 && margin >= 0.08 ? 0.85 : 0.4;
        how = "icon";
      } else {
        // One near-miss match: trust the text unless the picture clearly disagrees.
        confidence = scored[0].icon >= 0.15 ? 0.85 : 0.4;
        how = "label+icon";
      }
      // Modded guns don't look like their stock icon. If the picture is inconclusive and the label sits on an
      // item as wide as the gun (no other labels in the way), it's the gun, not one of its parts.
      const gun = f.cands.find((c) => c.item.types?.includes("gun"))?.item;
      if (confidence < 0.5 && gun && span(f.row, f.col) >= Math.max(2, gun.w - 1)) { pick = gun; confidence = 0.7; how = "size"; }
      // Short labels with no exact text match are often icon art read as letters ("EEN"): the picture must agree.
      else if (clean(f.label).length <= 3 && f.cands[0].cost > 0 && scored[0].icon < 0.35) {
        out.push({ row: f.row, col: f.col, label: f.label, id: null, confidence: 0 });
        continue;
      }
    }
    out.push({
      row: f.row, col: f.col, label: f.label, id: pick.id, name: pick.name, w: pick.w, h: pick.h, how,
      confidence, alternatives: f.cands.length > 1 ? f.cands.slice(0, 12).map((c) => c.item.id) : [],
    });
  }
  // The mark sits in the item's right-most column (where the label is), on its bottom row.
  for (const it of out) if (it.id) it.fir = firScore(img, g, it.row, it.col, Math.min(it.h ?? 1, 4)) > 0.7;

  // A picture of just the stash grid, for drawing the results over.
  const crop = nativeImage.createFromPath(file).crop({ x: g.x0, y: g.y0, width: g.cols * g.c, height: Math.min(img.h - g.y0, g.rows * g.c) });
  return {
    ok: true,
    file: path.basename(file),
    at: Date.now(),
    ms: Date.now() - t0,
    grid: { cols: g.cols, rows: g.rows, c: g.c, x0: g.x0, y0: g.y0, strength: Math.round(g.strength * 100) / 100 },
    image: `data:image/jpeg;base64,${crop.toJPEG(82).toString("base64")}`,
    items: out,
  };
}

async function shutdown() {
  await ocrWorker?.terminate().catch(() => {});
  ocrWorker = null;
  if (decoder && !decoder.isDestroyed()) decoder.destroy();
}

module.exports = { scanStash, detectGrid, loadImage, shutdown };
