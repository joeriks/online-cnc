import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceFeed, splitPasses, raiseSafeZ, addDwell, insertBefore, setSpeeds, applyAction } from '../src/core/rewrite.js';
import { simulate } from '../src/core/simulate.js';
import { EXAMPLES } from '../src/core/examples.js';
import { MACHINES, TOOLS, MATERIALS, findById } from '../src/core/library.js';

const cfgFor = (ex, machineId = '3018') => {
  const tools = {};
  for (const [k, v] of Object.entries(ex.tools)) tools[k] = findById(TOOLS, v);
  return { machine: findById(MACHINES, machineId), tools, initialTool: 1, material: findById(MATERIALS, ex.material), stock: { ...ex.stock, px: 30, py: 30 }, zero: ex.zero, detail: 'low', lostSteps: true, workholding: { method: 'tape' } };
};

test('replaceFeed changes only the matching F words and keeps comments', () => {
  const r = replaceFeed('G1 X1 F1000 (fast)\nG1 Z-1 F250\nG1 X2 F1000.0', 1000, 780);
  assert.equal(r.code, 'G1 X1 F780 (fast)\nG1 Z-1 F250\nG1 X2 F780');
  assert.equal(r.changed, 2);
});

test('setSpeeds adds S to a bare M3 and scales the feed', () => {
  const r = setSpeeds('M3\nG1 X1 F600', 12000, 600, 720);
  assert.equal(r.code, 'M3 S12000\nG1 X1 F720');
});

test('addDwell inserts G4 after M3 only once', () => {
  const r = addDwell('M3 S10000\nG1 Z-1 F100\nM5\nM3 S9000\nG4 P2', 1);
  assert.equal(r.code, 'M3 S10000\nG4 P1\nG1 Z-1 F100\nM5\nM3 S9000\nG4 P2');
});

test('raiseSafeZ lifts retract heights but not approach heights', () => {
  const r = raiseSafeZ('G0 Z5\nG0 X10\nG0 Z1\nG1 Z-1 F100\nG0 Z5', 30, 0);
  assert.equal(r.code, 'G0 Z30\nG0 X10\nG0 Z1\nG1 Z-1 F100\nG0 Z30');
});

test('insertBefore puts the line in place', () => {
  assert.equal(insertBefore('a\nb', 2, 'G0 Z3').code, 'a\nG0 Z3\nb');
});

test('rewrites refuse inch and incremental programs', () => {
  assert.equal(replaceFeed('G20\nG1 X1 F10', 10, 5).error, 'inch');
  assert.equal(splitPasses('G91\nG1 Z-1 F10', 0.5).error, 'relative');
});

test('splitPasses keeps the result but lowers the depth per pass', () => {
  const ex = EXAMPLES.find((e) => e.id === 'pocket');
  const code = ex.code();
  const r = splitPasses(code, 1, 0);
  assert.ok(r.changed >= 3, `passes added: ${r.changed}`);
  const before = simulate(code, cfgFor(ex));
  const after = simulate(r.code, cfgFor(ex));
  assert.ok(Math.abs(after.summary.removed - before.summary.removed) / before.summary.removed < 0.01);
  assert.ok(after.summary.maxForce < before.summary.maxForce * 0.85, `${after.summary.maxForce} vs ${before.summary.maxForce}`);
  assert.equal(after.error, null);
});

test('applying the suggested actions for the aggressive aluminium job lowers the force', () => {
  const ex = EXAMPLES.find((e) => e.id === 'alu-hard');
  const before = simulate(ex.code(), cfgFor(ex, 'vfd800'));
  const w = before.warnings.find((x) => x.actions && x.actions.some((a) => a.type === 'stepdown'));
  assert.ok(w, 'a warning with a stepdown action');
  const a = w.actions.find((x) => x.type === 'stepdown');
  const r = applyAction(ex.code(), a);
  assert.ok(!r.error, r.error);
  const after = simulate(r.code, cfgFor(ex, 'vfd800'));
  assert.ok(after.summary.maxForce < before.summary.maxForce * 0.6);
  assert.equal(after.summary.broken, false);
});
