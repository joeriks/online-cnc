import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret, segmentArc } from '../src/core/gcode.js';

const env = { startPos: [0, 0, 0], wcs: [[10, 20, -30], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], arcTolerance: 0.002, allowToolChange: true, initialTool: 1 };
const moves = (r) => r.ops.filter((o) => o.type === 'move');

test('rörelser i G54 blir maskinkoordinater', () => {
  const r = interpret('G90 G21\nG0 X5 Y5 (kommentar)\nG1 Z-1 F100 ; slut', env);
  assert.equal(r.error, null);
  const m = moves(r);
  assert.deepEqual(m[0].to, [15, 25, 0]);
  assert.deepEqual(m[1].to, [15, 25, -31]);
  assert.equal(m[1].feed, 100);
});

test('tum (G20) räknas om till mm, även F', () => {
  const r = interpret('G20 G91 G1 X1 F10', env);
  const m = moves(r)[0];
  assert.ok(Math.abs(m.to[0] - 25.4) < 1e-9);
  assert.ok(Math.abs(m.feed - 254) < 1e-9);
});

test('G92 och G53', () => {
  const r = interpret('G0 X0 Y0 Z0\nG92 X100\nG0 X101\nG53 G0 X1 Y2 Z-3', env);
  const m = moves(r);
  assert.deepEqual(m[1].to, [11, 20, -30]);
  assert.deepEqual(m[2].to, [1, 2, -3]);
});

test('GRBL-felkoder', () => {
  const code = (src) => interpret(src, env).error?.code;
  assert.equal(code('G1 X10'), 22); // F saknas
  assert.equal(code('G5 X1'), 20); // okänt kommando
  assert.equal(code('G0 X1 X2'), 25); // upprepat ord
  assert.equal(code('G0 G1 X1'), 21); // samma modalgrupp
  assert.equal(code('G2 X10 Y0 R2 F100'), 34); // omöjlig radie
  assert.equal(code('G2 X10 Y0 I3 J0 F100'), 33); // radie stämmer inte
  assert.equal(code('G2 Z-1 I1 F100'), 32); // inga axlar i planet
  assert.equal(code('G4'), 28); // P saknas
  assert.equal(code('G1 X1 A5 F100'), 20); // A-axel
  assert.equal(code('G0 X1 R5'), 36); // oanvänt ord
  assert.equal(code('G90.1'), 20);
  const r = interpret('G0 X1\nG1 X2\nG0 X3', env);
  assert.equal(r.error.line, 2);
});

const env0 = { ...env, wcs: env.wcs.map(() => [0, 0, 0]) };

test('G53 kräver G0/G1 (error:30)', () => {
  assert.equal(interpret('G53 G2 X10 Y0 I-10 F500', env).error.code, 30);
});

test('helcirkel med G2 och IJK ligger på radien', () => {
  const r = interpret('G90 G0 X10 Y0 Z0\nG2 X10 Y0 I-10 J0 F500', env0);
  const m = moves(r).slice(1);
  assert.ok(m.length > 50);
  for (const o of m) assert.ok(Math.abs(Math.hypot(o.to[0], o.to[1]) - 10) < 1e-6);
  assert.deepEqual(m[m.length - 1].to, [10, 0, 0]);
  // Medurs: första punkten ska ha negativt Y
  assert.ok(m[0].to[1] < 0);
});

test('bågsegment följer GRBL:s arc tolerance-formel', () => {
  const R = 20;
  const tol = 0.002;
  const a = segmentArc([R, 0, 0], [0, R, 0], [-R, 0, 0], R, [0, 1, 2], false, tol);
  const expected = Math.floor((0.5 * (Math.PI / 2) * R) / Math.sqrt(tol * (2 * R - tol)));
  assert.equal(a.points.length, expected);
  // Kordahöjd inom toleransen
  const th = Math.PI / 2 / expected;
  // GRBL avrundar antalet segment nedåt, så pilhöjden kan överstiga toleransen något
  assert.ok(R * (1 - Math.cos(th / 2)) <= tol * 1.05);
});

test('R-båge: negativt R ger den stora bågen', () => {
  const small = moves(interpret('G0 X0 Y0\nG2 X10 Y0 R10 F100', env0)).slice(1);
  const big = moves(interpret('G0 X0 Y0\nG2 X10 Y0 R-10 F100', env0)).slice(1);
  assert.ok(big.length > small.length * 3); // 300° mot 60°
});

test('M6 och spindel ger operationer', () => {
  const r = interpret('T2 M6\nM3 S12000\nG4 P1.5\nM5\nM30\nG0 X1', env);
  const types = r.ops.map((o) => o.type);
  assert.deepEqual(types, ['tool', 'spindle', 'dwell', 'spindle', 'end']);
  assert.equal(r.ops[0].tool, 2);
  assert.equal(r.ops[1].rpm, 12000);
});

test('M6 ger fel när verktygsbyte är avstängt', () => {
  const r = interpret('T2 M6', { ...env, allowToolChange: false });
  assert.equal(r.error.code, 20);
});

test('nästlade parenteser ger fel som i GRBL', () => {
  const r = interpret('(a (b) c)', env);
  assert.ok(r.error);
});
