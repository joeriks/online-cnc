// Materialmodell: en höjdkarta (Z-karta) över ämnet. Varje cell lagrar
// materialets översta Z (maskinkoordinater). Verktyget stämplas längs
// banan och sänker cellerna till verktygets profil.

import { makeProfile, cuttingLength } from './tool.js';

const LUT_SIZE = 1024;

export function prepareTool(t) {
  const R = t.d / 2;
  const profile = makeProfile(t);
  // Profilhöjd som tabell över r²/R² (undviker sqrt i den inre loopen)
  let lut = null;
  if (profile) {
    lut = new Float32Array(LUT_SIZE + 1);
    for (let k = 0; k <= LUT_SIZE; k++) lut[k] = profile(R * Math.sqrt(k / LUT_SIZE));
  }
  return { def: t, R, profile, lut, cutLen: cuttingLength(t) };
}

export class HeightMap {
  constructor({ x0, y0, sx, sy, zBottom, zTop, res }) {
    this.x0 = x0;
    this.y0 = y0;
    this.sx = sx;
    this.sy = sy;
    this.nx = Math.max(2, Math.round(sx / res));
    this.ny = Math.max(2, Math.round(sy / res));
    this.dx = sx / this.nx;
    this.dy = sy / this.ny;
    this.cellArea = this.dx * this.dy;
    this.zBottom = zBottom;
    this.zTop = zTop;
    this.h = new Float32Array(this.nx * this.ny);
    this.reset();
  }

  reset() {
    this.h.fill(this.zTop);
    this.resetDirty();
    this.dirty = { i0: 0, i1: this.nx - 1, j0: 0, j1: this.ny - 1 };
  }

  resetDirty() {
    this.dirty = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity };
  }

  // Stämpla verktyget längs en rät linje a→b. Resultatet ackumuleras i out.
  stampSegment(tool, ax, ay, az, bx, by, bz, out) {
    if (Math.min(az, bz) >= this.zTop) return out;
    const R = tool.R;
    if (Math.max(ax, bx) + R < this.x0 || Math.min(ax, bx) - R > this.x0 + this.sx) return out;
    if (Math.max(ay, by) + R < this.y0 || Math.min(ay, by) - R > this.y0 + this.sy) return out;
    const step = Math.min(this.dx, this.dy) * 0.5;
    const dxy = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(Math.max(dxy / step, Math.abs(bz - az) / step)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      this.stampPoint(tool, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, out);
    }
    return out;
  }

  stampPoint(tool, px, py, pz, out) {
    if (pz >= this.zTop) return;
    const { R, lut, cutLen } = tool;
    const lutScale = LUT_SIZE / (R * R);
    const { x0, y0, dx, dy, nx, ny, h, zBottom } = this;
    const iMin = Math.max(0, Math.ceil((px - R - x0) / dx - 0.5));
    const iMax = Math.min(nx - 1, Math.floor((px + R - x0) / dx - 0.5));
    const jMin = Math.max(0, Math.ceil((py - R - y0) / dy - 0.5));
    const jMax = Math.min(ny - 1, Math.floor((py + R - y0) / dy - 0.5));
    if (iMin > iMax || jMin > jMax) return;
    const R2 = R * R;
    const shankZ = pz + cutLen;
    let vol = 0;
    let touched = false;
    for (let j = jMin; j <= jMax; j++) {
      const cy = y0 + (j + 0.5) * dy - py;
      const cy2 = cy * cy;
      if (cy2 > R2) continue;
      const row = j * nx;
      for (let i = iMin; i <= iMax; i++) {
        const cx = x0 + (i + 0.5) * dx - px;
        const r2 = cx * cx + cy2;
        if (r2 > R2) continue;
        const idx = row + i;
        const old = h[idx];
        let z = pz;
        if (lut) {
          const f = r2 * lutScale;
          const k = f | 0;
          z += k >= LUT_SIZE ? lut[LUT_SIZE] : lut[k] + (lut[k + 1] - lut[k]) * (f - k);
        }
        if (z >= old) continue;
        if (z < zBottom) z = zBottom;
        if (z >= old) continue;
        touched = true;
        vol += old - z;
        if (old > out.apTop) out.apTop = old;
        if (old > shankZ && old - shankZ > out.shank) out.shank = old - shankZ;
        h[idx] = z;
        if (i < this.dirty.i0) this.dirty.i0 = i;
        if (i > this.dirty.i1) this.dirty.i1 = i;
        if (j < this.dirty.j0) this.dirty.j0 = j;
        if (j > this.dirty.j1) this.dirty.j1 = j;
      }
    }
    if (touched) {
      out.vol += vol * this.cellArea;
      if (pz < out.minTip) out.minTip = pz;
    }
  }

  // Borttagen volym totalt (mm³)
  removedVolume() {
    let s = 0;
    for (let i = 0; i < this.h.length; i++) s += this.zTop - this.h[i];
    return s * this.cellArea;
  }
}

export function newStampResult() {
  return { vol: 0, apTop: -Infinity, minTip: Infinity, shank: 0 };
}

// Välj upplösning utifrån ämnets storlek och detaljnivå.
export function chooseResolution(sx, sy, detail = 'normal', minToolD = 3) {
  const cells = { low: 220, normal: 400, high: 650 }[detail] || 400;
  let res = Math.max(sx, sy) / cells;
  res = Math.min(res, Math.max(0.05, minToolD / 6));
  const nice = [0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.5, 2];
  let best = nice[nice.length - 1];
  for (const v of nice) if (v >= res) { best = v; break; }
  // Håll antalet celler rimligt
  while ((sx / best) * (sy / best) > 900000) best *= 1.25;
  return best;
}
