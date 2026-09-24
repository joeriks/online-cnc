import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/core/simulate.js';
import { EXAMPLES } from '../src/core/examples.js';
import { MACHINES, TOOLS, MATERIALS, findById } from '../src/core/library.js';

function cfgFor(ex, machineId = '3018', extra = {}) {
  const tools = {};
  for (const [k, v] of Object.entries(ex.tools)) tools[k] = findById(TOOLS, v);
  return { machine: JSON.parse(JSON.stringify(findById(MACHINES, machineId))), tools, initialTool: 1, material: findById(MATERIALS, ex.material), stock: { ...ex.stock, px: 20, py: 20 }, zero: ex.zero, detail: 'low', lostSteps: true, ...extra };
}
const ex = (id) => EXAMPLES.find((e) => e.id === id);

test('alla exempel går att simulera på alla maskiner', () => {
  for (const m of MACHINES) {
    for (const e of EXAMPLES) {
      const r = simulate(e.code(), cfgFor(e, m.id));
      assert.ok(r.summary.totalTime > 0, `${e.id} på ${m.id}`);
      assert.ok(r.chunks.n > 0);
    }
  }
});

test('fickan tar bort rätt volym', () => {
  const r = simulate(ex('pocket').code(), cfgFor(ex('pocket')));
  const expected = 60 * 40 * 4.5;
  assert.ok(Math.abs(r.summary.removed - expected) / expected < 0.03, `${r.summary.removed}`);
  assert.equal(r.summary.counts.crit, 0);
  assert.equal(r.error, null);
});

test('för aggressiv aluminiumfräsning bryter verktyget på en 3018', () => {
  const r = simulate(ex('alu-hard').code(), cfgFor(ex('alu-hard')));
  assert.ok(r.summary.broken);
  assert.ok(r.summary.maxLoad > 1);
});

test('försiktiga aluminiumdata klarar sig', () => {
  const r = simulate(ex('alu-gentle').code(), cfgFor(ex('alu-gentle')));
  assert.equal(r.summary.broken, false);
  assert.equal(r.summary.counts.crit, 0);
});

test('vanliga misstag hittas', () => {
  const r = simulate(ex('mistakes').code(), cfgFor(ex('mistakes')));
  assert.equal(r.error.code, 34);
  const codes = new Set(r.warnings.map((w) => w.code));
  assert.ok(codes.has('RAPID_CUT'));
  assert.ok(codes.has('SPINUP'));
});

test('verktygsbyte byter verktyg i simuleringen', () => {
  const r = simulate(ex('sign').code(), cfgFor(ex('sign')));
  assert.equal(r.tools.length, 2);
  assert.ok(r.events.some((e) => e.type === 'tool' && e.tool === 2));
});

test('mjuka gränser ger ALARM:2 innan maskinen når målet', () => {
  const e = ex('pocket');
  const code = 'G21 G90\nM3 S10000\nG4 P1\n' + Array.from({ length: 40 }, (_, i) => `G1 X${i * 10} F1000`).join('\n');
  const r = simulate(code, cfgFor(e, '3018', { machine: { ...findById(MACHINES, '3018'), softLimits: true } }));
  assert.equal(r.alarm.code, 'ALARM:2');
  const lastX = r.chunks.bx[r.chunks.n - 1];
  assert.ok(lastX <= 300);
});

test('utan gränslägen kör axeln i ändstoppet och tappar steg', () => {
  const e = ex('pocket');
  const code = 'G21 G90\nG53 G0 X350\nG53 G0 X100';
  const r = simulate(code, cfgFor(e));
  assert.ok(r.warnings.some((w) => w.code === 'TRAVEL'));
  // Maskinen tror att den står på X100 men står 50 mm fel
  assert.ok(Math.abs(r.chunks.bx[r.chunks.n - 1] - 50) < 1e-3);
});

test('handöverfräs ignorerar S', () => {
  const e = ex('pocket');
  const r = simulate(e.code(), cfgFor(e, 'belt'));
  assert.ok(r.warnings.some((w) => w.code === 'ROUTER_S'));
});
