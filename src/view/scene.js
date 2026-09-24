// 3D-vy. Världskoordinater = maskinkoordinater i mm, Z uppåt.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeProfile, cuttingLength } from '../core/tool.js';

const tmpColor = new THREE.Color();

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404850, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-300, -500, 900);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(400, 300, 300);
    this.scene.add(fill);

    this.machineGroup = new THREE.Group();
    this.scene.add(this.machineGroup);
    this.stockGroup = new THREE.Group();
    this.scene.add(this.stockGroup);
    this.pathGroup = new THREE.Group();
    this.scene.add(this.pathGroup);
    this.head = new THREE.Group(); // spindel + verktyg, positionerad i verktygsspetsen
    this.scene.add(this.head);
    this.toolSpin = new THREE.Group();
    this.head.add(this.toolSpin);

    this.showMachine = true;
    this.showPaths = true;
    this.showRapids = true;
    this.dirtyRender = true;
    this.spinAngle = 0;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();
    this.controls.addEventListener('change', () => { this.dirtyRender = true; });
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const changed = this.controls.update();
      if (this.spinning) {
        this.spinAngle += 0.6;
        this.toolSpin.rotation.z = this.spinAngle;
        this.dirtyRender = true;
      }
      if (changed || this.dirtyRender) {
        this.renderer.render(this.scene, this.camera);
        this.dirtyRender = false;
      }
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirtyRender = true;
  }

  setPalette(p) {
    this.palette = p;
    this.dirtyRender = true;
  }

  // Maskin: bord, offerskiva, rutnät, räler och portal.
  buildMachine(machine, geo) {
    disposeGroup(this.machineGroup);
    this.machine = machine;
    this.geo = geo;
    const [X, Y] = machine.travel;
    const bedZ = geo.bedZ;
    const p = this.palette || {};
    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(X + 60, Y + 60, 12),
      new THREE.MeshStandardMaterial({ color: p.spoilboard || '#b89c74', roughness: 0.95 }),
    );
    bed.position.set(X / 2, Y / 2, bedZ - 6.05);
    this.machineGroup.add(bed);

    // Rutnät var 10 mm, kraftigare var 50 mm
    const gridPts = [];
    const gridBold = [];
    for (let x = 0; x <= X + 1e-6; x += 10) (x % 50 === 0 ? gridBold : gridPts).push(x, 0, bedZ + 0.02, x, Y, bedZ + 0.02);
    for (let y = 0; y <= Y + 1e-6; y += 10) (y % 50 === 0 ? gridBold : gridPts).push(0, y, bedZ + 0.02, X, y, bedZ + 0.02);
    const grid = new THREE.LineSegments(lineGeo(gridPts), new THREE.LineBasicMaterial({ color: p.grid || '#8c7a5e', transparent: true, opacity: 0.28 }));
    const grid2 = new THREE.LineSegments(lineGeo(gridBold), new THREE.LineBasicMaterial({ color: p.grid || '#8c7a5e', transparent: true, opacity: 0.55 }));
    this.machineGroup.add(grid, grid2);

    // Aluminiumram
    const alu = new THREE.MeshStandardMaterial({ color: p.frame || '#9aa3a8', roughness: 0.45, metalness: 0.6 });
    const railGeo = new THREE.BoxGeometry(30, Y + 90, 40);
    for (const x of [-45, X + 45]) {
      const rail = new THREE.Mesh(railGeo, alu);
      rail.position.set(x, Y / 2, bedZ - 12);
      this.machineGroup.add(rail);
    }
    const endGeo = new THREE.BoxGeometry(X + 120, 30, 40);
    for (const y of [-45, Y + 45]) {
      const end = new THREE.Mesh(endGeo, alu);
      end.position.set(X / 2, y, bedZ - 12);
      this.machineGroup.add(end);
    }
    // Portal (rör sig i Y), Z-vagn (rör sig i X)
    this.gantry = new THREE.Group();
    const top = bedZ + machine.zClearance + 70;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(X + 120, 40, 60), alu);
    beam.position.set(X / 2, 45, top);
    const sideGeo = new THREE.BoxGeometry(20, 60, top - bedZ + 20);
    for (const x of [-45, X + 45]) {
      const side = new THREE.Mesh(sideGeo, alu);
      side.position.set(x, 45, (top + bedZ) / 2);
      this.gantry.add(side);
    }
    this.gantry.add(beam);
    this.machineGroup.add(this.gantry);
    this.carriage = new THREE.Mesh(new THREE.BoxGeometry(70, 12, 110), new THREE.MeshStandardMaterial({ color: p.carriage || '#3b4348', roughness: 0.5, metalness: 0.3 }));
    this.machineGroup.add(this.carriage);
    this.carriageTop = top;

    // Nollpunkt (G54) som axelkors
    const z0 = geo.zero;
    const axes = new THREE.Group();
    const L = 12;
    axes.add(new THREE.LineSegments(lineGeo([0, 0, 0, L, 0, 0]), new THREE.LineBasicMaterial({ color: '#d0453a' })));
    axes.add(new THREE.LineSegments(lineGeo([0, 0, 0, 0, L, 0]), new THREE.LineBasicMaterial({ color: '#3a9a4a' })));
    axes.add(new THREE.LineSegments(lineGeo([0, 0, 0, 0, 0, L]), new THREE.LineBasicMaterial({ color: '#3a6fd0' })));
    axes.position.set(z0[0], z0[1], z0[2] + 0.05);
    axes.renderOrder = 5;
    this.machineGroup.add(axes);
    this.machineGroup.visible = this.showMachine && !this.resultMode;
    this.dirtyRender = true;
  }

  // Ämnet som ett nät över höjdkartan.
  buildStock(hm, material) {
    disposeGroup(this.stockGroup);
    this.hm = hm;
    const { nx, ny } = hm;
    const topCount = nx * ny;
    const wallCount = 2 * (2 * nx + 2 * ny);
    const pos = new Float32Array((topCount + wallCount) * 3);
    const nor = new Float32Array((topCount + wallCount) * 3);
    const col = new Float32Array((topCount + wallCount) * 4).fill(1); // RGBA: genomgående hål får alfa 0
    this.xs = new Float32Array(nx);
    this.ys = new Float32Array(ny);
    for (let i = 0; i < nx; i++) this.xs[i] = i === 0 ? hm.x0 : i === nx - 1 ? hm.x0 + hm.sx : hm.x0 + (i + 0.5) * hm.dx;
    for (let j = 0; j < ny; j++) this.ys[j] = j === 0 ? hm.y0 : j === ny - 1 ? hm.y0 + hm.sy : hm.y0 + (j + 0.5) * hm.dy;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        pos[k] = this.xs[i];
        pos[k + 1] = this.ys[j];
      }
    }
    const idx = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, b, d, a, d, c);
      }
    }
    const topIdx = idx.slice();
    // Väggar: fram, bak, vänster, höger – två rader (topp/botten) per kant
    this.walls = [];
    let base = topCount;
    const addWall = (cells, normal, flip) => {
      const start = base;
      for (let k = 0; k < cells.length; k++) {
        const [i, j] = cells[k];
        for (const row of [0, 1]) {
          const v = (start + k * 2 + row) * 3;
          pos[v] = this.xs[i];
          pos[v + 1] = this.ys[j];
          nor[v] = normal[0]; nor[v + 1] = normal[1]; nor[v + 2] = normal[2];
        }
        if (k < cells.length - 1) {
          const a = start + k * 2, b = a + 1, c = a + 2, d = a + 3;
          if (flip) idx.push(a, c, b, b, c, d);
          else idx.push(a, b, c, b, d, c);
        }
      }
      this.walls.push({ start, cells });
      base += cells.length * 2;
    };
    const range = (n0, f) => Array.from({ length: n0 }, (_, k) => f(k));
    addWall(range(nx, (i) => [i, 0]), [0, -1, 0], false);
    addWall(range(nx, (i) => [i, ny - 1]), [0, 1, 0], true);
    addWall(range(ny, (j) => [0, j]), [-1, 0, 0], true);
    addWall(range(ny, (j) => [nx - 1, j]), [1, 0, 0], false);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.stockMaterial = material;
    const metal = material.group === 'metal';
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, alphaTest: 0.5, roughness: metal ? 0.35 : 0.85, metalness: metal ? 0.55 : 0, side: THREE.DoubleSide });
    this.stockMesh = new THREE.Mesh(g, mat);
    this.stockGroup.add(this.stockMesh);
    // Undersida (syns i resultatläget), med samma hål som ovansidan
    const bpos = new Float32Array(topCount * 3);
    const bnor = new Float32Array(topCount * 3);
    const bcol = new Float32Array(topCount * 4);
    const under = new THREE.Color(material.color).multiplyScalar(0.8);
    for (let c = 0; c < topCount; c++) {
      bpos[c * 3] = pos[c * 3]; bpos[c * 3 + 1] = pos[c * 3 + 1]; bpos[c * 3 + 2] = hm.zBottom - 0.002;
      bnor[c * 3 + 2] = -1;
      bcol[c * 4] = under.r; bcol[c * 4 + 1] = under.g; bcol[c * 4 + 2] = under.b; bcol[c * 4 + 3] = 1;
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(bpos, 3));
    bg.setAttribute('normal', new THREE.BufferAttribute(bnor, 3));
    bg.setAttribute('color', new THREE.BufferAttribute(bcol, 4).setUsage(THREE.DynamicDrawUsage));
    bg.setIndex(topIdx);
    this.bottomMesh = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ vertexColors: true, alphaTest: 0.5, roughness: 0.9, side: THREE.DoubleSide }));
    this.stockGroup.add(this.bottomMesh);
    this.colTop = new THREE.Color(material.color);
    this.colCut = new THREE.Color(material.cutColor || material.color);
    this.colDeep = this.colCut.clone().multiplyScalar(0.72);
    hm.dirty = { i0: 0, i1: nx - 1, j0: 0, j1: ny - 1 };
    this.updateStock();
  }

  updateStock() {
    const hm = this.hm;
    if (!hm || !this.stockMesh) return;
    const d = hm.dirty;
    if (d.i0 > d.i1) return;
    const { nx, ny, h, zTop, zBottom } = hm;
    const g = this.stockMesh.geometry;
    const pos = g.attributes.position.array;
    const nor = g.attributes.normal.array;
    const col = g.attributes.color.array;
    const bcol = this.bottomMesh.geometry.attributes.color.array;
    const through = zBottom + 1e-4;
    const i0 = Math.max(0, d.i0 - 1), i1 = Math.min(nx - 1, d.i1 + 1);
    const j0 = Math.max(0, d.j0 - 1), j1 = Math.min(ny - 1, d.j1 + 1);
    const depthSpan = Math.max(0.5, zTop - zBottom);
    const xs = this.xs, ys = this.ys;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        const k = c * 3;
        const z = h[c];
        pos[k + 2] = z;
        const il = i > 0 ? i - 1 : i, ir = i < nx - 1 ? i + 1 : i;
        const jd = j > 0 ? j - 1 : j, ju = j < ny - 1 ? j + 1 : j;
        const gx = (h[j * nx + ir] - h[j * nx + il]) / Math.max(1e-6, xs[ir] - xs[il]);
        const gy = (h[ju * nx + i] - h[jd * nx + i]) / Math.max(1e-6, ys[ju] - ys[jd]);
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        nor[k] = -gx * inv; nor[k + 1] = -gy * inv; nor[k + 2] = inv;
        const depth = zTop - z;
        if (depth < 0.01) tmpColor.copy(this.colTop);
        else tmpColor.copy(this.colCut).lerp(this.colDeep, Math.min(1, depth / depthSpan));
        // Hål: en genomfräst cell vars alla grannar också är genomfrästa blir osynlig.
        // Kantcellerna behålls så att hålets väggar ritas hela vägen ner.
        let open = z <= through;
        if (open) {
          for (let jj = jd; jj <= ju && open; jj++) for (let ii = il; ii <= ir; ii++) if (h[jj * nx + ii] > through) { open = false; break; }
        }
        const q = c * 4;
        col[q] = tmpColor.r; col[q + 1] = tmpColor.g; col[q + 2] = tmpColor.b; col[q + 3] = open ? 0 : 1;
        bcol[q + 3] = open ? 0 : 1;
      }
    }
    // Väggar
    const wallTouched = d.j0 <= 1 || d.j1 >= ny - 2 || d.i0 <= 1 || d.i1 >= nx - 2;
    if (wallTouched) {
      for (const w of this.walls) {
        for (let k = 0; k < w.cells.length; k++) {
          const [i, j] = w.cells[k];
          const top = (w.start + k * 2) * 3;
          const bot = top + 3;
          pos[top + 2] = h[j * nx + i];
          pos[bot + 2] = zBottom;
          const ct = zTop - h[j * nx + i] < 0.01 ? this.colTop : this.colCut;
          const qt = (w.start + k * 2) * 4;
          const qb = qt + 4;
          col[qt] = ct.r * 0.9; col[qt + 1] = ct.g * 0.9; col[qt + 2] = ct.b * 0.9; col[qt + 3] = 1;
          col[qb] = ct.r * 0.8; col[qb + 1] = ct.g * 0.8; col[qb + 2] = ct.b * 0.8; col[qb + 3] = 1;
        }
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    this.bottomMesh.geometry.attributes.color.needsUpdate = true;
    g.computeBoundingSphere();
    hm.resetDirty();
    this.dirtyRender = true;
  }

  // Verktygsbanor från chunkdata.
  buildPaths(chunks) {
    disposeGroup(this.pathGroup);
    const n = chunks.n;
    const pos = new Float32Array(n * 6);
    const col = new Float32Array(n * 6);
    const p = this.palette || {};
    const cFeed = new THREE.Color(p.feed || '#1f7fb8');
    const cRapid = new THREE.Color(p.rapid || '#e0663a');
    const cDead = new THREE.Color('#8a8f93');
    for (let i = 0; i < n; i++) {
      const k = i * 6;
      pos[k] = chunks.ax[i]; pos[k + 1] = chunks.ay[i]; pos[k + 2] = chunks.az[i];
      pos[k + 3] = chunks.bx[i]; pos[k + 4] = chunks.by[i]; pos[k + 5] = chunks.bz[i];
      const f = chunks.flags[i];
      const c = f & 1 ? cRapid : f & 2 ? cFeed : cDead;
      col[k] = col[k + 3] = c.r; col[k + 1] = col[k + 4] = c.g; col[k + 2] = col[k + 5] = c.b;
    }
    this.pathFlags = chunks.flags;
    this.pathOrig = pos.slice();
    const posAttr = new THREE.BufferAttribute(pos, 3);
    const colAttr = new THREE.BufferAttribute(col, 3);
    const gAll = new THREE.BufferGeometry();
    gAll.setAttribute('position', posAttr);
    gAll.setAttribute('color', colAttr);
    const gDone = new THREE.BufferGeometry();
    gDone.setAttribute('position', posAttr);
    gDone.setAttribute('color', colAttr);
    // Kommande bana tydlig, redan körd bana svag så att den frästa ytan syns
    this.pathAll = new THREE.LineSegments(gAll, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthTest: false }));
    this.pathDone = new THREE.LineSegments(gDone, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.12, depthWrite: false }));
    this.pathCount = n;
    gDone.setDrawRange(0, 0);
    this.pathGroup.add(this.pathAll, this.pathDone);
    this.pathGroup.visible = this.showPaths && !this.resultMode;
    this.applyRapidVisibility();
    this.dirtyRender = true;
  }

  // Dolda snabbförflyttningar kollapsas till nollängd (samma geometri delas av båda linjerna).
  applyRapidVisibility() {
    if (!this.pathAll) return;
    const attr = this.pathAll.geometry.attributes.position;
    const pos = attr.array;
    const orig = this.pathOrig;
    const flags = this.pathFlags;
    for (let i = 0; i < flags.length; i++) {
      if (!(flags[i] & 1)) continue;
      const k = i * 6;
      if (this.showRapids) for (let q = 3; q < 6; q++) pos[k + q] = orig[k + q];
      else for (let q = 3; q < 6; q++) pos[k + q] = orig[k + q - 3];
    }
    attr.needsUpdate = true;
    this.dirtyRender = true;
  }

  setProgress(doneChunks) {
    if (!this.pathDone) return;
    const d = Math.max(0, Math.min(this.pathCount, doneChunks));
    this.pathDone.geometry.setDrawRange(0, d * 2);
    this.pathAll.geometry.setDrawRange(d * 2, (this.pathCount - d) * 2);
    this.dirtyRender = true;
  }

  // Verktyg + spännhylsa + spindel.
  buildTool(tool, spindleType, broken = false) {
    disposeGroup(this.toolSpin);
    disposeGroup(this.head, [this.toolSpin]);
    const key = tool ? JSON.stringify(tool) + spindleType + broken : 'none';
    this.toolKey = key;
    const p = this.palette || {};
    if (tool) {
      const R = tool.d / 2;
      const prof = makeProfile(tool);
      const cutLen = cuttingLength(tool);
      const shankR = (tool.shankD || tool.d) / 2;
      const stick = Math.max(tool.stickout, cutLen + 2);
      const pts = [];
      const brokenAt = broken ? Math.min(cutLen * 0.6, stick * 0.4) : 0;
      if (broken) {
        pts.push(new THREE.Vector2(0, brokenAt), new THREE.Vector2(Math.min(R, shankR) * 0.9, brokenAt + 0.3));
      } else if (tool.type === 'flat') {
        pts.push(new THREE.Vector2(0, 0), new THREE.Vector2(R, 0));
      } else {
        const steps = 16;
        for (let k = 0; k <= steps; k++) {
          const r = (R * k) / steps;
          pts.push(new THREE.Vector2(r, prof(r)));
        }
      }
      const coneTop = tool.type === 'vbit' ? Math.min(cutLen, prof(R)) : cutLen;
      if (!broken) pts.push(new THREE.Vector2(R, coneTop));
      pts.push(new THREE.Vector2(shankR, Math.max(coneTop, brokenAt) + 0.4));
      pts.push(new THREE.Vector2(shankR, stick));
      pts.push(new THREE.Vector2(0, stick));
      const g = new THREE.LatheGeometry(pts, 40);
      g.rotateX(Math.PI / 2);
      const toolMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: broken ? '#8e5b4a' : tool.material === 'hss' ? '#b7bcc0' : '#8f979d', metalness: 0.8, roughness: 0.3 }));
      this.toolSpin.add(toolMesh);
      // Skärzon markerad med tunn ring
      if (!broken) {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.01, R * 1.01, 0.4, 32, 1, true), new THREE.MeshBasicMaterial({ color: p.accent || '#0f6e7a' }));
        band.rotation.x = Math.PI / 2;
        band.position.z = coneTop;
        this.toolSpin.add(band);
      }
      // Spännmutter med markering som visar rotationen
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(9.5, 9.5, 11, 6), new THREE.MeshStandardMaterial({ color: '#c9ced2', metalness: 0.85, roughness: 0.25 }));
      nut.rotation.x = Math.PI / 2;
      nut.position.z = stick + 5.5;
      this.toolSpin.add(nut);
      const mark = new THREE.Mesh(new THREE.BoxGeometry(2.5, 20, 1.2), new THREE.MeshBasicMaterial({ color: p.accent || '#0f6e7a' }));
      mark.position.z = stick + 11.2;
      this.toolSpin.add(mark);
      this.spindleBase = stick + 11;
    } else this.spindleBase = 20;
    const bodyR = spindleType === 'router' ? 33 : spindleType === 'dc' ? 22.5 : 32.5;
    const bodyL = spindleType === 'dc' ? 70 : 190;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, bodyL, 40), new THREE.MeshStandardMaterial({ color: spindleType === 'router' ? '#2f3438' : '#d9dcde', metalness: spindleType === 'router' ? 0.1 : 0.6, roughness: 0.4 }));
    body.rotation.x = Math.PI / 2;
    body.position.z = this.spindleBase + bodyL / 2;
    this.head.add(body);
    this.dirtyRender = true;
  }

  setHead(pos, spinning) {
    this.head.position.set(pos[0], pos[1], pos[2]);
    this.spinning = spinning;
    if (this.gantry) this.gantry.position.y = pos[1];
    if (this.carriage) this.carriage.position.set(pos[0], pos[1] + 40, Math.max(pos[2] + (this.spindleBase || 20) + 60, this.geo.bedZ + 20));
    this.dirtyRender = true;
  }

  // Resultatläge: bara den färdiga detaljen – ingen maskin, spindel, bord eller banor.
  setResultMode(on) {
    this.resultMode = on;
    this.machineGroup.visible = on ? false : this.showMachine;
    this.pathGroup.visible = on ? false : this.showPaths;
    this.head.visible = !on;
    if (this.carriage) this.carriage.visible = !on;
    this.dirtyRender = true;
  }

  setMachineVisible(v) {
    this.showMachine = v;
    this.machineGroup.visible = v && !this.resultMode;
    // Bordet ska alltid synas
    this.dirtyRender = true;
  }

  setPathsVisible(v) {
    this.showPaths = v;
    this.pathGroup.visible = v && !this.resultMode;
    this.dirtyRender = true;
  }

  setRapidsVisible(v) {
    this.showRapids = v;
    this.applyRapidVisibility();
  }

  // Kameravyer kring ämnet.
  view(name, box) {
    const b = box || this.lastBox;
    if (!b) return;
    this.lastBox = b;
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, cz = (b.z0 + b.z1) / 2;
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0, 40);
    const dist = size * 1.9 + 60;
    const target = new THREE.Vector3(cx, cy, cz);
    let eye;
    if (name === 'top') eye = new THREE.Vector3(cx, cy - 0.001, cz + dist * 1.1);
    else if (name === 'front') eye = new THREE.Vector3(cx, cy - dist, cz + size * 0.15);
    else if (name === 'side') eye = new THREE.Vector3(cx + dist, cy, cz + size * 0.15);
    else eye = new THREE.Vector3(cx + dist * 0.55, cy - dist * 0.8, cz + dist * 0.62);
    this.camera.position.copy(eye);
    this.controls.target.copy(target);
    this.controls.update();
    this.dirtyRender = true;
  }

  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

function lineGeo(arr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  return g;
}

function disposeGroup(group, keep = []) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const o = group.children[i];
    if (keep.includes(o)) continue;
    group.remove(o);
    o.traverse?.((c) => {
      c.geometry?.dispose?.();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => m.dispose());
    });
  }
}
