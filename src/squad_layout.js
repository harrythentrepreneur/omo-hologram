// src/squad_layout.js — persisted layout model for /squad.
//
// The browser renders this JSON directly. The customization editor was
// removed; this module now just loads the layout from disk (with the omo
// "cozy" defaults applied) and serves it to the /squad page.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_LAYOUT_PATH = join(REPO_ROOT, "public", "squad", "assets", "default-layout-1.json");
const STORE_PATH = join(homedir(), ".omo", "squad-layout.json");

const VERSION = 1;

const DORMITORY_BEDS = [
  { uid: "bed_12", type: "CUSHIONED_BENCH", col: 12, row: 19 },
  { uid: "bed_14", type: "CUSHIONED_BENCH", col: 14, row: 19 },
  { uid: "bed_16", type: "CUSHIONED_BENCH", col: 16, row: 19 },
  { uid: "bed_18", type: "CUSHIONED_BENCH", col: 18, row: 19 },
];

const COZY_DECOR = [
  { uid: "cozy_plant_l", type: "PLANT_2", col: 11, row: 17 },
  { uid: "cozy_plant_r", type: "PLANT", col: 18, row: 17 },
  { uid: "cozy_hang", type: "HANGING_PLANT", col: 15, row: 9 },
];

const DORM_FLOOR_TINT = { h: 25, s: 48, b: -43, c: -88 };

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function makeUid(prefix = "f") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normaliseFurniture(f, i) {
  const type = String(f?.type || f?.baseType || "").trim();
  if (!type) return null;
  return {
    uid: String(f.uid || makeUid("f" + i)),
    type,
    col: Number.isFinite(Number(f.col)) ? Number(f.col) | 0 : 0,
    row: Number.isFinite(Number(f.row)) ? Number(f.row) | 0 : 0,
  };
}

function normaliseLayout(raw, source = "unknown") {
  if (!raw || typeof raw !== "object") throw new Error("layout must be an object");
  const cols = Number(raw.cols) | 0;
  const rows = Number(raw.rows) | 0;
  if (cols < 4 || rows < 4 || cols > 64 || rows > 64) throw new Error("invalid layout dimensions");
  if (!Array.isArray(raw.tiles) || raw.tiles.length !== cols * rows) throw new Error("tiles length does not match dimensions");
  const tileColors = Array.isArray(raw.tileColors) && raw.tileColors.length === cols * rows
    ? raw.tileColors
    : new Array(cols * rows).fill(null);
  const furniture = Array.isArray(raw.furniture)
    ? raw.furniture.map(normaliseFurniture).filter(Boolean)
    : [];
  return {
    version: VERSION,
    source,
    cols,
    rows,
    tiles: raw.tiles.map((n) => Number(n) | 0),
    tileColors,
    furniture,
    omoCozy: !!raw.omoCozy,
    updatedAt: raw.updatedAt || null,
  };
}

function loadDefaultLayout() {
  const raw = JSON.parse(readFileSync(DEFAULT_LAYOUT_PATH, "utf8"));
  return applyOmoDefaults(normaliseLayout(raw, "default"));
}

function applyOmoDefaults(layout) {
  const next = clone(layout);
  if (next.omoCozy) return next;

  for (const bed of DORMITORY_BEDS) {
    if (!next.furniture.some((f) => f.uid === bed.uid)) next.furniture.push({ ...bed });
  }

  for (let row = 19; row <= 20; row++) {
    for (let col = 11; col <= 18; col++) {
      const idx = row * next.cols + col;
      if (idx >= 0 && idx < next.tiles.length) {
        next.tiles[idx] = 1;
        next.tileColors[idx] = { ...DORM_FLOOR_TINT };
      }
    }
  }

  next.furniture = next.furniture.filter((f) =>
    !(f.type === "SMALL_TABLE_FRONT" && f.col === 17 && f.row === 19)
  );
  for (const item of COZY_DECOR) {
    if (!next.furniture.some((f) => f.uid === item.uid)) next.furniture.push({ ...item });
  }
  next.omoCozy = true;
  return next;
}

export function readLayout() {
  try {
    if (existsSync(STORE_PATH)) {
      const saved = JSON.parse(readFileSync(STORE_PATH, "utf8"));
      return normaliseLayout(saved, "user");
    }
  } catch (err) {
    console.warn("[squad-layout] failed to read saved layout:", err?.message || err);
  }
  return loadDefaultLayout();
}

export function mountRoutes(app) {
  app.get("/omo/api/squad/layout", (_req, res) => {
    try { res.json(readLayout()); }
    catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
  });
}
