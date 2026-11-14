// Suit biodata and the return field for the VR walk.
//
// The VR astronaut is driven by hand from the laptop, so there is no telemetry
// stream for this walk. The laptop (position authority) simulates it with the
// model the contract suggests for the telemetry team (CLAUDE.md §10.4):
//   M   = Pandolf while walking (§8.2), 250 W standing
//   VO₂ = M·κ·(1 + ε),  ε ← 0.9·ε + N(0, 0.03) every 10 simulated s
//   O₂ -= VO₂·Δt/60
//   FC  = 70 + 55·VO₂ ± 3, in [60, 190]
// and the abort rule of §9 on the return field R(p) (reverse Dijkstra from the
// habitat over the same directed O₂ graph the optimizer uses, §8.3):
//   O2_minimo = 1.15·R ;  margen = 100·(O₂/R − 1)  →  > 30 % ok, 15–30 % ámbar, ≤ 15 % rojo
// The phone only receives these numbers (BioNet) and draws them.
//
// Orders of magnitude for the demo, not validated physiology (CLAUDE.md §16).
import { costGrid, cellOf } from '../lib/costmap';
import { dijkstra, fieldAt, type Field } from '../lib/pathfinding';
import { KAPPA_O2, pandolfWatts, walkSpeed } from '../lib/energy';
import { BASE_A, heightAt, sandAt } from '../lib/terrain';
import { mulberry32 } from '../lib/noise';
import { rt } from '../store/simEngine';
import { vr } from '../vr/vrEngine';

export const O2_INICIAL_L = 40; // CLAUDE.md §7
export const REST_W = 250; // §10.4
export const RESERVA = 0.15; // ρ
export type Level = 'ok' | 'ambar' | 'rojo';

/** Compact biodata the laptop streams to the phone (inside the 60 Hz state). */
export interface BioNet {
  o2: number; // O₂ remaining, L
  o0: number; // O₂ at the start, L
  vo2: number; // L/min
  fc: number; // beats per minute
  r: number; // R(p): O₂ to walk home from here, L
  om?: number; // mission: O2_minimo_L from estado_aborto
  mg?: number; // mission: margen_pct from estado_aborto
  frost: number; // 0..1 cold on the visor
  hyp: number; // 0..1 hypoxia (tank empty)
  ts: number; // time scale
}

export const bio = {
  t: 0, // simulated seconds since the EVA started
  O2: O2_INICIAL_L,
  O2_0: O2_INICIAL_L,
  VO2: REST_W * KAPPA_O2,
  FC: 70 + 55 * REST_W * KAPPA_O2,
  M: REST_W,
  eps: 0,
  R: 0,
  /** Laptop controls (scenario events, not data). */
  timeScale: 1,
  fatigue: 1, // VO₂ factor (guion: fatiga ×1.3)
  leakLpm: 0, // suit leak, L/min
  coldManual: false,
  frost: 0,
  hyp: 0,
  /** Set when the values come from the network (phone). */
  remote: false,
  /** Mission mode: O2_minimo_L and margen_pct exactly as the optimizer sent them (estado_aborto). */
  msgO2min: NaN,
  msgMargen: NaN,
};

const rng = mulberry32(42);
const gauss = () => {
  // Box–Muller on the seeded generator: same run, same numbers.
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
};
let epsClock = 0;
let fcJitter = 0;
let gradeAvg = 0; // signed grade along the walk (%), smoothed
/** Time constant of the body's response to a change of effort (VO₂ on-kinetics), simulated s. */
const KINETICS_S = 25;

// ---------------------------------------------------------------------------
// Return field R(p)
// ---------------------------------------------------------------------------
let field: Field | null = null;
let fieldKey = '';
/** Bumped whenever R(p) is recomputed (the barrier rebuilds on it). */
export const returnField = { version: 0, get: () => field };

/** Reverse Dijkstra from the habitat, recomputed only when the costmap or the habitat changes. */
export function ensureReturnField() {
  const key = `${costGrid.version}|${BASE_A.x.toFixed(2)},${BASE_A.z.toFixed(2)}`;
  if (field && key === fieldKey) return field;
  fieldKey = key;
  field = dijkstra(BASE_A, false);
  returnField.version++;
  return field;
}

/** O₂ (L) needed to walk home from a point, ∞ if there is no way back. */
export function returnLitres(x: number, z: number): number {
  const f = ensureReturnField();
  return fieldAt(f, { x, z });
}

// ---------------------------------------------------------------------------
// Derived values (same on both devices)
// ---------------------------------------------------------------------------
export const o2Minimo = () => (Number.isFinite(bio.msgO2min) ? bio.msgO2min : (1 + RESERVA) * bio.R);
/** margen_pct of §9; Infinity at the habitat (R = 0). The optimizer sends 9999 there. */
export const margenPct = () => (Number.isFinite(bio.msgMargen) ? (bio.msgMargen >= 999 ? Infinity : bio.msgMargen) : bio.R > 0.05 ? 100 * (bio.O2 / bio.R - 1) : Infinity);
export function level(): Level {
  const m = margenPct();
  if (bio.O2 <= 0) return 'rojo';
  return m > 30 ? 'ok' : m > 15 ? 'ambar' : 'rojo';
}
/** Minutes of O₂ left at the current consumption. */
export const minutesLeft = () => bio.O2 / Math.max(0.05, bio.VO2 + bio.leakLpm);
export const LEVEL_COLOR: Record<Level, string> = { ok: '#3fd98a', ambar: '#ffb020', rojo: '#ff3b3b' };

// ---------------------------------------------------------------------------
// Laptop: simulate one frame
// ---------------------------------------------------------------------------
export function stepBio(dtReal: number) {
  const dts = dtReal * bio.timeScale;
  bio.t += dts;

  // Metabolic rate: Pandolf on the slope you are walking, or standing still.
  // The body walks at the contract's pace for that slope (§8.2: v = v0·e^(−0.042|G|)·(1 − 0.28η)),
  // the same the optimizer prices; the laptop's speed slider (up to 10 m/s) only fast-forwards the
  // walk. Using the slider speed made any uphill read as a sprint (FC pinned at 190).
  let target = REST_W;
  if (vr.speed > 0.2) {
    // Signed grade over the next 3 m, averaged over ~1 s: the 2 m mesh is too bumpy point to point.
    const probe = 3;
    const dx = Math.sin(vr.moveYaw) * probe;
    const dz = -Math.cos(vr.moveYaw) * probe;
    const G = (100 * (heightAt(vr.x + dx, vr.z + dz) - heightAt(vr.x - dx * 0.5, vr.z - dz * 0.5))) / (probe * 1.5);
    gradeAvg += (G - gradeAvg) * (1 - Math.exp(-dtReal / 1));
    const eta = 1 + 0.9 * sandAt(vr.x, vr.z);
    target = Math.max(REST_W, pandolfWatts(gradeAvg, eta, walkSpeed(gradeAvg, eta)));
  }
  // Effort changes are not instantaneous: heart rate and VO₂ follow with a lag.
  bio.M += (target - bio.M) * (1 - Math.exp(-dts / KINETICS_S));

  epsClock += dts;
  while (epsClock >= 10) {
    epsClock -= 10;
    bio.eps = 0.9 * bio.eps + 0.03 * gauss();
    fcJitter = Math.max(-3, Math.min(3, gauss() * 1.5));
  }
  bio.VO2 = bio.M * KAPPA_O2 * (1 + bio.eps) * bio.fatigue;
  bio.O2 = Math.max(0, bio.O2 - ((bio.VO2 + bio.leakLpm) * dts) / 60);
  bio.FC = Math.max(60, Math.min(190, 70 + 55 * bio.VO2 + fcJitter));
  bio.R = returnLitres(vr.x, vr.z);

  // Cold on the visor: a cold zone under your feet, the night, or the "frío extremo" event.
  const k = cellOf({ x: vr.x, z: vr.z });
  const coldTarget = bio.coldManual || costGrid.hazard[k] === 1 ? 1 : rt.sun.elevation < 0 ? 0.55 : costGrid.shade[k] ? 0.15 : 0;
  bio.frost += (coldTarget - bio.frost) * (1 - Math.exp(-dtReal / (coldTarget > bio.frost ? 5 : 3)));
  // Hypoxia builds up over ~15 s once the tank is empty.
  bio.hyp += ((bio.O2 <= 0 ? 1 : 0) - bio.hyp) * (1 - Math.exp(-dtReal / (bio.O2 <= 0 ? 15 : 4)));
}

export function resetBio(litres = O2_INICIAL_L) {
  Object.assign(bio, { t: 0, O2: litres, O2_0: litres, eps: 0, M: REST_W, fatigue: 1, leakLpm: 0, coldManual: false, frost: 0, hyp: 0 });
}

export const bioSnapshot = (): BioNet => ({
  o2: bio.O2,
  o0: bio.O2_0,
  vo2: bio.VO2,
  fc: bio.FC,
  r: Number.isFinite(bio.R) ? bio.R : -1,
  frost: bio.frost,
  hyp: bio.hyp,
  ts: bio.timeScale,
  om: Number.isFinite(bio.msgO2min) ? bio.msgO2min : undefined,
  mg: Number.isFinite(bio.msgMargen) ? bio.msgMargen : undefined,
});

/** Phone: take the laptop's numbers (smoothed visuals are done by the views). */
export function applyBio(b: BioNet) {
  bio.remote = true;
  bio.O2 = b.o2;
  bio.O2_0 = b.o0;
  bio.VO2 = b.vo2;
  bio.FC = b.fc;
  bio.R = b.r < 0 ? Infinity : b.r;
  bio.frost = b.frost;
  bio.hyp = b.hyp;
  bio.timeScale = b.ts;
  bio.msgO2min = b.om ?? NaN;
  bio.msgMargen = b.mg ?? NaN;
}

/**
 * Mission mode (laptop): the suit numbers are the messages' numbers, nothing simulated:
 * O₂, R, O2_minimo and margen from estado_aborto; FC and VO₂ from telemetria_astronauta.
 */
export function bioFromMission(
  m: { O2: number; O2_0: number; R: number; O2min: number; margen: number; FC: number; VO2: number },
  dtReal: number,
) {
  if (Number.isFinite(m.O2)) bio.O2 = m.O2;
  if (Number.isFinite(m.O2_0)) bio.O2_0 = m.O2_0;
  if (Number.isFinite(m.R)) bio.R = m.R;
  if (Number.isFinite(m.FC)) bio.FC = m.FC;
  if (Number.isFinite(m.VO2)) {
    bio.VO2 = m.VO2;
    bio.M = m.VO2 / KAPPA_O2;
  }
  bio.msgO2min = m.O2min;
  bio.msgMargen = m.margen;
  bio.leakLpm = 0;
  // Visor effects follow the same rules: night cold, empty tank.
  const night = rt.sun.elevation < 0 ? 0.55 : 0;
  bio.frost += (night - bio.frost) * (1 - Math.exp(-dtReal / 4));
  bio.hyp += ((bio.O2 <= 0 ? 1 : 0) - bio.hyp) * (1 - Math.exp(-dtReal / (bio.O2 <= 0 ? 15 : 4)));
}

// Development hook for automated checks (same module instance as the app).
if (import.meta.env.DEV && typeof window !== 'undefined')
  (window as unknown as { __aresBio?: unknown }).__aresBio = { bio, returnLitres, margenPct, level, resetBio, o2Minimo };
