import './style.css';
import SimWorker from './sim.worker.js?worker&inline';
import { MACHINES, TOOLS, MATERIALS, findById, cloneTool } from './core/library.js';
import { EXAMPLES, exampleName } from './core/examples.js';
import { t, setLang, getLang, nf } from './i18n.js';
import { describeTool } from './core/tool.js';
import { Viewer } from './view/scene.js';
import { fmtTime } from './view/chart.js';
import { Playback } from './playback.js';
import { Editor } from './ui/editor.js';
import { AnalysisPanel } from './ui/analysis.js';
import { renderMachine, renderTools, renderStock, fitStock } from './ui/settings.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'spansim-state-v1';
const LANG_KEY = 'spansim-lang';

// English is the default language; the choice is remembered in this browser.
try { setLang(localStorage.getItem(LANG_KEY) || 'en'); } catch { setLang('en'); }

// ---------- Tillstånd ----------

function exampleState(ex, machine) {
  const tools = {};
  for (const [n, id] of Object.entries(ex.tools)) tools[n] = cloneTool(findById(TOOLS, id));
  const state = {
    code: ex.code(),
    machine: JSON.parse(JSON.stringify(machine)),
    tools,
    initialTool: Number(Object.keys(ex.tools)[0]),
    materialId: ex.material,
    stock: { ...ex.stock, px: 30, py: 30 },
    zero: { ...ex.zero },
    detail: 'normal',
    lostSteps: true,
    spoilboard: 12,
  };
  fitStock(state);
  return state;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.code !== undefined && s.machine && s.tools) return s;
    }
  } catch { /* lagring kan vara blockerad */ }
  return exampleState(EXAMPLES[0], MACHINES[0]);
}

let state = loadState();
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignorera */ }
  }, 400);
}

function buildCfg() {
  return {
    machine: state.machine,
    tools: state.tools,
    initialTool: state.initialTool,
    material: findById(MATERIALS, state.materialId),
    stock: state.stock,
    zero: state.zero,
    detail: state.detail,
    lostSteps: state.lostSteps,
    spoilboard: state.spoilboard,
  };
}

// ---------- Vyer ----------

const viewer = new Viewer($('viewport'));
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  viewer.setPalette({ accent: v('--accent'), feed: v('--chart-load'), rapid: v('--warn'), spoilboard: '#b39a73', grid: '#6f5f47', frame: '#a3abb0', carriage: '#3b4348' });
}
readPalette();

const editor = new Editor({
  textarea: $('code'), gutter: $('gutter'), gutterInner: $('gutter-inner'), highlight: $('line-hl'),
  onChange: (v) => { state.code = v; persist(); scheduleRun(900); updateEditorMeta(); },
});
editor.value = state.code;

const ui = { selectedTool: state.initialTool };
const analysis = new AnalysisPanel($('tab-analysis'), {
  onSeek: (t) => { syncEvents(t); seek(t); },
  onWarning: (w) => {
    syncEvents(w.t);
    seek(Math.max(0, w.t));
    editor.selectLine(w.line);
  },
});

function settingsChanged(kind) {
  persist();
  scheduleRun(450);
  if (kind === 'machine') resetCamera = true;
}
function renderSettings() {
  renderMachine($('tab-machine'), state, settingsChanged);
  renderTools($('tab-tools'), state, ui, () => { settingsChanged(); renderStock($('tab-stock'), state, settingsChanged); });
  renderStock($('tab-stock'), state, () => { settingsChanged(); renderTools($('tab-tools'), state, ui, settingsChanged); });
}
renderSettings();

// Flikar
for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${tab.dataset.tab}`;
    if (tab.dataset.tab === 'analysis') analysis.chart.draw();
  });
}

// Exempel
const exSel = $('example-select');
function fillExamples() {
  exSel.replaceChildren(new Option(t('app.examples'), ''));
  for (const ex of EXAMPLES) exSel.append(new Option(exampleName(ex), ex.id));
}
fillExamples();
exSel.addEventListener('change', () => {
  const ex = EXAMPLES.find((e) => e.id === exSel.value);
  exSel.value = '';
  if (!ex) return;
  state = exampleState(ex, state.machine);
  ui.selectedTool = state.initialTool;
  editor.value = state.code;
  updateEditorMeta();
  renderSettings();
  persist();
  resetCamera = true;
  startAtBeginning = true;
  run();
});

// Filer
function loadText(name, text) {
  state.code = text.replace(/\r\n?/g, '\n');
  editor.value = state.code;
  fileName = name;
  updateEditorMeta();
  persist();
  startAtBeginning = true;
  run();
}
let fileName = '';
$('file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) loadText(f.name, await f.text());
  e.target.value = '';
});
const edBox = $('editor');
edBox.addEventListener('dragover', (e) => { e.preventDefault(); edBox.classList.add('drag'); });
edBox.addEventListener('dragleave', () => edBox.classList.remove('drag'));
edBox.addEventListener('drop', async (e) => {
  e.preventDefault();
  edBox.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) loadText(f.name, await f.text());
});

function updateEditorMeta() {
  $('editor-meta').textContent = `${fileName ? `${fileName} · ` : ''}${t('editor.lines', { n: nf(editor.lineCount) })}`;
}
updateEditorMeta();

// ---------- Simulering ----------

let worker = null;
let jobId = 0;
let runTimer = 0;
let result = null;
let playback = null;
let resetCamera = true;
let startAtBeginning = false;

function scheduleRun(ms) {
  clearTimeout(runTimer);
  runTimer = setTimeout(run, ms);
}

let statusKey = 'status.idle';
function setStatus(stateName, key) {
  statusKey = key;
  const text = t(key);
  const chip = $('status-chip');
  chip.dataset.state = stateName;
  chip.textContent = text;
}

function run() {
  clearTimeout(runTimer);
  if (worker) worker.terminate();
  worker = new SimWorker();
  const id = ++jobId;
  $('busy').hidden = false;
  $('busy-fill').style.width = '0%';
  setStatus('busy', 'status.busy');
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.id !== id) return;
    if (d.progress !== undefined) { $('busy-fill').style.width = `${Math.round(d.progress * 100)}%`; return; }
    $('busy').hidden = true;
    if (d.error) {
      setStatus('crit', 'status.error');
      $('editor-foot').innerHTML = '';
      $('editor-foot').append(Object.assign(document.createElement('span'), { className: 'err', textContent: t('editor.crashed', { msg: d.error.split('\n')[0] }) }));
      return;
    }
    applyResult(d.result);
  };
  worker.onerror = (err) => {
    $('busy').hidden = true;
    setStatus('crit', 'status.error');
    console.error(err);
  };
  worker.postMessage({ id, code: state.code, cfg: buildCfg(), lang: getLang() });
}

function applyResult(r) {
  const prevT = playT;
  const hadResult = !!result;
  result = r;
  playback = new Playback(r);
  const material = findById(MATERIALS, state.materialId);
  viewer.buildMachine(state.machine, r.geometry);
  viewer.buildStock(playback.hm, material);
  viewer.buildPaths(r.chunks);
  lastToolKey = '';
  if (resetCamera || !hadResult) {
    const b = r.geometry.box;
    viewer.view('iso', { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1 });
    resetCamera = false;
  }
  analysis.setResult(r);
  editor.setSeverity(r.lineSeverity);
  const s = r.summary;
  const kind = r.error || r.alarm || s.broken || s.lostSteps || s.counts.crit ? 'crit' : s.counts.warn ? 'warn' : 'ok';
  setStatus(kind, `status.${kind}`);
  const foot = $('editor-foot');
  foot.replaceChildren();
  if (r.error) {
    foot.append(Object.assign(document.createElement('span'), { className: 'err', textContent: t('editor.error', { code: r.error.code, line: r.error.line, msg: r.error.message }) }));
  } else {
    foot.textContent = t('editor.foot', { blocks: nf(s.blocks), time: fmtTime(s.totalTime), crit: s.counts.crit, warn: s.counts.warn });
  }
  if (startAtBeginning) {
    startAtBeginning = false;
    setPlaying(false);
    seek(s.totalTime);
  } else {
    seek(hadResult ? Math.min(prevT, s.totalTime) : s.totalTime);
  }
  syncEvents(playT);
  // Tabbens räknare
  const tab = document.querySelector('.tab[data-tab="analysis"]');
  tab.replaceChildren(t('tab.analysis'));
  const n = s.counts.crit + s.counts.warn;
  if (n) {
    const b = document.createElement('span');
    b.className = `badge ${s.counts.crit ? 'crit' : 'warn'}`;
    b.textContent = n;
    tab.append(b);
  }
}

// ---------- Uppspelning ----------

let playT = 0;
let playing = false;
let lastFrame = 0;
let evIdx = 0; // nästa händelse som inte har visats
let lastToolKey = '';
let bannerTimer = 0;
let chartTick = 0;

const playBtn = $('play-btn');
function setPlaying(p) {
  playing = p;
  playBtn.classList.toggle('playing', p);
  playBtn.setAttribute('aria-label', p ? t('tr.pause') : t('tr.start'));
  lastFrame = performance.now();
}
// Result mode: only the finished part, without machine, spindle or toolpaths.
let resultMode = false;
function setResultMode(on) {
  resultMode = on;
  $('result-btn').setAttribute('aria-pressed', String(on));
  viewer.setResultMode(on);
  $('dro').hidden = on;
  if (on) {
    setPlaying(false);
    $('banner').hidden = true;
    if (result) {
      seek(result.summary.totalTime);
      const b = result.geometry.box;
      viewer.view('iso', { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1 });
    }
  }
}
$('result-btn').addEventListener('click', () => setResultMode(!resultMode));

playBtn.addEventListener('click', () => {
  if (!result) { run(); return; }
  if (resultMode) setResultMode(false);
  if (!playing && playT >= result.summary.totalTime - 1e-6) rewind();
  setPlaying(!playing);
});
$('rewind-btn').addEventListener('click', () => rewind());
$('end-btn').addEventListener('click', () => { if (result) { setPlaying(false); seek(result.summary.totalTime); } });
$('run-btn').addEventListener('click', () => { startAtBeginning = true; run(); });
$('timeline').addEventListener('input', (e) => {
  if (!result) return;
  const t = (e.target.value / 1000) * result.summary.totalTime;
  syncEvents(t);
  seek(t);
});

function rewind() {
  evIdx = 0;
  $('banner').hidden = true;
  seek(0);
}

// Efter ett hopp i tiden: händelser före t räknas som redan visade.
function syncEvents(t) {
  if (!result) return;
  evIdx = 0;
  while (evIdx < result.events.length && result.events[evIdx].t < t) evIdx++;
}

function showBanner(text, kind = 'info', ms = 4500) {
  const b = $('banner');
  b.dataset.kind = kind;
  b.replaceChildren(text);
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => { b.hidden = true; }, ms);
}

function seek(t) {
  if (!playback) return;
  playT = Math.max(0, Math.min(t, result.summary.totalTime));
  playback.seek(playT);
  render();
}

function render() {
  const st = playback.state(playT);
  viewer.updateStock();
  const total = result.summary.totalTime;
  // Verktyg
  const toolEntry = result.tools[st.toolIdx];
  const toolDef = toolEntry ? toolEntry.def : state.tools[state.initialTool];
  const key = `${st.toolIdx}:${st.broken}`;
  if (key !== lastToolKey) {
    viewer.buildTool(toolDef, state.machine.spindle.type, st.broken);
    lastToolKey = key;
  }
  viewer.setHead(st.pos, st.spindleOn && st.rpm > 0);
  viewer.setProgress(st.chunk >= 0 ? (st.moving ? st.chunk : st.chunk + 1) : 0);

  // DRO
  const f3 = (v) => v.toFixed(3);
  $('dro-mx').textContent = f3(st.pos[0]);
  $('dro-my').textContent = f3(st.pos[1]);
  $('dro-mz').textContent = f3(st.pos[2]);
  $('dro-wx').textContent = f3(st.pos[0] - st.wo[0]);
  $('dro-wy').textContent = f3(st.pos[1] - st.wo[1]);
  $('dro-wz').textContent = f3(st.pos[2] - st.wo[2]);
  $('dro-f').textContent = Math.round(st.feed).toLocaleString('sv-SE');
  $('dro-s').textContent = Math.round(st.rpm).toLocaleString('sv-SE');
  $('dro-t').textContent = toolEntry ? `T${toolEntry.number} ${describeTool(toolEntry.def)}${st.broken ? t('dro.broken') : ''}` : '–';
  $('dro-line').textContent = st.line ? t('dro.line', { n: st.line }) : t('dro.noline');
  const atEnd = playT >= total - 1e-6;
  const alarmNow = st.alarm && playT >= st.alarm.t;
  const s = alarmNow ? 'Alarm' : playing && !atEnd ? 'Run' : !atEnd && playT > 0 ? 'Hold' : 'Idle';
  const pill = $('dro-state');
  pill.dataset.s = s;
  pill.textContent = s;
  const load = st.cutting ? st.load : 0;
  const fill = $('load-fill');
  fill.style.width = `${Math.min(100, load * 100)}%`;
  fill.classList.toggle('hot', load > 1);
  $('load-text').textContent = st.cutting ? t('dro.load', { p: Math.round(load * 100), f: nf(st.force, 1) }) : st.rapid && st.moving ? t('dro.rapid') : t('dro.notcutting');

  editor.setCurrentLine(st.line, playing);
  $('timeline').value = total > 0 ? Math.round((playT / total) * 1000) : 0;
  $('time-label').textContent = `${fmtTime(playT)} / ${fmtTime(total)}`;
  const now = performance.now();
  if (!playing || now - chartTick > 80) { analysis.setTime(playT); chartTick = now; }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!playing || !result) { lastFrame = now; return; }
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const speed = parseFloat($('speed').value) || 1;
  const total = result.summary.totalTime;
  let next = Math.min(total, playT + dt * speed);
  // Händelser mellan playT och next
  const evs = result.events;
  while (evIdx < evs.length && evs[evIdx].t <= next) {
    const e = evs[evIdx++];
    if ((e.type === 'pause' || e.type === 'tool') && $('stop-at-pause').checked) {
      next = e.t;
      setPlaying(false);
      showBanner(e.text, 'warn', 0);
      break;
    }
    if (e.type === 'break' || e.type === 'lost') showBanner(e.text, 'crit', 6000);
    else if (e.type === 'alarm' || e.type === 'error') { showBanner(e.text, 'crit', 0); next = e.t; setPlaying(false); break; }
    else if (e.type === 'dwell') showBanner(e.text, 'info', 1500);
  }
  if (next >= total) { next = total; setPlaying(false); }
  if (playing && !$('banner').hidden && $('banner').dataset.kind === 'warn') $('banner').hidden = true;
  seek(next);
}
requestAnimationFrame(frame);

// Vyknappar och växlar
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => viewer.view(b.dataset.view));
$('show-paths').addEventListener('change', (e) => viewer.setPathsVisible(e.target.checked));
$('show-rapids').addEventListener('change', (e) => viewer.setRapidsVisible(e.target.checked));
$('show-machine').addEventListener('change', (e) => viewer.setMachineVisible(e.target.checked));

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
  else if (e.key === 'Home') rewind();
  else if (e.key === 'End' && result) seek(result.summary.totalTime);
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  readPalette();
  analysis.chart.draw();
});

// ---------- Language ----------

function applyStatic() {
  document.documentElement.lang = getLang();
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria));
  $('status-chip').textContent = t(statusKey);
  $('lang-select').value = getLang();
}

$('lang-select').addEventListener('change', (e) => {
  setLang(e.target.value);
  try { localStorage.setItem(LANG_KEY, getLang()); } catch { /* ignore */ }
  applyStatic();
  fillExamples();
  renderSettings();
  analysis.build();
  analysis.chart.draw();
  updateEditorMeta();
  playBtn.setAttribute('aria-label', playing ? t('tr.pause') : t('tr.start'));
  run(); // warnings and events are generated in the selected language
});

applyStatic();
run();

// Används av automatiska tester
window.__spansim = { get result() { return result; }, get time() { return playT; }, get playing() { return playing; }, get eventIndex() { return evIdx; } };
