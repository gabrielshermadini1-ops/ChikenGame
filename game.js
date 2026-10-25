/*
 * PARROT CROSSING — a tiny endless hopper drawn with the 2D Canvas.
 *
 * World coordinates
 *   x : sideways (tiles). Playable columns are 0 .. COLS-1.
 *   z : forward (rows). Row z occupies z-0.5 .. z+0.5.
 *   y : up (tile heights).
 * Everything is projected with a simple isometric camera (see proj helpers),
 * and boxes are painted back-to-front to create the low-poly 3D illusion.
 */
(() => {
  'use strict';

  /* ===================================================================
   * Configuration
   * =================================================================== */
  const COLS = 9;                       // playable columns
  const MID = 4;                        // spawn column
  const RING_MIN = -22;                 // lanes loop between these x values
  const RING_MAX = COLS + 22;
  const RING_LEN = RING_MAX - RING_MIN;
  const HOP_TIME = 0.15;                // seconds per hop
  const HOP_HEIGHT = 0.55;
  const AHEAD = 26;                     // rows generated in front of the player
  const KEEP_BEHIND = 22;               // rows kept behind the best row
  const MAX_BACK = 5;                   // how far back the player may retreat
  const LOG_TOP = 0.1;                  // height of a log's top surface
  const BEST_KEY = 'parrotCrossing.best';

  const GRASS_H = 0.18, ROAD_H = 0, WATER_H = -0.12;

  const CAR_COLORS = ['#ff5a5f', '#ffb400', '#3ea8ff', '#a66bff', '#3ddc97', '#ff8a3d', '#f2f2f2', '#ff6fb5'];
  const FLOWER_COLORS = ['#ffffff', '#ffd93d', '#ff7eb6', '#ff9f43'];

  /* ===================================================================
   * Small helpers
   * =================================================================== */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const wrapX = (x) => ((x - RING_MIN) % RING_LEN + RING_LEN) % RING_LEN + RING_MIN;

  const shadeCache = new Map();
  /** Multiply a #rrggbb colour by a brightness factor. */
  function shade(hex, f) {
    const key = hex + f;
    let v = shadeCache.get(key);
    if (v) return v;
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
    const b = Math.min(255, Math.round((n & 255) * f));
    v = `rgb(${r},${g},${b})`;
    shadeCache.set(key, v);
    return v;
  }
  const faceCache = new Map();
  /** Top / left / right face colours for a box (light from the upper left). */
  function faces(hex) {
    let f = faceCache.get(hex);
    if (!f) {
      f = { top: shade(hex, 1.06), left: shade(hex, 0.84), right: shade(hex, 0.66) };
      faceCache.set(hex, f);
    }
    return f;
  }

  /* ===================================================================
   * DOM / canvas
   * =================================================================== */
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);
  const ui = {
    score: $('score'), best: $('best'),
    start: $('startScreen'), pause: $('pauseScreen'), over: $('overScreen'),
    finalScore: $('finalScore'), finalBest: $('finalBest'), overNote: $('overNote'),
    pauseBtn: $('pauseBtn'), dpad: $('dpad'),
  };

  /** View / camera state used by every draw call. */
  const V = { w: 0, h: 0, dpr: 1, S: 50, hw: 50, hh: 25, hv: 47, ox: 0, oy: 0, cx: MID, cz: 0, sky: null };

  function resize() {
    V.w = window.innerWidth;
    V.h = window.innerHeight;
    V.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(V.w * V.dpr);
    canvas.height = Math.round(V.h * V.dpr);
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    V.S = clamp(Math.min(V.w / 12, V.h / 12), 28, 76);   // pixels per tile (half diagonal)
    V.hw = V.S;
    V.hh = V.S * 0.5;
    V.hv = V.S * 0.95;
    // Where the camera target sits on screen: lower-left of centre so the forward diagonal has room.
    V.ox = V.w * (V.w < V.h ? 0.38 : 0.42);
    V.oy = V.h * 0.64;
    V.sky = ctx.createLinearGradient(0, 0, 0, V.h);
    V.sky.addColorStop(0, '#a9e4ff');
    V.sky.addColorStop(1, '#e8f8ff');
  }

  /* ===================================================================
   * World: rows, lanes and procedural generation
   * =================================================================== */

  /** A lane of moving things (cars or logs) that loops around the ring. */
  class Lane {
    constructor(kind, dir, speed) {
      this.kind = kind;       // 'road' | 'river'
      this.dir = dir;         // +1 / -1
      this.speed = speed;     // tiles per second
      this.items = [];        // { x, len, ... }
    }
    update(dt) {
      const d = this.dir * this.speed * dt;
      for (const it of this.items) it.x = wrapX(it.x + d);   // same speed => spacing never changes
    }
    /** Log under world-x `px`, or null. */
    logAt(px) {
      for (const it of this.items) if (Math.abs(px - it.x) <= it.len / 2 - 0.04) return it;
      return null;
    }
  }

  /**
   * Spread items around the ring with a guaranteed minimum gap.
   * `makeItem` returns { len, ... }.
   */
  function fillLane(lane, spacingMin, spacingMax, minGap, maxLen, makeItem) {
    const n = Math.max(2, Math.min(Math.round(RING_LEN / rand(spacingMin, spacingMax)), Math.floor(RING_LEN / (maxLen + minGap))));
    const items = [];
    for (let i = 0; i < n; i++) items.push(makeItem());
    const total = items.reduce((s, it) => s + it.len, 0);
    const extra = Math.max(0, RING_LEN - total - n * minGap);
    const weights = items.map(() => rand(0.2, 1));
    const wsum = weights.reduce((s, w) => s + w, 0);
    const shift = rand(0, RING_LEN);
    let cursor = 0;
    items.forEach((it, i) => {
      it.x = wrapX(RING_MIN + cursor + it.len / 2 + shift);
      cursor += it.len + minGap + (extra * weights[i]) / wsum;
    });
    lane.items = items;
  }

  class Row {
    constructor(z, type) {
      this.z = z;
      this.type = type;                                   // 'grass' | 'road' | 'river'
      this.h = type === 'grass' ? GRASS_H : type === 'road' ? ROAD_H : WATER_H;
      this.trees = new Map();                             // playable column -> { kind, s }
      this.decor = [];                                    // scenery trees outside the playable area
      this.flowers = [];
      this.lane = null;
    }
  }

  class World {
    constructor() {
      this.rows = new Map();
      this.genZ = -12;                    // next row to generate
      this.segType = 'grass';
      this.segLeft = 15;                  // opening meadow (z -12 .. 2)
      this.laneDir = 1;
      this.minAllowed = -MAX_BACK;
      this.ensure(AHEAD);
    }

    row(z) {
      if (z >= this.genZ) this.ensure(z + 1);
      return this.rows.get(z) || null;
    }

    ensure(maxZ) {
      while (this.genZ <= maxZ) {
        if (this.segLeft <= 0) this.nextSegment(this.genZ);
        this.segLeft--;
        this.rows.set(this.genZ, this.makeRow(this.genZ));
        this.genZ++;
      }
    }

    /** Alternate meadow and hazard so every hazard has a safe landing zone before and after. */
    nextSegment(z) {
      const d = clamp(z / 220, 0, 1);       // difficulty 0..1
      if (this.segType === 'grass') {
        this.segType = Math.random() < 0.6 ? 'road' : 'river';
        this.segLeft = this.segType === 'road' ? randInt(1, 2 + Math.round(d * 3)) : randInt(1, 2 + Math.round(d * 1.5));
        this.laneDir = Math.random() < 0.5 ? 1 : -1;
      } else {
        this.segType = 'grass';
        this.segLeft = randInt(1, d > 0.5 ? 2 : 3);
      }
    }

    makeRow(z) {
      const row = new Row(z, this.segType);
      const d = clamp(z / 220, 0, 1);
      if (row.type === 'grass') this.buildGrass(row);
      else if (row.type === 'road') this.buildRoad(row, d);
      else this.buildRiver(row, d);
      return row;
    }

    buildGrass(row) {
      const z = row.z;
      const start = z <= 2;                               // keep the spawn area open
      const count = start ? randInt(0, 1) : randInt(0, 3);
      for (let i = 0; i < count; i++) {
        const c = randInt(0, COLS - 1);
        if (start && c >= 2 && c <= 6) continue;
        if (row.trees.has(c) || row.trees.has(c - 1) || row.trees.has(c + 1)) continue;   // never wall the row
        row.trees.set(c, { kind: Math.random() < 0.65 ? 0 : 1, s: rand(0.88, 1.15) });
      }
      for (let c = -12; c < COLS + 12; c++) {
        if (c >= 0 && c < COLS) continue;
        const edge = c === -1 || c === COLS;
        if (Math.random() < (edge ? 0.8 : 0.5)) row.decor.push({ x: c + rand(-0.15, 0.15), kind: Math.random() < 0.6 ? 0 : 1, s: rand(0.85, 1.25) });
      }
      const nf = randInt(3, 6);
      for (let i = 0; i < nf; i++) row.flowers.push({ x: rand(-9, COLS + 8), dz: rand(-0.4, 0.4), c: pick(FLOWER_COLORS) });
    }

    buildRoad(row, d) {
      this.laneDir = Math.random() < 0.25 ? this.laneDir : -this.laneDir;
      const speed = rand(1.8, 3.3) * (1 + d * 0.7);
      const lane = new Lane('road', this.laneDir, speed);
      fillLane(lane, lerp(8, 6.2, d), lerp(11, 8, d), 3.2, 2.5, () => {
        if (Math.random() < 0.16) return { len: 2.5, truck: true, color: pick(CAR_COLORS), cargo: pick(['#f2f2f2', '#ffd23f', '#6fd0ff']) };
        return { len: rand(1.3, 1.7), truck: false, color: pick(CAR_COLORS) };
      });
      row.lane = lane;
    }

    buildRiver(row, d) {
      this.laneDir = -this.laneDir;
      const speed = rand(0.9, 2.0) * (1 + d * 0.6);
      const lane = new Lane('river', this.laneDir, speed);
      fillLane(lane, 5.4, 7, 1.4, 4.2, () => ({ len: rand(2.6, 4.2 - d * 0.8), phase: rand(0, 6.28) }));
      row.lane = lane;
    }

    update(dt) {
      for (const row of this.rows.values()) if (row.lane) row.lane.update(dt);
    }

    prune(minZ) {
      for (const z of this.rows.keys()) if (z < minZ) this.rows.delete(z);
    }
  }

  /* ===================================================================
   * Player
   * =================================================================== */
  class Parrot {
    constructor() {
      this.x = MID; this.z = 0;             // visual position
      this.tx = MID; this.tz = 0;           // logical tile (target of the current hop)
      this.fromX = MID; this.fromZ = 0; this.toX = MID; this.toZ = 0;
      this.baseFrom = GRASS_H; this.baseTo = GRASS_H;
      this.hop = -1;                        // seconds into the current hop, -1 when idle
      this.face = 'f';                      // f / b / l / r
      this.queued = null;                   // one buffered move
      this.log = null; this.logOff = 0;     // log we are riding
      this.squash = 0;                      // landing squash 0..1
      this.deadType = null; this.deadT = 0;
      this.bump = 0;                        // little shake when a move is blocked
    }
  }

  /* ===================================================================
   * Particles & ripples
   * =================================================================== */
  const particles = [];
  const ripples = [];

  function burst(x, y, z, colors, n, speed, up, size) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.3, 1) * speed;
      particles.push({
        x, y, z, vx: Math.cos(a) * s, vy: rand(0.4, 1) * up, vz: Math.sin(a) * s,
        life: rand(0.5, 0.9), max: 0.9, color: pick(colors), size,
      });
    }
  }
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy -= 9 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].t += dt;
      if (ripples[i].t > 1.1) ripples.splice(i, 1);
    }
  }

  /* ===================================================================
   * Game state
   * =================================================================== */
  let world = new World();
  let parrot = new Parrot();
  let state = 'menu';                       // menu | playing | paused | dying | over
  let score = 0;
  let maxZ = 0;
  let best = 0;
  let time = 0;
  const cam = { x: MID, z: 0 };

  try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { best = 0; }
  ui.best.textContent = best;

  function setOverlay(name) {
    ui.start.classList.toggle('visible', name === 'start');
    ui.pause.classList.toggle('visible', name === 'pause');
    ui.over.classList.toggle('visible', name === 'over');
  }
  function setScore(v) {
    score = v;
    ui.score.textContent = v;
    ui.score.classList.add('bump');
    setTimeout(() => ui.score.classList.remove('bump'), 110);
  }

  function resetGame() {
    world = new World();
    parrot = new Parrot();
    particles.length = 0;
    ripples.length = 0;
    maxZ = 0;
    score = 0;
    ui.score.textContent = '0';
    cam.x = MID; cam.z = 0;
    world.minAllowed = -MAX_BACK;
  }

  function startGame() {
    resetGame();
    state = 'playing';
    setOverlay(null);
  }

  function pauseGame() {
    if (state === 'playing') { state = 'paused'; setOverlay('pause'); }
  }
  function resumeGame() {
    if (state === 'paused') { state = 'playing'; setOverlay(null); lastTs = 0; }
  }
  function togglePause() {
    if (state === 'playing') pauseGame(); else if (state === 'paused') resumeGame();
  }

  function gameOver() {
    state = 'over';
    let isBest = false;
    if (score > best) {
      best = score; isBest = true;
      try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) { /* storage unavailable: ignore */ }
    }
    ui.best.textContent = best;
    ui.finalScore.textContent = score;
    ui.finalBest.textContent = best;
    ui.overNote.firstChild.textContent = isBest && score > 0 ? 'New best! ' : 'Best ';
    setOverlay('over');
  }

  /* ---------------------------------------------------------------
   * Movement
   * --------------------------------------------------------------- */

  /** Height the parrot stands at when resting on row `row` (possibly on a log). */
  function restHeight(row, log, t) {
    if (log) return LOG_TOP + Math.sin(t * 2.2 + log.phase) * 0.025;
    return row.h;
  }

  /** Try to start a hop in direction dir ('f','b','l','r'). Returns true if a hop began. */
  function tryMove(dir) {
    const p = parrot;
    p.face = dir;
    const dx = dir === 'l' ? -1 : dir === 'r' ? 1 : 0;
    const dz = dir === 'f' ? 1 : dir === 'b' ? -1 : 0;
    const nz = p.tz + dz;
    const cur = world.row(p.tz);
    const target = world.row(nz);
    if (!target || nz < world.minAllowed) { p.bump = 1; return false; }

    // Where will we land? Rivers keep the fractional x (we ride logs); other rows snap to a column.
    let nx;
    if (dz !== 0) nx = target.type === 'river' ? p.x : Math.round(p.x);
    else nx = (cur.type === 'river' ? p.x : Math.round(p.x)) + dx;

    if (nx < -0.01 || nx > COLS - 1 + 0.01) { p.bump = 1; return false; }          // stay on the playfield
    if (target.type === 'grass' && target.trees.has(Math.round(nx))) { p.bump = 1; return false; }   // tree in the way

    p.fromX = p.x; p.fromZ = p.z;
    p.toX = nx; p.toZ = nz;
    p.baseFrom = p.log ? restHeight(cur, p.log, time) : cur.h;
    if (target.type === 'river') p.baseTo = target.lane.logAt(nx) ? LOG_TOP : WATER_H;
    else p.baseTo = target.h;
    p.tx = nx; p.tz = nz;
    p.hop = 0;
    p.log = null;

    if (dz > 0 && nz > maxZ) {
      maxZ = nz;
      setScore(maxZ);
      world.ensure(maxZ + AHEAD);
      world.prune(maxZ - KEEP_BEHIND);
      world.minAllowed = Math.max(world.minAllowed, maxZ - MAX_BACK);
    }
    return true;
  }

  function queueMove(dir) {
    if (state !== 'playing') return;
    if (parrot.hop >= 0) parrot.queued = dir;      // buffer one move; holding a key never auto-repeats
    else tryMove(dir);
  }

  /** Called when a hop finishes: attach to logs, drown, spawn dust, run queued input. */
  function land() {
    const p = parrot;
    p.hop = -1;
    p.x = p.toX; p.z = p.toZ;
    p.squash = 1;
    const row = world.row(p.tz);
    if (row.type === 'river') {
      const log = row.lane.logAt(p.x);
      if (!log) { die('water'); return; }
      p.log = log; p.logOff = p.x - log.x;
      burst(p.x, LOG_TOP, p.z, ['#bfe9ff', '#ffffff'], 4, 0.7, 1.6, 0.07);
    } else {
      p.log = null;
      burst(p.x, row.h, p.z, row.type === 'grass' ? ['#a8e05a', '#ffffff'] : ['#d5d9e6'], 4, 0.6, 1.4, 0.06);
    }
    if (p.queued) { const q = p.queued; p.queued = null; tryMove(q); }
  }

  function die(type) {
    if (state !== 'playing') return;
    const p = parrot;
    state = 'dying';
    p.deadType = type;
    p.deadT = 0;
    p.hop = -1;
    p.queued = null;
    p.log = null;
    const row = world.row(Math.round(p.z));
    if (type === 'car') {
      p.baseTo = row.h;
      burst(p.x, row.h + 0.4, p.z, ['#2fbf4a', '#ff4d4d', '#2f7bff', '#ffd23f', '#36cf52'], 22, 2.4, 3.6, 0.1);
    } else {
      ripples.push({ x: p.x, z: p.z, t: 0 });
      burst(p.x, WATER_H, p.z, ['#bfe9ff', '#ffffff', '#6fd0ff'], 22, 1.6, 4.2, 0.09);
    }
  }

  /** Per-frame check against cars using the tile the parrot is visually standing on. */
  function checkCars() {
    const p = parrot;
    const zRow = p.hop >= 0 ? (p.hop / HOP_TIME < 0.5 ? p.fromZ : p.toZ) : p.tz;
    const row = world.rows.get(Math.round(zRow));
    if (!row || row.type !== 'road') return;
    for (const car of row.lane.items) {
      if (Math.abs(car.x - p.x) < car.len / 2 + 0.26) { die('car'); return; }
    }
  }

  function updateParrot(dt) {
    const p = parrot;
    p.squash = Math.max(0, p.squash - dt * 7);
    p.bump = Math.max(0, p.bump - dt * 6);
    if (p.hop >= 0) {
      p.hop += dt;
      const u = Math.min(1, p.hop / HOP_TIME);
      p.x = lerp(p.fromX, p.toX, u);
      p.z = lerp(p.fromZ, p.toZ, u);
      if (u >= 1) land();
    } else if (p.log) {
      p.x = p.log.x + p.logOff;                       // ride the log
      if (p.x < -0.6 || p.x > COLS - 0.4) { die('swept'); return; }   // carried off the playfield
    }
    if (state === 'playing') checkCars();
  }

  /* ---------------------------------------------------------------
   * Main update
   * --------------------------------------------------------------- */
  function update(dt) {
    if (state === 'paused') return;
    time += dt;
    world.update(dt);
    updateParticles(dt);

    if (state === 'playing') {
      updateParrot(dt);
    } else if (state === 'dying') {
      const p = parrot;
      p.deadT += dt;
      if (p.deadT > 0.9) gameOver();
    }

    // Camera: follow the parrot, never lag too far behind the furthest row.
    if (state !== 'dying' && state !== 'over') {
      const tz = Math.max(parrot.z, maxZ - 3);
      const tx = MID + (parrot.x - MID) * 0.55;
      cam.z += (tz - cam.z) * (1 - Math.exp(-6 * dt));
      cam.x += (tx - cam.x) * (1 - Math.exp(-5 * dt));
    }
  }

  /* ===================================================================
   * Rendering
   * =================================================================== */
  const items = [];                          // depth-sorted boxes for this frame

  function sxOf(x, z) { return V.ox + ((x - V.cx) + (z - V.cz)) * V.hw; }
  function syOf(x, y, z) { return V.oy + ((x - V.cx) - (z - V.cz)) * V.hh - y * V.hv; }

  /** Queue a box. Sort key approximates distance from the camera (nearer = larger). */
  function addBox(x0, x1, z0, z1, y0, y1, hexOrFaces, alpha) {
    const f = typeof hexOrFaces === 'string' ? faces(hexOrFaces) : hexOrFaces;
    items.push({ k: x1 - z0 + (y0 + y1) * 0.4, x0, x1, z0, z1, y0, y1, f, a: alpha });
  }

  function drawBox(b) {
    const hw = V.hw, hh = V.hh;
    const u0 = b.x0 - V.cx, u1 = b.x1 - V.cx, w0 = b.z0 - V.cz, w1 = b.z1 - V.cz;
    const sxA = V.ox + (u0 + w0) * hw, sxB = V.ox + (u1 + w0) * hw;
    const sxC = V.ox + (u1 + w1) * hw, sxD = V.ox + (u0 + w1) * hw;
    const gA = V.oy + (u0 - w0) * hh, gB = V.oy + (u1 - w0) * hh;
    const gC = V.oy + (u1 - w1) * hh, gD = V.oy + (u0 - w1) * hh;
    const yb = b.y0 * V.hv, yt = b.y1 * V.hv;
    if (b.a !== undefined) ctx.globalAlpha = b.a;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';

    // left face (z = z0)
    ctx.fillStyle = ctx.strokeStyle = b.f.left;
    ctx.beginPath();
    ctx.moveTo(sxA, gA - yb); ctx.lineTo(sxB, gB - yb); ctx.lineTo(sxB, gB - yt); ctx.lineTo(sxA, gA - yt);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // right face (x = x1)
    ctx.fillStyle = ctx.strokeStyle = b.f.right;
    ctx.beginPath();
    ctx.moveTo(sxB, gB - yb); ctx.lineTo(sxC, gC - yb); ctx.lineTo(sxC, gC - yt); ctx.lineTo(sxB, gB - yt);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // top face
    ctx.fillStyle = ctx.strokeStyle = b.f.top;
    ctx.beginPath();
    ctx.moveTo(sxA, gA - yt); ctx.lineTo(sxB, gB - yt); ctx.lineTo(sxC, gC - yt); ctx.lineTo(sxD, gD - yt);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (b.a !== undefined) ctx.globalAlpha = 1;
  }

  /** Flat rectangle on the ground plane, appended to the current path. */
  function pathXZ(x0, x1, z0, z1, y) {
    ctx.moveTo(sxOf(x0, z0), syOf(x0, y, z0));
    ctx.lineTo(sxOf(x1, z0), syOf(x1, y, z0));
    ctx.lineTo(sxOf(x1, z1), syOf(x1, y, z1));
    ctx.lineTo(sxOf(x0, z1), syOf(x0, y, z1));
    ctx.closePath();
  }
  function fillXZ(color, x0, x1, z0, z1, y) {
    ctx.fillStyle = color;
    ctx.beginPath();
    pathXZ(x0, x1, z0, z1, y);
    ctx.fill();
  }

  function onScreen(x, z, padX, padY) {
    const sx = sxOf(x, z), sy = syOf(x, 0, z);
    return sx > -padX && sx < V.w + padX && sy > -padY && sy < V.h + padY;
  }

  /** Visible x-range of a row (clamped to the generated scenery). */
  function visibleX(z) {
    const dz = z - V.cz;
    const x0 = V.cx - dz + (-80 - V.ox) / V.hw;
    const x1 = V.cx - dz + (V.w + 80 - V.ox) / V.hw;
    return [Math.max(x0, -30), Math.min(x1, COLS + 30)];
  }

  const FACE_COLOR = { grass: '#4f9a3a', road: '#3b4050', river: '#2d86b8' };

  function drawRowGround(row) {
    const z = row.z;
    const [x0, x1] = visibleX(z);
    if (x1 <= x0) return;
    const y = row.h;

    // Side face toward the camera where this row stands higher than the one in front of it.
    const below = world.rows.get(z - 1);
    if (below && below.h < row.h - 0.001) {
      ctx.fillStyle = FACE_COLOR[row.type];
      ctx.beginPath();
      const za = z - 0.5;
      ctx.moveTo(sxOf(x0, za), syOf(x0, below.h, za));
      ctx.lineTo(sxOf(x1, za), syOf(x1, below.h, za));
      ctx.lineTo(sxOf(x1, za), syOf(x1, row.h, za));
      ctx.lineTo(sxOf(x0, za), syOf(x0, row.h, za));
      ctx.closePath();
      ctx.fill();
    }

    if (row.type === 'grass') {
      fillXZ('#7bd45c', x0, x1, z - 0.5, z + 0.5, y);
      ctx.fillStyle = '#6dc84f';                           // checker tiles
      ctx.beginPath();
      for (let c = Math.ceil(x0); c < x1; c++) if (((c + z) & 1) === 0) pathXZ(c - 0.5, c + 0.5, z - 0.5, z + 0.5, y);
      ctx.fill();
      for (const f of row.flowers) {                       // tiny flowers
        const sx = sxOf(f.x, z + f.dz), sy = syOf(f.x, y, z + f.dz);
        if (sx < -10 || sx > V.w + 10) continue;
        ctx.fillStyle = f.c;
        ctx.beginPath();
        ctx.arc(sx, sy, V.S * 0.07, 0, 6.283);
        ctx.fill();
      }
    } else if (row.type === 'road') {
      fillXZ('#585e70', x0, x1, z - 0.5, z + 0.5, y);
      const prev = world.rows.get(z - 1);
      if (prev && prev.type === 'road') {                  // dashed lane marking between road rows
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        for (let c = Math.floor(x0 / 2) * 2; c < x1; c += 2) pathXZ(c - 0.5, c + 0.4, z - 0.54, z - 0.46, y + 0.002);
        ctx.fill();
      }
    } else {
      fillXZ('#52b9ec', x0, x1, z - 0.5, z + 0.5, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';          // drifting wave marks
      ctx.lineWidth = Math.max(1.5, V.S * 0.04);
      ctx.lineCap = 'round';
      ctx.beginPath();
      const drift = (time * 0.35 * row.lane.dir) % 2.6;
      for (let c = Math.floor(x0 / 2.6) * 2.6; c < x1; c += 2.6) {
        const hsh = Math.sin(c * 12.9898 + z * 78.233) * 43758.5453;
        const zz = z + ((hsh - Math.floor(hsh)) - 0.5) * 0.7;
        const wx = c + drift;
        ctx.moveTo(sxOf(wx, zz), syOf(wx, y + 0.002, zz));
        ctx.lineTo(sxOf(wx + 0.7, zz), syOf(wx + 0.7, y + 0.002, zz));
      }
      ctx.stroke();
    }
  }

  /* ---- scenery & vehicles -> boxes ---- */

  function addTree(x, z, base, kind, s) {
    addBox(x - 0.12, x + 0.12, z - 0.12, z + 0.12, base, base + 0.45 * s, '#8a5a2b');
    if (kind === 0) {                                      // round tree
      addBox(x - 0.4 * s, x + 0.4 * s, z - 0.4 * s, z + 0.4 * s, base + 0.4 * s, base + 1.05 * s, '#2e9e48');
      addBox(x - 0.27 * s, x + 0.27 * s, z - 0.27 * s, z + 0.27 * s, base + 1.05 * s, base + 1.4 * s, '#43b95b');
    } else {                                               // pine tree
      addBox(x - 0.42 * s, x + 0.42 * s, z - 0.42 * s, z + 0.42 * s, base + 0.4 * s, base + 0.8 * s, '#237d3c');
      addBox(x - 0.3 * s, x + 0.3 * s, z - 0.3 * s, z + 0.3 * s, base + 0.8 * s, base + 1.15 * s, '#2e9e48');
      addBox(x - 0.16 * s, x + 0.16 * s, z - 0.16 * s, z + 0.16 * s, base + 1.15 * s, base + 1.5 * s, '#43b95b');
    }
  }

  const WIN_FACES = { top: '#cfeeff', left: '#8fcdee', right: '#6aa9cc' };
  const WHEEL = '#2a2b36';

  function addCar(car, z, dir) {
    const x = car.x, h = car.len / 2;
    const base = ROAD_H;
    const zl = z - 0.34, zr = z + 0.34;
    // wheels (poking slightly outside the body so they read in 3D)
    for (const wx of [x - h + 0.38, x + h - 0.38]) addBox(wx - 0.17, wx + 0.17, z - 0.4, z + 0.4, base, base + 0.22, WHEEL);
    if (!car.truck) {
      addBox(x - h, x + h, zl, zr, base + 0.12, base + 0.46, car.color);
      const cw = car.len * 0.5, cxm = x - dir * car.len * 0.08;
      const cabin = faces(car.color);
      addBox(cxm - cw / 2, cxm + cw / 2, z - 0.29, z + 0.29, base + 0.46, base + 0.76,
        { top: cabin.top, left: WIN_FACES.left, right: WIN_FACES.right });
    } else {
      const cabLen = 0.85;
      const frontX = dir > 0 ? x + h - cabLen / 2 : x - h + cabLen / 2;
      const cargoX = dir > 0 ? x - cabLen / 2 : x + cabLen / 2;
      addBox(cargoX - (car.len - cabLen) / 2, cargoX + (car.len - cabLen) / 2, zl, zr, base + 0.12, base + 0.92, car.cargo);
      addBox(frontX - cabLen / 2, frontX + cabLen / 2, zl, zr, base + 0.12, base + 0.7, car.color);
      addBox(frontX - cabLen / 2 + 0.05, frontX + cabLen / 2 - 0.05, z - 0.3, z + 0.3, base + 0.55, base + 0.72, WIN_FACES);
    }
    // lights on the end that faces the camera's right side (+x end): head lights or tail lights
    const lightColor = dir > 0 ? '#fff3a8' : '#ff4040';
    for (const lz of [z - 0.2, z + 0.2]) addBox(x + h - 0.01, x + h + 0.05, lz - 0.07, lz + 0.07, base + 0.2, base + 0.32, lightColor);
  }

  function addLog(log, z) {
    const x = log.x, h = log.len / 2;
    const bob = Math.sin(time * 2.2 + log.phase) * 0.025;
    addBox(x - h, x + h, z - 0.36, z + 0.36, -0.16 + bob, LOG_TOP + bob, '#b7824a');
    addBox(x + h - 0.03, x + h + 0.01, z - 0.3, z + 0.3, -0.12 + bob, LOG_TOP - 0.04 + bob, '#e2b57c');   // cut end
  }

  /* ---- the parrot ---- */
  // Local coordinates: x = sideways, z = forward (beak side), y = up.
  const PARROT_PARTS = [
    { x: [-0.14, -0.04], z: [0.0, 0.12], y: [0, 0.14], c: '#ff9f1c' },        // feet
    { x: [0.04, 0.14], z: [0.0, 0.12], y: [0, 0.14], c: '#ff9f1c' },
    { x: [-0.07, 0.07], z: [-0.54, -0.18], y: [0.14, 0.26], c: '#ff4d4d' },   // red tail feather
    { x: [-0.05, 0.05], z: [-0.7, -0.52], y: [0.1, 0.2], c: '#2f7bff' },      // blue tail tip
    { x: [-0.22, 0.22], z: [-0.22, 0.22], y: [0.12, 0.54], c: '#2fbf4a' },    // body
    { x: [-0.15, 0.15], z: [0.21, 0.25], y: [0.16, 0.42], c: '#b3e85f' },     // chest patch
    { x: [-0.19, 0.19], z: [-0.02, 0.34], y: [0.5, 0.82], c: '#36cf52' },     // head
    { x: [-0.05, 0.05], z: [0.0, 0.22], y: [0.82, 0.97], c: '#ff4d4d' },      // red crest
    { x: [-0.07, 0.07], z: [0.34, 0.5], y: [0.6, 0.75], c: '#ffb02e' },       // beak (upper)
    { x: [-0.05, 0.05], z: [0.44, 0.5], y: [0.51, 0.6], c: '#e8890c' },       // beak hook
    { x: [0.19, 0.23], z: [0.19, 0.3], y: [0.63, 0.76], c: '#ffffff' },       // eyes
    { x: [-0.23, -0.19], z: [0.19, 0.3], y: [0.63, 0.76], c: '#ffffff' },
    { x: [0.22, 0.245], z: [0.24, 0.3], y: [0.65, 0.72], c: '#1b1b2f' },      // pupils
    { x: [-0.245, -0.22], z: [0.24, 0.3], y: [0.65, 0.72], c: '#1b1b2f' },
  ];

  /** Rotate local (lx, lz) so the parrot's beak points the way it is facing. */
  function rot(face, lx, lz) {
    switch (face) {
      case 'b': return [-lx, -lz];
      case 'r': return [lz, -lx];
      case 'l': return [-lz, lx];
      default: return [lx, lz];
    }
  }

  function parrotPose() {
    const p = parrot;
    let base, lift = 0, sy = 1, sw = 1, alpha;
    const row = world.rows.get(p.tz) || world.rows.get(Math.round(p.z));
    if (p.hop >= 0) {
      const u = Math.min(1, p.hop / HOP_TIME);
      base = lerp(p.baseFrom, p.baseTo, u) + Math.sin(Math.PI * u) * HOP_HEIGHT;
      sy = 1 + 0.14 * Math.sin(Math.PI * u);              // stretch while airborne
      sw = 1 - 0.06 * Math.sin(Math.PI * u);
      lift = Math.sin(Math.PI * u);                       // wings flap out
    } else {
      base = row ? restHeight(row, p.log, time) : GRASS_H;
      if (state === 'menu' || state === 'playing') base += Math.sin(time * 4) * 0.012;   // idle breathing
      sy = 1 - 0.22 * p.squash;                           // landing squash
      sw = 1 + 0.12 * p.squash;
      lift = p.squash * 0.5;
    }
    let ox = 0;
    if (p.bump > 0) ox = Math.sin(p.bump * 18) * 0.05 * p.bump;     // blocked-move wobble

    if (state === 'dying' || (state === 'over' && p.deadType)) {
      const t = p.deadT;
      if (p.deadType === 'car') {
        const u = Math.min(1, t / 0.12);
        sy = lerp(1, 0.1, u); sw = lerp(1, 1.7, u);
        base = p.baseTo;
        lift = 0;
        if (t > 0.6) alpha = Math.max(0, 1 - (t - 0.6) / 0.3);
      } else {
        const u = Math.min(1, t / 0.5);
        base = WATER_H - 0.1 - u * 0.85;
        sy = lerp(1, 0.7, u);
        lift = 1 - u;
        alpha = Math.max(0, 1 - u * 1.1);
      }
    }
    return { base, lift, sy, sw, alpha, ox };
  }

  function addParrot() {
    const p = parrot;
    const pose = parrotPose();
    if (pose.alpha !== undefined && pose.alpha <= 0) return;
    const parts = PARROT_PARTS;
    const push = (lx0, lx1, lz0, lz1, y0, y1, color) => {
      const [ax, az] = rot(p.face, lx0 * pose.sw, lz0 * pose.sw);
      const [bx, bz] = rot(p.face, lx1 * pose.sw, lz1 * pose.sw);
      addBox(p.x + pose.ox + Math.min(ax, bx), p.x + pose.ox + Math.max(ax, bx),
        p.z + Math.min(az, bz), p.z + Math.max(az, bz),
        pose.base + y0 * pose.sy, pose.base + y1 * pose.sy, color, pose.alpha);
    };
    for (const part of parts) push(part.x[0], part.x[1], part.z[0], part.z[1], part.y[0], part.y[1], part.c);
    // wings (flap outward and up while hopping)
    const l = pose.lift;
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? -0.32 - l * 0.12 : 0.22 + l * 0.0;
      const x1 = side < 0 ? -0.22 : 0.32 + l * 0.12;
      const dy = l * 0.12;
      push(x0, x1, -0.14, 0.14, 0.22 + dy, 0.42 + dy, '#2f7bff');          // blue wing
      push(x0, x1, -0.14, 0.14, 0.42 + dy, 0.5 + dy, '#ff4d4d');           // red edge
      push(x0, x1, -0.26, -0.14, 0.24 + dy, 0.38 + dy, '#ffd23f');         // yellow feathers
    }
  }

  function drawShadows(rowsInView) {
    ctx.fillStyle = 'rgba(20, 50, 30, 0.2)';
    ctx.beginPath();
    for (const row of rowsInView) {
      const z = row.z;
      if (row.type === 'grass') {
        const add = (x, s) => {
          if (!onScreen(x, z, 120, 160)) return;
          pathXZ(x - 0.36 * s + 0.12, x + 0.36 * s + 0.22, z - 0.34 * s, z + 0.34 * s, row.h + 0.002);
        };
        row.trees.forEach((t, c) => add(c, t.s));
        for (const d of row.decor) add(d.x, d.s);
      } else if (row.type === 'road') {
        for (const car of row.lane.items) {
          if (!onScreen(car.x, z, 200, 160)) continue;
          pathXZ(car.x - car.len / 2 + 0.05, car.x + car.len / 2 + 0.2, z - 0.36, z + 0.34, ROAD_H + 0.002);
        }
      }
    }
    ctx.fill();

    // foam under logs
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    for (const row of rowsInView) {
      if (row.type !== 'river') continue;
      for (const log of row.lane.items) {
        if (!onScreen(log.x, row.z, 220, 160)) continue;
        pathXZ(log.x - log.len / 2 - 0.15, log.x + log.len / 2 + 0.15, row.z - 0.46, row.z + 0.46, WATER_H + 0.003);
      }
    }
    ctx.fill();

    // parrot shadow
    const p = parrot;
    if (!(state === 'dying' && p.deadType !== 'car') && !(p.deadType === 'car' && p.deadT > 0.6)) {
      const pose = parrotPose();
      const row = world.rows.get(p.hop >= 0 ? (p.hop / HOP_TIME < 0.5 ? p.fromZ : p.toZ) : p.tz);
      const gy = row ? (p.log ? LOG_TOP : (row.type === 'river' ? (p.hop >= 0 ? p.baseTo : WATER_H) : row.h)) : GRASS_H;
      const air = Math.max(0, pose.base - gy);
      const r = 0.34 * (1 - Math.min(0.5, air * 0.6)) * (state === 'dying' ? pose.sw : 1);
      ctx.fillStyle = `rgba(15, 40, 30, ${0.26 - Math.min(0.12, air * 0.2)})`;
      ctx.beginPath();
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * 6.283;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(sxOf(x, z), syOf(x, gy + 0.004, z)); else ctx.lineTo(sxOf(x, z), syOf(x, gy + 0.004, z));
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  function render() {
    V.cx = cam.x; V.cz = cam.z;
    ctx.fillStyle = V.sky;
    ctx.fillRect(0, 0, V.w, V.h);

    const zc = Math.floor(V.cz);
    const rowsInView = [];
    for (let z = zc - 20; z <= zc + 22; z++) {
      const row = world.rows.get(z);
      if (row) { rowsInView.push(row); drawRowGround(row); }
    }

    // ripples sit on the water, under everything else
    for (const r of ripples) {
      const k = r.t / 1.1;
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k)})`;
      ctx.lineWidth = Math.max(2, V.S * 0.05);
      ctx.beginPath();
      const rad = 0.2 + k * 1.1;
      for (let i = 0; i <= 20; i++) {
        const a = (i / 20) * 6.283;
        const x = r.x + Math.cos(a) * rad, z = r.z + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(sxOf(x, z), syOf(x, WATER_H + 0.004, z)); else ctx.lineTo(sxOf(x, z), syOf(x, WATER_H + 0.004, z));
      }
      ctx.stroke();
    }

    drawShadows(rowsInView);

    items.length = 0;
    for (const row of rowsInView) {
      const z = row.z;
      if (row.type === 'grass') {
        row.trees.forEach((t, c) => { if (onScreen(c, z, 140, 260)) addTree(c, z, row.h, t.kind, t.s); });
        for (const d of row.decor) if (onScreen(d.x, z, 140, 260)) addTree(d.x, z, row.h, d.kind, d.s);
      } else if (row.type === 'road') {
        for (const car of row.lane.items) if (onScreen(car.x, z, 260, 200)) addCar(car, z, row.lane.dir);
      } else {
        for (const log of row.lane.items) if (onScreen(log.x, z, 280, 200)) addLog(log, z);
      }
    }
    addParrot();
    items.sort((a, b) => a.k - b.k);
    for (const b of items) drawBox(b);

    // particles on top
    for (const p of particles) {
      const a = clamp(p.life / p.max, 0, 1);
      const s = Math.max(2, p.size * V.S * (0.5 + a * 0.5));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(sxOf(p.x, p.z) - s / 2, syOf(p.x, p.y, p.z) - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  /* ===================================================================
   * Input
   * =================================================================== */
  const KEY_DIR = {
    ArrowUp: 'f', KeyW: 'f', ArrowDown: 'b', KeyS: 'b',
    ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r',
  };

  window.addEventListener('keydown', (e) => {
    const code = e.code;
    if (KEY_DIR[code]) {
      e.preventDefault();
      if (!e.repeat) queueMove(KEY_DIR[code]);       // one hop per key press
      return;
    }
    if (code === 'Space' || code === 'Escape') {
      e.preventDefault();
      if (e.repeat) return;
      if (state === 'playing' || state === 'paused') togglePause();
      else if (code === 'Space' && (state === 'menu' || state === 'over')) startGame();
    } else if (code === 'Enter') {
      e.preventDefault();
      if (!e.repeat && (state === 'menu' || state === 'over')) startGame();
      else if (!e.repeat && state === 'paused') resumeGame();
    }
  });

  $('playBtn').addEventListener('click', startGame);
  $('restartBtn').addEventListener('click', startGame);
  $('resumeBtn').addEventListener('click', resumeGame);
  ui.pauseBtn.addEventListener('click', () => { ui.pauseBtn.blur(); togglePause(); });

  // On-screen d-pad (pointer events cover touch + mouse)
  ui.dpad.querySelectorAll('.pad').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.classList.add('active');
      queueMove(btn.dataset.dir);
    });
    const off = () => btn.classList.remove('active');
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
    btn.addEventListener('pointerleave', off);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // Tap = forward, swipe along a lane diagonal = that direction.
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    document.body.classList.add('has-touch');
    const t = e.changedTouches[0];
    touchStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.hypot(dx, dy) < 24) queueMove('f');
    else if (dx >= 0 && dy < 0) queueMove('f');
    else if (dx < 0 && dy >= 0) queueMove('b');
    else if (dx < 0 && dy < 0) queueMove('l');
    else queueMove('r');
  }, { passive: true });
  // Keep the page from scrolling or rubber-banding while playing.
  document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  window.addEventListener('touchstart', () => document.body.classList.add('has-touch'), { once: true, passive: true });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
  window.addEventListener('blur', pauseGame);

  /* ===================================================================
   * Main loop (time-based, so speed is identical at any frame rate)
   * =================================================================== */
  let lastTs = 0;
  function frame(ts) {
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  resize();
  resetGame();
  parrot.face = 'b';                       // show the parrot's face on the title screen
  setOverlay('start');
  requestAnimationFrame(frame);
})();
