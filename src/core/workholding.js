// Workholding: how the stock is held down. Places fixtures clear of the toolpath,
// checks the tool/spindle envelope against them, finds parts that get cut free and
// compares the holding force with the cutting force.

import { cuttingLength } from './tool.js';

export const WORKHOLDING = ['clamps', 'screws', 'vise', 'tape', 'glue', 'vacuum'];

// Friction between stock and spoilboard / jaws.
const FRICTION = { wood: 0.35, plastic: 0.25, metal: 0.2, foam: 0.4 };
const CLAMP_FORCE = 1500; // N per hand-tightened M8 strap clamp
const SCREW_HOLD = 250; // N lateral per wood screw in the spoilboard
const VISE_FORCE = 4000; // N hobby machine vise
const TAPE_SHEAR = 0.06; // N/mm² double-sided carpet tape
const GLUE_SHEAR = 0.25; // N/mm² painter's tape + CA glue
const VACUUM = 0.07; // N/mm² (70 kPa) without a bleeder board

const CLAMP = { overlap: 12, width: 16, length: 55, bar: 10, boltAbove: 25, boltR: 4.5 };

export const defaultWorkholding = () => ({ method: 'auto', clamps: 4, viseOpening: 125, jawHeight: 20 });

// Tool envelope as stacked cylinders above the tip: cutter, shank, collet nut, spindle body.
export function toolEnvelope(tool, spindleType) {
  const R = tool.d / 2;
  const cut = cuttingLength(tool);
  const shank = (tool.shankD || tool.d) / 2;
  const stick = Math.max(tool.stickout, cut + 1);
  const body = spindleType === 'router' ? 33 : spindleType === 'dc' ? 22.5 : 32.5;
  return [
    { z0: 0, z1: cut, r: R, part: 'cutter' },
    { z0: cut, z1: stick, r: shank, part: 'shank' },
    { z0: stick, z1: stick + 11, r: 9.5, part: 'nut' },
    { z0: stick + 11, z1: stick + 220, r: body, part: 'spindle' },
  ];
}

// Which part of the envelope (if any) at tip position (x, y, z) intersects the box.
export function envelopeHit(env, x, y, z, b) {
  const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
  const dy = Math.max(b.min[1] - y, 0, y - b.max[1]);
  const d2 = dx * dx + dy * dy;
  for (const e of env) {
    if (z + e.z1 < b.min[2] || z + e.z0 > b.max[2]) continue;
    if (d2 < e.r * e.r) return e.part;
  }
  return null;
}

// Points along the commanded path, with the tool in use (planned blocks, before physics).
export function samplePath(planned, cfg) {
  const envs = new Map();
  const envFor = (num) => {
    if (!envs.has(num)) {
      const def = cfg.tools[num];
      envs.set(num, def ? toolEnvelope(def, cfg.machine.spindle.type) : null);
    }
    return envs.get(num);
  };
  let toolNum = cfg.initialTool;
  const pts = [];
  for (const it of planned.items) {
    if (it.type === 'tool') {
      if (cfg.tools[it.op.tool]) toolNum = it.op.tool;
      continue;
    }
    if (it.type !== 'move') continue;
    const b = it.block;
    const env = envFor(toolNum);
    if (!env) continue;
    const step = Math.max(0.5, Math.min(2, env[0].r));
    const n = Math.max(1, Math.ceil(b.L / step));
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      pts.push({ x: b.from[0] + (b.to[0] - b.from[0]) * f, y: b.from[1] + (b.to[1] - b.from[1]) * f, z: b.from[2] + (b.to[2] - b.from[2]) * f, env, line: b.line, rapid: b.rapid, t: b.t0 });
    }
  }
  return pts;
}

// Collision count (and first hit) for a set of solid fixture boxes.
export function collide(pts, boxes, limit = Infinity) {
  let hits = 0;
  let first = null;
  let rapidOnly = true;
  let minFeedZ = Infinity;
  for (const p of pts) {
    for (const b of boxes) {
      if (!b.solid) continue;
      const part = envelopeHit(p.env, p.x, p.y, p.z, b);
      if (!part) continue;
      hits++;
      if (!first) first = { line: p.line, t: p.t, part, obj: b.kind, x: p.x, y: p.y };
      if (!p.rapid) { rapidOnly = false; minFeedZ = Math.min(minFeedZ, p.z); }
      if (hits >= limit) return { hits, first, rapidOnly, minFeedZ };
      break;
    }
  }
  return { hits, first, rapidOnly, minFeedZ };
}

function clampBoxes(side, f, box) {
  const { overlap, width, length, bar, boltAbove, boltR } = CLAMP;
  const top = box.z1;
  const out = [];
  let x, y, dir; // point on the edge and outward direction
  if (side === 'front') { x = box.x0 + (box.x1 - box.x0) * f; y = box.y0; dir = [0, -1]; }
  else if (side === 'back') { x = box.x0 + (box.x1 - box.x0) * f; y = box.y1; dir = [0, 1]; }
  else if (side === 'left') { x = box.x0; y = box.y0 + (box.y1 - box.y0) * f; dir = [-1, 0]; }
  else { x = box.x1; y = box.y0 + (box.y1 - box.y0) * f; dir = [1, 0]; }
  const inner = [x - dir[0] * overlap, y - dir[1] * overlap];
  const outer = [x + dir[0] * (length - overlap), y + dir[1] * (length - overlap)];
  const half = width / 2;
  const bx0 = Math.min(inner[0], outer[0]) - (dir[0] ? 0 : half);
  const bx1 = Math.max(inner[0], outer[0]) + (dir[0] ? 0 : half);
  const by0 = Math.min(inner[1], outer[1]) - (dir[1] ? 0 : half);
  const by1 = Math.max(inner[1], outer[1]) + (dir[1] ? 0 : half);
  out.push({ kind: 'clamp', solid: true, shape: 'box', min: [bx0, by0, top], max: [bx1, by1, top + bar], color: '#6f7a82' });
  // Bolt a little outside the stock edge, and the step block under the outer end
  const bolt = [x + dir[0] * 12, y + dir[1] * 12];
  out.push({ kind: 'clamp', solid: true, shape: 'cyl', c: bolt, r: boltR, min: [bolt[0] - boltR, bolt[1] - boltR, box.z0], max: [bolt[0] + boltR, bolt[1] + boltR, top + boltAbove], color: '#9aa3a8' });
  const sb = [x + dir[0] * (length - overlap - 8), y + dir[1] * (length - overlap - 8)];
  out.push({ kind: 'clamp', solid: true, shape: 'box', min: [sb[0] - 8, sb[1] - 8, box.z0], max: [sb[0] + 8, sb[1] + 8, top], color: '#4c555b' });
  return out;
}

function screwBoxes(x, y, box) {
  return [
    { kind: 'screw', solid: true, shape: 'cyl', c: [x, y], r: 5, min: [x - 5, y - 5, box.z1], max: [x + 5, y + 5, box.z1 + 3], color: '#c9ced2' },
    { kind: 'screw', solid: true, shape: 'cyl', c: [x, y], r: 2.2, min: [x - 2.2, y - 2.2, box.z0 - 10], max: [x + 2.2, y + 2.2, box.z1], color: '#c9ced2', hidden: true },
  ];
}

function placeClamps(pts, box, count) {
  const sides = ['front', 'back', 'left', 'right'];
  const fracs = [0.5, 0.3, 0.7, 0.15, 0.85];
  const best = {};
  for (const side of sides) {
    let pick = null;
    for (const f of fracs) {
      const boxes = clampBoxes(side, f, box);
      const c = collide(pts, boxes, pick ? pick.hits : Infinity);
      if (!pick || c.hits < pick.hits) pick = { side, f, boxes, hits: c.hits };
      if (c.hits === 0) break;
    }
    best[side] = pick;
  }
  // Two clamps: the opposite pair with fewest hits. Four: one per side.
  let chosen;
  if (count <= 2) {
    const fb = best.front.hits + best.back.hits;
    const lr = best.left.hits + best.right.hits;
    chosen = fb <= lr ? [best.front, best.back] : [best.left, best.right];
  } else chosen = sides.map((s) => best[s]);
  return chosen.flatMap((c) => c.boxes);
}

function placeScrews(pts, box) {
  const cands = [];
  for (const inset of [6, 9]) {
    const x0 = box.x0 + inset, x1 = box.x1 - inset, y0 = box.y0 + inset, y1 = box.y1 - inset;
    if (x1 <= x0 || y1 <= y0) continue;
    const per = 2 * (x1 - x0) + 2 * (y1 - y0);
    const n = Math.max(8, Math.floor(per / 5));
    for (let k = 0; k < n; k++) {
      let s = (k / n) * per;
      let x, y;
      if (s < x1 - x0) { x = x0 + s; y = y0; }
      else if ((s -= x1 - x0) < y1 - y0) { x = x1; y = y0 + s; }
      else if ((s -= y1 - y0) < x1 - x0) { x = x1 - s; y = y1; }
      else { s -= x1 - x0; x = x0; y = y1 - s; }
      cands.push({ x, y });
    }
  }
  // Keep candidates the tool never reaches, with a 1.5 mm margin
  const free = [];
  for (const c of cands) {
    const b = { solid: true, min: [c.x - 3.7, c.y - 3.7, box.z0 - 10], max: [c.x + 3.7, c.y + 3.7, box.z1 + 3] };
    if (collide(pts, [b], 1).hits === 0) free.push(c);
  }
  // Greedy spread: start near the corners, then farthest point
  const picked = [];
  const corners = [[box.x0, box.y0], [box.x1, box.y1], [box.x1, box.y0], [box.x0, box.y1]];
  for (const [cx, cy] of corners) {
    let best = null, bd = Infinity;
    for (const c of free) {
      if (picked.includes(c)) continue;
      const d = Math.hypot(c.x - cx, c.y - cy);
      const far = picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 20);
      if (far && d < bd) { bd = d; best = c; }
    }
    if (best) picked.push(best);
  }
  return picked.flatMap((c) => screwBoxes(c.x, c.y, box));
}

function placeVise(box, wh) {
  const sx = box.x1 - box.x0, sy = box.y1 - box.y0, sz = box.z1 - box.z0;
  const alongX = sy <= wh.viseOpening; // jaws on the front and back
  if (!alongX && sx > wh.viseOpening) return null;
  const jawTop = box.z0 + Math.max(3, Math.min(wh.jawHeight, sz - 3));
  const jaws = [];
  if (alongX) {
    jaws.push({ kind: 'vise', solid: true, shape: 'box', min: [box.x0 - 10, box.y0 - 18, box.z0], max: [box.x1 + 10, box.y0, jawTop], color: '#3f6e8c' });
    jaws.push({ kind: 'vise', solid: true, shape: 'box', min: [box.x0 - 10, box.y1, box.z0], max: [box.x1 + 10, box.y1 + 18, jawTop], color: '#3f6e8c' });
    jaws.push({ kind: 'vise', solid: true, shape: 'box', min: [(box.x0 + box.x1) / 2 - 6, box.y0 - 70, box.z0 + 4], max: [(box.x0 + box.x1) / 2 + 6, box.y0 - 18, box.z0 + 16], color: '#9aa3a8' });
  } else {
    jaws.push({ kind: 'vise', solid: true, shape: 'box', min: [box.x0 - 18, box.y0 - 10, box.z0], max: [box.x0, box.y1 + 10, jawTop], color: '#3f6e8c' });
    jaws.push({ kind: 'vise', solid: true, shape: 'box', min: [box.x1, box.y0 - 10, box.z0], max: [box.x1 + 18, box.y1 + 10, jawTop], color: '#3f6e8c' });
    jaws.push({ kind: 'vise', solid: true, shape: 'box', min: [box.x0 - 70, (box.y0 + box.y1) / 2 - 6, box.z0 + 4], max: [box.x0 - 18, (box.y0 + box.y1) / 2 + 6, box.z0 + 16], color: '#9aa3a8' });
  }
  return { boxes: jaws, engagement: jawTop - box.z0 };
}

// Build fixtures for every method (placement only depends on the path).
export function planFixtures(pts, box, wh) {
  const out = {};
  out.clamps = { boxes: placeClamps(pts, box, wh.clamps) };
  out.screws = { boxes: placeScrews(pts, box) };
  out.vise = placeVise(box, wh) || { boxes: [], unavailable: true };
  const layer = (kind, color) => ({ boxes: [{ kind, solid: false, shape: 'box', min: [box.x0 - 0.8, box.y0 - 0.8, box.z0 - 0.4], max: [box.x1 + 0.8, box.y1 + 0.8, box.z0 + 0.05], color, opacity: 0.8 }] });
  out.tape = layer('tape', '#e8e2c8');
  out.glue = layer('glue', '#d9a441');
  out.vacuum = { boxes: [
    { kind: 'seal', solid: false, shape: 'box', min: [box.x0 - 6, box.y0 - 6, box.z0 - 0.5], max: [box.x1 + 6, box.y0 - 1, box.z0 + 1.5], color: '#2d2f31' },
    { kind: 'seal', solid: false, shape: 'box', min: [box.x0 - 6, box.y1 + 1, box.z0 - 0.5], max: [box.x1 + 6, box.y1 + 6, box.z0 + 1.5], color: '#2d2f31' },
    { kind: 'seal', solid: false, shape: 'box', min: [box.x0 - 6, box.y0 - 1, box.z0 - 0.5], max: [box.x0 - 1, box.y1 + 1, box.z0 + 1.5], color: '#2d2f31' },
    { kind: 'seal', solid: false, shape: 'box', min: [box.x1 + 1, box.y0 - 1, box.z0 - 0.5], max: [box.x1 + 6, box.y1 + 1, box.z0 + 1.5], color: '#2d2f31' },
  ] };
  return out;
}

// Connected pieces of material that remain (4-connectivity over cells not cut through).
export function findPieces(hm) {
  const { nx, ny, h, zBottom } = hm;
  const through = zBottom + 1e-4;
  const label = new Int32Array(nx * ny).fill(-1);
  const pieces = [];
  const stack = new Int32Array(nx * ny);
  for (let start = 0; start < nx * ny; start++) {
    if (label[start] >= 0 || h[start] <= through) continue;
    const id = pieces.length;
    let sp = 0, cells = 0, edge = false, i0 = nx, i1 = 0, j0 = ny, j1 = 0, sx = 0, sy = 0;
    stack[sp++] = start;
    label[start] = id;
    while (sp) {
      const c = stack[--sp];
      const i = c % nx, j = (c / nx) | 0;
      cells++; sx += i; sy += j;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) edge = true;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
      for (const n of nb) {
        if (n < 0 || label[n] >= 0 || h[n] <= through) continue;
        label[n] = id;
        stack[sp++] = n;
      }
    }
    pieces.push({
      id, area: cells * hm.cellArea, edge,
      bbox: [hm.x0 + i0 * hm.dx, hm.y0 + j0 * hm.dy, hm.x0 + (i1 + 1) * hm.dx, hm.y0 + (j1 + 1) * hm.dy],
      cx: hm.x0 + (sx / cells + 0.5) * hm.dx, cy: hm.y0 + (sy / cells + 0.5) * hm.dy,
    });
  }
  let contact = 0;
  for (const p of pieces) contact += p.area;
  return { label, pieces, contact };
}

// Evaluate every method. ctx: { pts, fixtures, hm, pieces, box, material, maxForce, wh, bedZ, woZ, looseLine }
export function evaluate(ctx) {
  const { fixtures, hm, box, material, wh } = ctx;
  const group = material.group || 'wood';
  const mu = FRICTION[group] || 0.3;
  const force = Math.max(1, ctx.maxForce);
  const sx = box.x1 - box.x0, sy = box.y1 - box.y0, sz = box.z1 - box.z0;
  const stockArea = sx * sy;
  const { pieces, contact } = ctx.pieces;
  const minPiece = 30; // mm², smaller bits are chips
  const main = pieces.filter((p) => p.edge);
  const loose = pieces.filter((p) => !p.edge && p.area >= minPiece);
  const mainArea = main.reduce((a, p) => a + p.area, 0);
  const throughArea = Math.max(0, stockArea - contact);
  const cellOf = (x, y) => {
    const i = Math.floor((x - hm.x0) / hm.dx), j = Math.floor((y - hm.y0) / hm.dy);
    if (i < 0 || j < 0 || i >= hm.nx || j >= hm.ny) return -1;
    return ctx.pieces.label[j * hm.nx + i];
  };
  const tipping = sz > 0.6 * Math.min(sx, sy);

  const results = [];
  for (const id of WORKHOLDING) {
    const fx = fixtures[id];
    const issues = [];
    let hold = 0;
    let na = null;
    let looseHeld = () => 0;
    if (id === 'clamps') {
      const fclamp = group === 'foam' ? 150 : CLAMP_FORCE;
      const n = fx.boxes.filter((b) => b.shape === 'cyl').length;
      hold = n * fclamp * mu;
      if (sz < 6 && Math.max(sx, sy) > 150) issues.push({ sev: 'warn', key: 'thin' });
    } else if (id === 'screws') {
      const n = fx.boxes.filter((b) => b.shape === 'cyl' && !b.hidden).length;
      if (group === 'metal') na = 'metal';
      else if (n === 0) na = 'noroom';
      hold = n * (group === 'foam' ? 30 : SCREW_HOLD);
      const screwPieces = new Set(fx.boxes.filter((b) => !b.hidden).map((b) => cellOf(b.c[0], b.c[1])));
      looseHeld = (p) => (screwPieces.has(p.id) ? SCREW_HOLD : 0);
    } else if (id === 'vise') {
      if (fx.unavailable) na = 'wide';
      else if (sz < 6) na = 'thin';
      else {
        const eng = fixtures.vise.engagement || 0;
        hold = 2 * VISE_FORCE * mu * Math.min(1, eng / 10);
        if (eng < 5) issues.push({ sev: 'warn', key: 'shallow', p: { e: eng.toFixed(1) } });
      }
    } else if (id === 'tape' || id === 'glue') {
      const s = id === 'tape' ? TAPE_SHEAR * (group === 'wood' ? 0.8 : 1) : GLUE_SHEAR;
      hold = mainArea * s;
      looseHeld = (p) => p.area * s;
      if (tipping) issues.push({ sev: 'warn', key: 'tipping' });
    } else if (id === 'vacuum') {
      const leak = Math.max(0, 1 - throughArea / (0.04 * stockArea));
      hold = mainArea * VACUUM * 0.5 * leak;
      looseHeld = (p) => p.area * VACUUM * 0.5 * leak * (p.area > 2500 ? 1 : 0.2);
      if (throughArea > 0.01 * stockArea) issues.push({ sev: 'warn', key: 'leak', p: { pct: Math.round((1 - leak) * 100) } });
      if (stockArea < 100 * 100) issues.push({ sev: 'warn', key: 'small' });
      if (tipping) issues.push({ sev: 'warn', key: 'tipping' });
    }
    if (na) {
      results.push({ id, rating: 'na', hold: 0, ratio: 0, issues: [{ sev: 'crit', key: `na.${na}` }], fixtures: [] });
      continue;
    }
    // Collisions with clamps, screws or jaws
    const col = collide(ctx.pts, fx.boxes);
    if (col.hits) {
      const top = Math.max(...fx.boxes.filter((b) => b.solid).map((b) => b.max[2]));
      issues.push({ sev: 'crit', key: col.rapidOnly || col.minFeedZ > box.z1 ? 'hitRapid' : 'hit', p: { line: col.first.line, part: col.first.part, obj: col.first.obj, z: (top + 5 - ctx.woZ).toFixed(0) }, line: col.first.line, t: col.first.t });
    }
    // Parts cut free
    for (const p of loose) {
      const held = looseHeld(p);
      if (held < 2 * force) issues.push({ sev: held > 0 ? 'warn' : 'crit', key: held > 0 ? 'looseWeak' : 'loose', p: { a: (p.area / 100).toFixed(1) }, line: ctx.looseLine(p), piece: p });
    }
    const ratio = hold / force;
    if (ratio < 2) issues.push({ sev: 'crit', key: 'weak', p: { hold: Math.round(hold), f: Math.round(force) } });
    else if (ratio < 4) issues.push({ sev: 'warn', key: 'weak', p: { hold: Math.round(hold), f: Math.round(force) } });
    const worst = issues.some((i) => i.sev === 'crit') ? 'bad' : issues.some((i) => i.sev === 'warn') ? 'ok' : 'good';
    results.push({ id, rating: worst, hold, ratio, issues, fixtures: fx.boxes, collision: col.hits ? col.first : null });
  }
  const rank = { good: 0, ok: 1, bad: 2, na: 3 };
  const ease = { tape: 0, clamps: 1, screws: 2, vise: 3, glue: 4, vacuum: 5 };
  results.sort((a, b) => rank[a.rating] - rank[b.rating] || ease[a.id] - ease[b.id]);
  return results;
}
