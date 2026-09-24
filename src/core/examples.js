// Exempelprogram. Varje exempel anger material, verktyg och ämne.

const n = (v) => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

function header(lines, title) {
  lines.push(`(${title})`, 'G21 G90 G17 G94 (mm, absolut, XY-plan, mm/min)', 'G54');
}

function rectPocket(L, { x0, y0, x1, y1, depth, doc, r, stepover, feed, plunge }) {
  const passes = Math.ceil(depth / doc - 1e-9);
  for (let p = 1; p <= passes; p++) {
    const z = -Math.min(depth, p * doc);
    const ax = x0 + r, bx = x1 - r, ay = y0 + r, by = y1 - r;
    L.push(`(Djup ${n(-z)} mm)`);
    L.push(`G0 X${n(ax)} Y${n(ay)}`);
    L.push('G0 Z1');
    L.push(`G1 Z${n(z)} F${plunge}`);
    L.push(`G1 X${n(bx)} F${feed}`);
    let y = ay;
    let right = true;
    while (y < by - 1e-6) {
      y = Math.min(by, y + stepover);
      L.push(`G1 Y${n(y)}`);
      right = !right;
      L.push(`G1 X${n(right ? bx : ax)}`);
    }
    // Finskär runt kanten
    L.push(`G1 X${n(ax)} Y${n(by)}`, `G1 Y${n(ay)}`, `G1 X${n(bx)}`, `G1 Y${n(by)}`, `G1 X${n(ax)}`);
    L.push('G0 Z3');
  }
}

function pocketPine() {
  const L = [];
  header(L, 'Rektangulär ficka 60 x 40 x 4,5 mm i furu');
  L.push('(Verktyg T1: pinnfräs 3,175 mm, 2 skär)');
  L.push('T1', 'M3 S10000', 'G4 P1 (vänta på att spindeln varvar upp)', 'G0 Z5');
  rectPocket(L, { x0: 20, y0: 15, x1: 80, y1: 55, depth: 4.5, doc: 1.5, r: 3.175 / 2, stepover: 1.3, feed: 1000, plunge: 250 });
  L.push('G0 Z5', 'M5', 'G0 X0 Y0', 'M30');
  return L.join('\n');
}

function helixMdf() {
  const L = [];
  header(L, 'Rund skiva Ø80 med hål Ø20 i 6 mm MDF – helixfräsning med G2');
  L.push('(Verktyg T1: pinnfräs 3,175 mm, 2 skär. Nollpunkt: ämnets mitt, överkant)');
  L.push('T1', 'M3 S10000', 'G4 P1', 'G0 Z5');
  const tr = 3.175 / 2;
  const circle = (R, label) => {
    L.push(`(${label})`);
    L.push(`G0 X${n(R)} Y0`, 'G0 Z0.5', 'G1 Z0 F300');
    let z = 0;
    const final = -6.3;
    while (z > final + 1e-6) {
      z = Math.max(final, z - 0.8);
      L.push(`G2 X${n(R)} Y0 I${n(-R)} J0 Z${n(z)} F800`);
    }
    L.push(`G2 X${n(R)} Y0 I${n(-R)} J0`);
    L.push('G0 Z5');
  };
  circle(10 - tr, 'Innerhål Ø20 – verktygets centrum går innanför');
  circle(40 + tr, 'Ytterkontur Ø80 – verktygets centrum går utanför');
  L.push('M5', 'G0 X0 Y0', 'M30');
  return L.join('\n');
}

function signOak() {
  const L = [];
  header(L, 'Skylt i ek: kantspår + V-gravyr med verktygsbyte');
  L.push('(T1: pinnfräs 3,175 mm. T2: V-fräs 60 grader)');
  L.push('T1', 'M3 S10000', 'G4 P1', 'G0 Z5');
  L.push('(Spår runt skylten, 1 mm per varv)');
  for (const z of [-1, -2]) {
    L.push('G0 X6 Y6', 'G1 Z' + z + ' F200', 'G1 X114 F700', 'G1 Y54', 'G1 X6', 'G1 Y6', 'G0 Z3');
  }
  L.push('G0 Z20', 'M5', 'T2 M6 (Byt till V-fräsen och nollställ Z)', 'M3 S10000', 'G4 P1', 'G0 Z5');
  const depth = -1.2;
  const letterC = (cx, cy) => {
    const r = 12;
    const a0 = (50 * Math.PI) / 180;
    const sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0);
    const ex = cx + r * Math.cos(-a0), ey = cy + r * Math.sin(-a0);
    L.push(`G0 X${n(sx)} Y${n(sy)}`, `G1 Z${depth} F150`, `G3 X${n(ex)} Y${n(ey)} I${n(cx - sx)} J${n(cy - sy)} F600`, 'G0 Z2');
  };
  const letterN = (x, y) => {
    L.push(`G0 X${n(x)} Y${n(y)}`, `G1 Z${depth} F150`, `G1 Y${n(y + 24)} F600`, `G1 X${n(x + 18)} Y${n(y)}`, `G1 Y${n(y + 24)}`, 'G0 Z2');
  };
  L.push('(Bokstäver C N C)');
  letterC(30, 30);
  letterN(51, 18);
  letterC(90, 30);
  L.push('G0 Z10', 'M5', 'G0 X0 Y0', 'M30');
  return L.join('\n');
}

function aluAggressive() {
  const L = [];
  header(L, 'Aluminium: för aggressiva skärdata – se vad som händer');
  L.push('(T1: pinnfräs 3,175 mm 2 skär. 3 mm djupt fullt spår i ett svep på en liten maskin)');
  L.push('T1', 'M3 S10000', 'G4 P1', 'G0 Z5');
  L.push('G0 X10 Y10', 'G1 Z-3 F200', 'G1 X70 F800', 'G1 Y30', 'G1 X10', 'G0 Z5');
  L.push('M5', 'G0 X0 Y0', 'M30');
  return L.join('\n');
}

function aluGentle() {
  const L = [];
  header(L, 'Aluminium: försiktiga data för en liten maskin');
  L.push('(T1: O-flute 3,175 mm 1 skär. 0,3 mm skärdjup, låg hastighet, luftblästring)');
  L.push('T1', 'M3 S10000', 'G4 P1', 'G0 Z5');
  rectPocket(L, { x0: 10, y0: 10, x1: 40, y1: 30, depth: 0.9, doc: 0.3, r: 3.175 / 2, stepover: 1.2, feed: 350, plunge: 60 });
  L.push('M5', 'G0 X0 Y0', 'M30');
  return L.join('\n');
}

function reliefFoam() {
  const L = [];
  header(L, '3D-relief, vågyta i PU-skum med kulfräs');
  L.push('(T1: kulfräs 3,175 mm. Raster längs X, 0,6 mm sidsteg)');
  L.push('T1', 'M3 S10000', 'G4 P1', 'G0 Z5');
  const f = (x, y) => -3 - 2 * Math.sin(x / 7) * Math.cos(y / 9) - 0.6 * Math.cos((x + y) / 5);
  let dir = 1;
  const x0 = 5, x1 = 75, y0 = 5, y1 = 75;
  L.push(`G0 X${x0} Y${y0}`, `G1 Z${n(f(x0, y0))} F400`);
  for (let y = y0; y <= y1 + 1e-6; y += 0.6) {
    const xs = [];
    for (let x = x0; x <= x1 + 1e-6; x += 1) xs.push(x);
    if (dir < 0) xs.reverse();
    L.push(`G1 Y${n(y)} Z${n(f(xs[0], y))} F1200`);
    for (const x of xs) L.push(`X${n(x)} Z${n(f(x, y))}`);
    dir = -dir;
  }
  L.push('G0 Z5', 'M5', 'G0 X0 Y0', 'M30');
  return L.join('\n');
}

function mistakes() {
  return [
    '(Vanliga misstag – kör och läs varningarna)',
    'G21 G90 G17 G94',
    'G54',
    'T1',
    'G0 X10 Y10 Z2',
    '(1: ingen G4 – verktyget går in innan spindeln har varvat upp)',
    'M3 S10000',
    'G1 Z-1 F300',
    'G1 X40 F900',
    '(2: glömt att lyfta – G0 rakt genom materialet)',
    'G0 X60 Y30',
    'G0 Z5',
    '(3: fel radie på bågen – GRBL svarar error:34 och avsändaren stannar)',
    'G0 X20 Y20',
    'G2 X60 Y20 R10 F500',
    'M5',
    'M30',
  ].join('\n');
}

function surfacing() {
  const L = [];
  header(L, 'Planfräsning av en björkplywoodskiva med Ø22 planfräs');
  L.push('(T1: planfräs 22 mm. 0,5 mm djup, 40 % sidsteg. Start utanför ämnet – planfräsen kan inte borra.)');
  L.push('T1', 'M3 S10000', 'G4 P1', 'G0 Z5', 'G0 X-15 Y2');
  L.push('G1 Z-0.5 F300');
  let y = 2;
  let right = true;
  while (y <= 98) {
    L.push(`G1 X${right ? 115 : -15} F1000`);
    y += 8.8;
    if (y <= 98) L.push(`G1 Y${n(y)}`);
    right = !right;
  }
  L.push('G0 Z5', 'M5', 'G0 X0 Y0', 'M30');
  return L.join('\n');
}

export const EXAMPLES = [
  { id: 'pocket', name: 'Ficka i furu', material: 'pine', tools: { 1: 'f3175-2' }, stock: { sx: 100, sy: 70, sz: 18 }, zero: { xy: 'corner', z: 'top' }, code: pocketPine },
  { id: 'helix', name: 'Rund skiva i MDF (helix, G2)', material: 'mdf', tools: { 1: 'f3175-2' }, stock: { sx: 100, sy: 100, sz: 6 }, zero: { xy: 'center', z: 'top' }, code: helixMdf },
  { id: 'sign', name: 'Skylt i ek med verktygsbyte (M6)', material: 'oak', tools: { 1: 'f3175-2', 2: 'v60' }, stock: { sx: 120, sy: 60, sz: 15 }, zero: { xy: 'corner', z: 'top' }, code: signOak },
  { id: 'relief', name: '3D-relief i PU-skum (kulfräs)', material: 'foam', tools: { 1: 'b3175' }, stock: { sx: 80, sy: 80, sz: 20 }, zero: { xy: 'corner', z: 'top' }, code: reliefFoam },
  { id: 'surface', name: 'Planfräsning av plywood', material: 'ply', tools: { 1: 'surf22' }, stock: { sx: 100, sy: 100, sz: 18 }, zero: { xy: 'corner', z: 'top' }, code: surfacing },
  { id: 'alu-gentle', name: 'Aluminium – försiktiga data', material: 'al', tools: { 1: 'f3175-1' }, stock: { sx: 50, sy: 40, sz: 8 }, zero: { xy: 'corner', z: 'top' }, code: aluGentle },
  { id: 'alu-hard', name: 'Aluminium – för aggressivt', material: 'al', tools: { 1: 'f3175-2' }, stock: { sx: 80, sy: 40, sz: 8 }, zero: { xy: 'corner', z: 'top' }, code: aluAggressive },
  { id: 'mistakes', name: 'Vanliga misstag', material: 'pine', tools: { 1: 'f3175-2' }, stock: { sx: 80, sy: 50, sz: 18 }, zero: { xy: 'corner', z: 'top' }, code: mistakes },
];
