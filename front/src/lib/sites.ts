// Science sites for the CTOPTW tour and natural storm shelters.
import { BASE_A, CANYON, HALF, TARGET_B, clearRocksNear, heightAt, type XZ } from './terrain';

export interface ScienceSite extends XZ {
  id: number; // node index in the tour graph (0 = habitat)
  code: string;
  name: string;
  mineral: string;
  value: number; // S_i, base science value
  massKg: number; // q_i, sample mass
  drillMin: number; // τ_i, sampling time (mission minutes)
  window: [number, number]; // [e_i, l_i] in LTST hours
  needsScan?: boolean; // inside the uncharted canyon
  note: string;
}

export const Q_KG = 4.0; // sample bag capacity, kg
export const PSI_ALPHA = 0.5; // diminishing-returns decay per repeated mineral

export const SITES: ScienceSite[] = [
  {
    id: 1, code: 'B', name: 'Boxwork outcrop', mineral: 'Sulfates', value: 10, massKg: 1.2, drillMin: 90,
    window: [10, 16.5], ...TARGET_B, note: 'Mineral veins of the Mount Sharp boxwork; needs high Sun for imaging.',
  },
  {
    id: 2, code: 'C', name: 'Canyon strata', mineral: 'Lake sediments', value: 8, massKg: 1.0, drillMin: 75,
    window: [9, 17], x: CANYON.x - 4.2, z: CANYON.z - 4.2, needsScan: true, note: 'Exposed layers on the canyon floor.',
  },
  {
    id: 3, code: 'F', name: 'Morning frost', mineral: 'Water ice', value: 7, massKg: 0.3, drillMin: 30,
    window: [7, 9.5], x: 80, z: -10, note: 'Frost in the crater shadow; it sublimates once the Sun is high.',
  },
  {
    id: 4, code: 'K', name: 'Clay bench', mineral: 'Phyllosilicates', value: 6, massKg: 1.0, drillMin: 60,
    window: [8, 17], x: -50, z: 14, note: 'Clay-bearing bench beside the western crater.',
  },
  {
    id: 5, code: 'Y', name: 'Gypsum veins', mineral: 'Sulfates', value: 5, massKg: 0.8, drillMin: 50,
    window: [8, 17], x: 26, z: -72, note: 'Same mineral class as the boxwork: worth less once B is sampled.',
  },
  {
    id: 6, code: 'D', name: 'Active dunes', mineral: 'Basaltic sand', value: 4, massKg: 0.6, drillMin: 30,
    window: [8, 17], x: 46, z: 10, note: 'Loose sand: slow, high-friction walking.',
  },
  {
    id: 7, code: 'H', name: 'Hematite nodules', mineral: 'Oxides', value: 4, massKg: 0.5, drillMin: 45,
    window: [8, 17], x: -30, z: -26, note: 'Concretions next to the small crater.',
  },
];

clearRocksNear(SITES, 7);

export const HABITAT: XZ = BASE_A;

/** ψ(m, n) = e^(−α (n − 1)): value multiplier for the n-th sample of a mineral class. */
export const psi = (n: number, alpha = PSI_ALPHA) => Math.exp(-alpha * (n - 1));

// ---------------------------------------------------------------------------
// Storm shelters: sky-view factor (SVF). During a solar particle event the dose
// rate scales roughly with the fraction of open sky, so canyon floors and
// crater walls that hide part of the sky lower the dose. The habitat is far
// better (shielded walls).
// ---------------------------------------------------------------------------
export const HABITAT_DOSE_FACTOR = 0.08;
/**
 * In a natural shelter the rover parks on the open side, a couple of metres
 * from the crew: its body, batteries and water tanks block part of the sky
 * that the terrain leaves visible (project design value).
 */
export const ROVER_SHIELD = 0.45;

/** SVF seen by a crew member crouched against the terrain (torso at 0.6 m). */
export function skyViewFactor(x: number, z: number, maxDist = 60, eye = 0.6): number {
  const h0 = heightAt(x, z) + eye;
  const AZ = 16;
  let sum = 0;
  for (let a = 0; a < AZ; a++) {
    const ang = (a / AZ) * Math.PI * 2;
    const dx = Math.sin(ang);
    const dz = -Math.cos(ang);
    let maxTan = 0;
    for (let d = 1; d <= maxDist; d += d < 12 ? 1 : 4) {
      const px = x + dx * d;
      const pz = z + dz * d;
      if (Math.abs(px) > HALF || Math.abs(pz) > HALF) break;
      maxTan = Math.max(maxTan, (heightAt(px, pz) - h0) / d);
    }
    const e = Math.atan(maxTan);
    sum += Math.cos(e) ** 2; // isotropic flux through the visible sky cap
  }
  return sum / AZ;
}

export interface ShelterCandidate extends XZ {
  svf: number;
  kind: 'habitat' | 'canyon' | 'crater' | 'ridge';
}

/** Natural shelters: local SVF minima on a 4 m grid, plus the habitat. */
export function findShelters(isWalkable: (p: XZ) => boolean, canyonKnown: boolean, inCanyon: (p: XZ) => boolean, nearCrater: (p: XZ) => boolean): ShelterCandidate[] {
  const STEP = 4;
  const n = Math.floor((2 * HALF - 20) / STEP);
  const grid: (ShelterCandidate | null)[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const p = { x: -HALF + 10 + i * STEP, z: -HALF + 10 + j * STEP };
      if (!isWalkable(p) || (!canyonKnown && inCanyon(p))) {
        grid.push(null);
        continue;
      }
      grid.push({ ...p, svf: skyViewFactor(p.x, p.z) * ROVER_SHIELD, kind: inCanyon(p) ? 'canyon' : nearCrater(p) ? 'crater' : 'ridge' });
    }
  const out: ShelterCandidate[] = [];
  for (let j = 1; j < n - 1; j++)
    for (let i = 1; i < n - 1; i++) {
      const c = grid[j * n + i];
      if (!c || c.svf > 0.9 * ROVER_SHIELD) continue;
      let isMin = true;
      for (let dj = -1; dj <= 1 && isMin; dj++)
        for (let di = -1; di <= 1; di++) {
          const o = grid[(j + dj) * n + i + di];
          if (o && o !== c && o.svf < c.svf) {
            isMin = false;
            break;
          }
        }
      if (isMin) out.push(c);
    }
  out.sort((a, b) => a.svf - b.svf);
  return [{ ...HABITAT, svf: HABITAT_DOSE_FACTOR, kind: 'habitat' }, ...out.slice(0, 14)];
}

// ---------------------------------------------------------------------------
// Solar particle event profile: a sharp onset, a peak in the first minutes and
// an exponential decay, as typical SPE time profiles show. mSv/h in the open.
// ---------------------------------------------------------------------------
export const SPE_PEAK = 7.5;
export const SPE_TAU_S = 12 * 60;
export const SPE_FLOOR = 0.6;
export const speRate = (t: number) => (t < 0 ? 0 : Math.min(1, t / 60) * (SPE_PEAK * Math.exp(-t / SPE_TAU_S) + SPE_FLOOR));

/**
 * Expected dose (mSv) if the crew walks `travelS` seconds in the open from
 * storm time `t0`, then waits with shielding factor `svf` until `tEnd`.
 */
export function expectedDose(t0: number, travelS: number, svf: number, tEnd: number): number {
  let dose = 0;
  const step = 10;
  for (let t = t0; t < tEnd; t += step) {
    const f = t - t0 < travelS ? 1 : svf;
    dose += (speRate(t) * f * step) / 3600;
  }
  return dose;
}
