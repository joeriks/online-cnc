// Rörelseplanerare modellerad efter GRBL 1.1 (planner.c).
// - Positioner avrundas till hela steg ($100–$102)
// - Hastighet och acceleration begränsas per axel ($110–$112, $120–$122)
// - Hörnhastighet med junction deviation ($11)
// - Lookahead begränsad till planeringsbufferten (15 block på en Arduino Uno)
// - Synkpunkter (M3/M5, S-byte, G4, M0, M6 …) tömmer bufferten så maskinen stannar
// - Seriell överföring: korta segment kan svälta bufferten så maskinen hackar

const LARGE = 1e38;

export function limitByAxis(maxValues, unit) {
  let limit = LARGE;
  for (let i = 0; i < 3; i++) {
    if (unit[i] !== 0) limit = Math.min(limit, Math.abs(maxValues[i] / unit[i]));
  }
  return limit;
}

// Trapetsprofil för ett block. Alla hastigheter i mm/s, acceleration i mm/s².
export function trapezoid(L, ve, vx, vn, a) {
  let da = Math.max(0, (vn * vn - ve * ve) / (2 * a));
  let dd = Math.max(0, (vn * vn - vx * vx) / (2 * a));
  if (da + dd > L) {
    const vp2 = (2 * a * L + ve * ve + vx * vx) / 2;
    const vp = Math.min(vn, Math.sqrt(Math.max(vp2, ve * ve, vx * vx)));
    da = Math.min(L, Math.max(0, (vp * vp - ve * ve) / (2 * a)));
    dd = L - da;
    return { L, ve, vx, vp, a, da, dc: 0, dd, ta: Math.max(0, (vp - ve) / a), tc: 0, td: Math.max(0, (vp - vx) / a) };
  }
  const dc = L - da - dd;
  return { L, ve, vx, vp: vn, a, da, dc, dd, ta: (vn - ve) / a, tc: dc / vn, td: (vn - vx) / a };
}

export function profileTime(p) {
  return p.ta + p.tc + p.td;
}

// Tid (s) för att nå sträckan s inom blocket.
export function timeAtDistance(p, s) {
  if (s <= 0) return 0;
  if (s >= p.L) return profileTime(p);
  if (s <= p.da) {
    if (p.a === 0) return s / Math.max(p.ve, 1e-9);
    return (-p.ve + Math.sqrt(p.ve * p.ve + 2 * p.a * s)) / p.a;
  }
  if (s <= p.da + p.dc) return p.ta + (s - p.da) / p.vp;
  const sd = s - p.da - p.dc;
  const disc = Math.max(0, p.vp * p.vp - 2 * p.a * sd);
  return p.ta + p.tc + (p.vp - Math.sqrt(disc)) / p.a;
}

const SYNC_TYPES = new Set(['spindle', 'dwell', 'pause', 'tool', 'sync', 'end', 'coolant']);

/**
 * Planera alla rörelser. machine: stepsPerMm, maxRate (mm/min), accel (mm/s²),
 * junctionDeviation, bufferBlocks, baud, parseMs.
 * Returnerar { items, blocks } där items är tidslinjen i ordning.
 */
export function plan(ops, machine, startPos, lineLengths = null) {
  const steps = machine.stepsPerMm;
  const W = Math.max(1, machine.bufferBlocks | 0);
  let posSteps = startPos.map((v, i) => Math.round(v * steps[i]));
  const blocks = [];
  const items = [];
  let group = [];
  let groupId = 0;
  let prevUnit = null;
  let prevNominal = 0;

  const flushGroup = () => {
    if (!group.length) return;
    planGroup(group, W);
    prevUnit = null;
    prevNominal = 0;
    group = [];
    groupId++;
  };

  for (const op of ops) {
    if (op.type === 'move') {
      const target = op.to.map((v, i) => Math.round(v * steps[i]));
      const dSteps = [target[0] - posSteps[0], target[1] - posSteps[1], target[2] - posSteps[2]];
      if (dSteps[0] === 0 && dSteps[1] === 0 && dSteps[2] === 0) continue; // GRBL kastar tomma block
      const from = posSteps.map((v, i) => v / steps[i]);
      const to = target.map((v, i) => v / steps[i]);
      const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const L = Math.hypot(d[0], d[1], d[2]);
      const unit = d.map((v) => v / L);
      const accel = limitByAxis(machine.accel, unit); // mm/s²
      const rapidRate = limitByAxis(machine.maxRate, unit); // mm/min
      const programmed = op.rapid ? rapidRate : Math.min(op.feed, rapidRate);
      const nominal = programmed / 60;
      let junctionSqr;
      if (!prevUnit) junctionSqr = 0;
      else {
        const cos = -(prevUnit[0] * unit[0] + prevUnit[1] * unit[1] + prevUnit[2] * unit[2]);
        if (cos > 0.999999) junctionSqr = 0;
        else if (cos < -0.999999) junctionSqr = LARGE;
        else {
          const ju = [unit[0] - prevUnit[0], unit[1] - prevUnit[1], unit[2] - prevUnit[2]];
          const jl = Math.hypot(ju[0], ju[1], ju[2]);
          const jAccel = limitByAxis(machine.accel, ju.map((v) => v / jl));
          const sinHalf = Math.sqrt(0.5 * (1 - cos));
          junctionSqr = Math.max(0, (jAccel * machine.junctionDeviation * sinHalf) / (1 - sinHalf));
        }
      }
      const maxEntrySqr = Math.min(junctionSqr, nominal * nominal, prevNominal * prevNominal);
      const block = {
        op, from, to, L, unit, accel, nominal, maxEntrySqr, groupId,
        feedCapped: !op.rapid && op.feed > rapidRate + 1e-6, rapidRate,
        line: op.line, rapid: op.rapid,
      };
      blocks.push(block);
      group.push(block);
      items.push({ type: 'move', block });
      posSteps = target;
      prevUnit = unit;
      prevNominal = nominal;
    } else {
      if (SYNC_TYPES.has(op.type)) flushGroup();
      items.push({ type: op.type, op });
    }
  }
  flushGroup();

  // Seriell genomströmning: varje källrad tar tid att skicka och tolka.
  const perByte = 10 / (machine.baud || 115200);
  const parseS = (machine.parseMs ?? 0) / 1000;
  const lineTimes = new Map();
  for (const b of blocks) {
    lineTimes.set(b.line, (lineTimes.get(b.line) || 0) + profileTime(b.profile));
  }
  const starved = new Map();
  for (const [line, t] of lineTimes) {
    const bytes = lineLengths ? (lineLengths[line - 1] ?? 20) + 1 : 21;
    const need = bytes * perByte + parseS;
    if (t > 0 && t < need) starved.set(line, need / t);
  }

  // Tidslinje
  let t = 0;
  for (const it of items) {
    if (it.type === 'move') {
      const b = it.block;
      b.timeScale = starved.get(b.line) || 1;
      b.t0 = t;
      b.duration = profileTime(b.profile) * b.timeScale;
      t += b.duration;
      b.t1 = t;
    } else if (it.type === 'dwell') {
      it.t0 = t;
      t += it.op.seconds;
      it.t1 = t;
    } else {
      it.t0 = t;
      it.t1 = t;
    }
  }
  return { items, blocks, totalTime: t, starvedLines: starved };
}

// Lookahead-planering för block mellan två synkpunkter.
function planGroup(g, W) {
  const n = g.length;
  let entrySqr = 0;
  for (let i = 0; i < n; i++) {
    const b = g[i];
    let exitLimit = 0;
    if (i < n - 1) {
      const end = Math.min(i + W - 1, n - 1);
      let e = 0;
      for (let j = end; j > i; j--) e = Math.min(g[j].maxEntrySqr, e + 2 * g[j].accel * g[j].L);
      exitLimit = e;
    }
    const exitSqr = Math.min(exitLimit, entrySqr + 2 * b.accel * b.L, b.nominal * b.nominal);
    b.profile = trapezoid(b.L, Math.sqrt(entrySqr), Math.sqrt(exitSqr), b.nominal, b.accel);
    entrySqr = exitSqr;
  }
}

// Position (sträcka) i blocket vid tiden tau (s) från blockets start.
export function distanceAtTime(p, tau) {
  if (tau <= 0) return 0;
  if (tau <= p.ta) return p.ve * tau + 0.5 * p.a * tau * tau;
  if (tau <= p.ta + p.tc) return p.da + p.vp * (tau - p.ta);
  const td = Math.min(tau - p.ta - p.tc, p.td);
  return Math.min(p.L, p.da + p.dc + p.vp * td - 0.5 * p.a * td * td);
}
