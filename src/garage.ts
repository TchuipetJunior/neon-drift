import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { animateFlames, modelFor, type CarModel } from './car';
import { BUILDINGS_CREDIT, GARAGE_CREDIT } from './credits';
import { CARS, carById } from './cars';
import type { Controls } from './input';

export interface GarageCallbacks {
  pick(id: string): void;
  go(): void;
  back(): void;
}

/** Camera presets as (azimuth around the car, polar angle from straight up, distance). Car nose points +z. */
const VIEWS = [
  { id: 'hero', label: '3/4', theta: Math.PI * 0.27, phi: 1.22, r: 9.5 },
  { id: 'front', label: 'FRONT', theta: 0, phi: 1.38, r: 8.5 },
  { id: 'side', label: 'SIDE', theta: Math.PI / 2, phi: 1.45, r: 9.5 },
  { id: 'rear', label: 'REAR', theta: Math.PI, phi: 1.3, r: 8.5 },
  { id: 'rear34', label: 'REAR 3/4', theta: -Math.PI * 0.75, phi: 1.2, r: 9.5 },
  { id: 'top', label: 'TOP', theta: Math.PI / 2, phi: 0.02, r: 11 },
  { id: 'low', label: 'LOW', theta: Math.PI * 0.18, phi: 1.6, r: 6.5 },
] as const;

const TARGET = new THREE.Vector3(0, 1.0, 0);
const HOVER_Y = 0.75;
const GARAGE_URL = `${import.meta.env.BASE_URL}models/car_garage__desert_garage_environment/scene.gltf`;
/** the glTF room is ~16 m wide; scale it up so the camera presets (r up to 11) stay inside the walls */
const GARAGE_SCALE = 1.5;
const IDLE_SPIN_DELAY = 4; // seconds of no input before the camera starts circling again

const $ = (id: string) => document.getElementById(id)!;

export class Garage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 400);
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly root = $('garage');
  private readonly stand = new THREE.Group(); // holds the car on the turntable
  private readonly models = new Map<string, CarModel>();
  private readonly ring: THREE.Mesh;
  /** procedural backdrop (grid + light columns) shown until / unless the garage model loads */
  private readonly legacy = new THREE.Group();
  private floor!: THREE.Mesh;
  /** roof slabs + hanging lamp: hidden while the camera is above them (top view) */
  private readonly roof: THREE.Object3D[] = [];
  private current: CarModel | null = null;
  private carId = CARS[0].id;
  private view = 0;
  private idle = 0;
  private t = 0;
  private drop = 0; // car-swap drop-in animation, 1 -> 0
  private tween: { from: THREE.Spherical; to: THREE.Spherical; k: number } | null = null;
  private visible = false;

  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly cb: GarageCallbacks) {
    this.buildShowroom();
    this.loadGarage();

    this.camera.position.setFromSpherical(this.spherical(VIEWS[0])).add(TARGET);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    const c = this.controls;
    c.target.copy(TARGET);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = 3.2;
    c.maxDistance = 11.5;   // stay inside the garage walls
    c.minPolarAngle = 0.01;      // straight down from above
    c.maxPolarAngle = 1.66;      // a touch below the car's mid-line for low shots
    c.screenSpacePanning = true;
    c.autoRotateSpeed = 0.9;
    c.enabled = false;
    c.addEventListener('start', () => { this.idle = 0; this.tween = null; c.autoRotate = false; });
    c.update();

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.8));
    this.composer.addPass(new OutputPass());

    this.ring = this.scene.getObjectByName('ring') as THREE.Mesh;

    // ---- UI
    $('gEnvCredit').textContent = `${GARAGE_CREDIT}
${BUILDINGS_CREDIT}`;
    $('gPrev').addEventListener('click', () => this.cycle(-1));
    $('gNext').addEventListener('click', () => this.cycle(1));
    $('gBack').addEventListener('click', () => this.cb.back());
    // keyboard "clicks" (detail 0) are ignored: Enter is handled by the game input instead
    $('gGo').addEventListener('click', (e) => { if (e.detail !== 0) this.cb.go(); });
    const views = $('gViews');
    VIEWS.forEach((v, i) => {
      const b = document.createElement('button');
      b.className = 'vbtn';
      b.textContent = v.label;
      b.addEventListener('click', () => this.setView(i));
      views.appendChild(b);
    });

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.composer.setSize(innerWidth, innerHeight);
    });
  }

  private buildShowroom() {
    const s = this.scene;
    s.background = new THREE.Color(0x06030c);
    s.fog = new THREE.Fog(0x06030c, 18, 48);
    // neutral studio reflections so paint reads as its true colour
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    s.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    s.environmentIntensity = 0.4;
    pmrem.dispose();

    s.add(new THREE.HemisphereLight(0xdfe6ff, 0x120818, 0.3));
    const key = new THREE.DirectionalLight(0xffffff, 0.95);
    key.position.set(6, 10, 7);
    s.add(key);
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.3);
    fill.position.set(-8, 5, -4);
    s.add(fill);
    for (const [x, z, col] of [[-6, 4, 0xff2bd6], [6, -5, 0x22f3ff]] as const) {
      const l = new THREE.PointLight(col, 22, 16, 2);
      l.position.set(x, 2.5, z);
      s.add(l);
    }

    // floor: dark glossy concrete with a faint polar grid
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(60, 64),
      new THREE.MeshStandardMaterial({ color: 0x0b0814, metalness: 0.5, roughness: 0.45 }),
    );
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    this.floor = floor;
    s.add(this.legacy);
    const grid = new THREE.PolarGridHelper(26, 16, 10, 64, 0x3a1a5a, 0x241038);
    grid.position.y = 0.005;
    this.legacy.add(grid);

    // turntable with neon rings
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(4.2, 4.4, 0.16, 72),
      new THREE.MeshStandardMaterial({ color: 0x17141f, metalness: 0.85, roughness: 0.3 }),
    );
    table.position.y = 0.08;
    s.add(table);
    const neon = (c: number, k: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.035, 8, 128), neon(0x22f3ff, 2.4));
    ring.name = 'ring';
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.17;
    s.add(ring);
    const inner = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.02, 8, 128), neon(0xff2bd6, 2));
    inner.rotation.x = Math.PI / 2;
    inner.position.y = 0.17;
    s.add(inner);

    // tall light columns around the room, alternating pink / cyan
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.18, 7, 0.18), neon(i % 2 ? 0x22f3ff : 0xff2bd6, 1.6));
      col.position.set(Math.sin(a) * 17, 3.5, Math.cos(a) * 17);
      this.legacy.add(col);
    }

    this.stand.position.y = HOVER_Y;
    s.add(this.stand);
  }

  /**
   * Load the glTF garage and neonise it: wall/prop textures stay (they carry the details) but are tinted
   * purple/navy with a faint emissive copy of themselves, painted metal becomes magenta/cyan neon, the lamp
   * strips glow, the floor turns glossy. Falls back to the procedural showroom on failure.
   */
  private loadGarage() {
    new GLTFLoader().loadAsync(GARAGE_URL).then((g) => {
      const room = g.scene;
      room.scale.setScalar(GARAGE_SCALE);
      room.updateMatrixWorld(true);
      this.neonise(room);
      this.scene.add(room);
      this.legacy.visible = false;
      this.floor.position.y = -0.03; // keep it from z-fighting with the garage floor
      (this.floor.material as THREE.MeshStandardMaterial).envMapIntensity = 0.05; // outside the open front it must not mirror the bright studio env
      this.scene.fog = new THREE.Fog(0x06030c, 30, 80);
      this.addStrips();
      // the studio key/fill lights were tuned for the bare floor: tame them so the garage walls stay moody
      this.scene.traverse((o) => { if (o instanceof THREE.DirectionalLight) o.intensity *= 0.55; });
    }).catch((e) => console.warn('Garage model failed to load, using the procedural showroom', e));
  }

  private neonise(room: THREE.Object3D) {
    const tint = (m: THREE.MeshStandardMaterial, col: number, glow: number, k: number, keepMap = true) => {
      m.color.set(col);
      m.emissive.set(glow).multiplyScalar(k);
      m.emissiveMap = keepMap ? m.map : null;
      if (!keepMap) m.map = null;
      m.metalness = Math.max(m.metalness, 0.15);
      m.needsUpdate = true;
    };
    const done = new Set<THREE.Material>();
    room.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const m = o.material as THREE.MeshStandardMaterial;
      const n = m.name;
      if (!done.has(m)) {
        done.add(m);
        m.envMapIntensity = 0.6;
        if (n === 'Light') {
          m.map = null; m.color.set(0x000000);
          m.emissive.set(o.name.includes('Cylinder005') ? 0xff2bd6 : 0x22f3ff).multiplyScalar(3);
          m.toneMapped = false;
        } else if (n === 'YellowMetal') tint(m, 0x2a1840, 0xff2bd6, 0.28, false);
        else if (n === 'rEDmETAL.001') tint(m, 0x14283c, 0x22f3ff, 0.28, false);
        else if (n === 'Wires') { m.color.set(0x07040d); m.emissive.set(0x22f3ff).multiplyScalar(0.25); }
        else if (n === 'Material.001') { // floor
          m.color.set(0x241a3a); m.emissive.set(0x1a1030).multiplyScalar(0.4); m.emissiveMap = m.map;
          m.metalness = 0.5; m.roughness = 0.3; m.envMapIntensity = 0.3;
        } else if (n === 'wALL') tint(m, 0x4b3d78, 0x7a5cff, 0.28);
        else if (n === 'WoodenTable') tint(m, 0x3a2f5c, 0x5a3cff, 0.16);
        else if (n === 'ImageTexture') tint(m, 0x2f5f8f, 0x22f3ff, 0.1);
        else tint(m, 0x7f7bb8, 0x6a4cff, 0.22); // posters, props, screens, shelves
      }
      // ceiling slabs and the hanging lamp would sit between the camera and the car in the top view
      const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      const sz = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
      if (c.y > 7 && sz.x > 6 && sz.z > 5 && sz.y < 4) this.roof.push(o);
    });
  }

  /** Neon edge lighting along the garage's walls (kept clear of the props on the left wall). */
  private addStrips() {
    const neon = (c: number, k: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), toneMapped: false });
    const H = 7.6 * GARAGE_SCALE; // half-width of the room
    const strip = (w: number, d: number, x: number, y: number, z: number, col: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, d), neon(col, 2.2));
      m.position.set(x, y, z);
      this.scene.add(m);
      return m;
    };
    // floor-level glow along the back and right walls, a cyan run higher on the back wall
    strip(2 * H, 0.08, 0, 0.1, -H, 0xff2bd6);
    strip(0.08, 2 * H, H, 0.1, 0, 0xff2bd6);
    strip(2 * H, 0.08, 0, 5.2, -H, 0x22f3ff);
    strip(0.08, 2 * H, H, 5.2, 0, 0x22f3ff);
    for (const [x, z, col] of [[0, -H + 1, 0xff2bd6], [H - 1, 0, 0x22f3ff]] as const) {
      const l = new THREE.PointLight(col, 40, 22, 2);
      l.position.set(x, 4, z);
      this.scene.add(l);
    }
  }

  private spherical(v: { theta: number; phi: number; r: number }) {
    return new THREE.Spherical(v.r, v.phi, v.theta);
  }

  private model(id: string) {
    let m = this.models.get(id);
    if (!m) {
      m = modelFor(carById(id));
      m.underglow.position.y = -HOVER_Y + 0.2;
      for (const f of m.flames) f.scale.set(1, 1, 0.45);
      this.models.set(id, m);
    }
    return m;
  }

  private setCar(id: string, animate: boolean) {
    this.carId = id;
    const m = this.model(id);
    if (this.current !== m) {
      if (this.current) this.stand.remove(this.current.root);
      this.stand.add(m.root);
      this.current = m;
      if (animate) this.drop = 1;
    }
    const def = carById(id);
    const idx = CARS.indexOf(def);
    $('gName').textContent = def.name;
    $('gCount').textContent = `${idx + 1} / ${CARS.length}`;
    $('gBlurb').textContent = def.blurb;
    $('gCredit').textContent = def.credit ?? '';
    $('gCredit').classList.toggle('hidden', !def.credit);
    const bar = (label: string, n: number) =>
      `<span class="stat"><b>${label}</b><i>${'<u class="on"></u>'.repeat(n)}${'<u></u>'.repeat(5 - n)}</i></span>`;
    const st = def.stats;
    $('gStats').innerHTML = bar('SPEED', st.speed) + bar('ACCEL', st.accel) + bar('GRIP', st.grip) + bar('MASS', st.mass);
    (this.ring.material as THREE.MeshBasicMaterial).color.set(def.glow).multiplyScalar(2.4);
  }

  private cycle(dir: number) {
    const i = CARS.findIndex((c) => c.id === this.carId);
    const next = CARS[(i + dir + CARS.length) % CARS.length].id;
    this.setCar(next, true);
    this.cb.pick(next);
    this.idle = 0;
  }

  /** Glide the camera to a preset; the user can grab it again at any point. */
  setView(i: number) {
    this.view = (i + VIEWS.length) % VIEWS.length;
    const from = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const to = this.spherical(VIEWS[this.view]);
    // take the short way round
    while (to.theta - from.theta > Math.PI) to.theta -= Math.PI * 2;
    while (to.theta - from.theta < -Math.PI) to.theta += Math.PI * 2;
    this.tween = { from, to, k: 0 };
    this.controls.autoRotate = false;
    this.idle = 0;
    document.querySelectorAll('#gViews .vbtn').forEach((b, j) => b.classList.toggle('on', j === this.view));
  }

  show(carId: string, goLabel: string) {
    this.visible = true;
    this.root.classList.remove('hidden');
    $('gGo').textContent = goLabel;
    this.setCar(carId, false);
    this.controls.target.copy(TARGET);
    this.camera.position.setFromSpherical(this.spherical(VIEWS[0])).add(TARGET);
    this.setView(0);
    this.tween = null;
    document.querySelectorAll('#gViews .vbtn').forEach((b, j) => b.classList.toggle('on', j === 0));
    this.controls.enabled = true;
    this.controls.update();
  }

  hide() {
    this.visible = false;
    this.root.classList.add('hidden');
    this.controls.enabled = false;
    this.controls.autoRotate = false;
  }

  get shown() { return this.visible; }

  update(dt: number, c: Controls) {
    this.t += dt;
    if (c.navX) this.cycle(c.navX);
    if (c.navY) this.setView(this.view + c.navY);

    // gamepad right stick orbits / zooms
    const pad = navigator.getGamepads?.().find((p) => p && p.connected);
    if (pad) {
      const rx = pad.axes[2] ?? 0, ry = pad.axes[3] ?? 0;
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
      if (dz(rx) || dz(ry)) {
        const sph = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
        sph.theta -= dz(rx) * 2.2 * dt;
        sph.phi = THREE.MathUtils.clamp(sph.phi + dz(ry) * 1.5 * dt, this.controls.minPolarAngle, this.controls.maxPolarAngle);
        this.camera.position.setFromSpherical(sph).add(this.controls.target);
        this.tween = null;
        this.controls.autoRotate = false;
        this.idle = 0;
      }
    }

    if (this.tween) {
      const tw = this.tween;
      tw.k = Math.min(1, tw.k + dt / 0.9);
      const e = tw.k < 0.5 ? 4 * tw.k ** 3 : 1 - (-2 * tw.k + 2) ** 3 / 2;
      const sph = new THREE.Spherical(
        THREE.MathUtils.lerp(tw.from.radius, tw.to.radius, e),
        THREE.MathUtils.lerp(tw.from.phi, tw.to.phi, e),
        THREE.MathUtils.lerp(tw.from.theta, tw.to.theta, e),
      );
      this.controls.target.lerp(TARGET, e);
      this.camera.position.setFromSpherical(sph).add(this.controls.target);
      if (tw.k >= 1) this.tween = null;
    } else {
      this.idle += dt;
      // resume a slow showroom spin after a while, except in the top-down view
      if (this.idle > IDLE_SPIN_DELAY && VIEWS[this.view].id !== 'top') this.controls.autoRotate = true;
    }
    this.controls.update(dt);
    const roofOn = this.camera.position.y < 7;
    for (const r of this.roof) r.visible = roofOn;
    // keep the pan target near the car and the camera above the floor
    this.controls.target.clampLength(0, 3.5);
    if (this.camera.position.y < 0.25) this.camera.position.y = 0.25;

    // car hover + drop-in on swap
    this.drop = Math.max(0, this.drop - dt * 2.5);
    const d = this.drop * this.drop;
    this.stand.position.y = HOVER_Y + Math.sin(this.t * 2.4) * 0.05 + d * 2.2;
    this.stand.rotation.y = d * 0.6;
    if (this.current) {
      const flicker = 0.4 + Math.random() * 0.12;
      for (const f of this.current.flames) f.scale.z = flicker;
      animateFlames(this.current.flames, this.t);
      this.current.underglow.position.y = -this.stand.position.y + 0.2;
      // showroom demo of the rear flaps: slowly breathe open and shut
      this.current.animate?.(dt, 0.5 - 0.5 * Math.cos(this.t * 0.9));
    }
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
