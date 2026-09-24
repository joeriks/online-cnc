// Verktygsgeometri: profilhöjd över spetsen som funktion av radien.

export function toolRadius(t) {
  return t.d / 2;
}

// Höjden på verktygets skärande yta över spetsen vid radien r (0 ≤ r ≤ R).
export function makeProfile(t) {
  const R = t.d / 2;
  switch (t.type) {
    case 'ball':
      return (r) => R - Math.sqrt(Math.max(0, R * R - r * r));
    case 'vbit': {
      const tipR = (t.tipD || 0) / 2;
      const k = 1 / Math.tan(((t.angle || 60) * Math.PI) / 360);
      return (r) => (r <= tipR ? 0 : (r - tipR) * k);
    }
    case 'bull': {
      const cr = Math.min(t.cornerR || 0.5, R);
      const flat = R - cr;
      return (r) => (r <= flat ? 0 : cr - Math.sqrt(Math.max(0, cr * cr - (r - flat) * (r - flat))));
    }
    default:
      return null; // platt: alltid 0
  }
}

// Effektiv skärdiameter vid axiellt skärdjup ap.
export function effectiveDiameter(t, ap) {
  const R = t.d / 2;
  if (t.type === 'ball') {
    if (ap >= R) return t.d;
    return 2 * Math.sqrt(Math.max(0, R * R - (R - ap) * (R - ap)));
  }
  if (t.type === 'vbit') {
    const tipR = (t.tipD || 0) / 2;
    const r = tipR + ap * Math.tan(((t.angle || 60) * Math.PI) / 360);
    return Math.max(0.05, Math.min(t.d, 2 * r));
  }
  return t.d;
}

// Verktygets skärlängd (V-fräsar: konens höjd).
export function cuttingLength(t) {
  if (t.type === 'vbit') {
    const prof = makeProfile(t);
    return Math.min(t.fluteLen || 99, prof(t.d / 2));
  }
  return t.fluteLen;
}

export function describeTool(t) {
  const d = t.d.toLocaleString('sv-SE', { maximumFractionDigits: 3 });
  if (t.type === 'vbit') return `V ${t.angle}° Ø${d}`;
  if (t.type === 'ball') return `Kula Ø${d}`;
  return `Ø${d} ${t.flutes}-skärs`;
}
