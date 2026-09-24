// Settings panels: machine, tools, material and stock.

import { MACHINES, TOOLS, MATERIALS, SPINDLE_TYPES, TOOL_TYPES, TOOL_MATERIALS, findById, cloneTool, loc, toolName } from '../core/library.js';
import { t, nf } from '../i18n.js';
import { WORKHOLDING, defaultWorkholding } from '../core/workholding.js';
import { recommend, chipLoadRange } from '../core/physics.js';
import { makeProfile, cuttingLength, describeTool } from '../core/tool.js';
import { el, numField, textField, selectField, checkField, axisField, section } from './dom.js';

export function renderMachine(root, state, changed) {
  const m = state.machine;
  root.replaceChildren();
  const presetOpts = [['', t('m.choosePreset')], ...MACHINES.map((p) => [p.id, loc(p)])];
  root.append(
    section(t('m.section'),
      selectField(t('m.preset'), presetOpts, '', (id) => {
        if (!id) return;
        state.machine = JSON.parse(JSON.stringify(findById(MACHINES, id)));
        fitStock(state);
        changed('machine');
        renderMachine(root, state, changed);
      }, { id: 'machine-preset' }),
      el('p', { class: 'note', text: loc(m, 'note') || t('m.customNote') }),
    ),
    section(t('m.motion'),
      axisField(t('m.travel'), m.travel, (i, v) => { m.travel[i] = Math.max(1, v); changed(); }, { code: '$130–$132', idPrefix: 'm-travel' }),
      axisField(t('m.maxRate'), m.maxRate, (i, v) => { m.maxRate[i] = Math.max(1, v); changed(); }, { code: '$110–$112', idPrefix: 'm-rate' }),
      axisField(t('m.accel'), m.accel, (i, v) => { m.accel[i] = Math.max(1, v); changed(); }, { code: '$120–$122', idPrefix: 'm-accel' }),
      axisField(t('m.steps'), m.stepsPerMm, (i, v) => { m.stepsPerMm[i] = Math.max(1, v); changed(); }, { code: '$100–$102', idPrefix: 'm-steps' }),
      el('div', { class: 'fields' },
        numField(t('m.jd'), m.junctionDeviation, (v) => { m.junctionDeviation = Math.max(0.001, v); changed(); }, { unit: 'mm', code: '$11', step: 0.001, id: 'm-jd' }),
        numField(t('m.at'), m.arcTolerance, (v) => { m.arcTolerance = Math.max(0.0005, v); changed(); }, { unit: 'mm', code: '$12', step: 0.001, id: 'm-at' }),
        numField(t('m.zc'), m.zClearance, (v) => { m.zClearance = Math.max(1, v); changed(); }, { unit: 'mm', step: 1, id: 'm-zc' }),
      ),
      el('div', { class: 'fields wide' },
        checkField(t('m.soft'), m.softLimits, (v) => { m.softLimits = v; changed(); }, { code: '$20', id: 'm-soft' }),
        checkField(t('m.hard'), m.hardLimits, (v) => { m.hardLimits = v; changed(); }, { code: '$21', id: 'm-hard' }),
        checkField(t('m.m6'), m.allowToolChange, (v) => { m.allowToolChange = v; changed(); }, { id: 'm-m6' }),
      ),
    ),
    section(t('m.spindle'),
      selectField(t('m.spType'), SPINDLE_TYPES.map((k) => [k, t(`sp.${k}`)]), m.spindle.type, (v) => { m.spindle.type = v; changed(); renderMachine(root, state, changed); }, { id: 'sp-type' }),
      el('div', { class: 'fields' },
        numField(t('m.power'), m.spindle.power, (v) => { m.spindle.power = Math.max(1, v); changed(); }, { unit: 'W', step: 10, id: 'sp-power' }),
        m.spindle.type === 'router'
          ? numField(t('m.dial'), m.spindle.dialRpm, (v) => { m.spindle.dialRpm = Math.max(1000, v); changed(); }, { unit: 'rpm', step: 500, id: 'sp-dial' })
          : numField(t('m.maxRpm'), m.spindle.maxRpm, (v) => { m.spindle.maxRpm = Math.max(100, v); changed(); }, { unit: 'rpm', code: '$30', step: 500, id: 'sp-max' }),
        m.spindle.type === 'router' ? null : numField(t('m.minRpm'), m.spindle.minRpm, (v) => { m.spindle.minRpm = Math.max(0, v); changed(); }, { unit: 'rpm', code: '$31', step: 500, id: 'sp-min' }),
        numField(t('m.spinUp'), m.spindle.spinUp, (v) => { m.spindle.spinUp = Math.max(0, v); changed(); }, { unit: 's', step: 0.1, id: 'sp-spin' }),
      ),
    ),
    section(t('m.mech'),
      axisField(t('m.thrust'), m.thrust, (i, v) => { m.thrust[i] = Math.max(1, v); changed(); }, { idPrefix: 'm-thrust' }),
      el('div', { class: 'fields' },
        numField(t('m.stiff'), m.stiffness, (v) => { m.stiffness = Math.max(10, v); changed(); }, { unit: 'N/mm', step: 10, id: 'm-stiff' }),
      ),
      el('p', { class: 'hint', text: t('m.mechHint') }),
    ),
    section(t('m.ctrl'),
      el('div', { class: 'fields' },
        numField(t('m.buf'), m.bufferBlocks, (v) => { m.bufferBlocks = Math.max(1, Math.round(v)); changed(); }, { unit: 'block', step: 1, id: 'm-buf' }),
        numField(t('m.baud'), m.baud, (v) => { m.baud = Math.max(1200, v); changed(); }, { unit: 'baud', step: 100, id: 'm-baud' }),
        numField(t('m.parse'), m.parseMs, (v) => { m.parseMs = Math.max(0, v); changed(); }, { unit: 'ms', step: 0.1, id: 'm-parse' }),
      ),
      el('p', { class: 'hint', text: t('m.ctrlHint') }),
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
    const tl = state.tools[n];
    const cv = el('canvas', { width: 34, height: 44, 'aria-hidden': 'true' });
    const row = el('button', { type: 'button', class: 'tool-row', 'aria-pressed': String(n === ui.selectedTool), onclick: () => { ui.selectedTool = n; rerender(); } },
      el('span', { class: 'tnum', text: `T${n}` }),
      el('span', { class: 'tname' }, toolName(tl), el('small', { text: `${describeTool(tl)} · ${TOOL_MATERIALS[tl.material] ? t(`tm.${tl.material}`) : ''}` })),
      cv,
    );
    table.append(row);
    requestAnimationFrame(() => drawToolIcon(cv, tl));
  }
  const addBtn = el('button', { type: 'button', class: 'btn btn-sm', text: t('t.add'), onclick: () => {
    let n = 1;
    while (state.tools[n]) n++;
    state.tools[n] = cloneTool(TOOLS.find((x) => x.id === 'v60') || TOOLS[0]);
    ui.selectedTool = n;
    changed();
    rerender();
  } });
  const delBtn = nums.length > 1 ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: t('t.remove', { n: ui.selectedTool }), onclick: () => {
    delete state.tools[ui.selectedTool];
    if (state.initialTool === ui.selectedTool) state.initialTool = Number(Object.keys(state.tools)[0]);
    changed();
    rerender();
  } }) : null;

  root.append(
    section(t('t.table'),
      table,
      el('div', { class: 'row-actions' }, addBtn, delBtn),
      selectField(t('t.initial'), nums.map((n) => [n, `T${n} – ${toolName(state.tools[n])}`]), state.initialTool, (v) => { state.initialTool = Number(v); changed(); }, { id: 'initial-tool' }),
      el('p', { class: 'hint', text: t('t.hint') }),
    ),
  );

  if (!tool) return;
  const set = (k, parse = (v) => v) => (v) => { tool[k] = parse(v); changed(); rerender(); };
  const libOpts = [['', t('t.fromLibrary')], ...TOOLS.map((x) => [x.id, loc(x)])];
  const fields = el('div', { class: 'fields' },
    selectField(t('t.type'), TOOL_TYPES.map((k) => [k, t(`tt.${k}`)]), tool.type, set('type'), { id: 'tool-type' }),
    numField(t('t.d'), tool.d, set('d', (v) => Math.max(0.1, v)), { unit: 'mm', step: 0.001, id: 'tool-d' }),
    numField(t('t.flutes'), tool.flutes, set('flutes', (v) => Math.max(1, Math.round(v))), { step: 1, id: 'tool-z' }),
    numField(t('t.fluteLen'), tool.fluteLen, set('fluteLen', (v) => Math.max(0.1, v)), { unit: 'mm', step: 0.5, id: 'tool-lc' }),
    numField(t('t.stickout'), tool.stickout, set('stickout', (v) => Math.max(1, v)), { unit: 'mm', step: 0.5, id: 'tool-ls' }),
    numField(t('t.shank'), tool.shankD, set('shankD', (v) => Math.max(0.5, v)), { unit: 'mm', step: 0.001, id: 'tool-shank' }),
    selectField(t('t.material'), Object.keys(TOOL_MATERIALS).map((k) => [k, t(`tm.${k}`)]), tool.material, set('material'), { id: 'tool-mat' }),
    tool.type === 'vbit' ? numField(t('t.angle'), tool.angle, set('angle', (v) => Math.min(170, Math.max(5, v))), { unit: '°', step: 1, id: 'tool-angle' }) : null,
    tool.type === 'vbit' ? numField(t('t.tipD'), tool.tipD || 0, set('tipD', (v) => Math.max(0, v)), { unit: 'mm', step: 0.05, id: 'tool-tip' }) : null,
    tool.type === 'bull' ? numField(t('t.cornerR'), tool.cornerR || 0.5, set('cornerR', (v) => Math.max(0.05, v)), { unit: 'mm', step: 0.1, id: 'tool-cr' }) : null,
  );
  root.append(
    section(`T${ui.selectedTool}`,
      selectField(t('t.library'), libOpts, '', (id) => {
        if (!id) return;
        state.tools[ui.selectedTool] = cloneTool(findById(TOOLS, id));
        changed();
        rerender();
      }, { id: 'tool-lib' }),
      textField(t('t.name'), toolName(tool), (v) => { tool.name = v; tool.customName = true; changed(); rerender(); }, { id: 'tool-name' }),
      fields,
      checkField(t('t.center'), tool.centerCutting, (v) => { tool.centerCutting = v; changed(); }, { id: 'tool-cc' }),
    ),
  );

  const r = recommend(tool, material, state.machine);
  root.append(
    section(t('t.reco', { material: loc(material).toLowerCase() }),
      el('div', { class: 'reco' },
        el('div', {}, el('span', { text: t('t.rpm') }), el('b', { text: `S${nf(r.rpm)}` })),
        el('div', {}, el('span', { text: t('t.feed') }), el('b', { text: `F${nf(r.feed)}` })),
        el('div', {}, el('span', { text: t('t.plunge') }), el('b', { text: `F${nf(r.plunge)}` })),
        el('div', {}, el('span', { text: t('t.ap') }), el('b', { text: `${nf(r.ap, 2)} mm` })),
        el('div', {}, el('span', { text: t('t.fz') }), el('b', { text: `${nf(r.fzRange[0], 3)}–${nf(r.fzRange[1], 3)}` })),
        el('div', {}, el('span', { text: t('t.vc') }), el('b', { text: `${nf(r.vc)} m/min` })),
      ),
      el('p', { class: 'hint', text: t('t.recoHint', { machine: loc(state.machine) || '–', load: nf(r.load * 100) }) }),
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
    section(t('s.material'),
      selectField(t('s.material'), MATERIALS.map((x) => [x.id, loc(x)]), mat.id, (v) => { state.materialId = v; changed(); rerender(); }, { id: 'material' }),
      el('p', { class: 'note' }, el('span', { class: 'swatch', style: `background:${mat.color}` }), loc(mat, 'note')),
      el('dl', { class: 'props' },
        el('dt', { text: t('s.kc') }), el('dd', { text: `${nf(mat.kc11)} N/mm²` }),
        el('dt', { text: t('s.mc') }), el('dd', { text: nf(mat.mc, 2) }),
        el('dt', { text: t('s.fz', { d: nf(tool ? tool.d : 6, 2) }) }), el('dd', { text: t('s.fzVal', { a: nf(fzMin, 3), b: nf(fzMax, 3) }) }),
        el('dt', { text: t('s.vcMax') }), el('dd', { text: `${nf(mat.vcMax.carbide)} / ${nf(mat.vcMax.hss)} m/min` }),
      ),
    ),
    section(t('s.stock'),
      el('div', { class: 'fields' },
        numField(t('s.sx'), s.sx, (v) => { s.sx = Math.max(1, v); fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-sx' }),
        numField(t('s.sy'), s.sy, (v) => { s.sy = Math.max(1, v); fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-sy' }),
        numField(t('s.sz'), s.sz, (v) => { s.sz = Math.max(0.5, v); changed(); }, { unit: 'mm', step: 0.5, id: 'stock-sz' }),
        numField(t('s.px'), s.px, (v) => { s.px = v; fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-px' }),
        numField(t('s.py'), s.py, (v) => { s.py = v; fitStock(state); changed(); }, { unit: 'mm', step: 1, id: 'stock-py' }),
        numField(t('s.spoil'), state.spoilboard, (v) => { state.spoilboard = Math.max(0, v); changed(); }, { unit: 'mm', step: 1, id: 'spoil' }),
      ),
      el('p', { class: 'hint', text: t('s.posHint') }),
    ),
    section(t('s.zero'),
      el('div', { class: 'fields' },
        selectField(t('s.zeroXY'), [['corner', t('s.corner')], ['center', t('s.center')]], state.zero.xy, (v) => { state.zero.xy = v; changed(); }, { id: 'zero-xy' }),
        selectField(t('s.zeroZ'), [['top', t('s.top')], ['bottom', t('s.bottom')]], state.zero.z, (v) => { state.zero.z = v; changed(); }, { id: 'zero-z' }),
      ),
    ),
    renderWorkholding(state, changed, rerender),
    section(t('s.sim'),
      el('div', { class: 'fields' },
        selectField(t('s.detail'), [['low', t('s.low')], ['normal', t('s.normal')], ['high', t('s.high')]], state.detail, (v) => { state.detail = v; changed(); }, { id: 'detail' }),
      ),
      checkField(t('s.lost'), state.lostSteps, (v) => { state.lostSteps = v; changed(); }, { id: 'lost-steps' }),
    ),
  );
}

function renderWorkholding(state, changed, rerender) {
  if (!state.workholding) state.workholding = defaultWorkholding();
  const wh = state.workholding;
  const opts = [['auto', t('wh.auto')], ...WORKHOLDING.map((id) => [id, t(`wh.name.${id}`)])];
  const fields = el('div', { class: 'fields' });
  if (wh.method === 'clamps' || wh.method === 'auto') {
    fields.append(selectField(t('wh.clampsN'), [[2, '2'], [4, '4']], wh.clamps, (v) => { wh.clamps = Number(v); changed(); }, { id: 'wh-clamps' }));
  }
  if (wh.method === 'vise' || wh.method === 'auto') {
    fields.append(
      numField(t('wh.viseOpening'), wh.viseOpening, (v) => { wh.viseOpening = Math.max(10, v); changed(); }, { unit: 'mm', step: 5, id: 'wh-vise' }),
      numField(t('wh.jawHeight'), wh.jawHeight, (v) => { wh.jawHeight = Math.max(3, v); changed(); }, { unit: 'mm', step: 1, id: 'wh-jaw' }),
    );
  }
  return section(t('wh.section'),
    selectField(t('wh.method'), opts, wh.method, (v) => { wh.method = v; changed(); rerender(); }, { id: 'wh-method' }),
    wh.method !== 'auto' ? el('p', { class: 'note', text: t(`wh.desc.${wh.method}`) }) : null,
    fields,
    el('p', { class: 'hint', text: t('wh.hint') }),
  );
}
