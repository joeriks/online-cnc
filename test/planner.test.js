import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, trapezoid, timeAtDistance, distanceAtTime } from '../src/core/planner.js';

const machine = {
  stepsPerMm: [1000, 1000, 1000], maxRate: [6000, 6000, 3000], accel: [100, 100, 100],
  junctionDeviation: 0.01, bufferBlocks: 15, baud: 1e9, parseMs: 0,
};
const mv = (to, feed, rapid = false, line = 1) => ({ type: 'move', to, feed, rapid, line });

test('ensam rörelse: trapetsprofil från och till stillastående', () => {
  const p = plan([mv([100, 0, 0], 1200)], machine, [0, 0, 0]);
  const v = 20, a = 100;
  const expected = 100 / v + v / a; // accelerations- och inbromsningssträcka
  assert.ok(Math.abs(p.totalTime - expected) < 1e-6, `${p.totalTime} != ${expected}`);
});

test('kort rörelse: triangelprofil', () => {
  const p = plan([mv([1, 0, 0], 6000)], machine, [0, 0, 0]);
  // Halva sträckan accelererar: L/2 = a·t²/2 → t = √(L/a), totalt 2·√(L/a)
  assert.ok(Math.abs(p.totalTime - 2 * Math.sqrt(1 / 100)) < 1e-6);
});

test('raka skarvar bibehåller farten', () => {
  const one = plan([mv([100, 0, 0], 1200)], machine, [0, 0, 0]).totalTime;
  const two = plan([mv([50, 0, 0], 1200), mv([100, 0, 0], 1200)], machine, [0, 0, 0]).totalTime;
  assert.ok(Math.abs(one - two) < 1e-6);
});

test('90°-hörn bromsar enligt junction deviation', () => {
  const straight = plan([mv([50, 0, 0], 3000), mv([100, 0, 0], 3000)], machine, [0, 0, 0]);
  const corner = plan([mv([50, 0, 0], 3000), mv([50, 50, 0], 3000)], machine, [0, 0, 0]);
  assert.ok(corner.totalTime > straight.totalTime);
  const b = corner.blocks[1];
  // v² = a·δ·sin(θ/2)/(1−sin(θ/2)), a begränsad av axlarna i skarvriktningen
  const sin = Math.sqrt(0.5 * (1 - 0));
  const ja = 100 * Math.SQRT2; // junction-vektorn (-1,1)/√2 ger a = 100/(1/√2)
  const vj = Math.sqrt((ja * 0.01 * sin) / (1 - sin));
  assert.ok(Math.abs(b.profile.ve - vj) < 1e-6);
});

test('diagonal G0 begränsas av den långsammaste axeln', () => {
  const p = plan([mv([0, 0, -100], 0, true)], machine, [0, 0, 0]);
  assert.equal(p.blocks[0].nominal, 3000 / 60);
});

test('rörelser kortare än ett steg kastas', () => {
  const p = plan([mv([0.0004, 0, 0], 100)], machine, [0, 0, 0]);
  assert.equal(p.blocks.length, 0);
});

test('synkpunkt (M5) stoppar maskinen', () => {
  const ops = [mv([50, 0, 0], 1200), { type: 'spindle', state: 'off', rpm: 0, line: 2 }, mv([100, 0, 0], 1200)];
  const p = plan(ops, machine, [0, 0, 0]);
  assert.equal(p.blocks[0].profile.vx, 0);
  assert.equal(p.blocks[1].profile.ve, 0);
});

test('begränsad lookahead: långa kedjor av korta block planeras mot stopp i buffertens slut', () => {
  const ops = [];
  for (let i = 1; i <= 200; i++) ops.push(mv([i * 0.2, 0, 0], 6000, false, i));
  const small = plan(ops, { ...machine, bufferBlocks: 4 }, [0, 0, 0]).totalTime;
  const large = plan(ops, { ...machine, bufferBlocks: 100 }, [0, 0, 0]).totalTime;
  assert.ok(small > large * 1.2, `${small} vs ${large}`);
});

test('långsam seriell länk svälter bufferten', () => {
  const ops = [];
  for (let i = 1; i <= 100; i++) ops.push(mv([i * 0.1, 0, 0], 6000, false, i));
  const fast = plan(ops, machine, [0, 0, 0]);
  const slow = plan(ops, { ...machine, baud: 9600, parseMs: 2 }, [0, 0, 0], ops.map(() => 'G1 X0.1 F6000'.length));
  assert.ok(slow.totalTime > fast.totalTime);
  assert.ok(slow.starvedLines.size > 50);
});

test('tid ↔ sträcka är varandras inverser', () => {
  const p = trapezoid(30, 5, 2, 20, 100);
  for (const s of [0, 1, 5, 15, 29, 30]) {
    const t = timeAtDistance(p, s);
    assert.ok(Math.abs(distanceAtTime(p, t) - s) < 1e-6);
  }
});
