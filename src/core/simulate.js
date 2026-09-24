// Kör ett helt program: tolkning, planering, materialborttagning och skärfysik.

import { interpret } from './gcode.js';
import { plan, timeAtDistance } from './planner.js';
import { HeightMap, prepareTool, newStampResult, chooseResolution } from './heightmap.js';
import { cutPhysics, chipLoadRange, recommend } from './physics.js';
import { TOOL_MATERIALS } from './library.js';

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
  const warn = (code, severity, line, t, value, title, detail, key = `${code}:${title}`) => {
    let w = warnings.get(key);
    if (!w) {
      w = { code, severity, line, t, count: 0, worst: value, title, detail, occ: [] };
      warnings.set(key, w);
    }
    w.count++;
    const last = w.occ[w.occ.length - 1];
    if ((!last || last.line !== line) && w.occ.length < 2000) w.occ.push({ line, t });
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[w.severity]) { w.severity = severity; w.title = title; w.detail = detail; w.worst = value; }
    else if (severity === w.severity && value > w.worst) { w.worst = value; w.detail = detail; w.title = title; }
    const cur = lineSeverity.get(line);
    if (cur === undefined || SEVERITY_RANK[severity] > SEVERITY_RANK[cur]) lineSeverity.set(line, severity);
  };

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
          text: `Mjuk gräns: rad ${blocks[j].line} vill köra utanför arbetsområdet (${axisOutside(p, travelMin, travelMax)}). GRBL upptäcker det när raden planeras och stannar maskinen direkt – ${j - k} block före målet.`,
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
      if (b.feedCapped) warn('FEED_CAP', 'info', b.line, b.t0, b.op.feed, 'Matningen begränsas av maskinens maxhastighet', `Programmerat F${Math.round(b.op.feed)} men axlarna klarar bara ${Math.round(b.rapidRate)} mm/min i den här riktningen ($110–$112).`);
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
            alarm = { code: 'ALARM:1', line: b.line, t: t0, text: `Hård gräns: maskinen körde på en gränsbrytare på rad ${b.line} (${axisOutside(B, travelMin, travelMax)}). GRBL stoppar alla motorer direkt, positionen är förlorad och maskinen måste referensköras ($H).` };
            stopTime = t0;
            break outer;
          }
          const clamped = B.map((v, i) => Math.min(travelMax[i], Math.max(travelMin[i], v)));
          for (let i = 0; i < 3; i++) offset[i] += clamped[i] - B[i];
          warn('TRAVEL', 'crit', b.line, t0, 1, 'Axeln kör in i ändläget', `Rörelsen går utanför arbetsområdet (${axisOutside(B, travelMin, travelMax)}). Utan gränslägesbrytare slår vagnen i ändstoppet och stegmotorn tappar steg – resten av programmet hamnar förskjutet.`);
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
              if (B[2] <= A[2] + 1e-6) warn('BED_RAPID', 'crit', b.line, t0, depth, 'Snabbförflyttning ner i offerskivan', `G0 går ${fmt(depth)} mm under ämnets undersida. Verktyget kraschar i bordet.`);
            } else if (depth > (cfg.spoilboard ?? 12)) warn('BED', 'crit', b.line, t0, depth, 'Fräser genom offerskivan in i maskinbordet', `Spetsen går ${fmt(depth)} mm under ämnet – djupare än offerskivan (${cfg.spoilboard ?? 12} mm).`);
            else if (depth > 1) warn('BED', 'warn', b.line, t0, depth, 'Djupt ner i offerskivan', `Spetsen går ${fmt(depth)} mm under ämnet. Vid genomfräsning räcker normalt 0,2–0,5 mm.`);
            else warn('BED', 'info', b.line, t0, depth, 'Fräser lite i offerskivan', `Spetsen går ${fmt(depth)} mm under ämnet (normalt vid genomfräsning).`);
          }
          if (st.vol > 1e-3) {
            removed += st.vol;
            flags |= 4; // skär i material
            const ap = st.apTop - Math.max(st.minTip, geo.bedZ);
            const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
            const dxy = Math.hypot(d[0], d[1]);
            if (st.shank > 0.05) warn('SHANK', 'crit', b.line, t0, st.shank, 'Verktygets skaft går i materialet', `Skärdjupet överstiger skärlängden (${fmt(prepTool.cutLen)} mm) med ${fmt(st.shank)} mm. Skaftet gnider, blir varmt och verktyget går lätt av.`);
            if (b.rapid) warn('RAPID_CUT', 'crit', b.line, t0, st.vol, 'Snabbförflyttning (G0) genom material', `G0 kör med ${Math.round(b.rapidRate)} mm/min rakt genom ämnet – en krasch. Lyft verktyget före förflyttningen eller använd G1.`);
            if (rpm < 1) {
              warn('SPINDLE_OFF', 'crit', b.line, t0, 1, 'Skär med stillastående spindel', sp.on ? 'Spindeln är på men varvtalet är 0 (S saknas eller S0). Verktyget pressas in i materialet och går av.' : 'M3 saknas – spindeln står still när verktyget går in i materialet. Verktyget går av.');
              broken = true;
              events.push({ t: t1, type: 'break', line: b.line, text: `Verktyg T${toolNum} gick av (spindeln stod still)` });
            } else {
              const ph = cutPhysics({ vol: st.vol, dt, dxy, dz: d[2], ap, rpm, tool, material, machine: m });
              load = ph.load; force = ph.force; defl = ph.deflection; chip = ph.hex; mrr = ph.mrr;
              maxLoad = Math.max(maxLoad, load); maxForce = Math.max(maxForce, force); maxDefl = Math.max(maxDefl, defl);
              checkCut(ph, { b, t0, rpm }, chipAcc);
              if (broken) events.push({ t: t1, type: 'break', line: b.line, text: `Verktyg T${toolNum} gick av på rad ${b.line}` });
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
                  warn('LOST_STEPS', 'crit', b.line, t0, ph.force, `Stegförlust på ${lost.join('/')}-axeln`, `Skärkraften (≈${Math.round(ph.force)} N) är större än vad stegmotorn orkar (${lost.map((a) => `${a}: ${m.thrust['XYZ'.indexOf(a)]} N`).join(', ')}). Motorn tappar steg, maskinen tappar positionen och resten av programmet hamnar förskjutet.`);
                  events.push({ t: t1, type: 'lost', line: b.line, text: `Stegförlust ${lost.join('/')} på rad ${b.line}` });
                }
              }
            }
          }
        }
        pushChunk(C, t0, t1, A, B, b.line, flags, toolIdx, rpm, (Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]) / dt) * 60, load, force, defl, chip, mrr, b.op.wo);
      }
      evalChip(chipAcc, b);
    } else if (it.type === 'spindle') {
      const t = it.t0;
      const on = op.state !== 'off';
      let target = 0;
      const s = m.spindle;
      if (on) {
        if (s.type === 'router') {
          target = s.dialRpm;
          if (!routerSWarned && op.rpm && Math.abs(op.rpm - s.dialRpm) > 1) {
            routerSWarned = true;
            warn('ROUTER_S', 'info', op.line, t, 0, 'S-värdet påverkar inte handöverfräsen', `Programmet vill ha ${op.rpm} rpm men fräsen går på ratten: ${s.dialRpm} rpm. M3/M5 slår bara på och av (via relä).`);
          }
        } else if (op.rpm <= 0) target = 0;
        else {
          target = Math.min(s.maxRpm, Math.max(s.minRpm || 0, op.rpm));
          if (op.rpm > s.maxRpm) warn('S_MAX', 'info', op.line, t, op.rpm, 'Varvtalet begränsas', `S${op.rpm} är högre än spindelns max (${s.maxRpm} rpm, $30).`);
        }
        if (op.rpm <= 0 && s.type !== 'router') warn('S_ZERO', 'warn', op.line, t, 0, 'Spindeln startas utan varvtal', 'M3 utan S-värde (eller S0) ger 0 % PWM – spindeln står still.');
      }
      const cur = rpmAt(t);
      sp.from = cur; sp.to = target; sp.t = t; sp.on = on;
      sp.dur = (s.spinUp || 1) * Math.abs(target - cur) / Math.max(1, s.maxRpm);
      events.push({ t, type: 'spindle', line: op.line, rpm: target, on, text: on ? `Spindel ${op.state === 'ccw' ? 'M4' : 'M3'} ${Math.round(target)} rpm` : 'Spindel av (M5)' });
    } else if (it.type === 'dwell') {
      events.push({ t: it.t0, t1: it.t1, type: 'dwell', line: op.line, text: `Väntar ${op.seconds} s (G4)` });
    } else if (it.type === 'tool') {
      toolChanges++;
      const def = cfg.tools[op.tool];
      if (sp.on && rpmAt(it.t0) > 0) warn('TC_SPINDLE', 'warn', op.line, it.t0, 0, 'Spindeln går vid verktygsbyte', 'GRBL stänger inte av spindeln vid M6. Lägg M5 före bytet.');
      if (!def) {
        warn('NO_TOOL', 'crit', op.line, it.t0, 0, `T${op.tool} finns inte i verktygstabellen`, 'Lägg till verktyget under Verktyg, annars fortsätter simuleringen med det gamla verktyget.');
      } else {
        toolNum = op.tool; tool = def; prepTool = prepareTool(def); broken = false;
      }
      events.push({ t: it.t0, type: 'tool', line: op.line, tool: op.tool, toolIdx: def ? getToolIdx(op.tool) : -1, text: `Verktygsbyte till T${op.tool}${def ? ` – ${def.name}` : ''}. Nollställ Z efter bytet.` });
    } else if (it.type === 'pause') {
      events.push({ t: it.t0, type: 'pause', line: op.line, text: `Programpaus (${op.reason}) – tryck på Start för att fortsätta` });
    } else if (it.type === 'end') {
      events.push({ t: it.t0, type: 'end', line: op.line, text: 'Programslut' });
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
      advice = `Maskinen hinner bara upp i ≈${Math.round(actualFeed)} mm/min av F${Math.round(b.op.feed)} på den korta sträckan (acceleration ${m.accel[0]} mm/s², $120). Längre rörelser eller lägre varvtal hjälper.`;
    } else if (suggestFeed > maxFeed && m.spindle.type !== 'router') {
      const s = Math.max(m.spindle.minRpm || 0, Math.round(maxFeed / (fzTarget / Math.max(thin, 0.05)) / z / 500) * 500);
      advice = `Maskinen klarar max ${Math.round(maxFeed)} mm/min – sänk i stället varvtalet till ≈S${s}.`;
    } else if (suggestFeed > maxFeed) {
      advice = `Maskinen klarar max ${Math.round(maxFeed)} mm/min – vrid ner fräsens varvtal på ratten.`;
    } else {
      advice = `Prova F≈${suggestFeed}${hex < fzMin ? ' eller sänk varvtalet' : ' eller höj varvtalet'}.`;
    }
    const line = b.line;
    const t0 = acc.t;
    const range = `Spåntjockleken är ${fmt(hex, 3)} mm (rekommenderat ${fmt(fzMin, 3)}–${fmt(fzMax, 3)} för Ø${fmt(Deff)} i ${material.name.toLowerCase()})`;
    const plunge = acc.plunge > 0.5 * acc.w;
    if (plunge) {
      // Vid nedstick accepteras tunnare spån, men för långsamt nedstick gnider ändå.
      if (hex < fzMin * 0.25) warn('PLUNGE_SLOW', 'info', line, t0, fzMin / hex, 'Mycket långsamt nedstick', `Spåntjockleken vid nedsticket är ${fmt(hex, 3)} mm per skär. Spetsen gnider och värms upp – en ramp eller helix ger renare skär och tar mindre tid.`);
      else if (hex > fzMax) warn('PLUNGE_FAST', 'warn', line, t0, hex / fzMax, 'För snabbt nedstick', `Spåntjockleken vid nedsticket är ${fmt(hex, 3)} mm per skär (max ≈${fmt(fzMax, 3)}). Centrumdelen av eggen tål inte det – sänk nedstickshastigheten eller ramp in.`);
      return;
    }
    if (hex < fzMin * 0.6) {
      if (material.melt) warn('MELT', 'warn', line, t0, fzMin / hex, 'Risk att plasten smälter', `${range}. Tunna spån tar inte med sig värmen – plasten smälter och svetsar fast. ${advice}`);
      else if (material.group === 'metal') warn('CHIP_LOW', 'warn', line, t0, fzMin / hex, 'För tunna spån – eggen gnider', `${range}. Metallen kladdar fast på eggen och verktyget slits snabbt. ${advice}`);
      else warn('CHIP_LOW', 'warn', line, t0, fzMin / hex, 'För tunna spån – risk för brännmärken', `${range}. Eggen gnider i stället för att skära. ${advice}`);
    } else if (hex > fzMax * 1.4) {
      const sev = hex > fzMax * 2.5 ? 'crit' : 'warn';
      warn('CHIP_HIGH', sev, line, t0, hex / fzMax, 'För tjocka spån', `${range}. Eggen överbelastas och kan flisa sig. ${advice}`);
    }
  }

  function checkCut(ph, { b, t0, rpm }, chipAcc) {
    const line = b.line;
    const vcMax = material.vcMax[tool.material] || material.vcMax.carbide;
    if (rpm < sp.to * 0.9 && sp.on) {
      warn('SPINUP', 'warn', line, t0, sp.to - rpm, 'Spindeln har inte nått fullt varvtal', `Verktyget går in i materialet vid ≈${Math.round(rpm)} rpm av ${Math.round(sp.to)}. GRBL väntar inte på spindeln – lägg in G4 P${Math.ceil(m.spindle.spinUp || 2)} efter M3.`);
    }
    // Spåntjockleken bedöms som volymviktat medel över blocket (se evalChip),
    // och bara där verktyget har ett rejält ingrepp – inte vid in- och utgång.
    if (ph.plunge || ph.ae >= 0.2 * ph.Deff) {
      const w = ph.mrr;
      chipAcc.w += w; chipAcc.hex += ph.hex * w; chipAcc.fz += ph.fz * w; chipAcc.deff += ph.Deff * w; chipAcc.rpm += rpm * w; chipAcc.feed += (ph.fz * Math.max(1, tool.flutes) * rpm) * w; if (ph.plunge) chipAcc.plunge += w;
      if (chipAcc.t < 0) chipAcc.t = t0;
    }
    if (ph.vc > vcMax) warn('VC_HIGH', 'warn', line, t0, ph.vc, 'För hög skärhastighet', `vc ≈ ${Math.round(ph.vc)} m/min, max ≈ ${vcMax} m/min för ${TOOL_MATERIALS[tool.material]?.name || 'verktyget'} i ${material.name.toLowerCase()}. Eggen blir för varm – sänk varvtalet.`);
    if (ph.load > 0.85) {
      const sev = ph.load > 1.2 ? 'crit' : 'warn';
      warn('POWER', sev, line, t0, ph.load, ph.load > 1 ? 'Spindeln överbelastas och tappar varv' : 'Spindeln går nära maxeffekt', `Skäret kräver ≈${Math.round(ph.power)} W men spindeln ger ${Math.round(ph.avail)} W vid ${Math.round(rpm)} rpm (${Math.round(ph.load * 100)} %). Minska skärdjup eller ingrepp.`);
    }
    if (ph.load > 2.2) {
      broken = true;
      warn('STALL', 'crit', line, t0, ph.load, 'Spindeln tvärstannar', `Effektbehovet är ${Math.round(ph.load * 100)} % av vad spindeln orkar. Spindeln stannar i skäret och verktyget går av.`);
      return;
    }
    if (ph.deflection > 0.08) {
      const sev = ph.deflection > 0.2 ? 'crit' : 'warn';
      warn('DEFLECT', sev, line, t0, ph.deflection, 'Verktyg och maskin böjs ut', `Utböjning ≈${fmt(ph.deflection, 3)} mm (verktyg ${fmt(ph.toolDefl, 3)} + maskin ${fmt(ph.machineDefl, 3)}) vid ≈${Math.round(ph.force)} N. Ger måttfel och risk för vibrationer (chatter).`);
    }
    if (ph.stressRatio >= 1) {
      broken = true;
      warn('BREAK', 'crit', line, t0, ph.stressRatio, 'Verktyget går av', `Böjspänningen i verktyget är ${Math.round(ph.stressRatio * 100)} % av brottgränsen (kraft ≈${Math.round(ph.force)} N, utstick ${tool.stickout} mm).`);
    } else if (ph.stressRatio > 0.65) {
      warn('BREAK_RISK', 'warn', line, t0, ph.stressRatio, 'Stor risk att verktyget går av', `Böjspänningen är ${Math.round(ph.stressRatio * 100)} % av brottgränsen. Minska skärdjupet, ingreppet eller utsticket.`);
    }
    if (ph.plunge && !tool.centerCutting) warn('PLUNGE_NC', 'crit', line, t0, 1, 'Nedstick med verktyg som inte skär i centrum', 'Verktyget kan inte borra rakt ner. Använd ramp eller helix.');
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
    if (cnt) warn('STARVE', cnt > 20 ? 'warn' : 'info', first, 0, worst, 'Planeringsbufferten svälter – maskinen hackar', `${cnt} rader är så korta att styrningen inte hinner ta emot dem (${m.baud} baud, ≈${m.parseMs} ms/rad). Farten sjunker till ned mot ${Math.round(100 / worst)} % av den planerade. Använd längre segment, bågar (G2/G3) eller en snabbare styrning.`, 'STARVE');
  }

  if (interp.error && !alarm) {
    events.push({ t: planned.totalTime, type: 'error', line: interp.error.line, text: `error:${interp.error.code} på rad ${interp.error.line}: ${interp.error.message}` });
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
  return `maskinkoordinat ${parts.join(', ')}`;
}

// Snabb svensk talformatering (decimalkomma, utan onödiga nollor).
export function fmt(v, dec = 2) {
  const f = 10 ** dec;
  let s = String(Math.round(Number(v) * f) / f);
  if (s.includes('e')) s = Number(v).toFixed(dec);
  if (s === '-0') s = '0';
  return s.replace('-', '−').replace('.', ',');
}
