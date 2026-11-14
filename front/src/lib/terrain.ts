// Shared heightfield for the Martian digital twin. Rendering, path planning,
// telemetry and entity placement all sample the same grid so the 3D scene and
// the simulation never disagree about where the ground is.
import { fbm, ridged, mulberry32 } from './noise';
import { REAL, REAL_HALF } from './realTerrain';

export interface XZ {
  x: number;
  z: number;
}

// Real package: the 480 m window of terreno/ (2 m mesh over its 2.5 m DEM). Procedural analog: 240 m at 1 m.
export const WORLD_SIZE = REAL ? 2 * REAL_HALF : 240; // metres
export const HALF = WORLD_SIZE / 2;
export const HF_RES = 241; // vertices per side
export const HF_STEP = WORLD_SIZE / (HF_RES - 1);

// World frame: +x = east, -z = north. Heading 0 = north, +π/2 = east.
export const BASE_A: XZ = { x: -88, z: -84 };
export const TARGET_B: XZ = { x: 86, z: 84 };

// A broad ridge (a Mount Sharp foothill) blocks the direct A→B line. Its flanks
// stay below ~30°, so it can be crossed on foot with switchbacks; a narrow
// canyon cuts through it but is uncharted until the scout drone maps it.
const RD = { x: Math.SQRT1_2, z: -Math.SQRT1_2 }; // ridge axis
const RN = { x: Math.SQRT1_2, z: Math.SQRT1_2 }; // across the ridge (≈ A→B)
export const CANYON_T = 10;
export const CANYON: XZ = { x: RD.x * CANYON_T, z: RD.z * CANYON_T };

export interface Crater {
  x: number;
  z: number;
  r: number;
  d: number;
}

export const CRATERS: Crater[] = [
  { x: -46, z: -40, r: 13, d: 5 },
  { x: 44, z: 46, r: 11, d: 4.5 },
  { x: -62, z: 38, r: 16, d: 6 },
  { x: 74, z: -10, r: 16, d: 4.5 },
  { x: -10, z: 70, r: 9, d: 3 },
  { x: 82, z: 18, r: 8, d: 3 },
  { x: -96, z: -18, r: 7, d: 2.5 },
  { x: 20, z: -82, r: 10, d: 4 },
  { x: -20, z: -60, r: 6, d: 2 },
];
// The real window has its own relief: no invented craters there.
if (REAL) CRATERS.length = 0;

export const DUNES = { x: 52, z: 16, r: 28 };

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const RIDGE_H = 12;
export const RIDGE_W = 29;

export function canyonMask(x: number, z: number): number {
  if (REAL) return 0; // the canyon only exists in the procedural analog
  const t = x * RD.x + z * RD.z;
  const u = x * RN.x + z * RN.z;
  return Math.exp(-(((t - CANYON_T) / 6.5) ** 4)) * Math.exp(-((u / 12) ** 4));
}

// ---------------------------------------------------------------------------
// External data (NASA Mars Trek) – optional macro relief and albedo tint
// ---------------------------------------------------------------------------
export interface GridData {
  data: Float32Array;
  n: number;
}

let dem: GridData | null = null; // normalised [-0.5, 0.5]
let albedo: GridData | null = null; // rgb triplets [0, 1]
export const DEM_AMPLITUDE = 11;
/** Regional slope of the real site (rise per metre east / north) and image mode. */
export const siteTerrain = { tiltEast: 0, tiltNorth: 0, hiRes: false };
export const albedoGrid = () => albedo;
/** Height of the regional plane (Mount Sharp flank) at a point. */
export const tiltAt = (x: number, z: number) => siteTerrain.tiltEast * x - siteTerrain.tiltNorth * z;

function sampleGrid(g: GridData, x: number, z: number, channels: number, ch: number): number {
  const fx = Math.min(g.n - 1.001, Math.max(0, ((x + HALF) / WORLD_SIZE) * (g.n - 1)));
  const fz = Math.min(g.n - 1.001, Math.max(0, ((z + HALF) / WORLD_SIZE) * (g.n - 1)));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const d = g.data;
  const a = d[(j * g.n + i) * channels + ch];
  const b = d[(j * g.n + i + 1) * channels + ch];
  const c = d[((j + 1) * g.n + i) * channels + ch];
  const e = d[((j + 1) * g.n + i + 1) * channels + ch];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
}

export function albedoAt(x: number, z: number, out: number[]): boolean {
  if (!albedo) return false;
  out[0] = sampleGrid(albedo, x, z, 3, 0);
  out[1] = sampleGrid(albedo, x, z, 3, 1);
  out[2] = sampleGrid(albedo, x, z, 3, 2);
  return true;
}

export const hasExternalData = () => dem !== null;

// ---------------------------------------------------------------------------
// Procedural generator
// ---------------------------------------------------------------------------
let sandOut = 0;

function rawSample(x: number, z: number, macroAmp: number): number {
  let h =
    fbm(x * 0.0075, z * 0.0075, 4) * macroAmp +
    fbm(x * 0.035 + 11.3, z * 0.035 - 4.1, 3) * 0.9 +
    fbm(x * 0.17, z * 0.17, 2) * 0.12;

  // Ridge with canyon notch
  const t = x * RD.x + z * RD.z;
  const u = x * RN.x + z * RN.z;
  // Long enough that rounding either end costs far more than the canyon shortcut.
  const along = 1 - smoothstep(160, 175, Math.abs(t)); // spans the whole site: no way around
  if (along > 0) {
    const jag = 0.9 + 0.2 * ridged(x * 0.03 + 3.1, z * 0.03 - 7.7, 2);
    const notch = 1 - 0.97 * Math.exp(-(((t - CANYON_T) / 6.5) ** 4));
    h += RIDGE_H * Math.exp(-((u / RIDGE_W) ** 2)) * along * jag * notch;
  }

  let sand = Math.max(0, fbm(x * 0.02 + 90, z * 0.02 - 30, 3)) * 0.45;

  for (const c of CRATERS) {
    const dx = x - c.x;
    const dz = z - c.z;
    const d2 = dx * dx + dz * dz;
    const lim = c.r * 1.9;
    if (d2 > lim * lim) continue;
    const d = Math.sqrt(d2);
    const q = d / c.r;
    // Each crater has a gentler breach facing the site centre, so its floor can
    // be reached on foot (real small craters often have a degraded wall).
    let da = Math.atan2(dz, dx) - Math.atan2(-c.z, -c.x);
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const breach = Math.exp(-((da / 0.5) ** 2));
    if (q < 1) {
      const bowl = 1 - q * q;
      const ramp = 1 - q;
      h -= c.d * (bowl + (ramp - bowl) * breach);
      sand = Math.max(sand, (1 - q) * 0.7);
    }
    h += c.d * 0.35 * (1 - 0.8 * breach) * Math.exp(-(((d - c.r) / (0.45 * c.r)) ** 2));
  }

  // Dune field
  const ddx = x - DUNES.x;
  const ddz = z - DUNES.z;
  const dd = Math.sqrt(ddx * ddx + ddz * ddz);
  const dm = 1 - smoothstep(DUNES.r * 0.45, DUNES.r, dd);
  if (dm > 0) {
    const ph = (x * 0.8 + z * 0.6) * 0.42 + fbm(x * 0.03, z * 0.03, 2) * 3;
    const w = Math.sin(ph) * 0.5 + 0.5;
    h += w * w * 1.3 * dm;
    sand = Math.max(sand, dm * (0.55 + 0.45 * w));
  }

  sandOut = Math.min(1, sand);
  return h;
}

export const heights = new Float32Array(HF_RES * HF_RES);
/** Heights before any user-placed hill (see applyBumps). */
export const baseHeights = new Float32Array(HF_RES * HF_RES);
export const sandGrid = new Float32Array(HF_RES * HF_RES);
export const terrainInfo = { version: 0, source: 'procedural' as string };

export interface Rock {
  x: number;
  z: number;
  s: number;
  sy: number;
  rot: number;
}
export const ROCKS: Rock[] = [];

function genRocks() {
  const rng = mulberry32(4242);
  ROCKS.length = 0;
  let tries = 0;
  const count = REAL ? 520 : 280; // same density over the 4× larger real window
  while (ROCKS.length < count && tries++ < 10000) {
    const x = (rng() * 2 - 1) * (HALF - 6);
    const z = (rng() * 2 - 1) * (HALF - 6);
    if (Math.hypot(x - BASE_A.x, z - BASE_A.z) < 15) continue;
    if (Math.hypot(x - TARGET_B.x, z - TARGET_B.z) < 12) continue;
    if (canyonMask(x, z) > 0.05) continue;
    ROCKS.push({ x, z, s: 0.22 + Math.pow(rng(), 3) * 1.8, sy: 0.55 + rng() * 0.5, rot: rng() * Math.PI * 2 });
  }
}

/** Scatter the boulders again (after the habitat moved), keeping `clear` points free. */
export function regenRocks(clear: XZ[], r = 7) {
  genRocks();
  clearRocksNear(clear, r);
}

/** Remove boulders around points that must stay walkable (science sites). */
export function clearRocksNear(points: XZ[], r: number) {
  for (let i = ROCKS.length - 1; i >= 0; i--)
    if (points.some((p) => Math.hypot(ROCKS[i].x - p.x, ROCKS[i].z - p.z) < r)) ROCKS.splice(i, 1);
}

export function buildHeightfield(
  demData: GridData | null = null,
  albedoData: GridData | null = null,
  source = 'procedural',
  opts: { hiRes?: boolean; tilt?: { east: number; north: number }; real?: (x: number, z: number) => number } = {},
) {
  dem = demData;
  albedo = albedoData;
  siteTerrain.hiRes = !!opts.hiRes;
  // Keep the regional slope walkable: real values on Mount Sharp's flank are a few degrees.
  const tE = opts.tilt?.east ?? 0;
  const tN = opts.tilt?.north ?? 0;
  const g = Math.hypot(tE, tN);
  // (Real DEM: the true regional slope, already in its heights; never scaled.)
  const k = opts.real || g <= 0.12 ? 1 : 0.12 / g;
  siteTerrain.tiltEast = tE * k;
  siteTerrain.tiltNorth = tN * k;
  const macroAmp = dem ? 2.2 : opts.hiRes ? 1.6 : 6;
  const real = opts.real;
  const sample = real
    ? (x: number, z: number) => {
        sandOut = 0; // no sand layer in the package: the orthophoto carries the surface
        return real(x, z);
      }
    : (x: number, z: number) => rawSample(x, z, macroAmp) + (dem ? sampleGrid(dem, x, z, 1, 0) * DEM_AMPLITUDE : 0) + tiltAt(x, z);

  const padA = sample(BASE_A.x, BASE_A.z);
  const padB = sample(TARGET_B.x, TARGET_B.z);

  for (let j = 0; j < HF_RES; j++) {
    const z = -HALF + j * HF_STEP;
    for (let i = 0; i < HF_RES; i++) {
      const x = -HALF + i * HF_STEP;
      let h = sample(x, z);
      const k = j * HF_RES + i;
      sandGrid[k] = sandOut;
      const dA = Math.hypot(x - BASE_A.x, z - BASE_A.z);
      if (dA < 13) h += (padA - h) * (1 - smoothstep(8, 13, dA));
      const dB = real ? Infinity : Math.hypot(x - TARGET_B.x, z - TARGET_B.z);
      if (dB < 10) h += (padB - h) * (1 - smoothstep(5, 10, dB));
      const edge = smoothstep(HALF - 14, HALF, Math.max(Math.abs(x), Math.abs(z)));
      const edgeH = tiltAt(x, z) - 2;
      heights[k] = h + (edgeH - h) * edge;
    }
  }
  if (ROCKS.length === 0) genRocks();
  baseHeights.set(heights);
  terrainInfo.version++;
  terrainInfo.source = source;
}

/** Add Gaussian hills on top of the base terrain (h metres high, r metres wide). */
export function applyBumps(bumps: { x: number; z: number; h: number; r: number }[]) {
  heights.set(baseHeights);
  for (const b of bumps) {
    const lim = b.r * 2.6;
    const i0 = Math.max(0, Math.floor((b.x - lim + HALF) / HF_STEP));
    const i1 = Math.min(HF_RES - 1, Math.ceil((b.x + lim + HALF) / HF_STEP));
    const j0 = Math.max(0, Math.floor((b.z - lim + HALF) / HF_STEP));
    const j1 = Math.min(HF_RES - 1, Math.ceil((b.z + lim + HALF) / HF_STEP));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = -HALF + i * HF_STEP;
        const z = -HALF + j * HF_STEP;
        const d2 = ((x - b.x) ** 2 + (z - b.z) ** 2) / (b.r * b.r);
        heights[j * HF_RES + i] += b.h * Math.exp(-d2);
      }
  }
  terrainInfo.version++;
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------
function bilinear(arr: Float32Array, x: number, z: number): number {
  const fx = Math.min(HF_RES - 1.0001, Math.max(0, (x + HALF) / HF_STEP));
  const fz = Math.min(HF_RES - 1.0001, Math.max(0, (z + HALF) / HF_STEP));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const k = j * HF_RES + i;
  const a = arr[k];
  const b = arr[k + 1];
  const c = arr[k + HF_RES];
  const d = arr[k + HF_RES + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export const heightAt = (x: number, z: number) => bilinear(heights, x, z);

/**
 * Height of the terrain exactly as it is drawn: each 1 m cell is two flat triangles, which can
 * sit a few centimetres above or below the smooth (bilinear) surface. Things that must touch the
 * visible ground, like the astronaut's boots, use this one.
 */
export function meshHeightAt(x: number, z: number): number {
  const fx = Math.min(HF_RES - 1.0001, Math.max(0, (x + HALF) / HF_STEP));
  const fz = Math.min(HF_RES - 1.0001, Math.max(0, (z + HALF) / HF_STEP));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const k = j * HF_RES + i;
  const h00 = heights[k];
  const h10 = heights[k + 1];
  const h01 = heights[k + HF_RES];
  const h11 = heights[k + HF_RES + 1];
  // The cell's diagonal runs from (i, j+1) to (i+1, j).
  return tx + tz <= 1 ? h00 + (h10 - h00) * tx + (h01 - h00) * tz : h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}
export const sandAt = (x: number, z: number) => bilinear(sandGrid, x, z);

export function slopeDegAt(x: number, z: number, e = 1.25): number {
  const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  return (Math.atan(Math.sqrt(gx * gx + gz * gz)) * 180) / Math.PI;
}

export function normalAt(x: number, z: number, out: { x: number; y: number; z: number }, e = 1.2) {
  const nx = heightAt(x - e, z) - heightAt(x + e, z);
  const nz = heightAt(x, z - e) - heightAt(x, z + e);
  const ny = 2 * e;
  const l = Math.hypot(nx, ny, nz);
  out.x = nx / l;
  out.y = ny / l;
  out.z = nz / l;
  return out;
}

export const dist = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z);

const toLin = (c: number) => Math.pow(c, 2.2);
const alb = [0, 0, 0];

/** Linear-space vertex colour for the terrain mesh. */
export function terrainColorAt(x: number, z: number, h: number, slope: number, sand: number, out: number[]) {
  const n = fbm(x * 0.05 + 40, z * 0.05 - 12, 3) * 0.5 + 0.5;
  let r = 0.6;
  let g = 0.3;
  let b = 0.16;
  const rock = smoothstep(14, 32, slope);
  r += (0.3 - r) * rock;
  g += (0.17 - g) * rock;
  b += (0.12 - b) * rock;
  const s = sand * 0.85 * (1 - rock);
  r += (0.82 - r) * s;
  g += (0.53 - g) * s;
  b += (0.33 - b) * s;
  const v = 0.82 + 0.32 * n + Math.max(-0.12, Math.min(0.1, h * 0.012));
  r *= v;
  g *= v;
  b *= v;
  if (siteTerrain.hiRes && albedo) {
    // Real HiRISE surface: the shader multiplies the image in, so the vertex
    // colour only carries shading of the scenario features (rock faces, sand).
    const k = (1 - rock * 0.3) * (1 + sand * 0.12);
    out[0] = toLin(Math.min(1, k));
    out[1] = toLin(Math.min(1, k * 0.98));
    out[2] = toLin(Math.min(1, k * 0.96));
    return;
  } else if (albedoAt(x, z, alb)) {
    const lum = alb[0] * 0.3 + alb[1] * 0.59 + alb[2] * 0.11;
    const m = 0.55 + 0.9 * lum;
    r = r * m * 0.6 + alb[0] * 0.4 * 1.1;
    g = g * m * 0.6 + alb[1] * 0.4 * 1.0;
    b = b * m * 0.6 + alb[2] * 0.4 * 0.9;
  }
  out[0] = toLin(Math.min(1, r));
  out[1] = toLin(Math.min(1, g));
  out[2] = toLin(Math.min(1, b));
}

buildHeightfield();
