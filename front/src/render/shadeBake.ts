// Baked light of the whole 240 m site, as one small texture the ground reads:
//   R  sunlight reaching the ground (soft shadows cast by the relief itself)
//   G  shadows of boulders and structures (used where the live shadow map does not reach)
//   B  how much sky the point sees (craters, the canyon and the foot of boulders are darker)
//
// The real-time shadow map only covers the tens of metres around the crew;
// this is what gives the far craters, the ridge and the distant boulders their
// shadows. It is recomputed when the Sun, the relief or the obstacles change,
// in small slices so the frame rate does not stall.
import * as THREE from 'three';
import { Q } from './quality';
import { HALF, WORLD_SIZE, heightAt, heights } from '../lib/terrain';
import { shadeUniforms } from './groundMaterial';

const N = Q.shadeRes;
const CELL = WORLD_SIZE / N;
const data = new Uint8Array(N * N * 4).fill(255);
export const shadeTexture = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
shadeTexture.magFilter = THREE.LinearFilter;
shadeTexture.minFilter = THREE.LinearFilter;
shadeTexture.needsUpdate = true;
shadeUniforms.uShade.value = shadeTexture;

/** Something that casts a shadow on the ground: a boulder, the habitat… */
export interface Caster {
  x: number;
  z: number;
  r: number; // footprint radius, metres
  h: number; // height above the ground, metres
}

const PENUMBRA = 0.012; // softened angular radius of the Sun
const AO_DIRS = 8;
const AO_DISTS = [0.8, 1.8, 3.5, 6.5, 11];
const aoDir = Array.from({ length: AO_DIRS }, (_, a) => [Math.cos((a / AO_DIRS) * Math.PI * 2), Math.sin((a / AO_DIRS) * Math.PI * 2)]);

let job = 0;
let aoVersion = -1;
const yieldToFrame = () => new Promise<void>((r) => setTimeout(r, 0));

async function sliced(rows: (j: number) => void, mine: number) {
  let t0 = performance.now();
  for (let j = 0; j < N; j++) {
    rows(j);
    if (performance.now() - t0 > 10) {
      await yieldToFrame();
      if (mine !== job) return false;
      t0 = performance.now();
    }
  }
  return true;
}

/**
 * Recompute the baked light. `terrainVersion` tells whether the relief changed
 * (the sky occlusion is only redone then).
 */
export async function bakeShade(sun: { x: number; y: number; z: number }, casters: Caster[], terrainVersion: number) {
  const mine = ++job;
  let hMax = -Infinity;
  for (let k = 0; k < heights.length; k++) if (heights[k] > hMax) hMax = heights[k];

  // --- B: sky occlusion ----------------------------------------------------
  if (aoVersion !== terrainVersion) {
    const ok = await sliced((j) => {
      const z = -HALF + (j + 0.5) * CELL;
      for (let i = 0; i < N; i++) {
        const x = -HALF + (i + 0.5) * CELL;
        const h0 = heightAt(x, z) + 0.1;
        let sum = 0;
        for (let a = 0; a < AO_DIRS; a++) {
          let maxTan = 0;
          for (const d of AO_DISTS) {
            const t = (heightAt(x + aoDir[a][0] * d, z + aoDir[a][1] * d) - h0) / d;
            if (t > maxTan) maxTan = t;
          }
          sum += 1 / (1 + maxTan * maxTan); // cos² of the horizon angle
        }
        data[(j * N + i) * 4 + 2] = Math.round(255 * Math.pow(sum / AO_DIRS, 0.85));
      }
    }, mine);
    if (!ok) return;
    aoVersion = terrainVersion;
  }

  // --- R: sunlight through the relief ---------------------------------------
  const hLen = Math.hypot(sun.x, sun.z);
  const up = sun.y > 0.01 && hLen > 1e-4;
  const dx = up ? sun.x / hLen : 0;
  const dz = up ? sun.z / hLen : 0;
  const tanEl = up ? sun.y / hLen : 0;
  const ok = await sliced((j) => {
    const z = -HALF + (j + 0.5) * CELL;
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 4;
      if (sun.y <= 0.01) {
        data[k] = 0;
        continue;
      }
      if (!up) {
        data[k] = 255; // Sun at the zenith
        continue;
      }
      const x = -HALF + (i + 0.5) * CELL;
      const h0 = heightAt(x, z) + 0.08;
      let vis = 1;
      for (let t = 0.6; ; t += Math.max(0.7, t * 0.08)) {
        const px = x + dx * t;
        const pz = z + dz * t;
        if (px < -HALF || px > HALF || pz < -HALF || pz > HALF) break;
        const rayH = h0 + t * tanEl;
        if (rayH > hMax) break;
        const v = (rayH - heightAt(px, pz)) / (t * PENUMBRA + 0.03);
        if (v < vis) {
          vis = v;
          if (vis <= 0) {
            vis = 0;
            break;
          }
        }
      }
      data[k] = Math.round(255 * vis);
    }
  }, mine);
  if (!ok) return;

  // --- G: boulder shadows, B: darker ground at their foot --------------------
  for (let k = 1; k < data.length; k += 4) data[k] = 255;
  for (const c of casters) {
    if (c.r < CELL * 0.6) continue;
    const len = up ? Math.min(16, c.h / Math.max(0.08, tanEl)) : 0;
    // Segment from the caster to the tip of its shadow (opposite to the Sun).
    const ex = c.x - dx * len;
    const ez = c.z - dz * len;
    const pad = c.r * 1.6 + 1;
    const i0 = Math.max(0, Math.floor((Math.min(c.x, ex) - pad + HALF) / CELL));
    const i1 = Math.min(N - 1, Math.ceil((Math.max(c.x, ex) + pad + HALF) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(c.z, ez) - pad + HALF) / CELL));
    const j1 = Math.min(N - 1, Math.ceil((Math.max(c.z, ez) + pad + HALF) / CELL));
    const sx = ex - c.x;
    const sz = ez - c.z;
    const s2 = sx * sx + sz * sz || 1e-9;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = -HALF + (i + 0.5) * CELL;
        const z = -HALF + (j + 0.5) * CELL;
        const k = (j * N + i) * 4;
        const dc = Math.hypot(x - c.x, z - c.z);
        // sky occlusion right at the foot
        const ao = 1 - 0.4 * Math.min(1, Math.max(0, (c.r * 1.6 - dc) / (c.r * 1.0)));
        data[k + 2] = Math.min(data[k + 2], Math.round(data[k + 2] * ao));
        if (len <= 0) continue;
        const t = Math.max(0, Math.min(1, ((x - c.x) * sx + (z - c.z) * sz) / s2));
        const d = Math.hypot(x - (c.x + sx * t), z - (c.z + sz * t));
        const r = c.r * (0.95 - 0.35 * t); // the shadow narrows and softens towards its tip
        const a = Math.min(1, Math.max(0, (r + CELL * 0.7 - d) / (CELL * 1.4 + r * 0.5 * t))) * (0.9 - 0.25 * t);
        const v = Math.round(255 * (1 - a));
        if (v < data[k + 1]) data[k + 1] = v;
      }
  }
  shadeTexture.needsUpdate = true;
}
