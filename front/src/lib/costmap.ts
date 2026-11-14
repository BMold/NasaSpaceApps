// Traversability graph shared by the planners, the tour solver, the rover-cam
// overlay and the route metrics.
//
// Each of the 96 × 96 cells (2.5 m) is a node with 8 directed edges. An edge
// a→b costs the litres of O₂ the astronaut burns walking it (Pandolf model with
// the SIGNED grade, so climbing costs more than descending), multiplied by risk
// factors (uncharted ground, cold zones, low-Sun glare, shade). Edges steeper
// than MAX_GRADE and cells steeper than MAX_SLOPE are impassable, which is what
// forces switchbacks on the ridge flanks.
import { HALF, ROCKS, WORLD_SIZE, canyonMask, heightAt, sandAt, slopeDegAt, type XZ } from './terrain';
import { edgeO2, type EdgeCost } from './energy';
import { REAL } from './realTerrain';

// 2.5 m cells in both modes; on the real window this is exactly the optimizer's 192 × 192 grid.
export const COST_N = REAL ? 192 : 96;
export const CELL = WORLD_SIZE / COST_N; // 2.5 m cells
export const MAX_SLOPE = 30; // degrees: no footing above this (any direction)
export const MAX_GRADE = 45; // %: steepest straight climb/descent allowed (≈ 24°)
export const UNCHARTED_FACTOR = 7; // × cost on ground nobody has mapped
export const COLD_FACTOR = 4; // × cost inside a −100 °C zone
export const GLARE_FACTOR = 1.25; // × cost walking into a Sun lower than 15°
export const SHADE_FACTOR = 1.08; // × cost in terrain shadow during the day (cold, no solar power)

export type CellClass = 0 | 1 | 2 | 3; // safe | caution | impassable | uncharted

export interface HazardRock {
  x: number;
  z: number;
  s: number;
  rot: number;
}

export interface Hazard {
  id: string;
  kind: 'cold' | 'rocks' | 'hill';
  height?: number; // hills: metres above the base terrain
  x: number;
  z: number;
  r: number;
  rocks?: HazardRock[];
}

export const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

const NN = COST_N * COST_N;

export const costGrid = {
  /** Relative per-cell cost (L of O₂ per metre on flat ground × risk), ∞ = blocked. For display. */
  cost: new Float32Array(NN),
  cls: new Uint8Array(NN),
  slope: new Float32Array(NN),
  sand: new Float32Array(NN),
  height: new Float32Array(NN),
  hazard: new Uint8Array(NN), // 1 = cold, 2 = rock field
  shade: new Uint8Array(NN), // 1 = in terrain shadow
  factor: new Float32Array(NN), // risk multiplier of the cell
  /** Directed edges: [k * 8 + d] → litres of O₂ (∞ if not walkable). */
  edgeL: new Float32Array(NN * 8),
  /** Directed edges: walking time in seconds. */
  edgeT: new Float32Array(NN * 8),
  /** Smallest litres per metre over all edges (admissible A* heuristic). */
  wMinPerM: 0.01,
  version: 0,
};

export const cellCenter = (i: number, j: number): XZ => ({
  x: -HALF + (i + 0.5) * CELL,
  z: -HALF + (j + 0.5) * CELL,
});

export function cellOf(p: XZ): number {
  const i = Math.min(COST_N - 1, Math.max(0, Math.floor((p.x + HALF) / CELL)));
  const j = Math.min(COST_N - 1, Math.max(0, Math.floor((p.z + HALF) / CELL)));
  return j * COST_N + i;
}

export const isWalkableCell = (k: number) => Number.isFinite(costGrid.cost[k]);

export interface SunInput {
  dir: { x: number; y: number; z: number };
  elevation: number;
  azimuth: number;
}

/** Ray-march each cell toward the Sun over the heightfield. */
function computeShade(sun: SunInput | null) {
  const { shade, height } = costGrid;
  shade.fill(0);
  if (!sun || sun.elevation <= 0) {
    if (sun) shade.fill(1);
    return;
  }
  const hl = Math.hypot(sun.dir.x, sun.dir.z) || 1;
  const sx = sun.dir.x / hl;
  const sz = sun.dir.z / hl;
  const tanE = Math.tan((sun.elevation * Math.PI) / 180);
  for (let j = 0; j < COST_N; j++)
    for (let i = 0; i < COST_N; i++) {
      const k = j * COST_N + i;
      const p = cellCenter(i, j);
      const h0 = height[k] + 0.3;
      for (let d = 2; d < 160; d += d < 20 ? 1.5 : 3) {
        const x = p.x + sx * d;
        const z = p.z + sz * d;
        if (Math.abs(x) > HALF || Math.abs(z) > HALF) break;
        if (heightAt(x, z) > h0 + d * tanE) {
          shade[k] = 1;
          break;
        }
      }
    }
}

const tmpEdge: EdgeCost = { litres: 0, seconds: 0, watts: 0, speed: 0 };

/**
 * known(x, z): optional map knowledge. Ground nobody has observed yet costs
 * ×UNSEEN_FACTOR, so a panoramic drone scan makes the planner trust what it saw.
 */
export const UNSEEN_FACTOR = 1.2;

export function computeCostmap(hazards: Hazard[], canyonScanned: boolean, sun: SunInput | null = null, known?: (x: number, z: number) => boolean) {
  const { cost, cls, slope, sand, hazard, height, factor, edgeL, edgeT } = costGrid;

  // Large boulders block a cell; medium ones only slow the walk.
  const rockBlock = new Uint8Array(NN);
  const rockSlow = new Float32Array(NN);
  for (const r of ROCKS) {
    if (r.s < 0.75) continue;
    stamp(r.x, r.z, r.s * 1.2, (k) => {
      if (r.s >= 1.3) rockBlock[k] = 1;
      else rockSlow[k] = Math.max(rockSlow[k], 0.35);
    });
  }

  for (let j = 0; j < COST_N; j++)
    for (let i = 0; i < COST_N; i++) {
      const k = j * COST_N + i;
      const p = cellCenter(i, j);
      height[k] = heightAt(p.x, p.z);
      slope[k] = slopeDegAt(p.x, p.z, CELL / 2);
      sand[k] = sandAt(p.x, p.z);
    }
  computeShade(sun);
  const day = !!sun && sun.elevation > 0;

  let unknown = 0;
  for (let k = 0; k < NN; k++) {
    const i = k % COST_N;
    const j = (k / COST_N) | 0;
    const p = cellCenter(i, j);
    hazard[k] = 0;
    let f = 1;
    // The flattened skirt around the 240 m tile is outside the mapped site.
    const outside = Math.max(Math.abs(p.x), Math.abs(p.z)) > HALF - 12;
    let blocked = outside || slope[k] > MAX_SLOPE || rockBlock[k] === 1;
    unknown = !canyonScanned && canyonMask(p.x, p.z) > 0.3 ? 1 : 0;
    if (unknown) f *= UNCHARTED_FACTOR;
    for (const h of hazards) {
      const d = Math.hypot(p.x - h.x, p.z - h.z);
      if (h.kind === 'cold') {
        if (d < h.r) {
          f *= COLD_FACTOR;
          hazard[k] = 1;
        } else if (d < h.r * 1.35) f *= 1.4;
      } else if (h.kind === 'rocks') {
        if (d < h.r) {
          blocked = true;
          hazard[k] = 2;
        } else if (d < h.r + 3) f *= 1.6;
      }
    }
    if (day && costGrid.shade[k]) f *= SHADE_FACTOR;
    if (known && !unknown && !known(p.x, p.z)) f *= UNSEEN_FACTOR;
    factor[k] = f;
    // Display cost: litres per metre on flat ground with this cell's terrain, × risk.
    const eta = 1 + 0.9 * sand[k] + rockSlow[k];
    const flat = edgeO2(1, 0, eta, tmpEdge).litres;
    const steep = 1 + Math.max(0, slope[k] - 8) * 0.12;
    cost[k] = blocked ? Infinity : flat * f * steep;
    cls[k] = blocked ? 2 : unknown ? 3 : f > 1.3 || slope[k] > 16 || sand[k] > 0.45 ? 1 : 0;
    etaGrid[k] = eta;
  }

  // Directed edges.
  const glareOn = !!sun && sun.elevation > 0 && sun.elevation < 15;
  const sunAz = sun ? (sun.azimuth * Math.PI) / 180 : 0;
  let wMin = Infinity;
  for (let k = 0; k < NN; k++) {
    const i = k % COST_N;
    const j = (k / COST_N) | 0;
    for (let d = 0; d < 8; d++) {
      const e = k * 8 + d;
      const [di, dj, w] = DIRS[d];
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= COST_N || nj >= COST_N) {
        edgeL[e] = Infinity;
        edgeT[e] = Infinity;
        continue;
      }
      const n = nj * COST_N + ni;
      // Diagonals may not cut the corner of a blocked cell.
      const blocked =
        !Number.isFinite(cost[k]) ||
        !Number.isFinite(cost[n]) ||
        (w > 1 && (!Number.isFinite(cost[j * COST_N + ni]) || !Number.isFinite(cost[nj * COST_N + i])));
      const dd = w * CELL;
      const G = (100 * (height[n] - height[k])) / dd;
      if (blocked || Math.abs(G) > MAX_GRADE) {
        edgeL[e] = Infinity;
        edgeT[e] = Infinity;
        continue;
      }
      const eta = (etaGrid[k] + etaGrid[n]) / 2;
      edgeO2(dd, G, eta, tmpEdge);
      let f = (factor[k] + factor[n]) / 2;
      if (glareOn) {
        const heading = Math.atan2(di, -dj); // clockwise from north
        let diff = Math.abs(heading - sunAz) % (2 * Math.PI);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        if (diff < (25 * Math.PI) / 180) f *= GLARE_FACTOR;
      }
      edgeL[e] = tmpEdge.litres * f;
      edgeT[e] = tmpEdge.seconds;
      wMin = Math.min(wMin, edgeL[e] / dd);
    }
  }
  costGrid.wMinPerM = Number.isFinite(wMin) ? wMin : 0.01;
  costGrid.version++;
}

const etaGrid = new Float32Array(NN);

function stamp(x: number, z: number, r: number, fn: (k: number) => void) {
  const i0 = Math.max(0, Math.floor((x - r + HALF) / CELL));
  const i1 = Math.min(COST_N - 1, Math.floor((x + r + HALF) / CELL));
  const j0 = Math.max(0, Math.floor((z - r + HALF) / CELL));
  const j1 = Math.min(COST_N - 1, Math.floor((z + r + HALF) / CELL));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const c = cellCenter(i, j);
      if (Math.hypot(c.x - x, c.z - z) <= r + CELL * 0.5) fn(j * COST_N + i);
    }
}

/** Index of the edge k → n (n must be one of k's 8 neighbours), or −1. */
export function edgeIndex(k: number, n: number): number {
  const di = (n % COST_N) - (k % COST_N);
  const dj = ((n / COST_N) | 0) - ((k / COST_N) | 0);
  for (let d = 0; d < 8; d++) if (DIRS[d][0] === di && DIRS[d][1] === dj) return k * 8 + d;
  return -1;
}

/** Litres for the directed edge k → n (∞ if not neighbours or blocked). */
export const edgeLitres = (k: number, n: number) => {
  const e = edgeIndex(k, n);
  return e < 0 ? Infinity : costGrid.edgeL[e];
};
