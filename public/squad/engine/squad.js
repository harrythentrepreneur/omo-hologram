// public/squad/engine/squad.js
//
// Pablo-faithful pixel office. Loads pablodelucca/pixel-agents's
// default-layout-1.json wholesale and renders his exact 21×22 room with
// our 4 omo agents seated at 4 of its workstations. Wander, walk-home,
// arrival flash and bubbles all carry over from the earlier port.

import { colorize, adjust } from './colorize.js';

const TILE = 16;
const CHAR_W = 16;
const CHAR_H = 32;
const SHEET_COLS = 7;
const SHEET_ROWS = 3;

export const DIR = { DOWN: 0, UP: 1, RIGHT: 2, LEFT: 3 };
export const STATE = { IDLE: 'idle', TYPE: 'type', READ: 'read', WALK: 'walk' };

const FRAME_TYPE_SEC = 0.30;
const FRAME_WALK_SEC = 0.15;
const FRAME_READ_SEC = 0.45;

// Activity-driven idle timer — when an agent has had no task activity for
// this long, they wander off to a chill spot. Tasks/tool events reset the
// clock via recordActivity().
const IDLE_BEFORE_CHILL_MS = 25_000;

// Sub-agent (linked-character) stations — when a parent agent spawns a
// sub-task tool (Task / spawn_*_agent), a small ephemeral character pops
// in, walks to one of these stations, does its work, then walks back near
// the parent and despawns. Picked round-robin per tool category.
const SUBAGENT_STATIONS = {
  // research/web — lounge sofa area (left side)
  web:    [{ col: 13, row: 13, dir: 'DOWN' }, { col: 14, row: 13, dir: 'DOWN' }],
  // code/file — bookshelf cluster (right side)
  code:   [{ col: 16, row: 13, dir: 'DOWN' }, { col: 15, row: 13, dir: 'DOWN' }],
  // default — anywhere
  generic:[{ col: 14, row: 14, dir: 'DOWN' }, { col: 15, row: 14, dir: 'DOWN' }],
};
function stationKindForTool(toolName) {
  const t = String(toolName || '').toLowerCase();
  if (/(search|web|fetch|extract|url|browse|http|google)/.test(t)) return 'web';
  if (/(read|write|edit|patch|file|grep|glob|find|ls|bash|terminal|shell|exec|run|code|git)/.test(t)) return 'code';
  return 'generic';
}

// Tools that should NOT trigger a "needs permission" bubble — these are
// orchestration tools, not gated by user permission in this app. Lifted
// from pixel-agents's PERMISSION_EXEMPT_TOOLS set.
export const PERMISSION_EXEMPT_TOOLS = new Set([
  'task', 'agent', 'subagent',
  'spawn_agent_task', 'spawn_browser_agent', 'spawn_research_agent',
  'askuserquestion', 'ask_user_question',
]);

// Friendly verb for the currentTool tooltip under each sprite.
export function toolToVerb(toolName) {
  const t = String(toolName || '').toLowerCase();
  if (/search|google/.test(t))                  return 'searching';
  if (/fetch|extract|curl|http|url|browse/.test(t)) return 'fetching';
  if (/read|view|open|cat/.test(t))             return 'reading';
  if (/write|edit|patch/.test(t))               return 'editing';
  if (/grep|glob|find|ls/.test(t))              return 'searching files';
  if (/bash|terminal|shell|exec|run/.test(t))   return 'running';
  if (/task|agent|spawn/.test(t))               return 'delegating';
  return t || 'working';
}

// ─── pixel office seats (in Pablo's coord system) ──────────────────────
// Pablo's work bay has 4 side-facing workstations: chairs at (3,16),(3,18)
// facing RIGHT toward PCs at (4,16),(4,18); chairs at (7,16),(7,18) facing
// LEFT toward PCs at (6,16),(6,18). Seats are *anonymous* — whoever the
// hermes wrapper spawns next gets assigned to seat0..seat3 dynamically.
const DIR_NAMES = { DOWN: 0, UP: 1, RIGHT: 2, LEFT: 3 };
// Seats live at the *bottom* tile of each 2-tile chair sprite so the
// character renders sitting IN the chair (on the seat) instead of
// floating above it where the backrest is.
const SEATS_SPEC = [
  { slot: 'seat0', col: 3, row: 17, dir: 'RIGHT' },
  { slot: 'seat1', col: 3, row: 19, dir: 'RIGHT' },
  { slot: 'seat2', col: 7, row: 17, dir: 'LEFT'  },
  { slot: 'seat3', col: 7, row: 19, dir: 'LEFT'  },
];

// ─── chill spots (off-duty hangouts) ────────────────────────────────────
// When an agent has been idle long enough, they walk to one of these
// spots and stay there until work arrives. Two kinds:
//   • bed   — own bunk in the bottom-right dormitory (CUSHIONED_BENCH).
//   • sofa  — a seat on the lounge sofa cluster (cols 13-16, rows 13-16).
// Each agent has one of each. The state machine picks randomly between
// them so the scene doesn't always look the same. Chairs/benches are
// blocked tiles, so we explicitly mark the chill destination as a
// stay-here-anyway position (BLOCKED.delete during setup).
const CHILL_SPOTS = {
  seat0: [
    { col: 12, row: 20, dir: 'DOWN', kind: 'bed'  },
    { col: 13, row: 14, dir: 'DOWN', kind: 'sofa' },
  ],
  seat1: [
    { col: 14, row: 20, dir: 'DOWN', kind: 'bed'  },
    { col: 16, row: 14, dir: 'DOWN', kind: 'sofa' },
  ],
  seat2: [
    { col: 16, row: 20, dir: 'DOWN', kind: 'bed'  },
    { col: 14, row: 13, dir: 'UP',   kind: 'sofa' },
  ],
  seat3: [
    { col: 18, row: 20, dir: 'DOWN', kind: 'bed'  },
    { col: 15, row: 14, dir: 'DOWN', kind: 'sofa' },
  ],
};

// Beds = CUSHIONED_BENCH placed at the dormitory positions. We inject
// these into FURNITURE_LAYOUT after loading Pablo's JSON so the BLOCKED
// set + depth sort already see them.
const DORMITORY_BEDS = [
  { baseType: 'CUSHIONED_BENCH', mirrored: false, col: 12, row: 19 },
  { baseType: 'CUSHIONED_BENCH', mirrored: false, col: 14, row: 19 },
  { baseType: 'CUSHIONED_BENCH', mirrored: false, col: 16, row: 19 },
  { baseType: 'CUSHIONED_BENCH', mirrored: false, col: 18, row: 19 },
];

// ─── furniture catalog ──────────────────────────────────────────────────
// Maps the type ids referenced in default-layout-1.json to the actual PNG
// files inside public/squad/assets/furniture/ and their pixel dimensions.
const FURN_CATALOG = {
  BIN:                { file: 'BIN/BIN.png',                            w: 16, h: 16 },
  CLOCK:              { file: 'CLOCK/CLOCK.png',                        w: 16, h: 16 },
  COFFEE:             { file: 'COFFEE/COFFEE.png',                      w: 16, h: 16 },
  COFFEE_TABLE:       { file: 'COFFEE_TABLE/COFFEE_TABLE.png',          w: 32, h: 32 },
  CUSHIONED_BENCH:    { file: 'CUSHIONED_BENCH/CUSHIONED_BENCH.png',    w: 16, h: 32 },
  DESK_FRONT:         { file: 'DESK/DESK_FRONT.png',                    w: 48, h: 32 },
  DOUBLE_BOOKSHELF:   { file: 'DOUBLE_BOOKSHELF/DOUBLE_BOOKSHELF.png',  w: 32, h: 32 },
  HANGING_PLANT:      { file: 'HANGING_PLANT/HANGING_PLANT.png',        w: 16, h: 32 },
  LARGE_PAINTING:     { file: 'LARGE_PAINTING/LARGE_PAINTING.png',      w: 32, h: 32 },
  PC_FRONT_OFF:       { file: 'PC/PC_FRONT_OFF.png',                    w: 16, h: 32 },
  PC_FRONT_ON_1:      { file: 'PC/PC_FRONT_ON_1.png',                   w: 16, h: 32 },
  PC_FRONT_ON_2:      { file: 'PC/PC_FRONT_ON_2.png',                   w: 16, h: 32 },
  PC_FRONT_ON_3:      { file: 'PC/PC_FRONT_ON_3.png',                   w: 16, h: 32 },
  PC_SIDE:            { file: 'PC/PC_SIDE.png',                         w: 16, h: 32 },
  PLANT:              { file: 'PLANT/PLANT.png',                        w: 16, h: 32 },
  PLANT_2:            { file: 'PLANT_2/PLANT_2.png',                    w: 16, h: 32 },
  SMALL_PAINTING:     { file: 'SMALL_PAINTING/SMALL_PAINTING.png',      w: 16, h: 32 },
  SMALL_PAINTING_2:   { file: 'SMALL_PAINTING_2/SMALL_PAINTING_2.png',  w: 16, h: 32 },
  SMALL_TABLE_FRONT:  { file: 'SMALL_TABLE/SMALL_TABLE_FRONT.png',      w: 32, h: 32 },
  SMALL_TABLE_SIDE:   { file: 'SMALL_TABLE/SMALL_TABLE_SIDE.png',       w: 16, h: 32 },
  SOFA_BACK:          { file: 'SOFA/SOFA_BACK.png',                     w: 32, h: 16 },
  SOFA_FRONT:         { file: 'SOFA/SOFA_FRONT.png',                    w: 32, h: 16 },
  SOFA_SIDE:          { file: 'SOFA/SOFA_SIDE.png',                     w: 16, h: 32 },
  TABLE_FRONT:        { file: 'TABLE_FRONT/TABLE_FRONT.png',            w: 48, h: 64 },
  WOODEN_CHAIR_SIDE:  { file: 'WOODEN_CHAIR/WOODEN_CHAIR_SIDE.png',     w: 16, h: 32 },
};

// Types we treat as "decorative on a surface" — they get drawn AFTER the
// furniture beneath them (coffee mug on top of desk, paintings on the wall).
const OVERLAY_TYPES = new Set([
  'COFFEE', 'CLOCK', 'SMALL_PAINTING', 'SMALL_PAINTING_2', 'LARGE_PAINTING',
]);
// Wall-mounted: depth-sort behind everything in front (lower zY)
const WALL_TYPES = new Set([
  'SMALL_PAINTING', 'SMALL_PAINTING_2', 'LARGE_PAINTING', 'CLOCK', 'HANGING_PLANT',
]);

// Parse "SOFA_SIDE:left" → { baseType: 'SOFA_SIDE', mirrored: true }
function parseFurnType(t) {
  const i = t.indexOf(':');
  if (i < 0) return { baseType: t, mirrored: false };
  return { baseType: t.slice(0, i), mirrored: t.slice(i + 1) === 'left' };
}

// ─── asset loaders ──────────────────────────────────────────────────────

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('failed to load ' + url));
    img.src = url;
  });
}

function decodeBubble(json) {
  const w = json.pixels[0].length;
  const h = json.pixels.length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const col = json.palette[json.pixels[y][x]];
      if (!col) continue;
      cx.fillStyle = col;
      cx.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

// ─── sprite frame mapping ───────────────────────────────────────────────
function spriteSlice(state, dir, frame) {
  const row = dir === DIR.LEFT ? DIR.RIGHT : dir;
  let col;
  switch (state) {
    case STATE.WALK: col = frame % 3; break;
    case STATE.IDLE: col = 1; break;
    case STATE.TYPE: col = 3 + (frame % 2); break;
    case STATE.READ: col = 5 + (frame % 2); break;
    default:         col = 1;
  }
  return { sx: col * CHAR_W, sy: row * CHAR_H };
}

// ─── public API ─────────────────────────────────────────────────────────

export function createSquadOffice({ canvas, basePath = '/squad' } = {}) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // Layout state — populated by start() from default-layout-1.json
  let COLS = 21, ROWS = 22;
  let LAYOUT = [];
  let TILE_COLORS = [];
  let FURNITURE_LAYOUT = [];
  let BLOCKED = new Set();
  let WALKABLE_TILES = [];
  // Bounding box of actual non-void content (Pablo's layout has lots of
  // VOID tiles above the building — they shouldn't be counted as part of
  // the room when fitting to viewport).
  let CONTENT_BOX = { minC: 0, minR: 0, maxC: 21, maxR: 22 };

  // Asset state — populated by start()
  let assets = null;

  // PC monitor animation
  let pcFrame = 0, pcFrameTimer = 0;
  const PC_FRAME_SEC = 0.2;

  // Characters — one slot per chair, all VACANT at boot. Hermes WS events
  // call assignSeat() to fill a chair, releaseSeat() to empty it.
  const characters = SEATS_SPEC.map((s, i) => {
    const cx = s.col * TILE + TILE / 2;
    const cy = s.row * TILE + TILE / 2;
    return {
      slot: s.slot,
      seatIndex: i,
      // Identity (filled by assignSeat). When agentId === null, this seat
      // is vacant — update/draw loops skip it.
      agentId: null,
      display: null,
      role: null,
      color: '#A09C92',
      seatCol: s.col, seatRow: s.row,
      seatDir: DIR[s.dir],
      sheetIndex: i,
      state: STATE.IDLE,
      requestedState: STATE.IDLE,
      dir: DIR[s.dir],
      frame: 0, frameTimer: 0,
      tileCol: s.col, tileRow: s.row,
      x: cx, y: cy,
      path: [], moveProgress: 0,
      wanderTimer: 4 + Math.random() * 8,
      wanderMoves: 0,
      bubbleType: null, bubbleTimer: 0,
      arrivalFlash: 0,
      chillCountdown: 25 + Math.random() * 20,
      chillTarget: null,
      atChillSpot: false,
      // activity-driven idle: bumped on every tool/task event. Once it
      // exceeds IDLE_BEFORE_CHILL_MS, the agent wanders off to a chill spot.
      lastActivityAt: Date.now(),
      // current tool name (transient, set on tool_start, cleared on tool_end)
      // — drives a small "reading file…" / "searching web…" tooltip.
      currentTool: null,
      // monotonic count of tool_end events since arrival. Shown as the
      // "N calls" line under the name tag.
      toolCallCount: 0,
    };
  });

  // Ephemeral sub-agent linked characters (sprites spawned when a parent
  // agent invokes a Task/spawn tool — they walk to a station, work for a
  // bit, then walk back and despawn). Keyed by parent agentId + uid.
  // Pablo-faithful: each linked character mirrors the parent's sprite
  // index so they read as "the same person's helper".
  const subAgents = [];
  function makeSubAgent(parent, tool, opts = {}) {
    const stationKind = stationKindForTool(tool);
    const pool = SUBAGENT_STATIONS[stationKind] || SUBAGENT_STATIONS.generic;
    const station = pool[Math.floor(Math.random() * pool.length)];
    // Spawn position: one tile in front of the parent so they "pop out"
    // of the parent's seat. Clamp to a walkable tile.
    let spawnCol = parent.seatCol;
    let spawnRow = parent.seatRow;
    if (parent.seatDir === DIR.RIGHT) spawnCol += 1;
    else if (parent.seatDir === DIR.LEFT) spawnCol -= 1;
    else if (parent.seatDir === DIR.DOWN) spawnRow += 1;
    else spawnRow -= 1;
    if (!isWalkable(spawnCol, spawnRow)) {
      spawnCol = parent.seatCol; spawnRow = parent.seatRow;
    }
    const cc = tileCenter(spawnCol, spawnRow);
    return {
      uid: opts.uid || ('sa_' + Math.random().toString(36).slice(2, 8)),
      parentSlot: parent.slot,
      tool: tool || '',
      stationKind,
      station,
      sheetIndex: parent.sheetIndex,    // mirror parent's sprite
      state: STATE.WALK,
      dir: parent.seatDir,
      frame: 0, frameTimer: 0,
      tileCol: spawnCol, tileRow: spawnRow,
      x: cc.x, y: cc.y,
      path: [], moveProgress: 0,
      phase: 'walking-out',              // 'walking-out' | 'working' | 'returning' | 'done'
      workTimer: 0,
      maxWorkSec: 2 + Math.random() * 3, // safety: at least 2s of working
      arrivalFlash: 0.6,
      doneAt: 0,
    };
  }
  const charBySlot = Object.fromEntries(characters.map((c) => [c.slot, c]));
  // agent_id → character (built on assignSeat, cleared on releaseSeat)
  const charByAgentId = new Map();

  function resolveCharacter(ref) {
    if (ref == null) return null;
    if (charByAgentId.has(ref)) return charByAgentId.get(ref);
    return charBySlot[ref] || null;
  }

  // ─── pathfinder ───────────────────────────────────────────────────────

  function isWalkable(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    const t = LAYOUT[row * COLS + col];
    if (t === 0 || t === 255) return false;
    if (BLOCKED.has(col + ',' + row)) return false;
    return true;
  }

  function findPath(sc, sr, ec, er) {
    if (sc === ec && sr === er) return [];
    if (!isWalkable(ec, er)) return [];
    const key = (c, r) => c + ',' + r;
    const startK = key(sc, sr);
    const endK = key(ec, er);
    const visited = new Set([startK]);
    const parent = new Map();
    const queue = [{ col: sc, row: sr }];
    const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
    while (queue.length) {
      const cur = queue.shift();
      const cK = key(cur.col, cur.row);
      if (cK === endK) {
        const path = [];
        let k = endK;
        while (k !== startK) {
          const [c, r] = k.split(',').map(Number);
          path.unshift({ col: c, row: r });
          k = parent.get(k);
        }
        return path;
      }
      for (const [dc, dr] of dirs) {
        const nc = cur.col + dc, nr = cur.row + dr;
        const nK = key(nc, nr);
        if (visited.has(nK)) continue;
        if (!isWalkable(nc, nr)) continue;
        visited.add(nK);
        parent.set(nK, cK);
        queue.push({ col: nc, row: nr });
      }
    }
    return [];
  }

  function dirBetween(fc, fr, tc, tr) {
    if (tc > fc) return DIR.RIGHT;
    if (tc < fc) return DIR.LEFT;
    if (tr > fr) return DIR.DOWN;
    return DIR.UP;
  }

  function pickWanderTarget() {
    return WALKABLE_TILES[Math.floor(Math.random() * WALKABLE_TILES.length)];
  }

  function computeContentBox() {
    let minC = COLS, minR = ROWS, maxC = -1, maxR = -1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (LAYOUT[r * COLS + c] !== 255) {
          if (c < minC) minC = c;
          if (r < minR) minR = r;
          if (c > maxC) maxC = c;
          if (r > maxR) maxR = r;
        }
      }
    }
    for (const f of FURNITURE_LAYOUT) {
      const def = FURN_CATALOG[f.baseType];
      if (!def) continue;
      const fw = Math.ceil(def.w / TILE);
      const fh = Math.ceil(def.h / TILE);
      if (f.col < minC) minC = f.col;
      if (f.row < minR) minR = f.row;
      if (f.col + fw - 1 > maxC) maxC = f.col + fw - 1;
      if (f.row + fh - 1 > maxR) maxR = f.row + fh - 1;
    }
    if (maxC < 0) { minC = 0; minR = 0; maxC = COLS - 1; maxR = ROWS - 1; }
    CONTENT_BOX = { minC, minR, maxC, maxR };
  }

  function rebuildPathfinder() {
    BLOCKED = new Set();
    for (const f of FURNITURE_LAYOUT) {
      // Wall-mounted decor doesn't block (it hangs above the floor).
      if (WALL_TYPES.has(f.baseType)) continue;
      // Overlay items (coffee mug, clock) don't block — they're on a desk surface.
      if (OVERLAY_TYPES.has(f.baseType)) continue;
      const def = FURN_CATALOG[f.baseType];
      if (!def) continue;
      const fw = Math.ceil(def.w / TILE);
      const fh = Math.ceil(def.h / TILE);
      for (let dr = 0; dr < fh; dr++) {
        for (let dc = 0; dc < fw; dc++) {
          BLOCKED.add((f.col + dc) + ',' + (f.row + dr));
        }
      }
    }
    // Unblock seat tiles so agents can path back to them
    for (const s of SEATS_SPEC) BLOCKED.delete(s.col + ',' + s.row);
    // Unblock chill destination tiles too (beds + sofa positions) — the
    // furniture there is intended to be sat ON, not walked AROUND.
    for (const slot of Object.keys(CHILL_SPOTS)) {
      for (const sp of CHILL_SPOTS[slot]) BLOCKED.delete(sp.col + ',' + sp.row);
    }
    WALKABLE_TILES = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (isWalkable(c, r)) WALKABLE_TILES.push({ col: c, row: r });
  }

  // ─── asset loading ────────────────────────────────────────────────────

  async function loadAssets() {
    // characters (untinted — skin tones stay diverse). Load all 6 so the
    // user can shift+click to re-skin a seat with any of Pablo's sprites.
    const chars = await Promise.all([0,1,2,3,4,5].map((i) =>
      loadImage(basePath + '/assets/characters/char_' + i + '.png')
    ));

    // bubbles
    const [bubW, bubP] = await Promise.all([
      fetch(basePath + '/assets/sprites/bubble-waiting.json').then((r) => r.json()),
      fetch(basePath + '/assets/sprites/bubble-permission.json').then((r) => r.json()),
    ]);
    const bubbles = { waiting: decodeBubble(bubW), permission: decodeBubble(bubP) };

    // Identify all floor tile values used (e.g. 1, 7, 9). Load each PNG —
    // gracefully fall back to floor_7 if a value > 8 was referenced (Pablo's
    // shipped layout uses tile=9 but only floor_0..8 exist on disk).
    const floorIdxs = new Set();
    for (const t of LAYOUT) if (t !== 0 && t !== 255) floorIdxs.add(t);
    const floorImgs = {};
    let fallback = null;
    try { fallback = await loadImage(basePath + '/assets/floors/floor_7.png'); } catch (_) {}
    await Promise.all([...floorIdxs].map(async (i) => {
      try {
        floorImgs[i] = await loadImage(basePath + '/assets/floors/floor_' + i + '.png');
      } catch (_) {
        floorImgs[i] = fallback;
      }
    }));

    // Wall
    const wallImg = await loadImage(basePath + '/assets/walls/wall_0.png');

    // Per-tile colorize cache. Key = tileIdx + ':' + JSON(color). Value =
    // a 16×16 canvas with the adjustSprite math applied. Tiles share canvases.
    const tileCache = new Map();
    function getTileCanvas(idx, color) {
      const key = idx + ':' + (color ? JSON.stringify(color) : '_');
      let c = tileCache.get(key);
      if (c) return c;
      const src = idx === 0 ? cropTo16(wallImg) : floorImgs[idx];
      if (!src) return null;
      c = color ? adjust(src, color) : src;
      tileCache.set(key, c);
      return c;
    }

    // Furniture PNGs — load the whole small catalog so edit mode can place
    // items that were not present in the initial layout.
    const furnIds = new Set(Object.keys(FURN_CATALOG));
    furnIds.add('PC_FRONT_ON_1'); furnIds.add('PC_FRONT_ON_2'); furnIds.add('PC_FRONT_ON_3'); // for animation
    furnIds.add('COFFEE'); // used as a "on break" overlay at sofa chill spots
    const furniture = {};
    await Promise.all([...furnIds].map(async (id) => {
      const spec = FURN_CATALOG[id];
      if (!spec) return;
      const img = await loadImage(basePath + '/assets/furniture/' + spec.file);
      furniture[id] = { img, w: spec.w, h: spec.h };
    }));

    return { chars, bubbles, getTileCanvas, furniture };
  }

  // helper: crop a wall sheet (64×128) to the top-left 16×16 tile
  function cropTo16(img) {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = false;
    cx.drawImage(img, 0, 0, 16, 16, 0, 0, 16, 16);
    return c;
  }

  function applyOmoDefaultsIfNeeded(j) {
    if (j.omoCozy) return j;
    const next = {
      ...j,
      tiles: [...j.tiles],
      tileColors: Array.isArray(j.tileColors) ? [...j.tileColors] : new Array(j.cols * j.rows).fill(null),
      furniture: Array.isArray(j.furniture) ? j.furniture.map((f) => ({ ...f })) : [],
      omoCozy: true,
    };
    for (const bed of DORMITORY_BEDS) {
      if (!next.furniture.some((f) => f.uid === bed.uid)) {
        next.furniture.push({ uid: bed.uid, type: bed.baseType, col: bed.col, row: bed.row });
      }
    }
    const tint = { h: 25, s: 48, b: -43, c: -88 };
    for (let row = 19; row <= 20; row++) {
      for (let col = 11; col <= 18; col++) {
        const idx = row * next.cols + col;
        next.tiles[idx] = 1;
        next.tileColors[idx] = tint;
      }
    }
    next.furniture = next.furniture.filter((f) =>
      !(String(f.type || f.baseType) === 'SMALL_TABLE_FRONT' && f.col === 17 && f.row === 19)
    );
    const decor = [
      { uid: 'cozy_plant_l', type: 'PLANT_2', col: 11, row: 17 },
      { uid: 'cozy_plant_r', type: 'PLANT', col: 18, row: 17 },
      { uid: 'cozy_hang', type: 'HANGING_PLANT', col: 15, row: 9 },
    ];
    for (const item of decor) if (!next.furniture.some((f) => f.uid === item.uid)) next.furniture.push(item);
    return next;
  }

  function applyLayoutJson(raw) {
    const j = applyOmoDefaultsIfNeeded(raw);
    COLS = j.cols; ROWS = j.rows;
    LAYOUT = [...j.tiles];
    TILE_COLORS = Array.isArray(j.tileColors) ? [...j.tileColors] : new Array(COLS * ROWS).fill(null);
    FURNITURE_LAYOUT = (j.furniture || []).map((f, i) => {
      const p = parseFurnType(f.type || f.baseType);
      return {
        uid: f.uid || ('f_' + i),
        baseType: p.baseType,
        mirrored: p.mirrored,
        col: Number(f.col) | 0,
        row: Number(f.row) | 0,
      };
    });
    rebuildPathfinder();
    computeContentBox();
    for (const ch of characters) {
      const cc = tileCenter(ch.seatCol, ch.seatRow);
      ch.tileCol = ch.seatCol; ch.tileRow = ch.seatRow;
      ch.x = cc.x; ch.y = cc.y;
      ch.dir = ch.seatDir;
      ch.path = [];
    }
  }

  // ─── walking + wander state machine ──────────────────────────────────

  const WALK_PX_PER_SEC = 48;
  const WANDER_MIN = 3, WANDER_MAX = 12;
  const WANDER_MOVES_LIMIT = 4;

  function tileCenter(c, r) {
    return { x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 };
  }

  function startWalkTo(ch, col, row) {
    const path = findPath(ch.tileCol, ch.tileRow, col, row);
    if (path.length === 0) return false;
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = STATE.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  function frameDurationFor(s) {
    if (s === STATE.WALK) return FRAME_WALK_SEC;
    if (s === STATE.READ) return FRAME_READ_SEC;
    if (s === STATE.TYPE) return FRAME_TYPE_SEC;
    return 999;
  }

  function update(dt) {
    for (const ch of characters) {
      if (!ch.agentId) continue;     // vacant seat — skip all animation
      const dur = frameDurationFor(ch.state);
      ch.frameTimer += dt;
      if (ch.frameTimer >= dur) {
        ch.frameTimer -= dur;
        const frames = ch.state === STATE.WALK ? 3 : 2;
        ch.frame = (ch.frame + 1) % frames;
      }
      if (ch.bubbleTimer > 0) {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) { ch.bubbleType = null; ch.bubbleTimer = 0; }
      }
      if (ch.arrivalFlash > 0) ch.arrivalFlash = Math.max(0, ch.arrivalFlash - dt * 2);

      const atSeat = ch.tileCol === ch.seatCol && ch.tileRow === ch.seatRow;
      const wantsToWork = ch.requestedState === STATE.TYPE || ch.requestedState === STATE.READ;

      if (ch.state === STATE.WALK) {
        if (ch.path.length === 0) {
          const cc = tileCenter(ch.tileCol, ch.tileRow);
          ch.x = cc.x; ch.y = cc.y;
          if (wantsToWork && atSeat) {
            ch.state = ch.requestedState;
            ch.dir = ch.seatDir;
            ch.arrivalFlash = 1;
          } else if (wantsToWork && !atSeat) {
            if (!startWalkTo(ch, ch.seatCol, ch.seatRow)) ch.state = STATE.IDLE;
          } else {
            ch.state = STATE.IDLE;
            ch.wanderTimer = WANDER_MIN + Math.random() * (WANDER_MAX - WANDER_MIN);
          }
          continue;
        }
        const next = ch.path[0];
        ch.dir = dirBetween(ch.tileCol, ch.tileRow, next.col, next.row);
        ch.moveProgress += (WALK_PX_PER_SEC / TILE) * dt;
        const from = tileCenter(ch.tileCol, ch.tileRow);
        const to   = tileCenter(next.col, next.row);
        const t = Math.min(ch.moveProgress, 1);
        ch.x = from.x + (to.x - from.x) * t;
        ch.y = from.y + (to.y - from.y) * t;
        if (ch.moveProgress >= 1) {
          ch.tileCol = next.col;
          ch.tileRow = next.row;
          ch.x = to.x; ch.y = to.y;
          ch.path.shift();
          ch.moveProgress = 0;
        }
        continue;
      }

      if (wantsToWork) {
        // Work arrives — drop the chill target and head home.
        if (ch.chillTarget) {
          ch.chillTarget = null;
          ch.atChillSpot = false;
        }
        if (atSeat) {
          ch.state = ch.requestedState;
          ch.dir = ch.seatDir;
        } else {
          startWalkTo(ch, ch.seatCol, ch.seatRow);
        }
        continue;
      }

      if (ch.state === STATE.IDLE) {
        // Off-duty behavior:
        //   • If task arrives (handled above via wantsToWork), walk home.
        //   • Otherwise, count down. When timer hits 0, pick a random
        //     chill spot (bed or sofa) and walk there.
        //   • Once at the chill spot, stay there. The next task_start
        //     will route the agent back to their seat.
        //   • If somehow they're at the seat but the chill timer
        //     elapsed, kick off a walk to a chill spot.
        const spots = CHILL_SPOTS[ch.slot] || [];
        const atChillTarget = ch.chillTarget &&
          ch.tileCol === ch.chillTarget.col && ch.tileRow === ch.chillTarget.row;

        if (atChillTarget) {
          // already lounging — just face the right way; reset for the
          // next idle cycle so they wander between bed and sofa later.
          ch.atChillSpot = true;
          ch.dir = DIR[ch.chillTarget.dir] ?? DIR.DOWN;
          if (ch.chillCountdown <= 0) {
            // periodically (every 60-180s) flip to the other chill spot
            ch.chillCountdown = 60 + Math.random() * 120;
          } else {
            ch.chillCountdown -= dt;
            if (ch.chillCountdown <= 0 && spots.length > 1) {
              // pick a different spot than the current one
              const others = spots.filter((s) => !(s.col === ch.chillTarget.col && s.row === ch.chillTarget.row));
              if (others.length) {
                const next = others[Math.floor(Math.random() * others.length)];
                ch.chillTarget = next;
                ch.atChillSpot = false;
                startWalkTo(ch, next.col, next.row);
              }
            }
          }
          break;
        }

        if (!atSeat && !ch.chillTarget) {
          // mid-walk somewhere, no target set — drift home
          startWalkTo(ch, ch.seatCol, ch.seatRow);
          break;
        }

        if (atSeat) {
          if (ch.dir !== ch.seatDir) ch.dir = ch.seatDir;
          ch.atChillSpot = false;
          // Activity-driven: only consider chilling if no task event has
          // touched this agent in IDLE_BEFORE_CHILL_MS. Any task_start,
          // tool_start, or tool_end bumps lastActivityAt elsewhere.
          const idleFor = Date.now() - (ch.lastActivityAt || Date.now());
          if (idleFor >= IDLE_BEFORE_CHILL_MS && spots.length > 0) {
            const target = spots[Math.floor(Math.random() * spots.length)];
            ch.chillTarget = target;
            if (!startWalkTo(ch, target.col, target.row)) {
              ch.chillTarget = null;
              // try again on next tick
              ch.lastActivityAt = Date.now() - (IDLE_BEFORE_CHILL_MS - 5_000);
            }
          }
        }
      }
    }

    // Sub-agent linked characters: walk out → work at station → walk back
    // → despawn. Mirrors the main-character state machine but on a much
    // shorter timeline.
    for (let i = subAgents.length - 1; i >= 0; i--) {
      const sa = subAgents[i];
      const dur = frameDurationFor(sa.state);
      sa.frameTimer += dt;
      if (sa.frameTimer >= dur) {
        sa.frameTimer -= dur;
        const frames = sa.state === STATE.WALK ? 3 : 2;
        sa.frame = (sa.frame + 1) % frames;
      }
      if (sa.arrivalFlash > 0) sa.arrivalFlash = Math.max(0, sa.arrivalFlash - dt * 2);

      if (sa.state === STATE.WALK) {
        if (sa.path.length === 0) {
          // try to grab a path toward the next phase target.
          if (sa.phase === 'walking-out') {
            if (!startWalkTo(sa, sa.station.col, sa.station.row)) {
              sa.phase = 'working';
              sa.state = STATE.READ;
              sa.dir = DIR[sa.station.dir] ?? DIR.DOWN;
            }
          } else if (sa.phase === 'returning') {
            // arrived back near the parent — despawn.
            sa.phase = 'done';
            sa.state = STATE.IDLE;
            sa.doneAt = Date.now();
          }
        } else {
          const next = sa.path[0];
          sa.dir = dirBetween(sa.tileCol, sa.tileRow, next.col, next.row);
          sa.moveProgress += (WALK_PX_PER_SEC / TILE) * dt;
          const from = tileCenter(sa.tileCol, sa.tileRow);
          const to   = tileCenter(next.col, next.row);
          const t = Math.min(sa.moveProgress, 1);
          sa.x = from.x + (to.x - from.x) * t;
          sa.y = from.y + (to.y - from.y) * t;
          if (sa.moveProgress >= 1) {
            sa.tileCol = next.col;
            sa.tileRow = next.row;
            sa.x = to.x; sa.y = to.y;
            sa.path.shift();
            sa.moveProgress = 0;
            if (sa.path.length === 0 && sa.phase === 'walking-out') {
              // arrived at station — enter "working" phase.
              sa.phase = 'working';
              sa.state = stationKindForTool(sa.tool) === 'web' ? STATE.READ : STATE.TYPE;
              sa.dir = DIR[sa.station.dir] ?? DIR.DOWN;
              sa.arrivalFlash = 0.6;
            }
          }
        }
      } else if (sa.phase === 'working') {
        sa.workTimer += dt;
        // safety: even if despawnSubAgent never fires, return home after
        // maxWorkSec so we never leak sprites.
        if (sa.workTimer >= sa.maxWorkSec * 6) {
          sa.phase = 'returning';
          const parent = charBySlot[sa.parentSlot];
          const target = parent ? { col: parent.seatCol, row: parent.seatRow } : null;
          if (target && !startWalkTo(sa, target.col, target.row)) {
            sa.phase = 'done';
            sa.doneAt = Date.now();
          }
        }
      }

      if (sa.phase === 'done') {
        // hold for a beat so the despawn isn't instant, then remove.
        if (Date.now() - sa.doneAt > 400) subAgents.splice(i, 1);
      }
    }

    pcFrameTimer += dt;
    if (pcFrameTimer >= PC_FRAME_SEC) {
      pcFrameTimer -= PC_FRAME_SEC;
      pcFrame = (pcFrame + 1) % 3;
    }
  }

  // ─── render ───────────────────────────────────────────────────────────

  function computeScale() {
    // Fit the *content* of the room (CONTENT_BOX) into the canvas, not
    // the full COLS×ROWS grid — Pablo's layout has VOID tiles above the
    // building, and we don't want those to push the visible room into a
    // small corner of the canvas.
    const PAD = 24;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(0, rect.width  - PAD * 2);
    const h = Math.max(0, rect.height - PAD * 2);
    const cw = (CONTENT_BOX.maxC - CONTENT_BOX.minC + 1) * TILE;
    const ch = (CONTENT_BOX.maxR - CONTENT_BOX.minR + 1) * TILE;
    const sx = w / cw;
    const sy = h / ch;
    return Math.max(1.5, Math.min(sx, sy));
  }

  function fitCanvas() {
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const want_w = Math.floor(w * dpr);
    const want_h = Math.floor(h * dpr);
    if (canvas.width  !== want_w) canvas.width  = want_w;
    if (canvas.height !== want_h) canvas.height = want_h;
    ctx.imageSmoothingEnabled = false;
    return dpr;
  }

  function renderTransform(dpr = Math.min(window.devicePixelRatio || 1, 2)) {
    const scale = computeScale() * dpr;
    const contentCols = (CONTENT_BOX.maxC - CONTENT_BOX.minC + 1);
    const contentRows = (CONTENT_BOX.maxR - CONTENT_BOX.minR + 1);
    const contentW = contentCols * TILE * scale;
    const contentH = contentRows * TILE * scale;
    const baseX = Math.floor((canvas.width - contentW) / 2);
    const baseY = Math.floor((canvas.height - contentH) / 2);
    return {
      dpr,
      scale,
      offsetX: baseX - CONTENT_BOX.minC * TILE * scale,
      offsetY: baseY - CONTENT_BOX.minR * TILE * scale,
    };
  }

  function drawCharacter(ch) {
    const sheet = assets.chars[ch.sheetIndex % assets.chars.length];
    const { sx, sy } = spriteSlice(ch.state, ch.dir, ch.frame);
    const px = Math.round(ch.x - CHAR_W / 2);
    const py = Math.round(ch.y + TILE / 2 - CHAR_H);
    if (ch.dir === DIR.LEFT) {
      ctx.save();
      ctx.translate(px + CHAR_W, py);
      ctx.scale(-1, 1);
      ctx.drawImage(sheet, sx, sy, CHAR_W, CHAR_H, 0, 0, CHAR_W, CHAR_H);
      ctx.restore();
    } else {
      ctx.drawImage(sheet, sx, sy, CHAR_W, CHAR_H, px, py, CHAR_W, CHAR_H);
    }
  }

  // Resolve a furniture instance's PNG (handles PC animation for the
  // agents assigned to PC tiles)
  function furnitureKey(f) {
    if (f.baseType !== 'PC_FRONT_OFF') return f.baseType;
    // find the agent owning this PC tile (PC at (col,row), seat at adjacent)
    const owner = characters.find((c) => {
      // for front PC at (col,row), agent sits at (col, row-1)
      return c.seatCol === f.col && c.seatRow === f.row - 1;
    });
    if (!owner) return 'PC_FRONT_OFF';
    if (owner.state === STATE.TYPE) return 'PC_FRONT_ON_' + (pcFrame + 1);
    if (owner.state === STATE.READ) return 'PC_FRONT_ON_2';
    return 'PC_FRONT_OFF';
  }

  function drawFurniture(f) {
    const id = furnitureKey(f);
    const def = assets.furniture[id];
    if (!def) return;
    if (f.mirrored) {
      ctx.save();
      ctx.translate(f.col * TILE + def.w, f.row * TILE);
      ctx.scale(-1, 1);
      ctx.drawImage(def.img, 0, 0, def.w, def.h);
      ctx.restore();
    } else {
      ctx.drawImage(def.img, f.col * TILE, f.row * TILE);
    }
  }

  // Pill-shaped name label that floats over each character's head — a
  // proper readable chip rather than faint canvas text. Uses an ivory
  // surface with a soft drop shadow + a status dot tinted with the
  // agent's color, plus an inset row for the live tool tooltip and call
  // counter.
  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y,         x + w, y + h, rr);
    ctx.arcTo(x + w, y + h,     x,     y + h, rr);
    ctx.arcTo(x,     y + h,     x,     y,     rr);
    ctx.arcTo(x,     y,         x + w, y,     rr);
    ctx.closePath();
  }
  function drawNameTag(ch, scale) {
    if (!ch.display) return;
    const cx = ch.x * scale;
    // Pill bottom sits just at the top of the head (small overlap looks
    // intentional, anchors the chip to the avatar instead of floating).
    const tipY = (ch.y + TILE / 2 - CHAR_H + 2) * scale;
    // Primary name chip: dot + name (+ optional role muted-suffix).
    ctx.save();
    ctx.font = '600 11.5px Inter, system-ui, sans-serif';
    const nameText = ch.display;
    const roleText = ch.role ? '· ' + ch.role : '';
    const nameW   = ctx.measureText(nameText).width;
    ctx.font = '500 10.5px Inter, system-ui, sans-serif';
    const roleW   = roleText ? ctx.measureText(roleText).width : 0;
    const PAD_X = 8, PAD_Y = 4, GAP = 6, DOT = 6;
    const innerW = DOT + GAP + nameW + (roleText ? 5 + roleW : 0);
    const chipW = innerW + PAD_X * 2;
    const chipH = 20;
    const chipX = Math.round(cx - chipW / 2);
    const chipY = Math.round(tipY - chipH);
    // shadow
    ctx.shadowColor = 'rgba(45, 42, 38, 0.18)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#FAF9F6';   // ivory surface
    roundRect(chipX, chipY, chipW, chipH, 999);
    ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    // border (subtle hairline)
    ctx.strokeStyle = 'rgba(45, 42, 38, 0.10)';
    ctx.lineWidth = 1;
    roundRect(chipX + 0.5, chipY + 0.5, chipW - 1, chipH - 1, 999);
    ctx.stroke();
    // status dot
    const dotX = chipX + PAD_X + DOT / 2;
    const dotY = chipY + chipH / 2;
    ctx.fillStyle = ch.color || '#A09C92';
    ctx.beginPath();
    ctx.arc(dotX, dotY, DOT / 2, 0, Math.PI * 2);
    ctx.fill();
    // soft glow ring when currently working (state !== IDLE) — reads as
    // "active right now"
    if (ch.state && ch.state !== STATE.IDLE) {
      ctx.strokeStyle = ch.color || '#A09C92';
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dotX, dotY, DOT / 2 + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // name + role
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '600 11.5px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#2D2A26';
    const nameX = chipX + PAD_X + DOT + GAP;
    ctx.fillText(nameText, nameX, dotY + 0.5);
    if (roleText) {
      ctx.font = '500 10.5px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#A09C92';
      ctx.fillText(roleText, nameX + nameW + 5, dotY + 0.5);
    }
    ctx.restore();

    // Secondary line: live tool tooltip + call counter. Smaller, monospace,
    // sits BELOW the chip so it doesn't break the silhouette.
    const subParts = [];
    if (ch.currentTool) subParts.push(toolToVerb(ch.currentTool) + '…');
    if (ch.toolCallCount > 0) {
      subParts.push(ch.toolCallCount === 1 ? '1 call' : ch.toolCallCount + ' calls');
    }
    if (subParts.length) {
      ctx.save();
      ctx.font = '500 9.5px JetBrains Mono, ui-monospace, monospace';
      const sub = subParts.join('  ·  ');
      const subW = ctx.measureText(sub).width;
      const subPad = 6, subH = 14;
      const subChipW = subW + subPad * 2;
      const subX = Math.round(cx - subChipW / 2);
      const subY = Math.round(chipY - subH - 4);
      ctx.shadowColor = 'rgba(45, 42, 38, 0.12)';
      ctx.shadowBlur = 4;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = 'rgba(250, 249, 246, 0.94)';
      roundRect(subX, subY, subChipW, subH, 999);
      ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      ctx.fillStyle = ch.currentTool ? '#6B6760' : '#A09C92';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(sub, subX + subChipW / 2, subY + subH / 2 + 0.5);
      ctx.restore();
    }
  }

  function render() {
    const dpr = fitCanvas();
    const { scale, offsetX, offsetY } = renderTransform(dpr);

    ctx.fillStyle = '#F5F4ED';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!assets) return;

    // Tile + furniture + character render — in scaled tile-px space
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Floor + walls — drawn first
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = LAYOUT[r * COLS + c];
        if (idx === 255) continue;
        const color = TILE_COLORS[r * COLS + c];
        const tcv = assets.getTileCanvas(idx, color);
        if (tcv) ctx.drawImage(tcv, c * TILE, r * TILE);
      }
    }

    // Drawables (furniture + characters) sorted by foot Y for depth
    const drawables = [];
    for (const f of FURNITURE_LAYOUT) {
      const def = assets.furniture[f.baseType];
      if (!def) continue;
      let bottomY = f.row * TILE + def.h;
      let bias = 0;
      if (WALL_TYPES.has(f.baseType))    bias = -10;
      if (OVERLAY_TYPES.has(f.baseType)) bias = 5;
      // PC_SIDE units sit ON TOP of TABLE_FRONT — push their sort key
      // past the table (which is 4 tiles tall) so the table doesn't
      // obscure them. Characters are at adjacent columns so this won't
      // make PCs cover people.
      if (f.baseType === 'PC_SIDE') bottomY += 80;
      drawables.push({ zY: bottomY, zBias: bias, kind: 'furn', ref: f });
    }
    for (const ch of characters) {
      if (!ch.agentId) continue;     // vacant seat — don't draw
      const bottomY = ch.y + TILE / 2;
      drawables.push({ zY: bottomY, zBias: 0, kind: 'char', ref: ch });
    }
    for (const sa of subAgents) {
      const bottomY = sa.y + TILE / 2;
      drawables.push({ zY: bottomY, zBias: 1, kind: 'subagent', ref: sa });
    }
    drawables.sort((a, b) => (a.zY - b.zY) || (a.zBias - b.zBias));

    for (const d of drawables) {
      if (d.kind === 'furn') {
        drawFurniture(d.ref);
      } else if (d.kind === 'subagent') {
        const sa = d.ref;
        if (sa.arrivalFlash > 0) {
          const a = sa.arrivalFlash;
          const rad = TILE * (0.6 + (1 - a) * 0.5);
          const grad = ctx.createRadialGradient(sa.x, sa.y - TILE / 2, 0, sa.x, sa.y - TILE / 2, rad);
          grad.addColorStop(0, `rgba(111, 168, 176, ${0.45 * a})`);
          grad.addColorStop(1, `rgba(111, 168, 176, 0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(sa.x - rad, sa.y - TILE / 2 - rad, rad * 2, rad * 2);
        }
        // sub-agents render at ~80% alpha so they read as ephemeral helpers
        const prevAlpha = ctx.globalAlpha;
        ctx.globalAlpha = prevAlpha * 0.78;
        drawCharacter(sa);
        ctx.globalAlpha = prevAlpha;
      } else {
        const ch = d.ref;
        if (ch.arrivalFlash > 0) {
          const a = ch.arrivalFlash;
          const rad = TILE * (1.0 + (1 - a) * 0.8);
          const grad = ctx.createRadialGradient(ch.x, ch.y - TILE / 2, 0, ch.x, ch.y - TILE / 2, rad);
          grad.addColorStop(0, `rgba(227, 117, 83, ${0.55 * a})`);
          grad.addColorStop(1, `rgba(227, 117, 83, 0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(ch.x - rad, ch.y - TILE / 2 - rad, rad * 2, rad * 2);
        }
        drawCharacter(ch);
      }
    }
    // Chill-spot overlays — z z z at beds, coffee mug at sofas. Drawn in
    // the same scaled tile-px space as characters so the position stays
    // glued to the sprite. Kept inside the existing ctx.save/restore
    // block.
    const tNow = Date.now() / 1000;
    for (const ch of characters) {
      if (!ch.agentId) continue;
      if (!ch.atChillSpot || !ch.chillTarget) continue;
      if (ch.chillTarget.kind === 'bed') {
        // Three drifting z's, staggered, fading. Use a soft serif-ish
        // font for a sleepy feel.
        ctx.save();
        ctx.font = 'italic 600 6px Inter, ui-sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (let i = 0; i < 3; i++) {
          const phase = (tNow * 0.6 + i * 0.5) % 1;
          const dx = ch.x + 4 + i * 2.5 + phase * 1.5;
          const dy = ch.y - CHAR_H + 10 - i * 3 - phase * 4;
          const alpha = (1 - phase) * 0.85;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = '#6FA8B0';
          ctx.fillText('z', dx, dy);
        }
        ctx.restore();
      } else if (ch.chillTarget.kind === 'sofa') {
        const cup = assets.furniture?.COFFEE;
        if (cup) {
          // Tiny mug floating next to the sprite — half-tile size, bobs
          // gently. Side depends on which way they're facing so it never
          // lands inside their head.
          const bob = Math.sin(tNow * 1.4 + ch.x * 0.1) * 0.5;
          const side = ch.dir === DIR.LEFT ? -1 : 1;
          const offsetX = side * 6;
          const dx = Math.round(ch.x + offsetX - cup.w / 4);
          const dy = Math.round(ch.y - CHAR_H + 14 + bob);
          ctx.save();
          ctx.globalAlpha = 0.95;
          ctx.drawImage(cup.img, 0, 0, cup.w, cup.h, dx, dy, cup.w / 2, cup.h / 2);
          ctx.restore();
        }
      }
    }

    ctx.restore();

    // Name tags (CSS-px space)
    ctx.save();
    ctx.translate(offsetX, offsetY);
    for (const ch of characters) {
      if (!ch.agentId) continue;
      drawNameTag(ch, scale);
    }
    ctx.restore();

    // Bubbles (CSS-px space, on top of labels)
    ctx.save();
    ctx.translate(offsetX, offsetY);
    for (const ch of characters) {
      if (!ch.agentId) continue;
      if (!ch.bubbleType || !assets.bubbles[ch.bubbleType]) continue;
      const b = assets.bubbles[ch.bubbleType];
      const BSCALE = scale * 1.3;
      const bw = b.width * BSCALE, bh = b.height * BSCALE;
      const bx = Math.round(ch.x * scale - bw / 2);
      const labelTopPx = (ch.y + TILE / 2 - CHAR_H - 26) * scale;
      let by = Math.round(labelTopPx - bh - 4);
      if (by < 4) by = Math.round((ch.y + TILE / 2 + 4) * scale);
      const fade = ch.bubbleTimer < 0.6 ? Math.max(0, ch.bubbleTimer / 0.6) : 1;
      ctx.globalAlpha = fade;
      ctx.shadowColor = 'rgba(45, 42, 38, 0.25)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      ctx.drawImage(b, bx, by, bw, bh);
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    ctx.restore();
  }

  // ─── loop + start ─────────────────────────────────────────────────────
  //
  // The loop is rAF-driven; update() runs pathfinding + animation state for
  // every character + sub-agent, render() clears and redraws the entire
  // canvas. That's the heaviest visual cost on /squad — and 100% of it is
  // wasted when the tab is hidden (browsers throttle backgrounded rAF to
  // ~1Hz but still call us, so the loop wakes up periodically with a long
  // dt, snap-forwards animations, and burns CPU on the resume frame). We
  // hard-pause via cancelAnimationFrame on visibilitychange and re-arm on
  // resume; lastTime is reset so we don't lurch on the first visible frame.

  let rafId = 0, stopped = false, paused = false, lastTime = 0;
  function loop(time) {
    if (stopped || paused) { rafId = 0; return; }
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, 0.1);
    lastTime = time;
    update(dt);
    render();
    rafId = requestAnimationFrame(loop);
  }
  function setPaused(v) {
    const next = !!v;
    if (next === paused) return;
    paused = next;
    if (paused) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lastTime = 0;
    } else if (!stopped && !rafId) {
      rafId = requestAnimationFrame(loop);
    }
  }

  async function start() {
    // 1) Fetch the persisted user layout. Fallback to the bundled default
    // if the API is unavailable during static development.
    let j;
    try {
      const res = await fetch('/omo/api/squad/layout');
      if (!res.ok) throw new Error('layout api ' + res.status);
      j = await res.json();
    } catch (_) {
      j = await fetch(basePath + '/assets/default-layout-1.json').then((r) => r.json());
    }
    applyLayoutJson(j);
    // 3) Load all assets
    assets = await loadAssets();
    // 4) Wire up visibility-driven pause. If the tab loads in the
    // background (e.g. ⌘-T then ⌘-click), skip the first paint until the
    // user actually looks at it.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => setPaused(document.hidden));
      if (document.hidden) { paused = true; return; }
    }
    // 5) Start the loop
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function setAgentState(ref, state, _dir) {
    const ch = resolveCharacter(ref);
    if (!ch || !ch.agentId) return;
    if (state) ch.requestedState = state;
    // Any non-IDLE state means there's task activity — keep them at their
    // seat (don't drift off to chill spots).
    if (state && state !== STATE.IDLE) ch.lastActivityAt = Date.now();
    if (state === STATE.IDLE && ch.tileCol === ch.seatCol && ch.tileRow === ch.seatRow) {
      ch.state = STATE.IDLE;
      ch.dir = ch.seatDir;
      ch.chillTarget = null;
      ch.atChillSpot = false;
    }
    ch.frame = 0;
    ch.frameTimer = 0;
  }

  // Bump the activity timer without changing state — used by tool_end so
  // the agent stays "at work" between tool calls instead of drifting off.
  function recordActivity(ref) {
    const ch = resolveCharacter(ref);
    if (!ch || !ch.agentId) return;
    ch.lastActivityAt = Date.now();
  }

  // Set/clear the "reading file…" / "searching web…" tooltip and bump the
  // tool-call counter. Pass `tool: null` to clear.
  function setAgentTool(ref, tool) {
    const ch = resolveCharacter(ref);
    if (!ch || !ch.agentId) return;
    ch.currentTool = tool || null;
    ch.lastActivityAt = Date.now();
  }
  function bumpAgentToolCount(ref) {
    const ch = resolveCharacter(ref);
    if (!ch || !ch.agentId) return;
    ch.toolCallCount = (ch.toolCallCount || 0) + 1;
    ch.lastActivityAt = Date.now();
  }

  // Spawn a sub-agent linked character next to the parent. Returns the
  // sub-agent's uid so the caller can despawn it later.
  function spawnSubAgent(parentRef, { tool = '', uid = null } = {}) {
    const parent = resolveCharacter(parentRef);
    if (!parent || !parent.agentId) return null;
    // cap at 6 concurrent sub-agents so the office never gets overcrowded.
    if (subAgents.length >= 6) return null;
    const sa = makeSubAgent(parent, tool, { uid });
    subAgents.push(sa);
    return sa.uid;
  }

  // Despawn a sub-agent by uid (returns home + fades out). If uid is
  // omitted, despawns the oldest sub-agent of the given parent.
  function despawnSubAgent(parentRef, { uid = null, tool = null } = {}) {
    const parent = resolveCharacter(parentRef);
    if (!parent) return false;
    let target = null;
    if (uid) target = subAgents.find((s) => s.uid === uid);
    else if (tool) target = subAgents.find((s) => s.parentSlot === parent.slot && s.tool === tool && s.phase !== 'returning' && s.phase !== 'done');
    else target = subAgents.find((s) => s.parentSlot === parent.slot && s.phase !== 'returning' && s.phase !== 'done');
    if (!target) return false;
    target.phase = 'returning';
    target.state = STATE.WALK;
    if (!startWalkTo(target, parent.seatCol, parent.seatRow)) {
      target.phase = 'done';
      target.doneAt = Date.now();
    }
    return true;
  }

  // Change which of the 6 sprite sheets a seat uses (shift+click reskin).
  function setCharacterSprite(ref, sheetIndex) {
    const ch = resolveCharacter(ref);
    if (!ch) return false;
    const idx = ((sheetIndex | 0) % 6 + 6) % 6;
    ch.sheetIndex = idx;
    return true;
  }

  function setAgentBubble(ref, type, durationSec = 2) {
    const ch = resolveCharacter(ref);
    if (!ch || !ch.agentId) return;
    ch.bubbleType = type;
    ch.bubbleTimer = durationSec;
  }

  function getCharacters() {
    return characters
      .filter((c) => c.agentId)
      .map((c) => ({
        slot: c.slot,
        agentId: c.agentId,
        display: c.display,
        role: c.role,
        state: c.state,
        color: c.color,
      }));
  }

  // Assign an identity to one of the 4 chairs. `seat` is 0..3. Idempotent —
  // re-assigning the same agent to the same seat refreshes their name/color
  // without re-flashing the arrival animation.
  function assignSeat(seat, { id, name, color, role } = {}) {
    if (!id) return null;
    const ch = characters[seat];
    if (!ch) return null;
    // If this agent is already on stage in a different seat, move them?
    // For simplicity: refuse the reassign and just return the existing seat.
    const existing = charByAgentId.get(id);
    if (existing && existing !== ch) return existing.slot;
    const isNew = ch.agentId !== id;
    ch.agentId = id;
    ch.display = name || id;
    ch.color = color || ch.color;
    ch.role = role || null;
    charByAgentId.set(id, ch);
    if (isNew) {
      // Park them at the seat, face the desk, give a brief arrival flash.
      const cc = tileCenter(ch.seatCol, ch.seatRow);
      ch.tileCol = ch.seatCol; ch.tileRow = ch.seatRow;
      ch.x = cc.x; ch.y = cc.y;
      ch.dir = ch.seatDir;
      ch.state = STATE.IDLE;
      ch.requestedState = STATE.IDLE;
      ch.path = [];
      ch.moveProgress = 0;
      ch.arrivalFlash = 1;
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
      ch.chillTarget = null;
      ch.atChillSpot = false;
      ch.lastActivityAt = Date.now();
      ch.currentTool = null;
      ch.toolCallCount = 0;
    }
    return ch.slot;
  }

  function releaseSeat(ref) {
    const ch = resolveCharacter(ref);
    if (!ch) return false;
    if (ch.agentId) charByAgentId.delete(ch.agentId);
    // despawn any sub-agents owned by this seat — they shouldn't outlive
    // their parent.
    for (let i = subAgents.length - 1; i >= 0; i--) {
      if (subAgents[i].parentSlot === ch.slot) subAgents.splice(i, 1);
    }
    ch.agentId = null;
    ch.display = null;
    ch.role = null;
    ch.color = '#A09C92';
    ch.state = STATE.IDLE;
    ch.requestedState = STATE.IDLE;
    ch.path = [];
    ch.bubbleType = null;
    ch.bubbleTimer = 0;
    ch.arrivalFlash = 0;
    ch.currentTool = null;
    ch.toolCallCount = 0;
    return true;
  }

  function findSeatByAgentId(id) {
    const ch = charByAgentId.get(id);
    return ch ? ch.slot : null;
  }

  // Hit-test a canvas-relative (CSS-px) point against character sprites.
  // Returns the slot id of the topmost-hit character, or null. Boxes are
  // approximated as the sprite's 16w × 32h footprint, slightly expanded to
  // make small sprites easy to click on a big monitor.
  function hitTestAt(cssX, cssY) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { scale, offsetX, offsetY } = renderTransform(dpr);
    // The canvas was scaled to dpr, but the listener gives us CSS px.
    const x = cssX * dpr;
    const y = cssY * dpr;
    // Iterate back-to-front so foreground characters win.
    const sorted = [...characters].filter((c) => c.agentId).sort((a, b) => b.y - a.y);
    const PAD_X = 6, PAD_Y = 8;
    for (const ch of sorted) {
      const left   = offsetX + (ch.x - CHAR_W / 2) * scale - PAD_X;
      const right  = offsetX + (ch.x + CHAR_W / 2) * scale + PAD_X;
      const top    = offsetY + (ch.y + TILE / 2 - CHAR_H) * scale - PAD_Y;
      const bottom = offsetY + (ch.y + TILE / 2) * scale + PAD_Y;
      if (x >= left && x <= right && y >= top && y <= bottom) {
        return { agentId: ch.agentId, slot: ch.slot };
      }
    }
    return null;
  }

  // Return the CSS-px position of a character's head (and a footprint
  // box), so callers can anchor a popover/glassmorphic panel to the
  // sprite. Mirrors the offset math in hitTestAt.
  function getSlotAnchor(ref) {
    const ch = resolveCharacter(ref);
    if (!ch) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { scale, offsetX, offsetY } = renderTransform(dpr);
    // sprite footprint in canvas (device) px, then back to CSS px.
    const left   = (offsetX + (ch.x - CHAR_W / 2) * scale) / dpr;
    const right  = (offsetX + (ch.x + CHAR_W / 2) * scale) / dpr;
    const top    = (offsetY + (ch.y + TILE / 2 - CHAR_H) * scale) / dpr;
    const bottom = (offsetY + (ch.y + TILE / 2) * scale) / dpr;
    return {
      head:   { x: (left + right) / 2, y: top },
      center: { x: (left + right) / 2, y: (top + bottom) / 2 },
      box:    { left, right, top, bottom, width: right - left, height: bottom - top },
      color:  ch.color,
    };
  }

  return {
    start, stop, setPaused,
    setAgentState, setAgentBubble,
    recordActivity, setAgentTool, bumpAgentToolCount,
    spawnSubAgent, despawnSubAgent,
    setCharacterSprite,
    getCharacters, hitTestAt, getSlotAnchor,
    assignSeat, releaseSeat, findSeatByAgentId,
    SEATS: SEATS_SPEC,
  };
}
