// Uppspelning: återskapar materialet och maskinens tillstånd vid valfri tid.

import { HeightMap, prepareTool, newStampResult } from './core/heightmap.js';

const SNAPSHOTS = 16;

export class Playback {
  constructor(result) {
    this.r = result;
    this.c = result.chunks;
    this.hm = new HeightMap(result.geometry.hm);
    this.tools = result.tools.map((t) => (t.def ? prepareTool(t.def) : null));
    this.done = 0; // chunkar < done är helt stämplade
    this.t = 0;
    this.snapStep = Math.max(200, Math.ceil(this.c.n / SNAPSHOTS));
    this.snaps = new Map();
    this.endTime = result.summary.totalTime;
    this.scratch = newStampResult();
  }

  // Index för sista chunk som börjat vid tiden t (−1 om ingen).
  chunkAt(t) {
    const t0 = this.c.t0;
    let lo = 0, hi = this.c.n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t0[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  stampChunk(i, frac = 1) {
    const c = this.c;
    if (!(c.flags[i] & 2)) return;
    const tool = this.tools[c.tool[i]];
    if (!tool) return;
    const bx = c.ax[i] + (c.bx[i] - c.ax[i]) * frac;
    const by = c.ay[i] + (c.by[i] - c.ay[i]) * frac;
    const bz = c.az[i] + (c.bz[i] - c.az[i]) * frac;
    this.hm.stampSegment(tool, c.ax[i], c.ay[i], c.az[i], bx, by, bz, this.scratch);
  }

  seek(t) {
    const c = this.c;
    if (t >= this.endTime - 1e-9 && this.done < c.n) {
      // Hoppa direkt till slutresultatet
      this.hm.h.set(this.r.finalHeights);
      this.hm.dirty = { i0: 0, i1: this.hm.nx - 1, j0: 0, j1: this.hm.ny - 1 };
      this.done = c.n;
      this.t = t;
      return;
    }
    const last = this.chunkAt(t);
    const target = last < 0 ? 0 : c.t1[last] <= t ? last + 1 : last;
    if (target < this.done || t < this.t) {
      // Bakåt: återställ från närmaste ögonblicksbild
      let best = 0;
      for (const k of this.snaps.keys()) if (k <= target && k > best) best = k;
      if (best > 0) this.hm.h.set(this.snaps.get(best));
      else this.hm.h.fill(this.hm.zTop);
      this.hm.dirty = { i0: 0, i1: this.hm.nx - 1, j0: 0, j1: this.hm.ny - 1 };
      this.done = best;
    }
    while (this.done < target) {
      this.stampChunk(this.done);
      this.done++;
      if (this.done % this.snapStep === 0 && !this.snaps.has(this.done)) this.snaps.set(this.done, this.hm.h.slice());
    }
    // Påbörjad chunk
    if (this.done < c.n && c.t0[this.done] < t) {
      const i = this.done;
      const frac = Math.min(1, (t - c.t0[i]) / Math.max(1e-9, c.t1[i] - c.t0[i]));
      this.stampChunk(i, frac);
    }
    this.t = t;
  }

  // Maskinens tillstånd vid tiden t.
  state(t) {
    const c = this.c;
    const i = this.chunkAt(t);
    const r = this.r;
    let pos, line, feed = 0, rpm = 0, load = 0, force = 0, wo, moving = false, rapid = false, toolIdx = -1, cutting = false;
    if (i < 0) {
      pos = r.start.slice();
      wo = r.geometry.zero.slice();
      line = 0;
    } else {
      const frac = Math.min(1, Math.max(0, (t - c.t0[i]) / Math.max(1e-9, c.t1[i] - c.t0[i])));
      pos = [c.ax[i] + (c.bx[i] - c.ax[i]) * frac, c.ay[i] + (c.by[i] - c.ay[i]) * frac, c.az[i] + (c.bz[i] - c.az[i]) * frac];
      wo = [c.wx[i], c.wy[i], c.wz[i]];
      moving = t < c.t1[i];
      line = c.line[i];
      rapid = !!(c.flags[i] & 1);
      cutting = moving && !!(c.flags[i] & 4);
      toolIdx = c.tool[i];
      if (moving) { feed = c.feed[i]; load = c.load[i]; force = c.force[i]; }
    }
    // Händelser (spindel, verktyg, brott) fram till t
    let spindleOn = false, broken = false, lastEvent = null, alarm = null;
    for (const e of r.events) {
      if (e.t > t) break;
      if (e.type === 'spindle') { spindleOn = e.on; rpm = e.rpm; }
      if (e.type === 'tool') { broken = false; if (e.toolIdx >= 0) toolIdx = e.toolIdx; }
      if (e.type === 'break') broken = true;
      if (e.type === 'alarm' || e.type === 'error') alarm = e;
      if (e.type !== 'spindle') lastEvent = e;
      if (e.type === 'dwell' && t <= e.t1) line = e.line;
    }
    if (i >= 0 && moving && c.rpm[i] >= 0) rpm = c.rpm[i];
    if (!spindleOn) rpm = 0;
    if (toolIdx < 0 && r.tools.length) toolIdx = 0;
    return { chunk: i, pos, wo, line, feed, rpm, load, force, moving, rapid, cutting, toolIdx, spindleOn, broken, lastEvent, alarm };
  }
}
