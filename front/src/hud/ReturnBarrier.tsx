// Survival barrier: the return field R(p) made visible on the ground.
//
// For every cell, R(p) = O₂ to walk back to the habitat from there (reverse
// Dijkstra, see bio.ts). With O₂ litres left, the abort rule of §9 holds
// wherever  O₂ ≤ 1.15·R(p). The red curtain stands exactly on that contour:
// past it you can no longer get home with the reserve. A faint amber line
// marks margen = 30 % (O₂ = 1.30·R). Both close in on the habitat as the tank
// drains; while the whole window is within reach, there is nothing to draw.
//
// Contours by marching squares over the 2.5 m costmap cell centres; cells with
// no way home (cliffs) count as "inside", so they do not wall themselves off.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { COST_N, cellCenter } from '../lib/costmap';
import { meshHeightAt } from '../lib/terrain';
import { UNLIT } from '../render/unlit';
import { bio, ensureReturnField, returnField } from './bio';

const WALL_H = 1.8; // metres: about chest height, it reads as a wall, not a fence

const vert = /* glsl */ `
varying vec2 vUv; varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const frag = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uOpacity;
varying vec2 vUv; varying vec3 vW;
void main() {
  float up = vUv.y;
  float base = 1.0 - smoothstep(0.0, 1.0, up);          // brightest on the ground
  float rim = smoothstep(0.0, 0.04, up) * (1.0 - smoothstep(0.04, 0.12, up));
  float scan = 0.6 + 0.4 * sin((vW.x + vW.z) * 1.6 - uTime * 3.0);
  float rise = smoothstep(0.0, 0.05, fract(up * 3.0 - uTime * 0.5)) * (1.0 - smoothstep(0.05, 0.25, fract(up * 3.0 - uTime * 0.5)));
  float a = (base * 0.55 * scan + rim * 0.9 + rise * 0.25 * base) * uOpacity;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Marching squares on v (cell centres): segments where v crosses 0. */
function contour(v: Float32Array): number[] {
  const n = COST_N;
  const out: number[] = [];
  const lerp = (a: number, b: number) => a / (a - b);
  for (let j = 0; j < n - 1; j++)
    for (let i = 0; i < n - 1; i++) {
      const k = j * n + i;
      const a = v[k]; // (i, j)
      const b = v[k + 1]; // (i+1, j)
      const c = v[k + n + 1]; // (i+1, j+1)
      const d = v[k + n]; // (i, j+1)
      const idx = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      // Edge crossings in cell units: top (a-b), right (b-c), bottom (d-c), left (a-d).
      const e = [
        [i + lerp(a, b), j],
        [i + 1, j + lerp(b, c)],
        [i + lerp(d, c), j + 1],
        [i, j + lerp(a, d)],
      ];
      const seg = (p: number, q: number) => out.push(e[p][0], e[p][1], e[q][0], e[q][1]);
      switch (idx) {
        case 1: case 14: seg(3, 0); break;
        case 2: case 13: seg(0, 1); break;
        case 3: case 12: seg(3, 1); break;
        case 4: case 11: seg(1, 2); break;
        case 6: case 9: seg(0, 2); break;
        case 7: case 8: seg(3, 2); break;
        case 5: seg(3, 0); seg(1, 2); break;
        case 10: seg(0, 1); seg(2, 3); break;
      }
    }
  return out;
}

/** Vertical light wall over a set of segments (cell coordinates → world). */
function wallGeometry(segs: number[]): THREE.BufferGeometry | null {
  const m = segs.length / 4;
  if (!m) return null;
  const c0 = cellCenter(0, 0);
  const c1 = cellCenter(1, 1);
  const cell = c1.x - c0.x;
  const pos = new Float32Array(m * 4 * 3);
  const uv = new Float32Array(m * 4 * 2);
  const idx = new Uint32Array(m * 6);
  for (let s = 0; s < m; s++) {
    const ax = c0.x + segs[s * 4] * cell;
    const az = c0.z + segs[s * 4 + 1] * cell;
    const bx = c0.x + segs[s * 4 + 2] * cell;
    const bz = c0.z + segs[s * 4 + 3] * cell;
    const ha = meshHeightAt(ax, az);
    const hb = meshHeightAt(bx, bz);
    pos.set([ax, ha, az, bx, hb, bz, ax, ha + WALL_H, az, bx, hb + WALL_H, bz], s * 12);
    uv.set([0, 0, 1, 0, 0, 1, 1, 1], s * 8);
    const v = s * 4;
    idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function makeMaterial(color: string) {
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(UNLIT * 1.6) }, uTime: { value: 0 }, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

export function ReturnBarrier() {
  const red = useMemo(() => makeMaterial('#ff3b3b'), []);
  const amber = useMemo(() => makeMaterial('#ffb020'), []);
  const redMesh = useRef<THREE.Mesh>(null);
  const amberMesh = useRef<THREE.Mesh>(null);
  const last = useRef({ o2: NaN, field: -1, at: 0 });
  const values = useMemo(() => new Float32Array(COST_N * COST_N), []);

  useEffect(
    () => () => {
      red.dispose();
      amber.dispose();
      redMesh.current?.geometry?.dispose();
      amberMesh.current?.geometry?.dispose();
    },
    [red, amber],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    red.uniforms.uTime.value = t;
    amber.uniforms.uTime.value = t;
    red.uniforms.uOpacity.value = 0.85 + 0.15 * Math.sin(t * 5);
    amber.uniforms.uOpacity.value = 0.35;

    // Rebuild at most 4 times a second, and only when O₂ or the field changed.
    const f = ensureReturnField();
    const L = last.current;
    if (t - L.at < 0.25 || (Math.abs(bio.O2 - L.o2) < 0.02 && L.field === returnField.version)) return;
    L.at = t;
    L.o2 = bio.O2;
    L.field = returnField.version;

    const build = (k: number, mesh: THREE.Mesh | null) => {
      if (!mesh) return;
      for (let c = 0; c < values.length; c++) {
        const R = f.cost[c];
        values[c] = Number.isFinite(R) ? bio.O2 - k * R : 1; // no way home: not a wall
      }
      const g = wallGeometry(contour(values));
      mesh.geometry?.dispose();
      mesh.geometry = g ?? new THREE.BufferGeometry();
      mesh.visible = !!g;
    };
    build(1.15, redMesh.current); // margen = 15 %: abort line
    build(1.3, amberMesh.current); // margen = 30 %
  });

  return (
    <group>
      <mesh ref={redMesh} material={red} renderOrder={7} frustumCulled={false} visible={false} />
      <mesh ref={amberMesh} material={amber} renderOrder={7} frustumCulled={false} visible={false} />
    </group>
  );
}
