// Skärfysik för fräsning.
//  - Spåntjocklek med spåntunning (radiellt ingrepp ae < D/2)
//  - Specifik skärkraft enligt Kienzle: kc = kc11 · h^-mc
//  - Effekt P = kc · MRR, tangentiell kraft Ft = P / vc
//  - Verktygsutböjning som konsolbalk, böjspänning för brottrisk
//  - Maskinens styvhet ger extra utböjning

import { TOOL_MATERIALS } from './library.js';
import { effectiveDiameter } from './tool.js';

// Rekommenderat fz-intervall (mm/skär) för verktyget i materialet vid diameter D.
export function chipLoadRange(material, D) {
  const f = Math.max(0.12, Math.min(2, D / 6));
  return [material.fz6[0] * f, material.fz6[1] * f];
}

// Tillgänglig spindeleffekt (W) vid visst varvtal.
export function spindlePower(spindle, rpm) {
  if (rpm <= 0) return 0;
  switch (spindle.type) {
    case 'dc':
      return spindle.power * Math.max(0.05, Math.min(1, rpm / spindle.maxRpm));
    case 'vfd':
      return spindle.power * Math.max(0.05, Math.min(1, rpm / spindle.maxRpm));
    default:
      return spindle.power;
  }
}

// Verktygets böjstyvhet och hållfasthet.
function toolBeam(tool) {
  const m = TOOL_MATERIALS[tool.material] || TOOL_MATERIALS.carbide;
  const core = tool.type === 'vbit' ? 0.9 : 0.8;
  const d = Math.max(0.2, Math.min(tool.d, tool.shankD || tool.d) * core);
  const I = (Math.PI * d ** 4) / 64;
  const L = Math.max(1, tool.stickout || tool.fluteLen || 10);
  return { E: m.E, I, L, d, strength: m.strength };
}

/**
 * Beräkna skärdata för ett stycke av banan.
 * input: { vol (mm³), dt (s), dxy, dz, ap, rpm, tool, material, machine }
 */
export function cutPhysics({ vol, dt, dxy, dz, ap, rpm, tool, material, machine }) {
  const z = Math.max(1, tool.flutes || 2);
  const apc = Math.max(0.01, ap);
  const Deff = effectiveDiameter(tool, apc);
  const mrr = vol / Math.max(dt, 1e-6); // mm³/s
  const plunge = dz < 0 && dxy < 0.3 * Math.abs(dz);
  let fz, ae, hex, hm;
  if (plunge) {
    fz = (Math.abs(dz) / dt) * 60 / Math.max(rpm, 1) / z;
    ae = Deff;
    hex = fz;
    hm = fz;
  } else {
    const len = Math.hypot(dxy, dz);
    fz = (len / dt) * 60 / Math.max(rpm, 1) / z;
    ae = Math.min(Deff, vol / Math.max(1e-6, dxy * apc));
    const ratio = Math.min(1, ae / Deff);
    const phi = Math.acos(Math.max(-1, 1 - 2 * ratio)); // ingreppsvinkel (rad)
    hex = ratio >= 0.5 ? fz : fz * Math.sin(phi);
    hm = phi > 1e-6 ? (fz * ae) / ((Deff / 2) * phi) : fz;
  }
  const kc = material.kc11 * Math.pow(Math.max(hm, 0.003), -material.mc);
  const power = (kc * mrr) / 1000; // W
  const vc = (Math.PI * Deff * Math.max(rpm, 0)) / 60000; // m/s
  const Ft = power / Math.max(vc, 0.05);
  const force = Ft * (plunge ? 1.6 : 1.25);
  const lateral = plunge ? Ft * 0.3 : force;
  const beam = toolBeam(tool);
  const toolDefl = (lateral * beam.L ** 3) / (3 * beam.E * beam.I);
  const machineDefl = force / Math.max(10, machine.stiffness || 200);
  const stress = (32 * lateral * beam.L) / (Math.PI * beam.d ** 3);
  const avail = spindlePower(machine.spindle, rpm);
  const load = avail > 0 ? power / avail : Infinity;
  return {
    mrr, fz, ae, ap: apc, hex, hm, kc, power, vc: vc * 60, Ft, force, plunge, Deff,
    deflection: toolDefl + machineDefl, toolDefl, machineDefl,
    stressRatio: stress / beam.strength, load, avail,
  };
}

// Rekommenderade skärdata för verktyg + material + maskin.
export function recommend(tool, material, machine) {
  const sp = machine.spindle;
  const z = Math.max(1, tool.flutes || 2);
  const vcMax = material.vcMax[tool.material] || material.vcMax.carbide;
  const D = tool.type === 'vbit' ? effectiveDiameter(tool, 1) : tool.d;
  let rpm;
  if (sp.type === 'router') rpm = sp.dialRpm;
  else rpm = Math.min(sp.maxRpm, (vcMax * 0.8 * 1000) / (Math.PI * D));
  rpm = Math.max(sp.type === 'router' ? rpm : sp.minRpm || 0, Math.round(rpm / 500) * 500);
  const [fzMin, fzMax] = chipLoadRange(material, D);
  const fz = Math.sqrt(fzMin * fzMax);
  let feed = fz * z * rpm;
  const maxXY = Math.min(machine.maxRate[0], machine.maxRate[1]);
  feed = Math.min(feed, maxXY);
  // Skärdjup vid fullt spår: minska tills effekt, kraft och utböjning är ok.
  let ap = tool.type === 'vbit' ? 1 : Math.min(tool.fluteLen, D * (material.group === 'metal' ? 0.3 : 1));
  let result = null;
  for (let iter = 0; iter < 40; iter++) {
    const dt = 1;
    const len = feed / 60;
    const vol = D * ap * len * (tool.type === 'ball' ? 0.7 : tool.type === 'vbit' ? 0.5 : 1);
    result = cutPhysics({ vol, dt, dxy: len, dz: 0, ap, rpm, tool, material, machine });
    const force = result.force;
    const okF = machine.thrust ? force < 0.6 * Math.min(machine.thrust[0], machine.thrust[1]) : true;
    if (result.load < 0.7 && result.stressRatio < 0.45 && result.deflection < 0.05 && okF) break;
    if (ap > 0.15) ap *= 0.85;
    else feed *= 0.85;
  }
  const plunge = Math.min(machine.maxRate[2], feed * 0.4);
  return {
    rpm, feed: Math.round(feed / 10) * 10, plunge: Math.round(plunge / 10) * 10,
    ap: Math.round(ap * 100) / 100, fz, fzRange: [fzMin, fzMax],
    stepover: tool.type === 'ball' ? tool.d * 0.1 : tool.type === 'vbit' ? null : tool.d * 0.4,
    load: result ? result.load : 0,
    vc: (Math.PI * D * rpm) / 1000,
  };
}
