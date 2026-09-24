import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeightMap, prepareTool, newStampResult } from '../src/core/heightmap.js';

const hm = () => new HeightMap({ x0: 0, y0: 0, sx: 60, sy: 40, zBottom: -10, zTop: 0, res: 0.1 });

test('spår med pinnfräs: volym = (D·L + πR²)·ap', () => {
  const m = hm();
  const tool = prepareTool({ type: 'flat', d: 6, fluteLen: 20 });
  const out = newStampResult();
  m.stampSegment(tool, 10, 20, -2, 50, 20, -2, out);
  const expected = (6 * 40 + Math.PI * 9) * 2;
  assert.ok(Math.abs(out.vol - expected) / expected < 0.02, `${out.vol} vs ${expected}`);
  assert.ok(Math.abs(m.removedVolume() - out.vol) < 1e-3);
  assert.ok(Math.abs(out.apTop - 0) < 1e-9);
});

test('kulfräs ger rund botten', () => {
  const m = hm();
  const tool = prepareTool({ type: 'ball', d: 6, fluteLen: 20 });
  m.stampSegment(tool, 10, 20, -3, 50, 20, -3, newStampResult());
  const at = (x, y) => m.h[Math.floor(y / m.dy) * m.nx + Math.floor(x / m.dx)];
  assert.ok(Math.abs(at(30, 20.05) + 3) < 0.05);
  assert.ok(Math.abs(at(30, 22.05) - (-3 + 3 - Math.sqrt(9 - 2.0 ** 2))) < 0.1);
});

test('V-fräs: bredden växer med djupet', () => {
  const m = hm();
  const tool = prepareTool({ type: 'vbit', d: 6, angle: 90, tipD: 0, fluteLen: 3 });
  m.stampSegment(tool, 10, 20, -1, 50, 20, -1, newStampResult());
  const row = Math.floor(20 / m.dy);
  let width = 0;
  for (let j = 0; j < m.ny; j++) if (m.h[j * m.nx + 300] < -1e-6) width += m.dy;
  assert.ok(Math.abs(width - 2) < 0.25, `bredd ${width}`);
  assert.ok(row > 0);
});

test('skaftet registreras när skärdjupet överstiger skärlängden', () => {
  const m = hm();
  const tool = prepareTool({ type: 'flat', d: 3, fluteLen: 2 });
  const out = newStampResult();
  m.stampSegment(tool, 10, 20, -5, 20, 20, -5, out);
  assert.ok(out.shank > 2.9);
});

test('materialet går inte under underkanten', () => {
  const m = hm();
  const tool = prepareTool({ type: 'flat', d: 3, fluteLen: 30 });
  const out = newStampResult();
  m.stampSegment(tool, 10, 20, -12, 20, 20, -12, out);
  assert.ok(m.h.reduce((a, b) => Math.min(a, b), Infinity) >= -10);
});
