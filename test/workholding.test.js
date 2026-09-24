import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/core/simulate.js';
import { EXAMPLES } from '../src/core/examples.js';
import { MACHINES, TOOLS, MATERIALS, findById } from '../src/core/library.js';
import { findPieces } from '../src/core/workholding.js';
import { HeightMap, prepareTool, newStampResult } from '../src/core/heightmap.js';

function run(id, workholding, machineId = '3018') {
  const ex = EXAMPLES.find((e) => e.id === id);
  const tools = {};
  for (const [k, v] of Object.entries(ex.tools)) tools[k] = findById(TOOLS, v);
  return simulate(ex.code(), { machine: findById(MACHINES, machineId), tools, initialTool: 1, material: findById(MATERIALS, ex.material), stock: { ...ex.stock, px: 30, py: 30 }, zero: ex.zero, detail: 'low', lostSteps: true, workholding });
}

test('a ring cut through the stock leaves a loose piece', () => {
  const hm = new HeightMap({ x0: 0, y0: 0, sx: 60, sy: 60, zBottom: -5, zTop: 0, res: 0.5 });
  const tool = prepareTool({ type: 'flat', d: 3, fluteLen: 10 });
  const out = newStampResult();
  for (let a = 0; a <= 360; a += 2) {
    const r = (a * Math.PI) / 180, r2 = ((a + 2) * Math.PI) / 180;
    hm.stampSegment(tool, 30 + 15 * Math.cos(r), 30 + 15 * Math.sin(r), -6, 30 + 15 * Math.cos(r2), 30 + 15 * Math.sin(r2), -6, out);
  }
  const { pieces } = findPieces(hm);
  const loose = pieces.filter((p) => !p.edge);
  assert.equal(loose.length, 1);
  assert.ok(Math.abs(loose[0].area - Math.PI * 13.5 ** 2) / (Math.PI * 13.5 ** 2) < 0.1);
});

test('cut-out disc: clamps are poor, tape or glue is chosen automatically', () => {
  const r = run('helix', { method: 'auto' });
  assert.ok(['glue', 'tape'].includes(r.workholding.selected));
  const clamps = r.workholding.options.find((o) => o.id === 'clamps');
  assert.equal(clamps.rating, 'bad');
  assert.ok(clamps.issues.some((i) => i.key === 'loose'));
});

test('clamps in the path break the tool when chosen', () => {
  const r = run('sign', { method: 'clamps' });
  assert.ok(r.warnings.some((w) => w.code === 'FIXTURE_HIT'));
  assert.ok(r.summary.broken);
});

test('screws cannot be used in aluminium', () => {
  const r = run('alu-gentle', { method: 'auto' });
  assert.equal(r.workholding.options.find((o) => o.id === 'screws').rating, 'na');
});

test('clamps clear of the pocket are rated good', () => {
  const r = run('pocket', { method: 'clamps' });
  const clamps = r.workholding.options.find((o) => o.id === 'clamps');
  assert.equal(clamps.rating, 'good');
  assert.equal(r.summary.broken, false);
});
