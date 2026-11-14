// GPU-side maps blended into the terrain shader: fog-of-war reveal mask and
// the live traversability costmap.
import * as THREE from 'three';
import { COST_N, costGrid } from './costmap';
import { HALF, WORLD_SIZE } from './terrain';

export const FOW_N = 128;
const fowData = new Uint8Array(FOW_N * FOW_N);
export const fowTexture = new THREE.DataTexture(fowData, FOW_N, FOW_N, THREE.RedFormat, THREE.UnsignedByteType);
fowTexture.magFilter = THREE.LinearFilter;
fowTexture.minFilter = THREE.LinearFilter;
fowTexture.needsUpdate = true;

export function resetFow() {
  fowData.fill(0);
  fowTexture.needsUpdate = true;
}

export function revealCircle(x: number, z: number, r: number) {
  const s = FOW_N / WORLD_SIZE;
  const cx = (x + HALF) * s;
  const cz = (z + HALF) * s;
  const rr = r * s;
  const j0 = Math.max(0, Math.floor(cz - rr));
  const j1 = Math.min(FOW_N - 1, Math.ceil(cz + rr));
  const i0 = Math.max(0, Math.floor(cx - rr));
  const i1 = Math.min(FOW_N - 1, Math.ceil(cx + rr));
  let changed = false;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / rr;
      if (d >= 1) continue;
      const v = Math.round(255 * Math.min(1, (1 - d) * 2.5));
      const k = j * FOW_N + i;
      if (v > fowData[k]) {
        fowData[k] = v;
        changed = true;
      }
    }
  }
  if (changed) fowTexture.needsUpdate = true;
}

export const fowValueAt = (x: number, z: number) => {
  const i = Math.min(FOW_N - 1, Math.max(0, Math.floor(((x + HALF) / WORLD_SIZE) * FOW_N)));
  const j = Math.min(FOW_N - 1, Math.max(0, Math.floor(((z + HALF) / WORLD_SIZE) * FOW_N)));
  return fowData[j * FOW_N + i] / 255;
};

const costData = new Uint8Array(COST_N * COST_N * 4);
export const costTexture = new THREE.DataTexture(costData, COST_N, COST_N, THREE.RGBAFormat, THREE.UnsignedByteType);
costTexture.magFilter = THREE.NearestFilter;
costTexture.minFilter = THREE.NearestFilter;

export const CLASS_COLORS: [number, number, number][] = [
  [63, 191, 127], // safe
  [217, 165, 32], // caution
  [200, 54, 74], // impassable
  [138, 99, 201], // uncharted
];

export function updateCostTexture() {
  for (let k = 0; k < COST_N * COST_N; k++) {
    const c = CLASS_COLORS[costGrid.cls[k]];
    costData[k * 4] = c[0];
    costData[k * 4 + 1] = c[1];
    costData[k * 4 + 2] = c[2];
    costData[k * 4 + 3] = 255;
  }
  costTexture.needsUpdate = true;
}

export const terrainUniforms = {
  uFow: { value: fowTexture as THREE.Texture },
  uFowStrength: { value: 0 },
  uCost: { value: costTexture as THREE.Texture },
  uCostOn: { value: 0 },
  uRoverPos: { value: new THREE.Vector2() },
  uRoverDir: { value: new THREE.Vector2(0, -1) },
  uTime: { value: 0 },
  uScanPos: { value: new THREE.Vector3() },
  uScanOn: { value: 0 },
};
