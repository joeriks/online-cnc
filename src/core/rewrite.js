// Automatic G-code edits used by the "Apply" buttons on warnings.
// Every function returns { code, changed } or { error } and never touches the original string.

import { cleanLine, tokenize } from './gcode.js';

const num = (v) => {
  const s = String(Math.round(v * 1000) / 1000);
  return s === '-0' ? '0' : s;
};

function checkSupported(lines) {
  for (const raw of lines) {
    const s = cleanLine(raw);
    if (/G20(?!\d)/.test(s)) return 'inch';
    if (/G93(?!\d)/.test(s)) return 'inverse';
    if (/G91(?![.\d])/.test(s)) return 'relative';
  }
  return null;
}

// Replace a word's value in a raw line, keeping comments and spacing.
function setWord(raw, letter, value) {
  const re = new RegExp(`(^|[^A-Za-z(;])(${letter})\\s*([+-]?(?:\\d+\\.?\\d*|\\.\\d+))`, 'i');
  const code = splitComment(raw);
  if (re.test(code.body)) return code.body.replace(re, (m, pre, L) => `${pre}${L}${value}`) + code.comment;
  return `${code.body.replace(/\s+$/, '')} ${letter}${value}${code.comment ? ` ${code.comment.trim()}` : ''}`;
}

function splitComment(raw) {
  const i = raw.search(/[(;]/);
  return i < 0 ? { body: raw, comment: '' } : { body: raw.slice(0, i), comment: raw.slice(i) };
}

function words(raw) {
  try {
    const out = {};
    for (const w of tokenize(cleanLine(raw))) {
      if (w.L === 'G' || w.L === 'M') (out[w.L] ||= []).push(w.v);
      else out[w.L] = w.v;
    }
    return out;
  } catch {
    return {};
  }
}

// F<from> → F<to> on every line that sets that feed.
export function replaceFeed(code, from, to) {
  const lines = code.split('\n');
  const why = checkSupported(lines);
  if (why) return { error: why };
  let changed = 0;
  const out = lines.map((raw) => {
    const w = words(raw);
    if (w.F === undefined || Math.abs(w.F - from) > 0.5) return raw;
    changed++;
    return setWord(raw, 'F', num(to));
  });
  return changed ? { code: out.join('\n'), changed } : { error: 'nofeed' };
}

// Spindle speed: S on M3/M4 lines (and S-only lines) → s. Optionally scale feeds by k.
export function setSpeeds(code, s, feedFrom, feedTo) {
  const lines = code.split('\n');
  const why = checkSupported(lines);
  if (why) return { error: why };
  let changed = 0;
  let out = lines.map((raw) => {
    const w = words(raw);
    const spindleOn = (w.M || []).some((m) => m === 3 || m === 4);
    if (w.S === undefined && !spindleOn) return raw;
    if (w.S === 0 && !spindleOn) return raw;
    changed++;
    return setWord(raw, 'S', num(s));
  });
  if (feedFrom && feedTo) {
    const r = replaceFeed(out.join('\n'), feedFrom, feedTo);
    if (!r.error) { out = r.code.split('\n'); changed += r.changed; }
  }
  return changed ? { code: out.join('\n'), changed } : { error: 'nospindle' };
}

// G4 P<p> right after every M3/M4 that is not already followed by a dwell.
export function addDwell(code, p) {
  const lines = code.split('\n');
  const out = [];
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const w = words(lines[i]);
    if (!(w.M || []).some((m) => m === 3 || m === 4)) continue;
    const next = words(lines[i + 1] || '');
    if ((next.G || []).includes(4) || (w.G || []).includes(4)) continue;
    out.push(`G4 P${num(p)}`);
    changed++;
  }
  return changed ? { code: out.join('\n'), changed } : { error: 'nodwell' };
}

// Insert a line before line n (1-based).
export function insertBefore(code, n, text) {
  const lines = code.split('\n');
  if (n < 1 || n > lines.length) return { error: 'line' };
  lines.splice(n - 1, 0, text);
  return { code: lines.join('\n'), changed: 1 };
}

// Raise retract heights: G0 moves to Z between (top + 2.5) and z are lifted to z.
export function raiseSafeZ(code, z, top = 0) {
  const lines = code.split('\n');
  const why = checkSupported(lines);
  if (why) return { error: why };
  let motion = 0;
  let changed = 0;
  const out = lines.map((raw) => {
    const w = words(raw);
    const g = (w.G || []).find((v) => v === 0 || v === 1 || v === 2 || v === 3);
    if (g !== undefined) motion = g;
    if ((w.G || []).includes(53)) return raw;
    if (motion !== 0 || w.Z === undefined) return raw;
    if (w.Z < top + 2.5 || w.Z >= z) return raw;
    changed++;
    return setWord(raw, 'Z', num(z));
  });
  return changed ? { code: out.join('\n'), changed } : { error: 'nosafe' };
}

// Split deep passes into several shallower ones (2.5D programs, absolute mm).
// A pass is a feed plunge to depth z followed by XY moves at that depth. When it is more than
// maxStep below the previous cut in the same area, copies of the pass are cut at in-between
// depths first, each followed by a retract and a move back to the start of the pass.
export function splitPasses(code, maxStep, top = 0) {
  const lines = code.split('\n');
  const why = checkSupported(lines);
  if (why) return { error: why };
  const st = { x: 0, y: 0, z: 0, motion: 0, feed: 0 };
  const passes = [];
  let cur = null;
  const snapshot = [];
  for (let i = 0; i < lines.length; i++) {
    const w = words(lines[i]);
    snapshot.push({ ...st });
    const g = (w.G || []).find((v) => v === 0 || v === 1 || v === 2 || v === 3);
    if (g !== undefined) st.motion = g;
    if (w.F !== undefined) st.feed = w.F;
    if ((w.G || []).includes(53)) { cur = null; continue; }
    const nx = w.X ?? st.x, ny = w.Y ?? st.y, nz = w.Z ?? st.z;
    const zMoves = w.Z !== undefined && Math.abs(w.Z - st.z) > 1e-6;
    const isArc = st.motion === 2 || st.motion === 3;
    if (zMoves) {
      if (cur) { passes.push(cur); cur = null; }
      // A straight feed plunge (no XY) below the top starts a pass
      if (st.motion === 1 && nz < top - 1e-6 && nz < st.z && w.X === undefined && w.Y === undefined) {
        cur = { start: i, end: i, z: nz, fromZ: st.z, sx: st.x, sy: st.y, feed: snapshot[i].feed, bbox: [nx, ny, nx, ny] };
      }
    } else if (cur && (w.X !== undefined || w.Y !== undefined || isArc)) {
      if (isArc && w.Z !== undefined && Math.abs(w.Z - cur.z) > 1e-6) { passes.push(cur); cur = null; }
      else {
        cur.end = i;
        cur.bbox = [Math.min(cur.bbox[0], nx), Math.min(cur.bbox[1], ny), Math.max(cur.bbox[2], nx), Math.max(cur.bbox[3], ny)];
      }
    } else if (cur && (w.M || []).length) { passes.push(cur); cur = null; }
    else if (cur) cur.end = i;
    st.x = nx; st.y = ny; st.z = nz;
  }
  if (cur) passes.push(cur);

  // Depth already cut in each pass's area = deepest earlier overlapping pass (or the top)
  const overlaps = (a, b) => a[0] <= b[2] + 0.5 && b[0] <= a[2] + 0.5 && a[1] <= b[3] + 0.5 && b[1] <= a[3] + 0.5;
  const inserts = new Map();
  let added = 0;
  passes.forEach((p, k) => {
    let prev = top;
    for (let j = 0; j < k; j++) if (overlaps(passes[j].bbox, p.bbox)) prev = Math.min(prev, passes[j].z);
    const depth = prev - p.z;
    if (depth <= maxStep + 1e-6) return;
    const n = Math.ceil(depth / maxStep - 1e-9);
    const step = depth / n;
    const block = lines.slice(p.start, p.end + 1);
    const extra = [];
    for (let j = 1; j < n; j++) {
      const zj = prev - step * j;
      for (let q = 0; q < block.length; q++) {
        const w = words(block[q]);
        extra.push(q === 0 || (w.Z !== undefined && Math.abs(w.Z - p.z) < 1e-6) ? setWord(block[q], 'Z', num(zj)) : block[q]);
      }
      extra.push(`G0 Z${num(p.fromZ)}`, `G0 X${num(p.sx)} Y${num(p.sy)}${p.feed ? ` F${num(p.feed)}` : ''}`);
      added++;
    }
    inserts.set(p.start, extra);
  });
  if (!added) return { error: 'nopasses' };
  const out = [];
  lines.forEach((l, i) => {
    if (inserts.has(i)) out.push(...inserts.get(i));
    out.push(l);
  });
  return { code: out.join('\n'), changed: added };
}

// Apply a structured action from a warning. Tool actions change the tool table instead.
export function applyAction(code, a) {
  switch (a.type) {
    case 'feed': return replaceFeed(code, a.from, a.to);
    case 'speeds': return setSpeeds(code, a.s, a.feedFrom, a.feedTo);
    case 'dwell': return addDwell(code, a.p);
    case 'insert': return insertBefore(code, a.line, a.text);
    case 'safeZ': return raiseSafeZ(code, a.z, a.top);
    case 'stepdown': return splitPasses(code, a.step, a.top);
    default: return { error: 'unknown' };
  }
}
