import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ROAD_HALF, Track } from './track';
import type { Controls } from './input';
import { DEFAULT_SPEC, type CarDef, type CarSpec } from './cars';

export interface CarModel {
  root: THREE.Group;
  flames: THREE.Mesh[];
  underglow: THREE.Mesh;
  thrusterLocal: THREE.Vector3[];
  /** spun around their local x axis with forward speed */
  wheels?: THREE.Object3D[];
  /** wheel radius for spin rate (default 0.43) */
  wheelRadius?: number;
  /** how much the flames widen at full boost (a wide bar flame must not outgrow the body) */
  flameGrowX?: number;
  /** per-frame body animation; `open` 0..1 = how far the rear flaps are raised (brake / lift-off) */
  animate?(dt: number, open: number): void;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
export const GLOW_TEX = glowTexture();

const neon = (c: number, k = 3) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), toneMapped: false });

/** Extrude a side profile (x = forward, y = up) across `width`, centred on the car's x axis. */
function extrudeProfile(s: THREE.Shape, width: number, bevel: boolean) {
  const geo = new THREE.ExtrudeGeometry(s, bevel
    ? { depth: width, bevelEnabled: true, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 3 }
    : { depth: width, bevelEnabled: false });
  geo.rotateY(-Math.PI / 2);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  geo.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
  return geo;
}


// ---- nitro flame: the user's animated GIF, baked to a 10x6 sprite sheet (public/assets/gifs/nitro-boost-sheet.png)
const FLAME_COLS = 10, FLAME_ROWS = 6, FLAME_FPS = 33;
let flameSheet: THREE.Texture | null = null;
function flameTexture() {
  if (!flameSheet) {
    flameSheet = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}assets/gifs/nitro-boost-sheet.png`);
    flameSheet.colorSpace = THREE.SRGBColorSpace;
  }
  return flameSheet;
}

/** Crossed flat + upright quads running from the nozzle (z = 0) back to z = -1; scale.z sets the flame length. */
function makeFlame(width: number, height: number): THREE.Mesh {
  const hw = width / 2, hh = height / 2;
  const v = [
    -hw, 0, 0, hw, 0, 0, hw, 0, -1, -hw, 0, -1, // flat
    0, -hh, 0, 0, hh, 0, 0, hh, -1, 0, -hh, -1, // upright
  ];
  const uv = [0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const map = flameTexture().clone(); // own offset per flame; the image is shared
  map.needsUpdate = true;
  map.repeat.set(1 / FLAME_COLS, 1 / FLAME_ROWS);
  const mat = new THREE.MeshBasicMaterial({
    map, color: new THREE.Color(2.2, 2.2, 2.2), transparent: true, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  return m;
}

/** Advance a model's flame animation to time t (seconds). */
export function animateFlames(flames: THREE.Mesh[], t: number) {
  const f = Math.floor(t * FLAME_FPS) % (FLAME_COLS * FLAME_ROWS);
  const col = f % FLAME_COLS, row = Math.floor(f / FLAME_COLS);
  for (const fl of flames) {
    const map = (fl.material as THREE.MeshBasicMaterial).map;
    if (map) map.offset.set(col / FLAME_COLS, 1 - (row + 1) / FLAME_ROWS);
  }
}

/** Twin rear thrusters with flames; pushes into the model's flame/thruster lists. */
function addThrusters(body: THREE.Group, glowColor: number, z: number, y: number, xs: number[], flames: THREE.Mesh[], thrusterLocal: THREE.Vector3[]) {
  const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 1, roughness: 0.3 });
  for (const sx of xs) {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 0.5, 16, 1, true), nozzleMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(sx, y, z);
    body.add(nozzle);
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.24, 16), neon(0xffffff, 2));
    core.position.set(sx, y, z - 0.01);
    core.rotation.y = Math.PI;
    body.add(core);
    const flame = makeFlame(0.95, 0.95);
    flame.position.set(sx, y, z - 0.15);
    body.add(flame);
    flames.push(flame);
    thrusterLocal.push(new THREE.Vector3(sx, y, z - 0.25));
  }
}

/**
 * Single full-width thruster bar (matches the nose and tail light bars): a recessed slot with a glowing
 * core and one flat flame sheet that tapers to a line. Trails leave from both ends of the bar.
 */
function addThrusterBar(body: THREE.Group, glowColor: number, z: number, y: number, width: number, flames: THREE.Mesh[], thrusterLocal: THREE.Vector3[]) {
  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(width + 0.12, 0.2, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x222233, metalness: 1, roughness: 0.3 }),
  );
  housing.position.set(0, y, z);
  body.add(housing);
  const core = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, 0.02), neon(0xffffff, 2));
  core.position.set(0, y, z - 0.045);
  body.add(core);

  // nitro sprite stretched across the whole bar: one wide horizontal jet
  const hw = width / 2;
  const flame = makeFlame(width, 0.55);
  flame.position.set(0, y, z - 0.05);
  body.add(flame);
  flames.push(flame);
  for (const sx of [hw - 0.1, -(hw - 0.1)]) thrusterLocal.push(new THREE.Vector3(sx, y, z - 0.15));
}

function addHoverPads(body: THREE.Group, glowColor: number, px: number, pz: number) {
  for (const [x, z] of [[px, pz], [-px, pz], [px, -pz], [-px, -pz]]) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.32, 16), neon(glowColor, 2));
    pad.rotation.x = Math.PI / 2;
    pad.position.set(x, 0.06, z);
    body.add(pad);
  }
}

function makeUnderglow(glowColor: number, w = 5.5, l = 8) {
  const underglow = new THREE.Mesh(
    new THREE.PlaneGeometry(w, l),
    new THREE.MeshBasicMaterial({
      map: GLOW_TEX, color: new THREE.Color(glowColor).multiplyScalar(0.6), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  underglow.rotation.x = -Math.PI / 2;
  return underglow;
}

export function makeCarModel(accent = 0xff2bd6, glowColor = 0x22f3ff, paintColor = 0x3a2a66): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // wedge side profile (x = forward, y = up), extruded across the width
  const s = new THREE.Shape();
  s.moveTo(-2.3, 0.15);
  s.lineTo(2.25, 0.12);
  s.lineTo(2.45, 0.32);
  s.lineTo(0.9, 0.62);
  s.lineTo(-0.5, 1.0);
  s.lineTo(-2.0, 0.95);
  s.lineTo(-2.4, 0.55);
  s.closePath();
  const paint = new THREE.MeshStandardMaterial({ color: paintColor, metalness: 0.75, roughness: 0.25 });
  body.add(new THREE.Mesh(extrudeProfile(s, 1.9, true), paint));

  // canopy
  const glass = new THREE.MeshStandardMaterial({
    color: 0x0b3a4a, emissive: new THREE.Color(glowColor), emissiveIntensity: 0.25,
    metalness: 1, roughness: 0.05, transparent: true, opacity: 0.9,
  });
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), glass);
  canopy.scale.set(0.72, 0.42, 1.35);
  canopy.position.set(0, 0.95, -0.15);
  body.add(canopy);

  // side neon strips
  for (const sx of [1, -1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 4.3), neon(accent));
    strip.position.set(sx * 1.08, 0.36, 0);
    body.add(strip);
  }
  // headlight bar
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.06), neon(0xffffff, 2.5));
  head.position.set(0, 0.3, 2.42);
  body.add(head);
  // tail light bar
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.06), neon(accent, 3.5));
  tail.position.set(0, 0.78, -2.47);
  body.add(tail);

  // rear wing
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 0.7), paint);
  wing.position.set(0, 1.35, -2.0);
  body.add(wing);
  const wingEdge = new THREE.Mesh(new THREE.BoxGeometry(2.52, 0.04, 0.05), neon(glowColor));
  wingEdge.position.set(0, 1.4, -2.34);
  body.add(wingEdge);
  for (const sx of [0.7, -0.7]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.3), paint);
    strut.position.set(sx, 1.12, -2.0);
    body.add(strut);
  }

  const flames: THREE.Mesh[] = [];
  const thrusterLocal: THREE.Vector3[] = [];
  addThrusters(body, glowColor, -2.45, 0.5, [0.6, -0.6], flames, thrusterLocal);
  addHoverPads(body, glowColor, 0.8, 1.5);
  const underglow = makeUnderglow(glowColor);
  root.add(underglow);

  return { root, flames, underglow, thrusterLocal };
}

// ---------------------------------------------------------------------------------------------------------
// Cybertruck: glTF model "Fortnite: Cybertruck" by fred346b, CC-BY-4.0 (credit text in credits.ts).
// The model keeps its own details (stainless shell, emissive light bars, interior); the game adds neon
// accent lines, ringed wheels that spin, and the same bar thruster the other cars use.
// ---------------------------------------------------------------------------------------------------------
const TRUCK_URL = `${import.meta.env.BASE_URL}models/fortnite_cybertruck/scene.gltf`;
const TRUCK_LEN = 5.2;                         // game units, nose to tail
const TRUCK_SRC = { zMin: -2.56, zMax: 2.99 }; // model extent along the car after the Sketchfab root rotation (+z = nose)
const TRUCK_SCALE = TRUCK_LEN / (TRUCK_SRC.zMax - TRUCK_SRC.zMin);
/** model-space offset that centres the truck on z and lifts the tyres' underside (y -0.039) to ~0.12 */
const TRUCK_OFFSET = new THREE.Vector3(0, 0.12 / TRUCK_SCALE + 0.039, -(TRUCK_SRC.zMax + TRUCK_SRC.zMin) / 2);
const TRUCK_WHEEL_R = 0.38;
// wheel centres in the glTF's own (pre-rotation) node space: x across, y along the truck (front = negative), z up
const TRUCK_WHEELS = [
  { name: 'twheel0', c: new THREE.Vector3(0.84, -2.135, 0.34) },  // front right
  { name: 'twheel1', c: new THREE.Vector3(-0.84, -2.135, 0.34) }, // front left
  { name: 'twheel2', c: new THREE.Vector3(0.84, 1.41, 0.34) },    // rear right
  { name: 'twheel3', c: new THREE.Vector3(-0.84, 1.41, 0.34) },   // rear left
];
const truckWheelOf = (x: number, y: number) => (y < -0.35 ? 0 : 2) + (x > 0 ? 0 : 1);

/** Split a wheel mesh (all four wheels merged per material) into one geometry per wheel, centred on its axle. */
function splitWheelGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const pos = src.attributes.position;
  const index = src.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const tris: number[][] = [[], [], [], []];
  for (let t = 0; t < triCount; t++) {
    let cx = 0, cy = 0;
    for (let k = 0; k < 3; k++) { cx += pos.getX(vi(t, k)) / 3; cy += pos.getY(vi(t, k)) / 3; }
    tris[truckWheelOf(cx, cy)].push(t);
  }
  return tris.map((list, w) => {
    const remap = new Map<number, number>();
    const order: number[] = [];
    const idx: number[] = [];
    for (const t of list) {
      for (let k = 0; k < 3; k++) {
        const v = vi(t, k);
        let n = remap.get(v);
        if (n === undefined) { n = order.length; remap.set(v, n); order.push(v); }
        idx.push(n);
      }
    }
    const geo = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) {
      const a = src.attributes[name];
      const arr = new Float32Array(order.length * a.itemSize);
      order.forEach((v, i) => {
        arr[i * a.itemSize] = a.getX(v);
        if (a.itemSize > 1) arr[i * a.itemSize + 1] = a.getY(v);
        if (a.itemSize > 2) arr[i * a.itemSize + 2] = a.getZ(v);
        if (a.itemSize > 3) arr[i * a.itemSize + 3] = a.getW(v);
      });
      geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
    }
    geo.setIndex(idx);
    geo.translate(-TRUCK_WHEELS[w].c.x, -TRUCK_WHEELS[w].c.y, -TRUCK_WHEELS[w].c.z);
    return geo;
  });
}

function prepareTruck(scene: THREE.Group): THREE.Group {
  scene.updateMatrixWorld(true);
  const glass = new THREE.MeshStandardMaterial({
    color: 0x06080c, emissive: 0x0a2030, emissiveIntensity: 0.25, metalness: 1, roughness: 0.06,
    transparent: true, opacity: 0.78, depthWrite: false, side: THREE.DoubleSide,
  });
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const pivots = TRUCK_WHEELS.map((w) => {
    const g = new THREE.Group();
    g.name = w.name;
    g.position.copy(w.c);
    return g;
  });
  for (const mesh of meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const n = mat.name;
    mesh.frustumCulled = false;
    if (n === 'Glass' || n === 'Material.007') {
      mesh.material = glass;
    } else if (n === 'Chassis') {
      // stainless: keep the baked texture and its emissive light bars, tone the reflections down so it stays
      // grey under the neon sky instead of blowing out
      mat.envMapIntensity = 0.5;
      mat.color.multiplyScalar(1.55);
      mat.emissiveIntensity = 3;
    } else if (n === 'Interior') {
      mat.envMapIntensity = 0.5;
      mat.emissiveIntensity = 1.5;
    } else if (n === 'Steel' || n === 'TruckBed') {
      mat.envMapIntensity = 0.6;
    }
    if (n === 'Tire' || n === 'material') {
      // every vertex of these meshes belongs to a wheel: split per wheel and hang each piece off its axle pivot
      const parts = splitWheelGeometry(mesh.geometry);
      mat.envMapIntensity = 0.5;
      parts.forEach((geo, w) => {
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        pivots[w].add(m);
      });
      mesh.visible = false;
      mesh.parent!.add(...pivots.filter((p) => !p.parent));
    }
  }
  return scene;
}

let truckLoad: Promise<THREE.Group | null> | null = null;
/** Load (once) and prepare the glTF; resolves null if it can't be loaded. */
function loadTruck(): Promise<THREE.Group | null> {
  truckLoad ??= new GLTFLoader().loadAsync(TRUCK_URL)
    .then((g) => prepareTruck(g.scene))
    .catch((e) => { console.warn('Cybertruck model failed to load', e); return null; });
  return truckLoad;
}

/** Stainless glTF pickup. Returns immediately; the model is attached into the body group once loaded. */
export function makeTruckModel(accent: number, glowColor: number, _paintColor: number): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body); // root.children[0] must stay the body group (driver view hides it)

  const flames: THREE.Mesh[] = [];
  const thrusterLocal: THREE.Vector3[] = [];
  addThrusterBar(body, glowColor, -2.66, 0.42, 1.4, flames, thrusterLocal);
  addHoverPads(body, glowColor, 0.7, 1.75);
  const underglow = makeUnderglow(glowColor, 6, 8.5);
  root.add(underglow);

  const model: CarModel = { root, flames, underglow, thrusterLocal, wheels: [], flameGrowX: 0.05, wheelRadius: TRUCK_WHEEL_R };

  void loadTruck().then((asset) => {
    if (!asset) return;
    const fit = new THREE.Group();
    fit.scale.setScalar(TRUCK_SCALE);
    fit.position.copy(TRUCK_OFFSET).multiplyScalar(TRUCK_SCALE);
    const car = asset.clone(true);
    fit.add(car);
    body.add(fit);

    // neon ring on the outer face of each wheel; the pivots are clones, so rings spin with their wheel
    const ring = neon(glowColor, 2.2);
    TRUCK_WHEELS.forEach((w) => {
      const p = car.getObjectByName(w.name);
      if (!p) return;
      const r = new THREE.Mesh(new THREE.TorusGeometry(TRUCK_WHEEL_R * 0.82, 0.02, 6, 28), ring);
      r.rotation.y = Math.PI / 2;
      r.position.x = Math.sign(w.c.x) * 0.16;
      p.add(r);
      model.wheels!.push(p);
    });

    // thin neon line under each rocker panel, in the car's accent colour (game units, outside the scaled model)
    const line = neon(accent, 1.8);
    for (const sx of [1, -1]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 2.5), line);
      l.position.set(sx * 0.98, 0.27, 0.14);
      body.add(l);
    }
  });

  return model;
}

// ---------------------------------------------------------------------------------------------------------
// Mercedes Vision AVTR: glTF model "2020 | Mercedes AVTR Concept | Thanks 100k wiew" by kevin,
// CC-BY-4.0 (credit text in cars.ts). The rear scale pods are baked into the mesh, so each pod gets an
// overlay lid (hinged at its front edge) plus a red emitter; lids lie shut under power and flare on the brakes.
// ---------------------------------------------------------------------------------------------------------
const AVTR_URL = `${import.meta.env.BASE_URL}models/2020__mercedes_avtr_concept__thanks_100k_wiew/scene.gltf`;
const AVTR_LEN = 5.3;                       // game units, nose to tail
const AVTR_SRC = { zMin: -2.2, zMax: 1.8 }; // model extent along the car (model units, +z = nose)
const AVTR_SCALE = AVTR_LEN / (AVTR_SRC.zMax - AVTR_SRC.zMin);
/** model-space offset that centres the car on z and lifts its underside to y ~ 0.15 */
const AVTR_OFFSET = new THREE.Vector3(0, 0.15 / AVTR_SCALE + 0.01, -(AVTR_SRC.zMax + AVTR_SRC.zMin) / 2);
const AVTR_WHEELS = [
  { name: 'wheel0', c: new THREE.Vector3(0.675, 0.31, 1.25), rims: ['avtr_rim', 'avtr_rim.004', 'avtr_rim.005'] },
  { name: 'wheel1', c: new THREE.Vector3(-0.675, 0.31, 1.25), rims: ['avtr_rim.003', 'avtr_rim.010', 'avtr_rim.011'] },
  { name: 'wheel2', c: new THREE.Vector3(0.675, 0.31, -1.51), rims: ['avtr_rim.001', 'avtr_rim.006', 'avtr_rim.007'] },
  { name: 'wheel3', c: new THREE.Vector3(-0.675, 0.31, -1.51), rims: ['avtr_rim.002', 'avtr_rim.008', 'avtr_rim.009'] },
];

interface AvtrPod { p: THREE.Vector3; n: THREE.Vector3; w: number; l: number; rank: number }
interface AvtrAsset { scene: THREE.Group; pods: AvtrPod[] }

/** Split a mesh into connected pieces (vertices welded by position); returns each piece's world-space bounds. */
function meshPieces(mesh: THREE.Mesh) {
  const geo = mesh.geometry as THREE.BufferGeometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const v = new THREE.Vector3();
  const world: THREE.Vector3[] = [];
  const vid: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const key = `${Math.round(v.x * 500)},${Math.round(v.y * 500)},${Math.round(v.z * 500)}`;
    let id = ids.get(key);
    if (id === undefined) { id = parent.length; parent.push(id); ids.set(key, id); world.push(v.clone()); }
    vid.push(id);
  }
  const tri = idx ? idx.count : pos.count;
  for (let i = 0; i < tri; i += 3) {
    const a = find(vid[idx ? idx.getX(i) : i]);
    for (let k = 1; k < 3; k++) {
      const b = find(vid[idx ? idx.getX(i + k) : i + k]);
      if (a !== b) parent[b] = a;
    }
  }
  const boxes = new Map<number, THREE.Box3>();
  world.forEach((p, i) => {
    const r = find(i);
    let b = boxes.get(r);
    if (!b) boxes.set(r, (b = new THREE.Box3()));
    b.expandByPoint(p);
  });
  return [...boxes.values()];
}

function prepareAvtr(scene: THREE.Group): AvtrAsset {
  scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const matName = (m: THREE.Mesh) => (m.material as THREE.Material).name;

  // ---- materials: keep the model's own look but tame it for the game's neon lighting
  for (const m of meshes) {
    const mat = m.material as THREE.MeshStandardMaterial;
    const n = mat.name;
    mat.envMapIntensity = 0.55;
    if (n.startsWith('avtr_glass')) {
      mat.transparent = true; mat.depthWrite = false; mat.envMapIntensity = 1; mat.roughness = 0.05;
    } else if (n === 'avtr_left_front_light') {
      mat.emissiveIntensity = 2.6; mat.toneMapped = false;
    } else if (n === 'avtr_chrome') {
      mat.envMapIntensity = 0.9;
    }
  }

  // ---- rear pods: one connected piece of the pink "secondary" mesh each
  const pods: AvtrPod[] = [];
  const sec = meshes.find((m) => matName(m) === 'avtr_secondary');
  if (sec) {
    const targets = meshes.filter((m) => !/glass|secondary|rear_light|taillight/.test(matName(m)));
    // the blue "left_front_light" mesh also contains the pods' side slivers: drop those triangles (keep wheels, nose, logo)
    const blue = meshes.find((m) => matName(m) === 'avtr_left_front_light' && m.geometry.attributes.position.count > 10000);
    if (blue) {
      const g = blue.geometry as THREE.BufferGeometry;
      const pa = g.attributes.position, ix = g.index!;
      const keep: number[] = [];
      const v = new THREE.Vector3();
      for (let i = 0; i < ix.count; i += 3) {
        v.set(0, 0, 0);
        for (let k = 0; k < 3; k++) v.add(new THREE.Vector3().fromBufferAttribute(pa, ix.getX(i + k)));
        v.multiplyScalar(1 / 3).applyMatrix4(blue.matrixWorld);
        if (!(v.z < -0.4 && v.z > -1.97 && v.y > 0.55)) keep.push(ix.getX(i), ix.getX(i + 1), ix.getX(i + 2));
      }
      g.setIndex(keep);
    }
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    // each piece is just the pod's -x side wall (a flat hexagon edge, half the pod's length): rebuild the pod from it
    for (const b of meshPieces(sec)) {
      const c = b.getCenter(new THREE.Vector3());
      const sz = b.getSize(new THREE.Vector3());
      if (c.z > -0.45 || Math.abs(c.x) > 0.42 || sz.z < 0.03 || sz.z > 0.3) continue; // rear deck only
      const l = sz.z * 1.5, w = l * 0.6;
      const cx = c.x, cz = b.min.z + l * 0.28;
      ray.set(new THREE.Vector3(cx, 3, cz), down);
      const hit = ray.intersectObjects(targets, false)[0];
      if (!hit || !hit.face) continue;
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      if (n.y < 0.3) continue;
      pods.push({ p: hit.point.clone(), n, w, l, rank: 0 });
    }
    const zs = pods.map((p) => p.p.z);
    const zHi = Math.max(...zs), zLo = Math.min(...zs);
    for (const p of pods) p.rank = (zHi - p.p.z) / Math.max(1e-3, zHi - zLo); // front rows first
  }

  // ---- wheels: re-parent each wheel's rim nodes under a pivot at its centre so they spin around the axle (x)
  for (const w of AVTR_WHEELS) {
    const pivot = new THREE.Group();
    pivot.name = w.name;
    pivot.position.copy(w.c);
    scene.add(pivot);
    pivot.updateMatrixWorld(true);
    for (const name of w.rims) {
      // GLTFLoader strips '.' from node names ("avtr_rim.001" -> "avtr_rim001")
      const node = scene.getObjectByName(name.replace(/\./g, ''));
      if (node) pivot.attach(node);
    }
  }
  return { scene, pods };
}

let avtrLoad: Promise<AvtrAsset | null> | null = null;
/** Load (once) and prepare the glTF; resolves null if it can't be loaded. */
export function loadAvtr(): Promise<AvtrAsset | null> {
  avtrLoad ??= new GLTFLoader().loadAsync(AVTR_URL)
    .then((g) => prepareAvtr(g.scene))
    .catch((e) => { console.warn('AVTR model failed to load', e); return null; });
  return avtrLoad;
}

/**
 * Bionic concept pod. Returns immediately; the glTF is attached into the body group once loaded.
 * Nitro leaves through a full-width bar like the Cybertruck's.
 */
export function makeAvtrModel(accent: number, glowColor: number, _paintColor: number): CarModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body); // root.children[0] must stay the body group (driver view hides it)

  const flames: THREE.Mesh[] = [];
  const thrusterLocal: THREE.Vector3[] = [];
  addThrusterBar(body, glowColor, -2.55, 0.42, 1.3, flames, thrusterLocal);
  addHoverPads(body, glowColor, 0.7, 1.6);
  const underglow = makeUnderglow(glowColor, 5.5, 8.5);
  root.add(underglow);

  const model: CarModel = { root, flames, underglow, thrusterLocal, wheels: [], flameGrowX: 0.05 };

  const redOff = new THREE.Color(0x0c0c12);
  const redOn = new THREE.Color(accent).multiplyScalar(3);
  let open = 0;
  let apply: ((open: number) => void) | null = null;
  model.animate = (_dt, o) => { open = o; apply?.(o); };

  void loadAvtr().then((asset) => {
    if (!asset) return;
    const fit = new THREE.Group();
    fit.scale.setScalar(AVTR_SCALE);
    fit.position.copy(AVTR_OFFSET).multiplyScalar(AVTR_SCALE);
    const car = asset.scene.clone(true);
    // per-instance copies of the materials that animate with the flaps
    const lit: THREE.MeshStandardMaterial[] = [];
    let primary: THREE.Material | null = null;
    car.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.name === 'avtr_primary') primary = mat;
      if (mat.name === 'avtr_secondary' || mat.name === 'avtr_right_rear_light') {
        m.material = mat.clone();
        lit.push(m.material as THREE.MeshStandardMaterial);
      }
    });
    fit.add(car);
    body.add(fit);

    // lids + red emitters over each pod
    const emit = new THREE.MeshBasicMaterial({ color: redOff.clone(), toneMapped: false });
    const lidMat = primary ?? new THREE.MeshStandardMaterial({ color: 0x9aa0aa, metalness: 0.7, roughness: 0.3 });
    const hex = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
    const lids: { hinge: THREE.Object3D; rank: number }[] = [];
    for (const pod of asset.pods) {
      const lw = pod.w / 0.866 * 1.04, ll = pod.l * 1.04;
      const anchor = new THREE.Group();
      anchor.position.copy(pod.p).addScaledVector(pod.n, 0.004);
      anchor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pod.n);
      const disc = new THREE.Mesh(hex, emit);
      disc.scale.set(lw * 0.92, 0.004, ll * 0.92);
      anchor.add(disc);
      const hinge = new THREE.Group();
      hinge.position.z = ll / 2; // hinge on the front (nose side) edge
      const lid = new THREE.Mesh(hex, lidMat);
      lid.scale.set(lw, 0.012, ll);
      lid.position.set(0, 0.012, -ll / 2);
      hinge.add(lid);
      anchor.add(hinge);
      car.add(anchor);
      lids.push({ hinge, rank: pod.rank });
    }

    // wheels (pivots live in the cloned scene)
    for (const w of AVTR_WHEELS) {
      const p = car.getObjectByName(w.name);
      if (p) model.wheels!.push(p);
    }

    let shown = -1;
    apply = (o) => {
      if (Math.abs(o - shown) < 1e-3) return;
      shown = o;
      const k = o * o;
      emit.color.copy(redOff).lerp(redOn, k);
      for (const m of lit) {
        const rear = m.name === 'avtr_right_rear_light';
        m.color.set(0x0c0c12);
        m.emissive.set(accent).multiplyScalar(k * (rear ? 3 : 2.5));
        m.emissiveIntensity = 1;
        m.toneMapped = false;
        if (rear) { m.transparent = true; m.opacity = Math.min(1, o * 1.6); m.depthWrite = false; }
      }
      for (const l of lids) {
        const local = THREE.MathUtils.smoothstep(o * 1.5 - l.rank * 0.5, 0, 1);
        l.hinge.rotation.x = local * 1.05;
      }
    };
    apply(open);
  });

  return model;
}

export function modelFor(def: CarDef): CarModel {
  if (def.body === 'truck') return makeTruckModel(def.accent, def.glow, def.paint);
  if (def.body === 'avtr') return makeAvtrModel(def.accent, def.glow, def.paint);
  return makeCarModel(def.accent, def.glow, def.paint);
}

export interface CarEvents {
  onBoost(tier: number): void;
  onImpact(strength: number): void;
}

const TIERS = [0.7, 1.6, 2.7];
const BOOST_TIME = [0.8, 1.4, 2.2];

export class Car {
  model: CarModel;
  spec: CarSpec = DEFAULT_SPEC;
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector2(); // world (x, z)
  heading = 0;
  trackIdx = -1;
  drifting = false;
  driftDir = 0;
  driftCharge = 0;
  boostTime = 0;
  boost = 0; // smoothed 0..1
  throttle = 0;
  steerVis = 0;
  /** sideways slip speed (u/s), used for drift scoring */
  lateral = 0;
  /** smoothed 0..1: rear flaps raised (braking / lifting off), 0 under power */
  brakeOpen = 0;
  private roll = 0;
  private pitch = 0;
  private prevVf = 0;
  private hoverT = Math.random() * 10;

  private readonly models = new Map<string, CarModel>();

  constructor(private readonly scene: THREE.Scene, accent = 0xff2bd6, glow = 0x22f3ff) {
    this.model = makeCarModel(accent, glow);
    this.model.root.rotation.order = 'YXZ';
    scene.add(this.model.root);
  }

  /** Swap body + handling to another car definition (models are cached per id). */
  setDef(def: CarDef) {
    let m = this.models.get(def.id);
    if (!m) {
      m = modelFor(def);
      m.root.rotation.order = 'YXZ';
      this.models.set(def.id, m);
    }
    this.spec = def.spec;
    if (m === this.model) return;
    const visible = this.model.root.visible;
    this.scene.remove(this.model.root);
    this.model = m;
    m.root.visible = visible;
    this.scene.add(m.root);
    this.syncModel(0);
  }

  /** Swap only the body (rivals keep the default handling); models are cached per id + colours. */
  setBody(def: CarDef) {
    const key = `${def.id}:${def.accent}:${def.glow}`;
    let m = this.models.get(key);
    if (!m) {
      m = modelFor(def);
      m.root.rotation.order = 'YXZ';
      this.models.set(key, m);
    }
    if (m === this.model) return;
    const visible = this.model.root.visible;
    this.scene.remove(this.model.root);
    this.model = m;
    m.root.visible = visible;
    this.scene.add(m.root);
    this.syncModel(0);
  }

  get speed() { return this.vel.length(); }
  get forwardSpeed() { return this.vel.x * Math.sin(this.heading) + this.vel.y * Math.cos(this.heading); }
  get driftTier() {
    let t = 0;
    for (let i = 0; i < TIERS.length; i++) if (this.driftCharge >= TIERS[i]) t = i + 1;
    return t;
  }
  get driftFraction() { return Math.min(1, this.driftCharge / TIERS[2]); }

  /** Boost pad / external boost. Returns true if this started a new boost. */
  padBoost(seconds: number) {
    const fresh = this.boostTime < 0.2;
    this.boostTime = Math.max(this.boostTime, seconds);
    return fresh;
  }

  placeAt(track: Track, idx: number, lat = 0) {
    const k = track.wrap(idx);
    const p = track.pts[k], t = track.tan[k], s = track.side[k];
    this.pos.set(p.x + s.x * lat, 0, p.z + s.z * lat);
    this.heading = Math.atan2(t.x, t.z);
    this.vel.set(0, 0);
    this.trackIdx = k;
    this.drifting = false;
    this.driftCharge = 0;
    this.boostTime = 0;
    this.boost = 0;
    this.brakeOpen = 0;
    this.prevVf = 0;
    this.syncModel(0);
  }

  update(dt: number, c: Controls, track: Track, ev: CarEvents) {
    const h = this.heading;
    const fx = Math.sin(h), fz = Math.cos(h);
    const rx = -Math.cos(h), rz = Math.sin(h);
    let vf = this.vel.x * fx + this.vel.y * fz;
    let vl = this.vel.x * rx + this.vel.y * rz;

    const boosting = this.boostTime > 0;
    const sp = this.spec;
    const maxV = boosting ? sp.boostV : sp.maxV;
    const acc = boosting ? sp.boostAcc : sp.acc;

    // throttle / brake / drag
    if (c.throttle > 0 && vf < maxV) vf += c.throttle * acc * (1 - Math.max(0, vf) / maxV) * dt;
    if (boosting) vf += 30 * dt;
    if (vf > maxV) vf -= (vf - maxV) * 1.2 * dt;
    if (c.brake > 0) {
      if (vf > 1) vf -= c.brake * 85 * dt;
      else vf = Math.max(-22, vf - c.brake * 30 * dt);
    }
    if (c.throttle === 0 && c.brake === 0) vf *= Math.exp(-0.45 * dt);

    // drift state machine: hold drift + steer at speed; release to cash in charge as boost
    if (!this.drifting && c.drift && Math.abs(c.steer) > 0.25 && vf > 22) {
      this.drifting = true;
      this.driftDir = Math.sign(c.steer);
      this.driftCharge = 0;
    }
    if (this.drifting && (!c.drift || vf < 12)) {
      const tier = this.driftTier;
      if (tier > 0 && vf >= 12) {
        this.boostTime = Math.max(this.boostTime, BOOST_TIME[tier - 1]);
        ev.onBoost(tier);
      }
      this.drifting = false;
      this.driftCharge = 0;
    }
    if (this.drifting) this.driftCharge += dt * (0.55 + Math.min(1, Math.abs(vl) / 14));

    // steering
    const speedF = THREE.MathUtils.clamp(vf / 14, -1, 1);
    let turn = this.drifting ? sp.driftTurn : sp.turn;
    turn *= 1 - 0.3 * THREE.MathUtils.clamp(vf / 120, 0, 1);
    const steer = this.drifting ? this.driftDir * 0.6 + c.steer * 0.55 : c.steer;
    this.steerVis = THREE.MathUtils.lerp(this.steerVis, steer, 1 - Math.exp(-10 * dt));

    // lateral grip: low when drifting so the tail slides out
    const grip = this.drifting ? sp.driftGrip : c.brake > 0.5 && vf > 30 ? 4 : sp.grip;
    vl *= Math.exp(-grip * dt);
    this.lateral = vl;

    this.vel.set(fx * vf + rx * vl, fz * vf + rz * vl);
    this.heading += steer * turn * speedF * dt;

    // integrate
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.y * dt;

    // walls
    const n = track.nearest(this.pos.x, this.pos.z, this.trackIdx);
    this.trackIdx = n.idx;
    const limit = ROAD_HALF - 1.3;
    if (Math.abs(n.lat) > limit) {
      const sgn = Math.sign(n.lat);
      const s = track.side[n.idx];
      const over = Math.abs(n.lat) - limit;
      this.pos.x -= s.x * over * sgn;
      this.pos.z -= s.z * over * sgn;
      const nx = s.x * sgn, nz = s.z * sgn;
      const vn = this.vel.x * nx + this.vel.y * nz;
      if (vn > 0) {
        this.vel.x -= nx * vn * 1.35;
        this.vel.y -= nz * vn * 1.35;
        this.vel.multiplyScalar(1 - Math.min(0.2, vn * 0.008));
        if (vn > 4) ev.onImpact(vn);
      }
    }

    this.boostTime = Math.max(0, this.boostTime - dt);
    this.boost = THREE.MathUtils.lerp(this.boost, boosting ? 1 : 0, 1 - Math.exp(-6 * dt));
    this.throttle = c.throttle;
    // flaps: shut under power / boost, flared on the brakes, half-open while coasting down
    const openTarget = c.brake > 0 && vf > 1 ? 1 : c.throttle > 0 || boosting ? 0 : vf > 5 ? 0.6 : 0;
    this.brakeOpen = THREE.MathUtils.lerp(this.brakeOpen, openTarget, 1 - Math.exp(-(openTarget > this.brakeOpen ? 14 : 7) * dt));

    const accel = (vf - this.prevVf) / Math.max(dt, 1e-4);
    this.prevVf = vf;
    this.roll = THREE.MathUtils.lerp(this.roll, -this.steerVis * 0.16 - vl * 0.006, 1 - Math.exp(-8 * dt));
    this.pitch = THREE.MathUtils.lerp(this.pitch, THREE.MathUtils.clamp(-accel * 0.0018, -0.06, 0.08), 1 - Math.exp(-5 * dt));
    this.syncModel(dt);
  }

  private syncModel(dt: number) {
    this.hoverT += dt;
    const m = this.model;
    const y = 0.7 + Math.sin(this.hoverT * 3.2) * 0.07;
    m.root.position.set(this.pos.x, y, this.pos.z);
    m.root.rotation.set(this.pitch, this.heading, this.roll);
    m.underglow.position.y = -y + 0.06;
    m.underglow.rotation.set(-Math.PI / 2 - this.pitch, 0, 0);
    const flicker = 0.8 + Math.random() * 0.4;
    const len = (0.9 + this.throttle * 1.6 + this.boost * 4.2) * flicker;
    animateFlames(m.flames, this.hoverT * 1.0);
    for (const f of m.flames) {
      f.scale.set(1 + this.boost * (m.flameGrowX ?? 0.6), 1 + this.boost * 0.6, len);
    }
    m.animate?.(dt, this.brakeOpen);
    if (m.wheels) for (const w of m.wheels) w.rotation.x += this.forwardSpeed * dt / (m.wheelRadius ?? 0.43);
  }
}
