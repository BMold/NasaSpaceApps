// Astronaut metabolic model: Pandolf et al. (1977) load-carriage equation,
// adapted to Martian gravity as in the team's route-flow document. It turns a
// signed grade into watts, walking speed and litres of O₂ per edge.

export const G_MARS = 0.38; // g_Mars / g_Earth
export const W_BODY = 80; // astronaut mass, kg
export const M_SUIT = 150; // suit + PLSS mass, kg
export const V0 = 1.2; // base walking speed on flat, firm ground, m/s
export const KAPPA_O2 = 0.00298; // L of O₂ per W·min (≈ 20.1 kJ per litre)
export const Q_O2 = 380; // usable PLSS oxygen, litres (≈ 0.54 kg)
export const RHO = 0.15; // safety reserve on every return estimate
export const M_WORK = 300; // metabolic rate while drilling / sampling, W

/** Effective load the legs carry on Mars, in Earth-equivalent kg. */
export const L_EFF = (W_BODY + M_SUIT) * G_MARS - W_BODY;

/** Walking speed (m/s) for a signed grade G (%) and terrain factor η ≥ 1. */
export function walkSpeed(G: number, eta: number): number {
  return Math.max(0.05, V0 * Math.exp(-0.042 * Math.abs(G)) * (1 - 0.28 * eta));
}

/** Pandolf metabolic rate (W). The grade term is clamped at ≥ 0 when walking downhill. */
export function pandolfWatts(G: number, eta: number, v: number): number {
  const W = W_BODY;
  const L = L_EFF;
  const slopeTerm = Math.max(0, 0.35 * v * G);
  return 1.5 * W + 2.0 * (W + L) * (L / W) ** 2 + eta * (W + L) * (1.5 * v * v + slopeTerm);
}

/** Standing metabolic rate (W): Pandolf with v = 0. */
export const STANDING_W = pandolfWatts(0, 1, 0);

export interface EdgeCost {
  litres: number;
  seconds: number;
  watts: number;
  speed: number;
}

/** O₂ litres and time to walk Δd metres at grade G (%) over terrain factor η. */
export function edgeO2(dd: number, G: number, eta: number, out: EdgeCost = { litres: 0, seconds: 0, watts: 0, speed: 0 }): EdgeCost {
  const v = walkSpeed(G, eta);
  const M = pandolfWatts(G, eta, v);
  const minutes = dd / (60 * v);
  out.litres = M * minutes * KAPPA_O2;
  out.seconds = dd / v;
  out.watts = M;
  out.speed = v;
  return out;
}

/** O₂ litres for a stationary activity of `minutes` at `watts`. */
export const workO2 = (minutes: number, watts = M_WORK) => watts * minutes * KAPPA_O2;

/** Watts → kcal/h. */
export const kcalPerHour = (watts: number) => watts * 0.8598;
