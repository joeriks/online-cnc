// Förinställda maskiner, verktyg och material.
// Värdena är typiska för hobbyutrustning och ska ses som rimliga uppskattningar.

export const MACHINES = [
  {
    id: '3018',
    name: '3018-klass (GRBL på Uno, 775-motor)',
    note: 'Liten skrivbordsfräs med T8-trapetsskruv, aluminiumprofiler och en borstad 775-motor. Klarar trä och plast, aluminium bara med små skärdjup.',
    travel: [300, 180, 45],
    zClearance: 38,
    stepsPerMm: [800, 800, 800],
    maxRate: [1000, 1000, 600],
    accel: [100, 100, 50],
    junctionDeviation: 0.01,
    arcTolerance: 0.002,
    bufferBlocks: 15,
    baud: 115200,
    parseMs: 2.2,
    thrust: [120, 120, 90],
    stiffness: 200,
    spindle: { type: 'dc', power: 90, maxRpm: 10000, minRpm: 0, dialRpm: 10000, spinUp: 1.0 },
    softLimits: false,
    hardLimits: false,
    allowToolChange: true,
  },
  {
    id: 'belt',
    name: 'Remdriven gantry med handöverfräs',
    note: 'Större hobbymaskin med GT2-remmar och en handöverfräs (710 W). Varvtalet ställs på fräsens ratt – S-värdet i G-koden ignoreras.',
    travel: [800, 800, 75],
    zClearance: 70,
    stepsPerMm: [40, 40, 400],
    maxRate: [5000, 5000, 1000],
    accel: [400, 400, 200],
    junctionDeviation: 0.01,
    arcTolerance: 0.002,
    bufferBlocks: 15,
    baud: 115200,
    parseMs: 2.2,
    thrust: [180, 180, 250],
    stiffness: 120,
    spindle: { type: 'router', power: 450, maxRpm: 30000, minRpm: 10000, dialRpm: 18000, spinUp: 1.5 },
    softLimits: true,
    hardLimits: true,
    allowToolChange: true,
  },
  {
    id: 'vfd800',
    name: 'Kulskruvsmaskin med 800 W VFD-spindel',
    note: 'Stabilare hobbymaskin med kulskruvar, 32-bitars styrning (grblHAL) och luftkyld frekvensstyrd spindel. Effekten sjunker proportionellt vid låga varvtal.',
    travel: [600, 400, 90],
    zClearance: 85,
    stepsPerMm: [320, 320, 320],
    maxRate: [5000, 5000, 2000],
    accel: [500, 500, 300],
    junctionDeviation: 0.01,
    arcTolerance: 0.002,
    bufferBlocks: 100,
    baud: 1000000,
    parseMs: 0.2,
    thrust: [450, 450, 450],
    stiffness: 600,
    spindle: { type: 'vfd', power: 800, maxRpm: 24000, minRpm: 6000, dialRpm: 24000, spinUp: 4 },
    softLimits: true,
    hardLimits: true,
    allowToolChange: true,
  },
  {
    id: 'vfd1500',
    name: 'Stålram med 1,5 kW vattenkyld spindel',
    note: 'Tung maskin med stålram och vattenkyld spindel. Klarar aluminium med rimliga data.',
    travel: [800, 600, 120],
    zClearance: 115,
    stepsPerMm: [400, 400, 400],
    maxRate: [8000, 8000, 3000],
    accel: [800, 800, 400],
    junctionDeviation: 0.01,
    arcTolerance: 0.002,
    bufferBlocks: 100,
    baud: 1000000,
    parseMs: 0.2,
    thrust: [900, 900, 900],
    stiffness: 2000,
    spindle: { type: 'vfd', power: 1500, maxRpm: 24000, minRpm: 6000, dialRpm: 24000, spinUp: 5 },
    softLimits: true,
    hardLimits: true,
    allowToolChange: true,
  },
];

export const SPINDLE_TYPES = {
  dc: 'Borstad DC-motor (PWM, konstant moment)',
  vfd: 'Frekvensstyrd spindel (VFD)',
  router: 'Handöverfräs (varvtal på ratten)',
};

export const TOOL_TYPES = { flat: 'Pinnfräs', ball: 'Kulfräs', vbit: 'V-fräs', bull: 'Hörnradiefräs' };

export const TOOLS = [
  { id: 'f3175-2', name: 'Pinnfräs Ø3,175 2-skärs HM', type: 'flat', d: 3.175, flutes: 2, fluteLen: 12, stickout: 17, shankD: 3.175, material: 'carbide', centerCutting: true },
  { id: 'f3175-1', name: 'O-flute Ø3,175 1-skärs HM', type: 'flat', d: 3.175, flutes: 1, fluteLen: 12, stickout: 17, shankD: 3.175, material: 'carbide', centerCutting: true },
  { id: 'f2-2', name: 'Pinnfräs Ø2 2-skärs HM', type: 'flat', d: 2, flutes: 2, fluteLen: 8, stickout: 14, shankD: 3.175, material: 'carbide', centerCutting: true },
  { id: 'f6-2', name: 'Pinnfräs Ø6 2-skärs HM', type: 'flat', d: 6, flutes: 2, fluteLen: 22, stickout: 30, shankD: 6, material: 'carbide', centerCutting: true },
  { id: 'f6-3', name: 'Pinnfräs Ø6 3-skärs HM (aluminium)', type: 'flat', d: 6, flutes: 3, fluteLen: 15, stickout: 25, shankD: 6, material: 'carbide', centerCutting: true },
  { id: 'f4-hss', name: 'Pinnfräs Ø4 2-skärs HSS', type: 'flat', d: 4, flutes: 2, fluteLen: 11, stickout: 20, shankD: 4, material: 'hss', centerCutting: true },
  { id: 'b3175', name: 'Kulfräs Ø3,175 2-skärs HM', type: 'ball', d: 3.175, flutes: 2, fluteLen: 12, stickout: 17, shankD: 3.175, material: 'carbide', centerCutting: true },
  { id: 'b6', name: 'Kulfräs Ø6 2-skärs HM', type: 'ball', d: 6, flutes: 2, fluteLen: 20, stickout: 28, shankD: 6, material: 'carbide', centerCutting: true },
  { id: 'v60', name: 'V-fräs 60° Ø6, spets 0,2', type: 'vbit', d: 6, flutes: 2, angle: 60, tipD: 0.2, fluteLen: 5.0, stickout: 18, shankD: 6, material: 'carbide', centerCutting: true },
  { id: 'v90', name: 'V-fräs 90° Ø12', type: 'vbit', d: 12, flutes: 2, angle: 90, tipD: 0, fluteLen: 6, stickout: 20, shankD: 6, material: 'carbide', centerCutting: true },
  { id: 'v20', name: 'Gravyrstift 20° spets 0,1', type: 'vbit', d: 3.175, flutes: 1, angle: 20, tipD: 0.1, fluteLen: 8.7, stickout: 16, shankD: 3.175, material: 'carbide', centerCutting: true },
  { id: 'surf22', name: 'Planfräs Ø22 2-skärs', type: 'flat', d: 22, flutes: 2, fluteLen: 5, stickout: 22, shankD: 6.35, material: 'carbide', centerCutting: false },
];

// kc11: specifik skärkraft vid 1 mm spåntjocklek (N/mm²), mc: Kienzle-exponent.
// fz6: rekommenderad spåntjocklek per skär (mm) för en Ø6-fräs.
// vcMax: högsta skärhastighet (m/min) för hårdmetall resp. HSS.
export const MATERIALS = [
  { id: 'pine', name: 'Furu (mjukt trä)', group: 'wood', kc11: 40, mc: 0.3, fz6: [0.08, 0.25], vcMax: { carbide: 3000, hss: 1200 }, color: '#e3c28f', cutColor: '#d8b27a', note: 'Förlåtande material. Håll spåntjockleken uppe så det blir spån och inte damm – för tunna spån ger brännmärken.' },
  { id: 'oak', name: 'Ek (hårt trä)', group: 'wood', kc11: 70, mc: 0.3, fz6: [0.06, 0.2], vcMax: { carbide: 2500, hss: 900 }, color: '#b98e5a', cutColor: '#a47a48', note: 'Hårdare och segare än furu, kräver mer kraft. Brännmärken vid för låg matning.' },
  { id: 'mdf', name: 'MDF', group: 'wood', kc11: 55, mc: 0.3, fz6: [0.08, 0.25], vcMax: { carbide: 3000, hss: 800 }, color: '#b58a5e', cutColor: '#a27a50', note: 'Jämnt material som sliter på eggarna (lim). Fint damm – använd utsug.' },
  { id: 'ply', name: 'Björkplywood', group: 'wood', kc11: 65, mc: 0.3, fz6: [0.07, 0.22], vcMax: { carbide: 2800, hss: 900 }, color: '#e8d2a8', cutColor: '#d9bd8c', note: 'Limskikten sliter på verktyget. Upp-spiral ger flisor i överkant.' },
  { id: 'foam', name: 'PU-skum (modellblock)', group: 'foam', kc11: 4, mc: 0.3, fz6: [0.1, 0.5], vcMax: { carbide: 5000, hss: 5000 }, color: '#d9d4a8', cutColor: '#cbc38e', note: 'Mycket lätt att fräsa. Bra för att prova program och 3D-reliefer.' },
  { id: 'pmma', name: 'Akryl (PMMA, gjuten)', group: 'plastic', kc11: 120, mc: 0.25, fz6: [0.05, 0.15], vcMax: { carbide: 400, hss: 200 }, melt: true, color: '#cfe6ee', cutColor: '#e8f2f5', note: 'Smälter om spånen blir för tunna eller varvtalet för högt. 1-skärs O-flute ger bäst resultat.' },
  { id: 'pom', name: 'POM (acetal)', group: 'plastic', kc11: 110, mc: 0.25, fz6: [0.06, 0.2], vcMax: { carbide: 500, hss: 250 }, melt: true, color: '#f1f0ea', cutColor: '#ffffff', note: 'Fräses mycket bra. Kan smälta vid för tunna spån.' },
  { id: 'hdpe', name: 'HDPE', group: 'plastic', kc11: 60, mc: 0.25, fz6: [0.08, 0.3], vcMax: { carbide: 600, hss: 300 }, melt: true, color: '#eef1f0', cutColor: '#ffffff', note: 'Mjuk och seg plast. Kräver skarpa verktyg och tjocka spån.' },
  { id: 'al', name: 'Aluminium 6082/6061', group: 'metal', kc11: 700, mc: 0.25, fz6: [0.02, 0.06], vcMax: { carbide: 400, hss: 120 }, color: '#c9ced3', cutColor: '#e4e8ec', note: 'Kräver styv maskin, små skärdjup och smörjning/luftblästring. För tunna spån ger påkladdning på eggen.' },
  { id: 'brass', name: 'Mässing', group: 'metal', kc11: 780, mc: 0.18, fz6: [0.025, 0.07], vcMax: { carbide: 300, hss: 90 }, color: '#d7b45a', cutColor: '#ecd28a', note: 'Lättbearbetad metall men kräver kraft. Verktyg med rak släppning undviker att fräsen drar sig ner.' },
  { id: 'steel', name: 'Konstruktionsstål S235', group: 'metal', kc11: 1600, mc: 0.25, fz6: [0.015, 0.04], vcMax: { carbide: 120, hss: 30 }, color: '#8d9399', cutColor: '#b3b9bf', note: 'I praktiken utanför vad de flesta hobbymaskiner klarar.' },
];

export const TOOL_MATERIALS = {
  carbide: { name: 'Hårdmetall (HM)', E: 580000, strength: 1300 },
  hss: { name: 'Snabbstål (HSS)', E: 210000, strength: 900 },
};

export function findById(list, id) {
  return list.find((x) => x.id === id) || list[0];
}

export function cloneTool(t) {
  return JSON.parse(JSON.stringify(t));
}
