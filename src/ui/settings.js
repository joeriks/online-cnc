// Inställningspaneler: maskin, verktyg, material och ämne.

import { MACHINES, TOOLS, MATERIALS, SPINDLE_TYPES, TOOL_TYPES, TOOL_MATERIALS, findById, cloneTool } from '../core/library.js';
import { recommend, chipLoadRange } from '../core/physics.js';
import { makeProfile, cuttingLength, describeTool } from '../core/tool.js';
import { el, numField, textField, selectField, checkField, axisField, section, nf } from './dom.js';

export function renderMachine(root, state, changed) {
  const m = state.machine;
  root.replaceChildren();
  const presetOpts = [['', 'Välj förinställning…'], ...MACHINES.map((p) => [p.id, p.name])];
  root.append(
    section('Maskin',
      selectField('Förinställning', presetOpts, '', (id) => {
        if (!id) return;
        state.machine = JSON.parse(JSON.stringify(findById(MACHINES, id)));
        fitStock(state);
        changed('machine');
        renderMachine(root, state, changed);
      }, { id: 'machine-preset' }),
      el('p', { class: 'note', text: m.note || 'Egen maskinkonfiguration.' }),
    ),
    section('Rörelse (GRBL-inställningar)',
      axisField('Arbetsområde (mm)', m.travel, (i, v) => { m.travel[i] = Math.max(1, v); changed(); }, { code: '$130–$132', idPrefix: 'm-travel' }),
      axisField('Maxhastighet (mm/min)', m.maxRate, (i, v) => { m.maxRate[i] = Math.max(1, v); changed(); }, { code: '$110–$112', idPrefix: 'm-rate' }),
      axisField('Acceleration (mm/s²)', m.accel, (i, v) => { m.accel[i] = Math.max(1, v); changed(); }, { code: '$120–$122', idPrefix: 'm-accel' }),
      axisField('Steg per mm', m.stepsPerMm, (i, v) => { m.stepsPerMm[i] = Math.max(1, v); changed(); }, { code: '$100–$102', idPrefix: 'm-steps' }),
      el('div', { class: 'fields' },
        numField('Junction deviation', m.junctionDeviation, (v) => { m.junctionDeviation = Math.max(0.001, v); changed(); }, { unit: 'mm', code: '$11', step: 0.001, id: 'm-jd' }),
        numField('Arc tolerance', m.arcTolerance, (v) => { m.arcTolerance = Math.max(0.0005, v); changed(); }, { unit: 'mm', code: '$12', step: 0.001, id: 'm-at' }),
        numField('Spets över bordet vid Z0', m.zClearance, (v) => { m.zClearance = Math.max(1, v); changed(); }, { unit: 'mm', step: 1, id: 'm-zc' }),
      ),
      el('div', { class: 'fields wide' },
        checkField('Mjuka gränser', m.softLimits, (v) => { m.softLimits = v; changed(); }, { code: '$20', id: 'm-soft' }),
        checkField('Hårda gränslägesbrytare', m.hardLimits, (v) => { m.hardLimits = v; changed(); }, { code: '$21', id: 'm-hard' }),
        checkField('Tillåt verktygsbyte (M6)', m.allowToolChange, (v) => { m.allowToolChange = v; changed(); }, { id: 'm-m6' }),
      ),
    ),
    section('Spindel',
      selectField('Typ', Object.entries(SPINDLE_TYPES), m.spindle.type, (v) => { m.spindle.type = v; changed(); renderMachine(root, state, changed); }, { id: 'sp-type' }),
      el('div', { class: 'fields' },
        numField('Axeleffekt', m.spindle.power, (v) => { m.spindle.power = Math.max(1, v); changed(); }, { unit: 'W', step: 10, id: 'sp-power' }),
        m.spindle.type === 'router'
          ? numField('Varvtal på ratten', m.spindle.dialRpm, (v) => { m.spindle.dialRpm = Math.max(1000, v); changed(); }, { unit: 'rpm', step: 500, id: 'sp-dial' })
          : numField('Max varvtal', m.spindle.maxRpm, (v) => { m.spindle.maxRpm = Math.max(100, v); changed(); }, { unit: 'rpm', code: '$30', step: 500, id: 'sp-max' }),
        m.spindle.type === 'router' ? null : numField('Min varvtal', m.spindle.minRpm, (v) => { m.spindle.minRpm = Math.max(0, v); changed(); }, { unit: 'rpm', code: '$31', step: 500, id: 'sp-min' }),
        numField('Uppvarvning 0→max', m.spindle.spinUp, (v) => { m.spindle.spinUp = Math.max(0, v); changed(); }, { unit: 's', step: 0.1, id: 'sp-spin' }),
      ),
    ),
    section('Mekanik',
      axisField('Axelkraft innan stegförlust (N)', m.thrust, (i, v) => { m.thrust[i] = Math.max(1, v); changed(); }, { idPrefix: 'm-thrust' }),
      el('div', { class: 'fields' },
        numField('Ramstyvhet', m.stiffness, (v) => { m.stiffness = Math.max(10, v); changed(); }, { unit: 'N/mm', step: 10, id: 'm-stiff' }),
      ),
      el('p', { class: 'hint', text: 'Axelkraften är vad stegmotor, skruv/rem och drivelektronik orkar trycka innan motorn tappar steg. Styvheten avgör hur mycket ramen fjädrar undan för skärkraften.' }),
    ),
    section('Styrning och överföring',
      el('div', { class: 'fields' },
        numField('Planeringsbuffert', m.bufferBlocks, (v) => { m.bufferBlocks = Math.max(1, Math.round(v)); changed(); }, { unit: 'block', step: 1, id: 'm-buf' }),
        numField('Seriell hastighet', m.baud, (v) => { m.baud = Math.max(1200, v); changed(); }, { unit: 'baud', step: 100, id: 'm-baud' }),
        numField('Tolkning per rad', m.parseMs, (v) => { m.parseMs = Math.max(0, v); changed(); }, { unit: 'ms', step: 0.1, id: 'm-parse' }),
      ),
      el('p', { class: 'hint', text: 'GRBL på en Arduino Uno planerar 15 rörelser framåt. Korta segment som skickas snabbare än styrningen hinner ta emot dem gör att maskinen bromsar in och hackar.' }),
    ),
  );
}

export function fitStock(state) {
  const t = state.machine.travel;
  const s = state.stock;
  s.px = Math.max(0, Math.min(s.px, t[0] - s.sx));
  s.py = Math.max(0, Math.min(s.py, t[1] - s.sy));
}

export function drawToolIcon(canvas, tool) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = 34, H = 44;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cs = getComputedStyle(canvas);
  const ink = cs.getPropertyValue('--ink-2').trim() || '#555';
  const acc = cs.getPropertyValue('--accent').trim() || '#0c6b77';
  const cut = cuttingLength(tool);
  const len = Math.max(tool.stickout, cut);
  const maxR = Math.max(tool.d, tool.shankD || tool.d) / 2;
  const scale = Math.min((W - 6) / (2 * maxR), (H - 4) / len);
  const cx = W / 2, base = H - 2;
  const prof = makeProfile(tool);
  const R = tool.d / 2;
  const sr = (tool.shankD || tool.d) / 2;
  const pts = [];
  const steps = 12;
  for (let k = 0; k <= steps; k++) {
    const r = (R * k) / steps;
    pts.push([r, prof ? prof(r) : 0]);
  }
  const top = tool.type === 'vbit' ? Math.min(cut, prof(R)) : cut;
  g.fillStyle = acc;
  g.beginPath();
  g.moveTo(cx - pts[pts.length - 1][0] * scale, base - top * scale);
  for (let k = pts.length - 1; k >= 0; k--) g.lineTo(cx - pts[k][0] * scale, base - pts[k][1] * scale);
  for (let k = 0; k < pts.length; k++) g.lineTo(cx + pts[k][0] * scale, base - pts[k][1] * scale);
  g.lineTo(cx + R * scale, base - top * scale);
  g.closePath();
  g.fill();
  g.fillStyle = ink;
  g.globalAlpha = 0.55;
  g.fillRect(cx - sr * scale, base - len * scale, 2 * sr * scale, (len - top) * scale);
  g.globalAlpha = 1;
}

export function renderTools(root, state, ui, changed) {
  root.replaceChildren();
  const nums = Object.keys(state.tools).map(Number).sort((a, b) => a - b);
  if (!nums.includes(ui.selectedTool)) ui.selectedTool = nums[0];
  const tool = state.tools[ui.selectedTool];
  const material = findById(MATERIALS, state.materialId);
  const rerender = () => renderTools(root, state, ui, changed);

  const table = el('div', { class: 'tool-table' });
  for (const n of nums) {
    const t = state.tools[n];
    const cv = el('canvas', { width: 34, height: 44, 'aria-hidden': 'true' });
    const row = el('button', { type: 'button', class: 'tool-row', 'aria-pressed': String(n === ui.selectedTool), onclick: () => { ui.selectedTool = n; rerender(); } },
      el('span', { class: 'tnum', text: `T${n}` }),
      el('span', { class: 'tname' }, t.name, el('small', { text: `${describeTool(t)} · ${TOOL_MATERIALS[t.material]?.name || ''}` })),
      cv,
    );
    table.append(row);
    requestAnimationFrame(() => drawToolIcon(cv, t));
  }
  const addBtn = el('button', { type: 'button', class: 'btn btn-sm', text: 'Lägg till verktyg', onclick: () => {
    let n = 1;
    while (state.tools[n]) n++;
    state.tools[n] = cloneTool(TOOLS.find((t) => t.id === 'v60') || TOOLS[0]);
    ui.selectedTool = n;
    changed();
    rerender();
  } });
  const delBtn = nums.length > 1 ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: `Ta bort T${ui.selectedTool}`, onclick: () => {
    delete state.tools[ui.selectedTool];
    if (state.initialTool === ui.selectedTool) state.initialTool = Number(Object.keys(state.tools)[0]);
    changed();
    rerender();
  } }) : null;

  root.append(
    section('Verktygstabell',
      table,
      el('div', { class: 'row-actions' }, addBtn, delBtn),
      selectField('Verktyg i spindeln vid start', nums.map((n) => [n, `T${n} – ${state.tools[n].name}`]), state.initialTool, (v) => { state.initialTool = Number(v); changed(); }, { id: 'initial-tool' }),
      el('p', { class: 'hint', text: 'Programmet byter verktyg med T# M6. Simulatorn antar att du nollställer Z efter varje byte.' }),
    ),
  );

  if (!tool) return;
  const set = (k, parse = (v) => v) => (v) => { tool[k] = parse(v); changed(); rerender(); };
  const libOpts = [['', 'Hämta från biblioteket…'], ...TOOLS.map((t) => [t.id, t.name])];
  const fields = el('div', { class: 'fields' },
    selectField('Typ', Object.entries(TOOL_TYPES), tool.type, set('type'), { id: 'tool-type' }),
    numField('Diameter', tool.d, set('d', (v) => Math.max(0.1, v)), { unit: 'mm', step: 0.001, id: 'tool-d' }),
    numField('Antal skär', tool.flutes, set('flutes', (v) => Math.max(1, Math.round(v))), { step: 1, id: 'tool-z' }),
    numField('Skärlängd', tool.fluteLen, set('fluteLen', (v) => Math.max(0.1, v)), { unit: 'mm', step: 0.5, id: 'tool-lc' }),
    numField('Utstick', tool.stickout, set('stickout', (v) => Math.max(1, v)), { unit: 'mm', step: 0.5, id: 'tool-ls' }),
    numField('Skaft', tool.shankD, set('shankD', (v) => Math.max(0.5, v)), { unit: 'mm', step: 0.001, id: 'tool-shank' }),
    selectField('Material', Object.entries(TOOL_MATERIALS).map(([k, v]) => [k, v.name]), tool.material, set('material'), { id: 'tool-mat' }),
    tool.type === 'vbit' ? numField('Spetsvinkel', tool.angle, set('angle', (v) => Math.min(170, Math.max(5, v))), { unit: '°', step: 1, id: 'tool-angle' }) : null,
    tool.type === 'vbit' ? numField('Spetsbredd', tool.tipD || 0, set('tipD', (v) => Math.max(0, v)), { unit: 'mm', step: 0.05, id: 'tool-tip' }) : null,
    tool.type === 'bull' ? numField('Hörnradie', tool.cornerR || 0.5, set('cornerR', (v) => Math.max(0.05, v)), { unit: 'mm', step: 0.1, id: 'tool-cr' }) : null,
  );
  root.append(
    section(`T${ui.selectedTool}`,
      selectField('Bibliotek', libOpts, '', (id) => {
        if (!id) return;
        state.tools[ui.selectedTool] = cloneTool(findById(TOOLS, id));
        changed();
        rerender();
      }, { id: 'tool-lib' }),
      textField('Namn', tool.name, (v) => { tool.name = v; changed(); rerender(); }, { id: 'tool-name' }),
      fields,
      checkField('Skär i centrum (kan borra rakt ner)', tool.centerCutting, (v) => { tool.centerCutting = v; changed(); }, { id: 'tool-cc' }),
    ),
  );

  const r = recommend(tool, material, state.machine);
  root.append(
    section(`Rekommenderade data i ${material.name.toLowerCase()}`,
      el('div', { class: 'reco' },
        el('div', {}, el('span', { text: 'Varvtal' }), el('b', { text: `S${nf(r.rpm)}` })),
        el('div', {}, el('span', { text: 'Matning' }), el('b', { text: `F${nf(r.feed)}` })),
        el('div', {}, el('span', { text: 'Nedstick' }), el('b', { text: `F${nf(r.plunge)}` })),
        el('div', {}, el('span', { text: 'Skärdjup (fullt spår)' }), el('b', { text: `${nf(r.ap, 2)} mm` })),
        el('div', {}, el('span', { text: 'Spåntjocklek fz' }), el('b', { text: `${nf(r.fzRange[0], 3)}–${nf(r.fzRange[1], 3)}` })),
        el('div', {}, el('span', { text: 'Skärhastighet vc' }), el('b', { text: `${nf(r.vc)} m/min` })),
      ),
      el('p', { class: 'hint', text: `Beräknat för ${state.machine.name || 'maskinen'}: skärdjupet sänks tills spindellast, verktygsspänning, utböjning och axelkraft håller sig inom säkra gränser. Last i fullt spår ≈ ${nf(r.load * 100)} %.` }),
    ),
  );
}

export function renderStock(root, state, changed) {
  root.replaceChildren();
  const mat = findById(MATERIALS, state.materialId);
  const s = state.stock;
  const tool = state.tools[state.initialTool] || Object.values(state.tools)[0];
  const [fzMin, fzMax] = chipLoadRange(mat, tool ? tool.d : 6);
  const rerender = () => renderStock(root, state, changed);
  root.append(
    section('Material',
      selectField('Material', MATERIALS.map((m) => [m.id, m.name]), mat.id, (v) => { state.materialId = v; changed(); rerender(); }, { id: 'material' }),
      el('p', { class: 'note' }, el('span', { class: 'swatch', style: `background:${mat.color}` }), mat.note),
      el('dl', { class: 'props' },
        el('dt', { text: 'Specifik skärkraft kc1.1' }), el('dd', { text: `${nf(mat.kc11)} N/mm²` }),
        el('dt', { text: 'Kienzle-exponent mc' }), el('dd', { text: nf(mat.mc, 2) }),
        el('dt', { text: `Spåntjocklek (Ø${nf(tool ? tool.d : 6, 2)})` }), el('dd', { text: `${nf(fzMin, 3)}–${nf(fzMax, 3)} mm/skär` }),
        el('dt', { text: 'Max vc (HM / HSS)' }), el('dd', { text: `${nf(mat.vcMax.carbide)} / ${nf(mat.vcMax.hss)} m/min` }),
      ),
    ),
    section('Ämne',
      el('div', { class: 'fields' },
        numField('Längd X', s.sx, (v) => { s.sx = Math.max(1, v); fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-sx' }),
        numField('Bredd Y', s.sy, (v) => { s.sy = Math.max(1, v); fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-sy' }),
        numField('Tjocklek Z', s.sz, (v) => { s.sz = Math.max(0.5, v); changed(); }, { unit: 'mm', step: 0.5, id: 'stock-sz' }),
        numField('Position X', s.px, (v) => { s.px = v; fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-px' }),
        numField('Position Y', s.py, (v) => { s.py = v; fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-py' }),
        numField('Offerskiva', state.spoilboard, (v) => { state.spoilboard = Math.max(0, v); changed(); }, { unit: 'mm', step: 1, id: 'spoil' }),
      ),
      el('p', { class: 'hint', text: 'Positionen är ämnets främre vänstra hörn i maskinkoordinater. Ämnet ligger på offerskivan.' }),
    ),
    section('Nollpunkt (G54)',
      el('div', { class: 'fields' },
        selectField('X/Y', [['corner', 'Främre vänstra hörnet'], ['center', 'Ämnets mitt']], state.zero.xy, (v) => { state.zero.xy = v; changed(); }, { id: 'zero-xy' }),
        selectField('Z', [['top', 'Ämnets överkant'], ['bottom', 'Ämnets underkant']], state.zero.z, (v) => { state.zero.z = v; changed(); }, { id: 'zero-z' }),
      ),
    ),
    section('Simulering',
      el('div', { class: 'fields' },
        selectField('Detaljnivå', [['low', 'Låg (snabb)'], ['normal', 'Normal'], ['high', 'Hög']], state.detail, (v) => { state.detail = v; changed(); }, { id: 'detail' }),
      ),
      checkField('Simulera stegförluster', state.lostSteps, (v) => { state.lostSteps = v; changed(); }, { id: 'lost-steps' }),
    ),
  );
}
