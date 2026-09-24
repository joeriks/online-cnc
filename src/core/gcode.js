// G-kodstolk som följer GRBL 1.1:s regler (gcode.c / motion_control.c).
// Resultatet är en lista med operationer i maskinkoordinater (mm) som
// planeraren och simulatorn sedan kör.

import { t } from '../i18n.js';

export const GRBL_ERROR_CODES = [1, 2, 3, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38];

export class GcodeError extends Error {
  constructor(code, detail) {
    super(t(`err.${code}`) + (detail ? ` (${detail})` : ''));
    this.code = code;
  }
}

const ARC_EPS = 5e-7;

// Ta bort kommentarer och blanksteg, versaler.
export function cleanLine(raw) {
  let s = '';
  let paren = false;
  for (const ch of raw) {
    if (paren) {
      if (ch === ')') paren = false;
      continue;
    }
    if (ch === '(') { paren = true; continue; }
    if (ch === ';') break;
    if (ch === ' ' || ch === '\t' || ch === '\r') continue;
    s += ch;
  }
  return s.toUpperCase();
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)/;

export function tokenize(s) {
  const words = [];
  let i = 0;
  while (i < s.length) {
    const L = s[i];
    if (L < 'A' || L > 'Z') throw new GcodeError(1, `"${L}"`);
    const m = NUM_RE.exec(s.slice(i + 1));
    if (!m) throw new GcodeError(2, t('errd.after', { l: L }));
    words.push({ L, v: parseFloat(m[0]) });
    i += 1 + m[0].length;
  }
  return words;
}

// Modalgrupper för G-koder, nycklade på värdet * 10.
const G_GROUP = {
  0: 'motion', 10: 'motion', 20: 'motion', 30: 'motion', 800: 'motion',
  382: 'probe', 383: 'probe', 384: 'probe', 385: 'probe',
  40: 'nonmodal', 100: 'nonmodal', 280: 'nonmodal', 281: 'nonmodal', 300: 'nonmodal', 301: 'nonmodal',
  530: 'nonmodal', 920: 'nonmodal', 921: 'nonmodal',
  170: 'plane', 180: 'plane', 190: 'plane',
  900: 'distance', 910: 'distance',
  901: 'arcdistance', 911: 'arcdistance',
  930: 'feedmode', 940: 'feedmode',
  200: 'units', 210: 'units',
  400: 'cutter',
  431: 'tlo', 490: 'tlo',
  540: 'wcs', 550: 'wcs', 560: 'wcs', 570: 'wcs', 580: 'wcs', 590: 'wcs',
  610: 'control',
};
const M_GROUP = { 0: 'stop', 1: 'stop', 2: 'stop', 30: 'stop', 3: 'spindle', 4: 'spindle', 5: 'spindle', 6: 'tool', 7: 'coolant', 8: 'coolant', 9: 'coolant', 56: 'override' };

const PLANES = { 170: [0, 1, 2], 180: [2, 0, 1], 190: [1, 2, 0] };
const AXES = ['X', 'Y', 'Z'];

// GRBL:s mc_arc: dela upp bågen i raka segment enligt $12 (arc tolerance).
export function segmentArc(pos, target, offset, radius, plane, cw, tol) {
  const [a0, a1, lin] = plane;
  const cx = pos[a0] + offset[a0];
  const cy = pos[a1] + offset[a1];
  const r0 = -offset[a0];
  const r1 = -offset[a1];
  const rt0 = target[a0] - cx;
  const rt1 = target[a1] - cy;
  let ang = Math.atan2(r0 * rt1 - r1 * rt0, r0 * rt0 + r1 * rt1);
  if (cw) { if (ang >= -ARC_EPS) ang -= 2 * Math.PI; }
  else if (ang <= ARC_EPS) ang += 2 * Math.PI;
  const denom = Math.sqrt(Math.max(1e-12, tol * (2 * radius - tol)));
  const segs = Math.floor(Math.abs(0.5 * ang * radius) / denom);
  const pts = [];
  if (segs > 0) {
    const th = ang / segs;
    const linPer = (target[lin] - pos[lin]) / segs;
    for (let i = 1; i < segs; i++) {
      const c = Math.cos(i * th);
      const s = Math.sin(i * th);
      const p = [0, 0, 0];
      p[a0] = cx + r0 * c - r1 * s;
      p[a1] = cy + r0 * s + r1 * c;
      p[lin] = pos[lin] + linPer * i;
      pts.push(p);
    }
  }
  pts.push(target.slice());
  return { points: pts, angle: ang, length: Math.hypot(Math.abs(ang) * radius, target[lin] - pos[lin]) };
}

/**
 * Tolka ett helt program.
 * env: { startPos, wcs: [[x,y,z] x6], arcTolerance, allowToolChange, initialTool }
 * Returnerar { ops, error, notes, lineCount }.
 */
export function interpret(text, env) {
  const lines = text.split('\n');
  const st = {
    motion: 0, plane: 170, absolute: true, inverse: false, inch: false,
    wcsIdx: 0, wcs: env.wcs.map((a) => a.slice()), g92: [0, 0, 0], tlo: 0,
    feed: 0, rpm: 0, spindle: 'off', tool: env.initialTool ?? 1, nextTool: env.initialTool ?? 1,
    pos: env.startPos.slice(), g28: env.home ? env.home.slice() : [0, 0, 0], g30: env.home ? env.home.slice() : [0, 0, 0],
  };
  const ops = [];
  const notes = [];
  let error = null;
  let ended = false;

  const workOffset = () => {
    const w = st.wcs[st.wcsIdx];
    return [w[0] + st.g92[0], w[1] + st.g92[1], w[2] + st.g92[2] + st.tlo];
  };

  const move = (rapid, target, feed, line, arc = false) => {
    if (target[0] === st.pos[0] && target[1] === st.pos[1] && target[2] === st.pos[2]) return;
    ops.push({ type: 'move', rapid, from: st.pos.slice(), to: target.slice(), feed, line, arc, wo: workOffset() });
    st.pos = target.slice();
  };

  const execLine = (raw, ln) => {
    let s = cleanLine(raw);
    if (!s || s[0] === '%') return;
    if (s[0] === '/') s = s.slice(1);
    if (s[0] === '$') {
      if (s === '$H') {
        ops.push({ type: 'sync', line: ln });
        const home = env.home || [0, 0, 0];
        move(true, [st.pos[0], st.pos[1], home[2]], 0, ln);
        move(true, home.slice(), 0, ln);
        notes.push({ line: ln, text: t('note.home') });
      } else if (/^\$[A-Z0-9#$=.JIGNCX-]*$/.test(s)) {
        notes.push({ line: ln, text: t('note.skip', { cmd: s }) });
      } else throw new GcodeError(3);
      return;
    }
    const words = tokenize(s);
    const gs = [];
    const ms = [];
    const val = {};
    for (const w of words) {
      if (w.L === 'G') gs.push(w.v);
      else if (w.L === 'M') ms.push(w.v);
      else {
        if (!'FIJKLNPRSTXYZ'.includes(w.L)) throw new GcodeError(20, t('errd.axes', { l: w.L }));
        if (w.L in val) throw new GcodeError(25, w.L);
        val[w.L] = w.v;
      }
    }
    if ('N' in val && (val.N < 0 || val.N > 9999999 || !Number.isInteger(val.N))) throw new GcodeError(27);

    // Klassificera G-koder
    const groups = {};
    for (const v of gs) {
      const k = Math.round(v * 10);
      if (Math.abs(v * 10 - k) > 1e-3) throw new GcodeError(23, `G${v}`);
      const grp = G_GROUP[k];
      if (!grp) throw new GcodeError(20, `G${v}`);
      if (grp === 'probe') throw new GcodeError(20, t('errd.probe', { v }));
      if (groups[grp] !== undefined) throw new GcodeError(21, `G${v}`);
      groups[grp] = k;
    }
    const mg = {};
    for (const v of ms) {
      if (!Number.isInteger(v)) throw new GcodeError(20, `M${v}`);
      const grp = M_GROUP[v];
      if (!grp) throw new GcodeError(20, `M${v}`);
      if (mg[grp] !== undefined) throw new GcodeError(21, `M${v}`);
      mg[grp] = v;
    }
    if (groups.arcdistance === 901) throw new GcodeError(20, t('errd.g901'));
    if (mg.tool === 6 && !env.allowToolChange) throw new GcodeError(20, t('errd.m6'));

    // Modala lägen gäller för hela raden innan värden tolkas
    if (groups.feedmode !== undefined) st.inverse = groups.feedmode === 930;
    if (groups.units !== undefined) st.inch = groups.units === 200;
    if (groups.plane !== undefined) st.plane = groups.plane;
    if (groups.distance !== undefined) st.absolute = groups.distance === 900;
    if (groups.wcs !== undefined) st.wcsIdx = (groups.wcs - 540) / 10;
    const unit = st.inch ? 25.4 : 1;
    const used = new Set(['N']);
    const hasAxis = AXES.some((a) => a in val);
    const nonmodal = groups.nonmodal;
    const motionInLine = groups.motion;
    const motion = motionInLine !== undefined ? motionInLine : st.motion;

    // F
    let inverseF = 0;
    if ('F' in val) {
      used.add('F');
      if (val.F < 0) throw new GcodeError(2, t('errd.negF'));
      if (st.inverse) inverseF = val.F;
      else st.feed = val.F * unit;
    }
    // S
    if ('S' in val) {
      used.add('S');
      if (val.S < 0) throw new GcodeError(2, t('errd.negS'));
    }
    // T
    if ('T' in val) {
      used.add('T');
      if (!Number.isInteger(val.T)) throw new GcodeError(23, 'T');
      if (val.T > 255) throw new GcodeError(38);
      st.nextTool = val.T;
    }
    // M6
    if (mg.tool === 6) {
      ops.push({ type: 'tool', tool: st.nextTool, prev: st.tool, line: ln });
      st.tool = st.nextTool;
    }
    // Spindel
    const newRpm = 'S' in val ? val.S : st.rpm;
    let newSpindle = st.spindle;
    if (mg.spindle !== undefined) newSpindle = mg.spindle === 3 ? 'cw' : mg.spindle === 4 ? 'ccw' : 'off';
    if (newSpindle !== st.spindle || (newRpm !== st.rpm && st.spindle !== 'off')) {
      ops.push({ type: 'spindle', state: newSpindle, rpm: newRpm, line: ln });
    }
    st.rpm = newRpm;
    st.spindle = newSpindle;
    // Kylning
    if (mg.coolant !== undefined) ops.push({ type: 'coolant', state: mg.coolant, line: ln });
    // G4
    if (nonmodal === 40) {
      if (!('P' in val)) throw new GcodeError(28, t('errd.g4P'));
      used.add('P');
      ops.push({ type: 'dwell', seconds: val.P, line: ln });
    }
    // G43.1 / G49
    if (groups.tlo === 431) {
      if ('X' in val || 'Y' in val) throw new GcodeError(37);
      if (!('Z' in val)) throw new GcodeError(26, t('errd.g431'));
      st.tlo = val.Z * unit;
      used.add('Z');
    } else if (groups.tlo === 490) st.tlo = 0;

    // Rörelsemål i maskinkoordinater
    const computeTarget = (machineCoords) => {
      const t = st.pos.slice();
      const wo = workOffset();
      AXES.forEach((a, i) => {
        if (!(a in val)) return;
        const v = val[a] * unit;
        if (machineCoords) t[i] = v;
        else if (st.absolute) t[i] = v + wo[i];
        else t[i] = st.pos[i] + v;
      });
      return t;
    };

    // Icke-modala kommandon som använder axelord
    let axisUsedByNonmodal = false;
    if (nonmodal === 100) {
      if (!('L' in val) || !('P' in val)) throw new GcodeError(28, t('errd.g10'));
      used.add('L'); used.add('P');
      let p = val.P;
      if (!Number.isInteger(p) || p < 0 || p > 6) throw new GcodeError(29);
      const idx = p === 0 ? st.wcsIdx : p - 1;
      if (val.L !== 2 && val.L !== 20) throw new GcodeError(20, `G10 L${val.L}`);
      AXES.forEach((a, i) => {
        if (!(a in val)) return;
        const v = val[a] * unit;
        st.wcs[idx][i] = val.L === 2 ? v : st.pos[i] - st.g92[i] - (i === 2 ? st.tlo : 0) - v;
      });
      axisUsedByNonmodal = true;
      ops.push({ type: 'sync', line: ln });
    } else if (nonmodal === 280 || nonmodal === 300) {
      if (hasAxis) move(true, computeTarget(false), 0, ln);
      move(true, (nonmodal === 280 ? st.g28 : st.g30).slice(), 0, ln);
      axisUsedByNonmodal = true;
    } else if (nonmodal === 281) st.g28 = st.pos.slice();
    else if (nonmodal === 301) st.g30 = st.pos.slice();
    else if (nonmodal === 920) {
      if (!hasAxis) throw new GcodeError(26, t('errd.g92'));
      AXES.forEach((a, i) => {
        if (!(a in val)) return;
        st.g92[i] = st.pos[i] - st.wcs[st.wcsIdx][i] - (i === 2 ? st.tlo : 0) - val[a] * unit;
      });
      axisUsedByNonmodal = true;
    } else if (nonmodal === 921) st.g92 = [0, 0, 0];
    if (axisUsedByNonmodal) {
      if (hasAxis && motionInLine !== undefined && motionInLine !== 800) throw new GcodeError(24);
      AXES.forEach((a) => used.add(a));
    }

    if (motionInLine !== undefined) st.motion = motionInLine;
    const g53 = nonmodal === 530;
    if (g53 && st.motion !== 0 && st.motion !== 10) throw new GcodeError(30);

    // Rörelse
    const needsMotion = motionInLine !== undefined && motionInLine !== 800 && motionInLine >= 20;
    if (!axisUsedByNonmodal && (hasAxis || needsMotion)) {
      if (motion === 800) {
        if (hasAxis) throw new GcodeError(31);
      } else if (!hasAxis) {
        throw new GcodeError(26, `G${motion / 10}`);
      } else {
        AXES.forEach((a) => used.add(a));
        const target = computeTarget(g53);
        if (motion === 0) move(true, target, 0, ln);
        else {
          if (st.inverse ? inverseF <= 0 : st.feed <= 0) throw new GcodeError(22, `G${motion / 10}`);
          if (motion === 10) {
            const len = Math.hypot(target[0] - st.pos[0], target[1] - st.pos[1], target[2] - st.pos[2]);
            move(false, target, st.inverse ? len * inverseF : st.feed, ln);
          } else {
            arcMove(motion === 20, target, val, unit, used, ln, inverseF);
          }
        }
      }
    }

    // Programstopp
    if (mg.stop === 0 || mg.stop === 1) ops.push({ type: 'pause', reason: `M${mg.stop}`, line: ln });
    if (mg.stop === 2 || mg.stop === 30) {
      if (st.spindle !== 'off') ops.push({ type: 'spindle', state: 'off', rpm: st.rpm, line: ln });
      ops.push({ type: 'end', line: ln });
      st.spindle = 'off';
      ended = true;
    }

    const unused = Object.keys(val).filter((k) => !used.has(k));
    if (unused.length) throw new GcodeError(36, unused.join(', '));
  };

  const arcMove = (cw, target, val, unit, used, ln, inverseF) => {
    const plane = PLANES[st.plane];
    const [a0, a1] = plane;
    const planeAxes = [AXES[a0], AXES[a1]];
    if (!planeAxes.some((a) => a in val)) throw new GcodeError(32);
    const x = target[a0] - st.pos[a0];
    const y = target[a1] - st.pos[a1];
    const offset = [0, 0, 0];
    let radius;
    if ('R' in val) {
      used.add('R');
      if (x === 0 && y === 0 && target.every((v, i) => v === st.pos[i])) throw new GcodeError(33, t('errd.rSame'));
      let r = val.R * unit;
      let h = 4 * r * r - x * x - y * y;
      if (h < 0) throw new GcodeError(34);
      h = -Math.sqrt(h) / Math.hypot(x, y);
      if (!cw) h = -h;
      if (r < 0) { h = -h; r = -r; }
      offset[a0] = 0.5 * (x - y * h);
      offset[a1] = 0.5 * (y + x * h);
      radius = r;
    } else {
      const ijk = ['I', 'J', 'K'];
      const inPlane = [ijk[a0], ijk[a1]];
      if (!inPlane.some((w) => w in val)) throw new GcodeError(35);
      ijk.forEach((w, i) => {
        if (w in val) {
          used.add(w);
          offset[i] = val[w] * unit;
        }
      });
      const tx = x - offset[a0];
      const ty = y - offset[a1];
      const targetR = Math.hypot(tx, ty);
      radius = Math.hypot(offset[a0], offset[a1]);
      const dr = Math.abs(targetR - radius);
      if (dr > 0.005 && (dr > 0.5 || dr > 0.001 * radius)) throw new GcodeError(33, t('errd.radius', { d: dr.toFixed(3) }));
    }
    const arc = segmentArc(st.pos, target, offset, radius, plane, cw, env.arcTolerance ?? 0.002);
    const feed = st.inverse ? arc.length * inverseF : st.feed;
    for (const p of arc.points) move(false, p, feed, ln, true);
  };

  for (let i = 0; i < lines.length && !ended; i++) {
    try {
      execLine(lines[i], i + 1);
    } catch (e) {
      if (e instanceof GcodeError) {
        error = { code: e.code, message: e.message, line: i + 1 };
        break;
      }
      throw e;
    }
  }
  return { ops, error, notes, lineCount: lines.length, finalPos: st.pos.slice() };
}
