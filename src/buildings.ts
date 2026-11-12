import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Sci-fi Buildings Pack (CC-BY-4.0, see credits.ts) turned into an instanced, neon-styled skyline.
 * The pack's 12 variants are baked once into a "kit" (shared geometry + materials); each track then only
 * places InstancedMeshes from it. Facades are dark tinted navy/magenta with the texture's bright trim glowing in
 * the instance colour; the (black) window glass is replaced by a procedural grid of lit panes.
 */

const URL = `${import.meta.env.BASE_URL}models/sci-fi_buildings_pack_low-poly_game_ready/scene.gltf`;

/** 0 = low, 1 = mid, 2 = tower; chosen from each variant's height : footprint ratio */
const CLASS_OF: Record<string, 0 | 1 | 2> = {
  Building1: 0, Building1b: 0, Building5: 0, Building5b: 0,
  Building2: 1, Building2b: 1, Building4: 1, Building4b: 1,
  Building3: 2, Building3b: 2, Building6: 2, Building6b: 2,
};
/** window rows per class, matching the old procedural city */
const FLOORS = [6, 14, 26];

export interface Variant {
  name: string;
  cls: 0 | 1 | 2;
  /** source size after baking (x, y, z), footprint centred on the origin, base on y = 0 */
  size: THREE.Vector3;
  baseGeo: THREE.BufferGeometry;
  baseMat: THREE.Material;
  winGeo: THREE.BufferGeometry | null;
  winMat: THREE.Material | null;
}

export interface BuildingKit {
  variants: Variant[];
  byClass: Variant[][];
}

const HASH = /* glsl */ `
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

/** Luminance (0..1) above which ~8% of the texture's pixels lie. */
function brightEdge(map: THREE.Texture) {
  try {
    const img = map.image as CanvasImageSource & { width: number; height: number };
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data;
    const l: number[] = [];
    for (let i = 0; i < d.length; i += 4) l.push((d[i] + d[i + 1] + d[i + 2]) / 765);
    l.sort((a, b) => a - b);
    return Math.min(0.93, l[Math.floor(l.length * 0.92)]);
  } catch {
    return 0.9;
  }
}

/** Dark, tinted facade: texture x instance colour, with the texture's bright trim emitting the (re-saturated) tint. */
function facadeMaterial(map: THREE.Texture | null) {
  const m = new THREE.MeshStandardMaterial({ map, color: 0x4c4c58, roughness: 0.6, metalness: 0.3, envMapIntensity: 0.25 });
  // only the texture's brightest ~8% (panel edges, vents, trim) glows, whatever the variant's overall brightness
  const lo = map ? brightEdge(map) : 0.9;
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `
      #include <emissivemap_fragment>
      #if defined( USE_MAP ) && defined( USE_COLOR )
        float lum = dot(sampledDiffuseColor.rgb, vec3(0.3333));
        vec3 neonTint = vColor / max(max(vColor.r, vColor.g), max(vColor.b, 0.001));
        totalEmissiveRadiance += neonTint * smoothstep(${lo.toFixed(3)}, ${(lo + 0.07).toFixed(3)}, lum) * 0.6;
      #endif
      `,
    );
  };
  return m;
}

/** Unlit window grid: random lit panes in the instance's neon colour, dark glass elsewhere. */
function windowMaterial(floors: number, height: number) {
  const cellH = height / floors;
  const cellW = cellH * 0.8;
  const m = new THREE.MeshBasicMaterial({ toneMapped: false });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLP;\nvarying float vInst;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vLP = position;
        #ifdef USE_INSTANCING
          vInst = float(gl_InstanceID);
        #else
          vInst = 0.0;
        #endif`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLP;\nvarying float vInst;\n${HASH}`)
      .replace('#include <color_fragment>', /* glsl */ `
        vec2 cell = vec2((vLP.x + vLP.z) / ${cellW.toFixed(4)}, vLP.y / ${cellH.toFixed(4)});
        vec2 id = floor(cell);
        vec2 f = fract(cell);
        float r = hash21(id + vInst * 17.31);
        float pane = step(0.14, f.x) * step(f.x, 0.86) * step(0.18, f.y) * step(f.y, 0.82);
        float lit = step(0.6, r) * pane;
        float bright = 0.4 + 0.6 * hash21(id.yx + vInst * 3.7) + step(0.97, r) * 0.45;
        vec3 neon = vColor / max(max(vColor.r, vColor.g), max(vColor.b, 0.001));
        diffuseColor.rgb = mix(vec3(0.012, 0.006, 0.03), neon * bright, lit);
      `);
  };
  return m;
}

let kitLoad: Promise<BuildingKit | null> | null = null;
let kit: BuildingKit | null = null;

/** Synchronous access once loaded (null before / on failure). */
export const buildingKit = () => kit;

/** Load (once) and bake the glTF; resolves null when it can't be loaded. */
export function loadBuildingKit(): Promise<BuildingKit | null> {
  kitLoad ??= new GLTFLoader().loadAsync(URL)
    .then((g) => (kit = bake(g.scene)))
    .catch((e) => { console.warn('Building pack failed to load', e); return null; });
  return kitLoad;
}

function bake(scene: THREE.Object3D): BuildingKit {
  scene.updateMatrixWorld(true);
  const variants: Variant[] = [];
  // GLTFLoader strips '.' from node names; the building roots here have none
  scene.traverse((node) => {
    const cls = CLASS_OF[node.name];
    if (cls === undefined) return;
    const meshes: THREE.Mesh[] = [];
    node.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const geos = meshes.map((m) => m.geometry.clone().applyMatrix4(m.matrixWorld));
    const box = new THREE.Box3();
    for (const g of geos) { g.computeBoundingBox(); box.union(g.boundingBox!); }
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    let baseGeo: THREE.BufferGeometry | null = null, winGeo: THREE.BufferGeometry | null = null;
    let map: THREE.Texture | null = null;
    meshes.forEach((m, i) => {
      geos[i].translate(-c.x, -box.min.y, -c.z);
      const mat = m.material as THREE.MeshStandardMaterial;
      if (/windows/i.test(mat.name)) winGeo = geos[i];
      else { baseGeo = geos[i]; map = mat.map; }
    });
    if (!baseGeo) return;
    variants.push({
      name: node.name, cls, size,
      baseGeo, baseMat: facadeMaterial(map),
      winGeo, winMat: winGeo ? windowMaterial(FLOORS[cls], size.y) : null,
    });
  });
  const byClass: Variant[][] = [[], [], []];
  for (const v of variants) byClass[v.cls].push(v);
  return { variants, byClass };
}
