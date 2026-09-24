// Kör ett helt program: tolkning, planering, materialborttagning och skärfysik.

import { interpret } from './gcode.js';
import { plan, timeAtDistance } from './planner.js';
import { HeightMap, prepareTool, newStampResult, chooseResolution } from './heightmap.js';
import { cutPhysics, chipLoadRange, recommend } from './physics.js';
import { loc, toolName } from './library.js';
import { t, fmt, gfmt } from '../i18n.js';

export { fmt };

const SEVERITY_RANK = { info: 0, warn: 1, crit: 2 };

export function stockGeometry(cfg) {
  const m = cfg.machine;
  const bedZ = -m.zClearance;
  const s = cfg.stock;
  const box = { x0: s.px, y0: s.py, x1: s.px + s.sx, y1: s.py + s.sy, z0: bedZ, z1: bedZ + s.sz };
  const zero = [
    cfg.zero.xy === 'center' ? s.px + s.sx / 2 : s.px,
    cfg.zero.xy === 'center' ? s.py + s.sy / 2 : s.py,
    cfg.zero.z === 'bottom' ? bedZ : bedZ + s.sz,
  ];
  return { bedZ, box, zero };
}

export function machineStart(cfg, geo) {
  return [geo.zero[0], geo.zero[1], 0];
}

export function simulate(code, cfg, onProgress) {
  const m = cfg.machine;
  const material = cfg.material;
  const geo = stockGeometry(cfg);
  const wcs = [geo.zero.slice(), [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const start = machineStart(cfg, geo);
  const lines = code.split('\n');
  const home = [0, 0, 0];

  const interp = interpret(code, {
    startPos: start, wcs, arcTolerance: m.arcTolerance, allowToolChange: m.allowToolChange,
    initialTool: cfg.initialTool, home,
  });
  const planned = plan(interp.ops, m, start, lines.map((l) => l.length));

  const toolNums = Object.keys(cfg.tools).map(Number);
  const minD = Math.min(...toolNums.map((n) => cfg.tools[n].d));
  const res = cfg.resolution || chooseResolution(cfg.stock.sx, cfg.stock.sy, cfg.detail, minD);
  const hmParams = { x0: geo.box.x0, y0: geo.box.y0, sx: cfg.stock.sx, sy: cfg.stock.sy, zBottom: geo.box.z0, zTop: geo.box.z1, res };
  const hm = new HeightMap(hmParams);

  // Verktyg som används, indexerade för uppspelningen
  const toolList = [];
  const toolIndex = new Map();
  const getToolIdx = (num) => {
    if (!toolIndex.has(num)) {
      toolIndex.set(num, toolList.length);
      toolList.push({ number: num, def: cfg.tools[num] });
    }
    return toolIndex.get(num);
  };

  // Chunkdata (kolumner)
  const C = { t0: [], t1: [], ax: [], ay: [], az: [], bx: [], by: [], bz: [], line: [], flags: [], tool: [], rpm: [], feed: [], load: [], force: [], defl: [], chip: [], mrr: [], wx: [], wy: [], wz: [] };
  const events = [];
  const warnings = new Map();
  const lineSeverity = new Map();
  const notes = interp.notes.slice();

  // Varningar grupperas per typ; varje förekomst (rad + tid) sparas så man kan stega mellan dem.
  // opts: { fix: 'konkret åtgärd', key: 'grupperingsnyckel' }
  const warn = (code, severity, line, t, value, title, detail, opts = {}) => {
    const key = opts.key || `${code}:${title}`;
    const fix = opts.fix || '';
    let w = warnings.get(key);
    if (!w) {
      w = { code, severity, line, t, count: 0, worst: value, title, detail, fix, occ: [] };
      warnings.set(key, w);
    }
    w.count++;
    const last = w.occ[w.occ.length - 1];
    if ((!last || last.line !== line) && w.occ.length < 2000) w.occ.push({ line, t });
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[w.severity]) { w.severity = severity; w.title = title; w.detail = detail; w.fix = fix; w.worst = value; }
    else if (severity === w.severity && value > w.worst) { w.worst = value; w.detail = detail; w.title = title; w.fix = fix; }
    const cur = lineSeverity.get(line);
    if (cur === undefined || SEVERITY_RANK[severity] > SEVERITY_RANK[cur]) lineSeverity.set(line, severity);
  };

  const workZ = (machineZ, wo) => gfmt(machineZ - wo[2], 2);
  // Varning via översättningsnycklar: w.<k>.title / .detail / .fix
  const W = (code, severity, line, time, value, k, p = {}, opts = {}) => warn(code, severity, line, time, value,
    t(`w.${k}.title`, p), opts.detail ?? t(`w.${k}.detail`, p), { ...opts, fix: opts.fix ?? (t(`w.${k}.fix`, p) === `w.${k}.fix` ? '' : t(`w.${k}.fix`, p)) });

  // Tillstånd
  let toolNum = cfg.initialTool;
  let tool = cfg.tools[toolNum];
  let prepTool = tool ? prepareTool(tool) : null;
  let broken = false;
  const offset = [0, 0, 0]; // förlorade steg (verklig − kommenderad)
  const sp = { on: false, from: 0, to: 0, t: 0, dur: 0, programmed: 0 };
  const rpmAt = (t) => {
    if (sp.dur <= 0 || t >= sp.t + sp.dur) return sp.to;
    return sp.from + (sp.to - sp.from) * Math.max(0, (t - sp.t) / sp.dur);
  };
  const travelMin = [0, 0, -m.travel[2]];
  const travelMax = [m.travel[0], m.travel[1], 0];
  let alarm = null;
  let stopTime = Infinity;
  let removed = 0;
  let cutDist = 0;
  let rapidDist = 0;
  let cutTime = 0;
  let naive = 0;
  let maxLoad = 0;
  let maxForce = 0;
  let maxDefl = 0;
  let toolChanges = 0;
  let routerSWarned = false;

  // Mjuka gränser: GRBL upptäcker felet när raden planeras, upp till en full buffert i förväg.
  if (m.softLimits) {
    const blocks = planned.blocks;
    for (let j = 0; j < blocks.length; j++) {
      const p = blocks[j].to;
      const out = [0, 1, 2].some((i) => p[i] < travelMin[i] - 1e-3 || p[i] > travelMax[i] + 1e-3);
      if (out) {
        let gs = j;
        while (gs > 0 && blocks[gs - 1].groupId === blocks[j].groupId) gs--;
        const k = Math.max(gs, j - m.bufferBlocks);
        stopTime = blocks[k].t0;
        alarm = {
          code: 'ALARM:2', line: blocks[j].line, t: stopTime,
          text: t('alarm.soft', { line: blocks[j].line, where: axisOutside(p, travelMin, travelMax), blocks: j - k }),
        };
        break;
      }
    }
  }

  const itemsTotal = planned.items.length;
  let lastProgress = 0;
  let lastLine = 1;
  outer: for (let ii = 0; ii < itemsTotal; ii++) {
    const it = planned.items[ii];
    if (onProgress && ii - lastProgress > 2000) { lastProgress = ii; onProgress(ii / itemsTotal); }
    if (it.t0 >= stopTime) break;
    const op = it.op;
    if (it.type === 'move') {
      const b = it.block;
      lastLine = b.line;
      const nominalFeed = b.rapid ? b.rapidRate : Math.min(b.op.feed, b.rapidRate);
      naive += (b.L / nominalFeed) * 60;
      if (b.rapid) rapidDist += b.L; else cutDist += b.L;
      if (b.feedCapped) W('FEED_CAP', 'info', b.line, b.t0, b.op.feed, 'FEED_CAP', { f: Math.round(b.op.feed), max: Math.round(b.rapidRate) }, { fix: '' });
      const chunkLen = b.rapid ? 3 : 1;
      const n = Math.max(1, Math.ceil(b.L / chunkLen));
      const toolIdx = tool ? getToolIdx(toolNum) : -1;
      let prevT = b.t0;
      const chipAcc = { w: 0, hex: 0, fz: 0, deff: 0, rpm: 0, feed: 0, plunge: 0, t: -1 };
      for (let k = 1; k <= n; k++) {
        const s0 = (b.L * (k - 1)) / n;
        const s1 = (b.L * k) / n;
        const t0 = prevT;
        const t1 = k === n ? b.t1 : b.t0 + timeAtDistance(b.profile, s1) * b.timeScale;
        prevT = t1;
        if (t0 >= stopTime) break outer;
        const f0 = s0 / b.L;
        const f1 = s1 / b.L;
        const A = [0, 1, 2].map((i) => b.from[i] + (b.to[i] - b.from[i]) * f0 + offset[i]);
        let B = [0, 1, 2].map((i) => b.from[i] + (b.to[i] - b.from[i]) * f1 + offset[i]);
        // Hårda gränser / krasch i ändläget
        const outside = [0, 1, 2].some((i) => B[i] < travelMin[i] - 1e-3 || B[i] > travelMax[i] + 1e-3);
        if (outside) {
          if (m.hardLimits) {
            alarm = { code: 'ALARM:1', line: b.line, t: t0, text: t('alarm.hard', { line: b.line, where: axisOutside(B, travelMin, travelMax) }) };
            stopTime = t0;
            break outer;
          }
          const clamped = B.map((v, i) => Math.min(travelMax[i], Math.max(travelMin[i], v)));
          for (let i = 0; i < 3; i++) offset[i] += clamped[i] - B[i];
          W('TRAVEL', 'crit', b.line, t0, 1, 'TRAVEL', { where: axisOutside(B, travelMin, travelMax), x: m.travel[0], y: m.travel[1], z: m.travel[2] });
          B = clamped;
        }

        let flags = b.rapid ? 1 : 0;
        const rpm = rpmAt((t0 + t1) / 2);
        const dt = Math.max(1e-6, t1 - t0);
        let load = 0, force = 0, defl = 0, chip = 0, mrr = 0;
        if (!b.rapid) cutTime += dt;
        if (tool && !broken) {
          flags |= 2; // verktyget kan skära
          const st = newStampResult();
          hm.stampSegment(prepTool, A[0], A[1], A[2], B[0], B[1], B[2], st);
          const minZ = Math.min(A[2], B[2]);
          if (minZ < geo.bedZ - 0.01) {
            const depth = geo.bedZ - minZ;
            if (b.rapid) {
              if (B[2] <= A[2] + 1e-6) W('BED_RAPID', 'crit', b.line, t0, depth, 'BED_RAPID', { d: fmt(depth) });
            } else if (depth > (cfg.spoilboard ?? 12)) W('BED', 'crit', b.line, t0, depth, 'BED_CRIT', { d: fmt(depth), s: cfg.spoilboard ?? 12, z: workZ(geo.bedZ - 0.3, b.op.wo) });
            else if (depth > 1) W('BED', 'warn', b.line, t0, depth, 'BED_WARN', { d: fmt(depth), z: workZ(geo.bedZ - 0.3, b.op.wo) });
            else W('BED', 'info', b.line, t0, depth, 'BED_INFO', { d: fmt(depth) });
          }
          if (st.vol > 1e-3) {
            removed += st.vol;
            flags |= 4; // skär i material
            const ap = st.apTop - Math.max(st.minTip, geo.bedZ);
            const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
            const dxy = Math.hypot(d[0], d[1]);
            if (st.shank > 0.05) W('SHANK', 'crit', b.line, t0, st.shank, 'SHANK', { len: fmt(prepTool.cutLen), d: fmt(st.shank), need: Math.ceil(prepTool.cutLen + st.shank + 1) });
            if (b.rapid) W('RAPID_CUT', 'crit', b.line, t0, st.vol, 'RAPID_CUT', { rate: Math.round(b.rapidRate), z: workZ(geo.box.z1 + 3, b.op.wo), line: b.line });
            if (rpm < 1) {
              W('SPINDLE_OFF', 'crit', b.line, t0, 1, 'SPINDLE_OFF', { rpm: recRpm(), p: Math.ceil(m.spindle.spinUp || 1) }, { detail: t(sp.on ? 'w.SPINDLE_OFF.detailOn' : 'w.SPINDLE_OFF.detailOff') });
              broken = true;
              events.push({ t: t1, type: 'break', line: b.line, text: t('ev.breakStill', { n: toolNum }) });
            } else {
              const ph = cutPhysics({ vol: st.vol, dt, dxy, dz: d[2], ap, rpm, tool, material, machine: m });
              load = ph.load; force = ph.force; defl = ph.deflection; chip = ph.hex; mrr = ph.mrr;
              maxLoad = Math.max(maxLoad, load); maxForce = Math.max(maxForce, force); maxDefl = Math.max(maxDefl, defl);
              checkCut(ph, { b, t0, rpm }, chipAcc);
              if (broken) events.push({ t: t1, type: 'break', line: b.line, text: t('ev.breakLine', { n: toolNum, line: b.line }) });
              // Stegförluster: axelkraften överstiger vad motorn orkar
              if (cfg.lostSteps !== false && !broken) {
                const L3 = Math.hypot(d[0], d[1], d[2]) || 1;
                const lost = [];
                for (let i = 0; i < 3; i++) {
                  const comp = i === 2 && ph.plunge ? ph.force : ph.force * Math.abs(d[i] / L3);
                  if (comp > m.thrust[i] && Math.abs(d[i]) > 1e-6) {
                    lost.push('XYZ'[i]);
                    offset[i] -= d[i];
                    B[i] = A[i];
                  }
                }
                if (lost.length) {
                  W('LOST_STEPS', 'crit', b.line, t0, ph.force, 'LOST_STEPS', { axes: lost.join('/'), f: Math.round(ph.force), limits: lost.map((a) => `${a}: ${m.thrust['XYZ'.indexOf(a)]} N`).join(', ') }, { fix: reduceForce(ph, b, Math.min(...lost.map((a) => (0.7 * m.thrust['XYZ'.indexOf(a)]) / ph.force))) });
                  events.push({ t: t1, type: 'lost', line: b.line, text: t('ev.lost', { axes: lost.join('/'), line: b.line }) });
                }
              }
            }
          }
        }
        pushChunk(C, t0, t1, A, B, b.line, flags, toolIdx, rpm, (Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) / dt) * 60, load, force, defl, chip, mrr, b.op.wo);
      }
      evalChip(chipAcc, b);
    } else if (it.type === 'spindle') {
      const tt = it.t0;
      const on = op.state !== 'off';
      let target = 0;
      const s = m.spindle;
      if (on) {
        if (s.type === 'router') {
          target = s.dialRpm;
          if (!routerSWarned && op.rpm && Math.abs(op.rpm - s.dialRpm) > 1) {
            routerSWarned = true;
            W('ROUTER_S', 'info', op.line, tt, 0, 'ROUTER_S', { rpm: op.rpm, dial: s.dialRpm });
          }
        } else if (op.rpm <= 0) target = 0;
        else {
          target = Math.min(s.maxRpm, Math.max(s.minRpm || 0, op.rpm));
          if (op.rpm > s.maxRpm) W('S_MAX', 'info', op.line, tt, op.rpm, 'S_MAX', { s: op.rpm, max: s.maxRpm, k: fmt(s.maxRpm / op.rpm, 2) });
        }
        if (op.rpm <= 0 && s.type !== 'router') W('S_ZERO', 'warn', op.line, tt, 0, 'S_ZERO', { rpm: recRpm(), line: op.line });
      }
      const cur = rpmAt(tt);
      sp.from = cur; sp.to = target; sp.t = tt; sp.on = on;
      sp.dur = (s.spinUp || 1) * Math.abs(target - cur) / Math.max(1, s.maxRpm);
      events.push({ t: tt, type: 'spindle', line: op.line, rpm: target, on, text: on ? t('ev.spindleOn', { m: op.state === 'ccw' ? 'M4' : 'M3', rpm: Math.round(target) }) : t('ev.spindleOff') });
    } else if (it.type === 'dwell') {
      events.push({ t: it.t0, t1: it.t1, type: 'dwell', line: op.line, text: t('ev.dwell', { s: fmt(op.seconds) }) });
    } else if (it.type === 'tool') {
      toolChanges++;
      const def = cfg.tools[op.tool];
      if (sp.on && rpmAt(it.t0) > 0) W('TC_SPINDLE', 'warn', op.line, it.t0, 0, 'TC_SPINDLE', { n: op.tool });
      if (!def) {
        W('NO_TOOL', 'crit', op.line, it.t0, 0, 'NO_TOOL', { n: op.tool });
      } else {
        toolNum = op.tool; tool = def; prepTool = prepareTool(def); broken = false;
      }
      events.push({ t: it.t0, type: 'tool', line: op.line, tool: op.tool, toolIdx: def ? getToolIdx(op.tool) : -1, text: t('ev.tool', { n: op.tool, name: def ? ` – ${toolName(def)}` : '' }) });
    } else if (it.type === 'pause') {
      events.push({ t: it.t0, type: 'pause', line: op.line, text: t('ev.pause', { r: op.reason }) });
    } else if (it.type === 'end') {
      events.push({ t: it.t0, type: 'end', line: op.line, text: t('ev.end') });
    }
  }

  function evalChip(acc, b) {
    if (acc.w <= 0 || !tool) return;
    const hex = acc.hex / acc.w;
    const fz = acc.fz / acc.w;
    const Deff = acc.deff / acc.w;
    const rpm = acc.rpm / acc.w;
    const [fzMin, fzMax] = chipLoadRange(material, Math.min(tool.d, Deff));
    const thin = hex / Math.max(fz, 1e-9);
    const fzTarget = Math.sqrt(fzMin * fzMax);
    const z = Math.max(1, tool.flutes);
    const suggestFeed = Math.round((fzTarget / Math.max(thin, 0.05)) * z * rpm / 10) * 10;
    const actualFeed = acc.feed / acc.w;
    const maxFeed = Math.min(b.rapidRate, m.maxRate[0], m.maxRate[1]);
    let advice;
    if (!b.rapid && actualFeed < 0.7 * b.op.feed) {
      advice = t('adv.accel', { v: Math.round(actualFeed), f: Math.round(b.op.feed), a: m.accel[0] });
    } else if (suggestFeed > maxFeed && m.spindle.type !== 'router') {
      const s = Math.max(m.spindle.minRpm || 0, Math.round(maxFeed / (fzTarget / Math.max(thin, 0.05)) / z / 500) * 500);
      advice = t('adv.maxS', { max: Math.round(maxFeed), s });
    } else if (suggestFeed > maxFeed) {
      advice = t('adv.maxDial', { max: Math.round(maxFeed) });
    } else {
      advice = t(hex < fzMin ? 'adv.feedLow' : 'adv.feedHigh', { f: suggestFeed });
    }
    const line = b.line;
    const t0 = acc.t;
    const range = t('chip.range', { h: fmt(hex, 3), a: fmt(fzMin, 3), b: fmt(fzMax, 3), d: fmt(Deff), mat: loc(material).toLowerCase() });
    const plunge = acc.plunge > 0.5 * acc.w;
    const plungeFeed = Math.round((fzMin * 0.6 * z * rpm) / 10) * 10;
    const plungeMax = Math.round((fzMax * 0.8 * z * rpm) / 10) * 10;
    if (plunge) {
      // Vid nedstick accepteras tunnare spån, men för långsamt nedstick gnider ändå.
      if (hex < fzMin * 0.25) W('PLUNGE_SLOW', 'info', line, t0, fzMin / hex, 'PLUNGE_SLOW', { h: fmt(hex, 3), f: Math.min(plungeFeed, m.maxRate[2]) });
      else if (hex > fzMax) W('PLUNGE_FAST', 'warn', line, t0, hex / fzMax, 'PLUNGE_FAST', { h: fmt(hex, 3), max: fmt(fzMax, 3), f: plungeMax });
      return;
    }
    if (hex < fzMin * 0.6) {
      if (material.melt) W('MELT', 'warn', line, t0, fzMin / hex, 'MELT', { range }, { fix: advice });
      else if (material.group === 'metal') W('CHIP_LOW', 'warn', line, t0, fzMin / hex, 'CHIP_LOW_METAL', { range }, { fix: advice });
      else W('CHIP_LOW', 'warn', line, t0, fzMin / hex, 'CHIP_LOW', { range }, { fix: advice });
    } else if (hex > fzMax * 1.4) {
      const sev = hex > fzMax * 2.5 ? 'crit' : 'warn';
      W('CHIP_HIGH', sev, line, t0, hex / fzMax, 'CHIP_HIGH', { range }, { fix: advice });
    }
  }

  // Rekommenderat varvtal för aktuellt verktyg (för åtgärdstexter)
  function recRpm() {
    return tool ? recommend(tool, material, m).rpm : Math.round(m.spindle.maxRpm * 0.8);
  }


  // Skärkraften är ungefär proportionell mot skärdjup (ap) och sidsteg (ae),
  // och mot matningen upphöjt till (1 − mc). Räkna fram värden som ger kraften × r.
  function reduceForce(ph, b, r, extra = '') {
    r = Math.min(0.95, Math.max(0.02, r));
    const opts = [];
    const feed = b.op.feed || 0;
    if (ph.plunge) {
      opts.push(t('fix.plungeFeed', { f: round10(feed * Math.pow(r, 1 / (1 - material.mc))), now: Math.round(feed) }));
      opts.push(t('fix.ramp'));
    } else {
      if (ph.ap > 0.1) opts.push(t('fix.ap', { v: fmt(floorStep(ph.ap * r, 0.05)), now: fmt(ph.ap) }));
      if (ph.ae >= 0.9 * ph.Deff) opts.push(t('fix.slot', { v: fmt(floorStep(ph.Deff * Math.min(0.4, r), 0.05)) }));
      else if (ph.ae * r >= 0.05 * ph.Deff) opts.push(t('fix.ae', { v: fmt(floorStep(ph.ae * r, 0.05)), now: fmt(ph.ae) }));
      const fr = Math.pow(r, 1 / (1 - material.mc));
      const [fzMin] = chipLoadRange(material, ph.Deff);
      if (feed > 0 && ph.hex * fr >= fzMin * 0.6) opts.push(t('fix.feed', { f: round10(feed * fr), now: Math.round(feed) }));
    }
    let text = opts.length ? cap(opts.join(t('fix.or'))) + '.' : '';
    if (extra) text += ` ${extra}`;
    return text.trim();
  }

  // Kortare utstick minskar verktygets utböjning med L³ och böjspänningen med L.
  function stickoutHint(rTool, power) {
    const L = tool.stickout;
    const Lnew = Math.floor(L * Math.pow(Math.min(1, rTool), 1 / power));
    const minL = Math.ceil((tool.fluteLen || 5) + 2);
    if (Lnew < L - 1 && Lnew >= minL) return t('fix.stickout', { n: Lnew, now: L });
    if (Lnew < minL && L > minL + 1) return t('fix.stickoutMin', { n: minL });
    return '';
  }

  function deflectFix(ph, b) {
    const target = 0.07;
    const r = target / ph.deflection;
    let extra = '';
    if (ph.machineDefl > ph.toolDefl) {
      extra = t('fix.frame', { d: fmt(ph.machineDefl, 3), k: m.stiffness });
    } else {
      const rest = Math.max(0.01, target - ph.machineDefl);
      extra = stickoutHint(rest / ph.toolDefl, 3);
    }
    extra += ` ${t('fix.finish')}`;
    return reduceForce(ph, b, r, extra);
  }

  function powerFix(ph, b, rpm) {
    const r = 0.8 / ph.load;
    let extra = '';
    const s = m.spindle;
    if (s.type !== 'router' && rpm < s.maxRpm * 0.9) {
      const rpmNew = Math.min(s.maxRpm, Math.round(rpm / Math.max(r, 0.3) / 500) * 500);
      extra = t('fix.rpmPower', { s: rpmNew, f: round10((b.op.feed || 0) * (rpmNew / rpm)), p: Math.round((rpmNew / rpm) * 100) });
    }
    return reduceForce(ph, b, r, extra);
  }

  function checkCut(ph, { b, t0, rpm }, chipAcc) {
    const line = b.line;
    const vcMax = material.vcMax[tool.material] || material.vcMax.carbide;
    if (rpm < sp.to * 0.9 && sp.on) {
      W('SPINUP', 'warn', line, t0, sp.to - rpm, 'SPINUP', { rpm: Math.round(rpm), target: Math.round(sp.to), p: Math.ceil(m.spindle.spinUp || 2) });
    }
    // Spåntjockleken bedöms som volymviktat medel över blocket (se evalChip),
    // och bara där verktyget har ett rejält ingrepp – inte vid in- och utgång.
    if (ph.plunge || ph.ae >= 0.2 * ph.Deff) {
      const w = ph.mrr;
      chipAcc.w += w; chipAcc.hex += ph.hex * w; chipAcc.fz += ph.fz * w; chipAcc.deff += ph.Deff * w; chipAcc.rpm += rpm * w; chipAcc.feed += (ph.fz * Math.max(1, tool.flutes) * rpm) * w; if (ph.plunge) chipAcc.plunge += w;
      if (chipAcc.t < 0) chipAcc.t = t0;
    }
    if (ph.vc > vcMax) { const k = vcMax / ph.vc; W('VC_HIGH', 'warn', line, t0, ph.vc, 'VC_HIGH', { vc: Math.round(ph.vc), max: vcMax, tm: t(`tm.${tool.material}`), mat: loc(material).toLowerCase(), s: Math.round((rpm * k) / 500) * 500, f: round10(b.op.feed * k) }); }
    if (ph.load > 0.85) {
      const sev = ph.load > 1.2 ? 'crit' : 'warn';
      W('POWER', sev, line, t0, ph.load, ph.load > 1 ? 'POWER_OVER' : 'POWER_NEAR', { p: Math.round(ph.power), avail: Math.round(ph.avail), rpm: Math.round(rpm), load: Math.round(ph.load * 100) }, { detail: t('w.POWER.detail', { p: Math.round(ph.power), avail: Math.round(ph.avail), rpm: Math.round(rpm), load: Math.round(ph.load * 100) }), fix: powerFix(ph, b, rpm) });
    }
    if (ph.load > 2.2) {
      broken = true;
      W('STALL', 'crit', line, t0, ph.load, 'STALL', { load: Math.round(ph.load * 100) }, { fix: powerFix(ph, b, rpm) });
      return;
    }
    if (ph.deflection > 0.08) {
      const sev = ph.deflection > 0.2 ? 'crit' : 'warn';
      W('DEFLECT', sev, line, t0, ph.deflection, 'DEFLECT', { d: fmt(ph.deflection, 3), dt: fmt(ph.toolDefl, 3), dm: fmt(ph.machineDefl, 3), f: Math.round(ph.force) }, { fix: deflectFix(ph, b) });
    }
    if (ph.stressRatio >= 1) {
      broken = true;
      W('BREAK', 'crit', line, t0, ph.stressRatio, 'BREAK', { p: Math.round(ph.stressRatio * 100), f: Math.round(ph.force), l: tool.stickout }, { fix: reduceForce(ph, b, 0.5 / ph.stressRatio, stickoutHint(0.5 / ph.stressRatio, 1)) });
    } else if (ph.stressRatio > 0.65) {
      W('BREAK_RISK', 'warn', line, t0, ph.stressRatio, 'BREAK_RISK', { p: Math.round(ph.stressRatio * 100), f: Math.round(ph.force) }, { fix: reduceForce(ph, b, 0.5 / ph.stressRatio, stickoutHint(0.5 / ph.stressRatio, 1)) });
    }
    if (ph.plunge && !tool.centerCutting) W('PLUNGE_NC', 'crit', line, t0, 1, 'PLUNGE_NC');
  }

  // Svältande buffert
  if (planned.starvedLines.size) {
    let worst = 1, first = Infinity, cnt = 0;
    for (const [line, f] of planned.starvedLines) {
      if (line > lastLine && alarm) continue;
      cnt++;
      worst = Math.max(worst, f);
      first = Math.min(first, line);
    }
    if (cnt) W('STARVE', cnt > 20 ? 'warn' : 'info', first, 0, worst, 'STARVE', { n: cnt, baud: m.baud, ms: fmt(m.parseMs, 1), p: Math.round(100 / worst) }, { key: 'STARVE' });
  }

  if (interp.error && !alarm) {
    events.push({ t: planned.totalTime, type: 'error', line: interp.error.line, text: t('ev.error', { code: interp.error.code, line: interp.error.line, msg: interp.error.message }) });
    lineSeverity.set(interp.error.line, 'crit');
  }
  if (alarm) {
    events.push({ t: alarm.t, type: 'alarm', line: alarm.line, text: `${alarm.code} – ${alarm.text}` });
    lineSeverity.set(alarm.line, 'crit');
  }
  events.sort((a, b) => a.t - b.t);

  const n = C.t0.length;
  const f32 = (arr) => Float32Array.from(arr);
  const chunks = {
    n,
    t0: Float64Array.from(C.t0), t1: Float64Array.from(C.t1),
    ax: f32(C.ax), ay: f32(C.ay), az: f32(C.az), bx: f32(C.bx), by: f32(C.by), bz: f32(C.bz),
    line: Int32Array.from(C.line), flags: Uint8Array.from(C.flags), tool: Int16Array.from(C.tool),
    rpm: f32(C.rpm), feed: f32(C.feed), load: f32(C.load), force: f32(C.force), defl: f32(C.defl),
    chip: f32(C.chip), mrr: f32(C.mrr), wx: f32(C.wx), wy: f32(C.wy), wz: f32(C.wz),
  };
  const endTime = Math.min(stopTime, planned.totalTime, n ? Math.max(chunks.t1[n - 1], lastEventTime(events)) : lastEventTime(events));

  const warnList = [...warnings.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.t - b.t);
  const counts = { info: 0, warn: 0, crit: 0 };
  for (const w of warnList) counts[w.severity]++;
  const firstTool = cfg.tools[cfg.initialTool];

  return {
    error: interp.error,
    alarm,
    notes,
    geometry: { ...geo, hm: hmParams, res: hm.dx },
    start,
    tools: toolList,
    chunks,
    events,
    warnings: warnList,
    lineSeverity: Object.fromEntries(lineSeverity),
    finalHeights: hm.h,
    summary: {
      totalTime: endTime,
      naiveTime: naive,
      cutTime,
      cutDist,
      rapidDist,
      removed,
      maxLoad,
      maxForce,
      maxDefl,
      toolChanges,
      counts,
      broken: events.some((e) => e.type === 'break'),
      lostSteps: events.some((e) => e.type === 'lost'),
      offset: offset.slice(),
      lines: lines.length,
      blocks: planned.blocks.length,
      recommendation: firstTool ? recommend(firstTool, material, m) : null,
    },
  };
}

function lastEventTime(events) {
  let t = 0;
  for (const e of events) t = Math.max(t, e.t1 ?? e.t);
  return t;
}

function pushChunk(C, t0, t1, A, B, line, flags, tool, rpm, feed, load, force, defl, chip, mrr, wo) {
  C.t0.push(t0); C.t1.push(t1);
  C.ax.push(A[0]); C.ay.push(A[1]); C.az.push(A[2]);
  C.bx.push(B[0]); C.by.push(B[1]); C.bz.push(B[2]);
  C.line.push(line); C.flags.push(flags); C.tool.push(tool);
  C.rpm.push(rpm); C.feed.push(feed); C.load.push(load); C.force.push(force); C.defl.push(defl); C.chip.push(chip); C.mrr.push(mrr);
  C.wx.push(wo[0]); C.wy.push(wo[1]); C.wz.push(wo[2]);
}

function axisOutside(p, min, max) {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    if (p[i] < min[i] - 1e-3) parts.push(`${'XYZ'[i]} ${fmt(p[i])} < ${fmt(min[i])}`);
    else if (p[i] > max[i] + 1e-3) parts.push(`${'XYZ'[i]} ${fmt(p[i])} > ${fmt(max[i])}`);
  }
  return t('axis.outside', { parts: parts.join(', ') });
}

const round10 = (v) => Math.max(10, Math.round(v / 10) * 10);
const floorStep = (v, step) => Math.max(step, Math.floor(v / step) * step);

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

