// Boulders of the site and the loose stones around the crew.
//
// Shapes: an icosphere pushed out with 3D noise and then cut by a few random
// planes, which gives the flat faces and worn edges of fractured rock; the
// bottom is flattened and buried. Surface: baked stone texture projected from
// three sides (no stretching), airfall dust on the faces that look up and in
// the pits, soil banked against the foot, and a darker contact line so the
// rock sits IN the ground instead of on it.
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three-stdlib';
import { BASE_A, HALF, ROCKS, heightAt, normalAt, sandAt } from '../../lib/terrain';
import { mulberry32 } from '../../lib/noise';
import { rt } from '../../store/simEngine';
import { GROUND_COLORS, detailTextures } from '../../render/groundMaterial';
import { addMarsFog } from '../../render/marsFog';
import { Q, tier } from '../../render/quality';
import type { Caster } from '../../render/shadeBake';

// --- 3D value noise ---------------------------------------------------------
function hash3(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise3(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const f = (t: number) => t * t * (3 - 2 * t);
  const u = f(x - xi), v = f(y - yi), w = f(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u), l(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u), v),
    l(l(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u), l(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}
function fbm3(x: number, y: number, z: number, oct: number) {
  let s = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) {
    s += noise3(x, y, z) * a;
    n += a;
    a *= 0.5;
    x *= 2.03; y *= 2.03; z *= 2.03;
  }
  return s / n;
}

/**
 * A boulder about one unit in radius, flat and buried below y = −0.25 (the ground line).
 * `kind` picks the family: 0 blocky fractured rock, 1 layered slab, 2 rounded, wind-worn boulder.
 */
export function makeRockGeometry(seed: number, detail: number, kind = seed % 3): THREE.BufferGeometry {
  const rng = mulberry32(seed * 7919 + 13);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  const ox = rng() * 50, oy = rng() * 50, oz = rng() * 50;
  // Fracture planes. Blocky rocks get many deep cuts; slabs get bedding planes (flat top, stepped sides).
  const planes: [number, number, number, number][] = [];
  const count = kind === 2 ? 3 + Math.floor(rng() * 3) : 8 + Math.floor(rng() * 6);
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const y = kind === 1 ? (rng() - 0.5) * 0.35 : -0.3 + rng() * 1.25;
    const h = Math.sqrt(Math.max(0, 1 - Math.min(1, y) ** 2));
    const n = new THREE.Vector3(Math.cos(a) * h, Math.min(1, y), Math.sin(a) * h).normalize();
    planes.push([n.x, n.y, n.z, (kind === 2 ? 0.7 : 0.5) + rng() * 0.36]);
  }
  if (kind === 1) {
    const tilt = new THREE.Vector3((rng() - 0.5) * 0.3, 1, (rng() - 0.5) * 0.3).normalize();
    planes.push([tilt.x, tilt.y, tilt.z, 0.3 + rng() * 0.16]);
  }
  const cut = kind === 2 ? 0.6 : 0.86;
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const r = 0.8 + 0.42 * fbm3(v.x * 1.3 + ox, v.y * 1.3 + oy, v.z * 1.3 + oz, 3) + 0.08 * fbm3(v.x * 4.2 + oz, v.y * 4.2 + ox, v.z * 4.2 + oy, 2);
    v.multiplyScalar(r);
    for (const [nx, ny, nz, o] of planes) {
      const t = v.x * nx + v.y * ny + v.z * nz - o;
      if (t > 0) v.addScaledVector(_n.set(nx, ny, nz), -t * cut);
    }
    if (kind === 1) {
      // Bedding: the sides step in and out along thin layers.
      const layer = Math.sin(v.y * 26 + ox) * 0.5 + 0.5;
      const k = 1 + 0.045 * (layer > 0.55 ? 1 : -1) * Math.min(1, Math.hypot(v.x, v.z) * 2);
      v.x *= k;
      v.z *= k;
    }
    // Faces are never truly flat: a slow warp after the cuts, then small-scale chipping.
    v.multiplyScalar(1 + 0.16 * (fbm3(v.x * 2.1 + oy, v.y * 2.1 + oz, v.z * 2.1 + ox, 2) - 0.5) + 0.05 * (noise3(v.x * 9 + ox, v.y * 9 + oy, v.z * 9 + oz) - 0.5));
    if (v.y > 0) v.y *= kind === 1 ? 0.62 : 0.8; // squat: wider than tall
    if (v.y < -0.5) v.y = -0.5 - (-0.5 - v.y) * 0.12; // flat, buried base
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // Bring every variant back to about one unit across.
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const k = 2 / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
  g.scale(k, Math.min(1.25, k), k);
  // Hard edges where the fracture faces meet, smooth shading within each face.
  g = toCreasedNormals(g, kind === 2 ? 1.0 : 0.7);
  g.computeBoundingSphere();
  return g;
}
const _n = new THREE.Vector3();

export interface RockMaterialOptions {
  /** Loose stones: smaller texture scale and a shrink-to-nothing ring at the edge of the populated area. */
  clutter?: boolean;
}

export const clutterUniforms = { uClutterFocus: { value: new THREE.Vector3() }, uClutterRadius: { value: Q.clutterRadius } };

export function makeRockMaterial({ clutter = false }: RockMaterialOptions = {}) {
  const tex = detailTextures();
  const normalMaps = tier !== 'low';
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.93, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    addMarsFog(shader);
    Object.assign(shader.uniforms, { uStoneN: { value: tex.stoneN }, uStoneA: { value: tex.stoneA } }, clutter ? clutterUniforms : {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRockPos; varying float vRockY;\n${clutter ? 'uniform vec3 uClutterFocus; uniform float uClutterRadius;' : ''}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRockY = position.y;
${
  clutter
    ? `#ifdef USE_INSTANCING
  float dEdge = distance(instanceMatrix[3].xz, uClutterFocus.xz);
  transformed *= 1.0 - smoothstep(uClutterRadius * 0.70, uClutterRadius * 0.97, dEdge);
#endif`
    : ''
}`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
#ifdef USE_INSTANCING
  vRockPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vRockPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vRockPos; varying float vRockY;
uniform sampler2D uStoneN; uniform sampler2D uStoneA;
${GROUND_COLORS}
vec3 rockPerturb = vec3(0.0); float rockAo = 1.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 nW = normalize(inverseTransformDirection(normalize(vNormal), viewMatrix));
  vec3 bw = pow(abs(nW), vec3(4.0));
  bw /= bw.x + bw.y + bw.z;
  float S = ${clutter ? '2.6' : '0.95'};
  vec2 uvx = vRockPos.zy * S; vec2 uvy = vRockPos.xz * S; vec2 uvz = vRockPos.xy * S;
  vec3 a = texture2D(uStoneA, uvx).rgb * bw.x + texture2D(uStoneA, uvy).rgb * bw.y + texture2D(uStoneA, uvz).rgb * bw.z;
${
  normalMaps
    ? `  // The same texture four times larger: lumps and tonal bands you can see from across the site.
  vec3 big = texture2D(uStoneN, uvx * 0.23).rgb * bw.x + texture2D(uStoneN, uvy * 0.23).rgb * bw.y + texture2D(uStoneN, uvz * 0.23).rgb * bw.z;
  diffuseColor.rgb *= (0.42 + 0.98 * a.r) * (0.78 + 0.5 * big.z);`
    : `  diffuseColor.rgb *= 0.42 + 0.98 * a.r;`
}
  // Airfall dust settles on what faces the sky and in the pits; wind keeps the steep faces clean.
  float dust = smoothstep(0.30, 0.86, nW.y + (a.b - 0.25) * 0.55) * ${clutter ? '0.62' : '0.78'};
  // Soil banked against the foot of the rock.
  float foot = smoothstep(${clutter ? '-0.05' : '0.02'}, -0.24, vRockY);
  dust = max(dust, foot * 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, C_DUST * (0.62 + 0.62 * a.r), dust);
  rockAo = a.g * mix(0.50, 1.0, smoothstep(-0.30, 0.10, vRockY));
${
  normalMaps
    ? `  float camD = distance(cameraPosition, vRockPos);
  float nw = (1.0 - smoothstep(18.0, 60.0, camD)) * 1.1;
  vec2 tx = (texture2D(uStoneN, uvx).xy - 0.5) * 2.0; vec2 ty = (texture2D(uStoneN, uvy).xy - 0.5) * 2.0; vec2 tz = (texture2D(uStoneN, uvz).xy - 0.5) * 2.0;
  rockPerturb = (vec3(0.0, tx.y, tx.x) * bw.x + vec3(ty.x, 0.0, ty.y) * bw.y + vec3(tz.x, tz.y, 0.0) * bw.z) * nw;
  vec2 bx = (texture2D(uStoneN, uvx * 0.23).xy - 0.5) * 2.0; vec2 by = (texture2D(uStoneN, uvy * 0.23).xy - 0.5) * 2.0; vec2 bz = (texture2D(uStoneN, uvz * 0.23).xy - 0.5) * 2.0;
  rockPerturb += (vec3(0.0, bx.y, bx.x) * bw.x + vec3(by.x, 0.0, by.y) * bw.y + vec3(bz.x, bz.y, 0.0) * bw.z) * 0.9 * (1.0 - smoothstep(60.0, 160.0, camD));`
    : ''
}
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
normal = normalize(normal + (viewMatrix * vec4(rockPerturb, 0.0)).xyz);`,
      )
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= rockAo; reflectedLight.directDiffuse *= mix(1.0, rockAo, 0.35);');
  };
  mat.customProgramCacheKey = () => `mars-rock-${clutter}-${normalMaps}`;
  return mat;
}

// Shared by the site boulders and the hazard rock fields.
const VARIANTS = 6;
let variants: { hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }[] | null = null;
export function rockVariants() {
  variants ??= Array.from({ length: VARIANTS }, (_, i) => ({ hi: makeRockGeometry(i + 1, Q.rockDetail), lo: makeRockGeometry(i + 1, Math.max(2, Q.rockDetail - 2)) }));
  return variants;
}
let sharedRockMat: THREE.MeshStandardMaterial | null = null;
export const rockMaterial = () => (sharedRockMat ??= makeRockMaterial());

// Tints: dark basalt blocks, brown sandstone, light mudstone.
const TINTS = [
  [0.27, 0.215, 0.18],
  [0.34, 0.255, 0.185],
  [0.215, 0.18, 0.16],
  [0.4, 0.3, 0.21],
  [0.3, 0.23, 0.17],
];

export interface RockLike {
  x: number;
  z: number;
  s: number;
  sy?: number;
  rot: number;
}

const BIG = 0.8; // boulders at least this size get the detailed mesh

/** Instanced boulders: `rocks` are world positions and sizes (the same ones the planner avoids). */
export function RockInstances({ rocks, version }: { rocks: RockLike[]; version: number | string }) {
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);
  const geos = rockVariants();
  const mat = rockMaterial();
  const groups = useMemo(() => {
    const out: RockLike[][] = Array.from({ length: VARIANTS * 2 }, () => []);
    rocks.forEach((r, i) => out[(i % VARIANTS) * 2 + (r.s >= BIG ? 0 : 1)].push(r));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rocks, version]);

  useLayoutEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const c = new THREE.Color();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    groups.forEach((list, gi) => {
      const mesh = refs.current[gi];
      if (!mesh) return;
      list.forEach((r, i) => {
        const sy = r.sy ?? 0.8;
        const k = hash3(Math.round(r.x * 10), 7, Math.round(r.z * 10));
        e.set((k - 0.5) * 0.3, r.rot, (hash3(Math.round(r.x * 10), 3, Math.round(r.z * 10)) - 0.5) * 0.3);
        q.setFromEuler(e);
        pos.set(r.x, heightAt(r.x, r.z) + r.s * sy * 0.25, r.z);
        scl.set(r.s, r.s * sy, r.s * 0.9);
        mesh.setMatrixAt(i, m.compose(pos, q, scl));
        const t = TINTS[Math.floor(k * TINTS.length) % TINTS.length];
        const v = 0.85 + 0.3 * hash3(Math.round(r.z * 10), 11, Math.round(r.x * 10));
        mesh.setColorAt(i, c.setRGB(t[0] * v, t[1] * v, t[2] * v));
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    });
  }, [groups]);

  return (
    <>
      {groups.map((list, gi) => (
        <instancedMesh
          key={`${gi}-${list.length}`}
          ref={(mm) => (refs.current[gi] = mm)}
          args={[gi % 2 === 0 ? geos[gi >> 1].hi : geos[gi >> 1].lo, mat, Math.max(1, list.length)]}
          castShadow
          receiveShadow
        />
      ))}
    </>
  );
}

/** What the boulders shadow on the ground, for the baked light of the far field. */
export function rockCasters(rocks: RockLike[] = ROCKS): Caster[] {
  return rocks.map((r) => ({ x: r.x, z: r.z, r: r.s * 0.92, h: r.s * (r.sy ?? 0.8) }));
}

export function Rocks({ version }: { version: number }) {
  return <RockInstances rocks={ROCKS} version={version} />;
}

// ---------------------------------------------------------------------------
// Loose stones: thousands of small rocks kept in a disc around the crew. The
// layout is a pure function of the position (hashed grid), so both devices see
// the same stones and they are still there when you walk back.
// ---------------------------------------------------------------------------
const CELL = 1.3;
const PER_CELL = 5;

export function Clutter({ version }: { version: number }) {
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  // Angular fragments and flat slabs, like the float rocks of Gale (not river pebbles).
  const geos = useMemo(() => [makeRockGeometry(42, tier === 'low' ? 1 : 2, 0), makeRockGeometry(43, tier === 'low' ? 1 : 2, 1)], []);
  const mat = useMemo(() => makeRockMaterial({ clutter: true }), []);
  const built = useRef({ x: 1e9, z: 1e9, version: -1 });
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), p: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color(), n: { x: 0, y: 1, z: 0 } }), []);

  useFrame(() => {
    const [imA, imB] = meshes.current;
    if (!imA || !imB) return;
    const fx = rt.astro.x;
    const fz = rt.astro.z;
    clutterUniforms.uClutterFocus.value.set(fx, 0, fz);
    if (Math.hypot(fx - built.current.x, fz - built.current.z) < CELL * 1.5 && built.current.version === version) return;
    built.current = { x: fx, z: fz, version };

    const R = Q.clutterRadius;
    const { m, q, e, p, s, c, n } = tmp;
    const i0 = Math.floor((fx - R) / CELL), i1 = Math.floor((fx + R) / CELL);
    const j0 = Math.floor((fz - R) / CELL), j1 = Math.floor((fz + R) / CELL);
    const counts = [0, 0];
    const max = Math.floor(Q.clutter / 2);
    for (let cj = j0; cj <= j1; cj++)
      for (let ci = i0; ci <= i1; ci++) {
        const cx = (ci + 0.5) * CELL;
        const cz = (cj + 0.5) * CELL;
        if (Math.hypot(cx - fx, cz - fz) > R + CELL) continue;
        for (let k = 0; k < PER_CELL; k++) {
          const which = hash3(cj, k + 100, ci) < 0.62 ? 0 : 1;
          const im = which === 0 ? imA : imB;
          const count = counts[which];
          if (count >= max) continue;
          const h1 = hash3(ci, k * 3 + 1, cj);
          const x = (ci + h1) * CELL;
          const z = (cj + hash3(ci, k * 3 + 2, cj)) * CELL;
          if (Math.abs(x) > HALF - 1.5 || Math.abs(z) > HALF - 1.5) continue;
          // Fewer stones on loose sand and on the swept habitat pad; clusters elsewhere.
          const sand = sandAt(x, z);
          const patch = noise3(x * 0.09, 3.7, z * 0.09);
          const density = (1 - 0.9 * sand) * (0.25 + 1.5 * patch * patch);
          if (hash3(ci, k * 3 + 3, cj) > density) continue;
          if (Math.hypot(x - (BASE_A.x - 7), z - (BASE_A.z - 7)) < 9.6) continue;
          // Power law of sizes: most are pebbles, a few are fist- to head-sized.
          const u = hash3(cj, k * 5 + 4, ci);
          const size = 0.022 + 0.2 * Math.pow(u, 3.4);
          normalAt(x, z, n, 0.6);
          e.set(hash3(ci, k + 20, cj) * 6.28, hash3(cj, k + 30, ci) * 6.28, (hash3(ci, k + 40, cj) - 0.5) * 0.8);
          q.setFromEuler(e);
          const flat = 0.55 + 0.5 * hash3(cj, k + 50, ci);
          p.set(x, heightAt(x, z) + size * flat * (0.05 + 0.3 * hash3(ci, k + 60, cj)), z);
          s.set(size, size * flat, size * (0.7 + 0.5 * hash3(cj, k + 70, ci)));
          im.setMatrixAt(count, m.compose(p, q, s));
          const t = TINTS[Math.floor(hash3(ci, k + 80, cj) * TINTS.length) % TINTS.length];
          const v = 0.8 + 0.45 * hash3(cj, k + 90, ci);
          im.setColorAt(count, c.setRGB(t[0] * v, t[1] * v, t[2] * v));
          counts[which]++;
        }
      }
    [imA, imB].forEach((im, i) => {
      im.count = counts[i];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    });
  });

  return (
    <>
      {geos.map((geo, i) => (
        <instancedMesh key={i} ref={(m) => (meshes.current[i] = m)} args={[geo, mat, Math.max(1, Math.floor(Q.clutter / 2))]} castShadow={Q.clutterShadows} receiveShadow frustumCulled={false} />
      ))}
    </>
  );
}
