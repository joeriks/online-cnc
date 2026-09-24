import { t } from '../i18n.js';

// Tidsdiagram: spindellast (%) och verklig matning (mm/min).

export class LoadChart {
  constructor(canvas, onSeek) {
    this.canvas = canvas;
    this.onSeek = onSeek;
    this.data = null;
    this.t = 0;
    const seek = (e) => {
      if (!this.data) return;
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left - this.padL) / (r.width - this.padL - this.padR);
      onSeek(Math.max(0, Math.min(1, x)) * this.data.total);
    };
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); seek(e); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) seek(e); });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    new ResizeObserver(() => this.draw()).observe(canvas);
    this.padL = 38;
    this.padR = 10;
  }

  setData(result) {
    const c = result.chunks;
    this.data = { c, total: Math.max(1e-6, result.summary.totalTime), events: result.events, maxRate: null };
    this.draw();
  }

  setTime(t) {
    this.t = t;
    this.draw();
  }

  colors() {
    const cs = getComputedStyle(this.canvas);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    return {
      ink: v('--ink-2', '#4a5358'), muted: v('--muted', '#7a8488'), line: v('--line', '#d3d8d8'),
      load: v('--chart-load', '#0f6e7a'), feed: v('--chart-feed', '#8a6fb8'), crit: v('--crit', '#c43d2b'), warn: v('--warn', '#c07a06'), cursor: v('--ink', '#1b2023'),
    };
  }

  draw() {
    const cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const col = this.colors();
    g.font = '11px "IBM Plex Mono", ui-monospace, monospace';
    const { padL, padR } = this;
    const plotW = W - padL - padR;
    const gap = 16;
    const h1 = Math.round((H - 18 - gap) * 0.62);
    const h2 = H - 18 - gap - h1;
    const y1 = 4, y2 = y1 + h1 + gap;
    if (!this.data || !this.data.c.n) {
      g.fillStyle = col.muted;
      g.fillText(t('chart.empty'), padL, H / 2);
      return;
    }
    const { c, total } = this.data;
    // Samla max last och medelmatning per pixelkolumn
    const cols = Math.max(1, Math.floor(plotW));
    if (!this.agg || this.agg.cols !== cols || this.agg.c !== c) this.agg = aggregate(c, total, cols);
    const { load, feedSum, feedW, maxFeed } = this.agg;
    let maxLoad = 1;
    for (let x = 0; x < cols; x++) maxLoad = Math.max(maxLoad, load[x]);
    maxLoad = Math.min(3, Math.max(1.2, maxLoad * 1.05));

    // Last
    const ly = (v) => y1 + h1 - (Math.min(v, maxLoad) / maxLoad) * h1;
    g.strokeStyle = col.line;
    g.lineWidth = 1;
    g.fillStyle = col.muted;
    for (const v of [0, 0.5, 1]) {
      const y = Math.round(ly(v)) + 0.5;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(W - padR, y); g.stroke();
      g.fillText(`${Math.round(v * 100)}%`, 2, y + 4);
    }
    g.fillStyle = hexA(col.load, 0.22);
    g.beginPath();
    g.moveTo(padL, ly(0));
    for (let x = 0; x < cols; x++) g.lineTo(padL + x + 0.5, ly(load[x]));
    g.lineTo(padL + cols, ly(0));
    g.closePath();
    g.fill();
    g.strokeStyle = col.load;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x < cols; x++) {
      const y = ly(load[x]);
      if (x === 0) g.moveTo(padL + x + 0.5, y); else g.lineTo(padL + x + 0.5, y);
    }
    g.stroke();
    // Överlast markeras
    g.fillStyle = col.crit;
    for (let x = 0; x < cols; x++) if (load[x] > 1) g.fillRect(padL + x, y1 + h1 + 1, 1, 3);
    // 100 %-linje
    g.strokeStyle = hexA(col.crit, 0.6);
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(padL, Math.round(ly(1)) + 0.5); g.lineTo(W - padR, Math.round(ly(1)) + 0.5); g.stroke();
    g.setLineDash([]);
    g.fillStyle = col.ink;
    g.fillText(t('chart.load'), padL + 4, y1 + 11);

    // Matning
    const fy = (v) => y2 + h2 - (v / maxFeed) * h2;
    g.strokeStyle = col.line;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, Math.round(fy(0)) + 0.5); g.lineTo(W - padR, Math.round(fy(0)) + 0.5); g.stroke();
    g.strokeStyle = col.feed;
    g.lineWidth = 1.25;
    g.beginPath();
    let started = false;
    for (let x = 0; x < cols; x++) {
      const v = feedW[x] > 0 ? feedSum[x] / feedW[x] : 0;
      const y = fy(v);
      if (!started) { g.moveTo(padL + x + 0.5, y); started = true; } else g.lineTo(padL + x + 0.5, y);
    }
    g.stroke();
    g.fillStyle = col.muted;
    g.fillText(shortNum(maxFeed), 2, y2 + 9);
    g.fillText('0', 2, y2 + h2);
    g.fillStyle = col.ink;
    g.fillText(t('chart.feed'), padL + 4, y2 + 11);

    // Händelser
    for (const e of this.data.events) {
      if (!['tool', 'break', 'lost', 'alarm', 'error', 'pause'].includes(e.type)) continue;
      const x = padL + (e.t / total) * plotW;
      g.fillStyle = e.type === 'tool' || e.type === 'pause' ? col.ink : col.crit;
      g.beginPath();
      g.moveTo(x, y1); g.lineTo(x - 4, y1 - 0); g.lineTo(x, y1 + 6); g.lineTo(x + 4, y1); g.closePath();
      g.fill();
      g.fillRect(x - 0.5, y1, 1, h1);
    }

    // Tidsaxel
    g.fillStyle = col.muted;
    const ticks = 5;
    for (let k = 0; k <= ticks; k++) {
      const t = (total * k) / ticks;
      const x = padL + (plotW * k) / ticks;
      const label = fmtTime(t);
      const w = g.measureText(label).width;
      g.fillText(label, Math.min(W - w - 2, Math.max(padL, x - w / 2)), H - 3);
    }
    // Markör
    const cx = padL + (Math.min(this.t, total) / total) * plotW;
    g.strokeStyle = col.cursor;
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, H - 16); g.stroke();
  }
}

function aggregate(c, total, cols) {
  const load = new Float32Array(cols);
  const feedSum = new Float32Array(cols);
  const feedW = new Float32Array(cols);
  let maxFeed = 1;
  for (let i = 0; i < c.n; i++) {
    const a = Math.floor((c.t0[i] / total) * cols);
    const b = Math.min(cols - 1, Math.floor((c.t1[i] / total) * cols));
    const dt = c.t1[i] - c.t0[i];
    for (let x = Math.max(0, a); x <= b; x++) {
      if (c.load[i] > load[x]) load[x] = c.load[i];
      feedSum[x] += c.feed[i] * dt;
      feedW[x] += dt;
    }
    if (c.feed[i] > maxFeed) maxFeed = c.feed[i];
  }
  return { cols, c, load, feedSum, feedW, maxFeed };
}

export function fmtTime(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function shortNum(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v));
}

function hexA(color, a) {
  const c = color.trim();
  if (c.startsWith('#') && c.length === 7) {
    const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}
