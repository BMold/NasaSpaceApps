// Martian clock and Sun position (Mars24 algorithm, Allison & McEwen 2000).
// The season (Ls) comes from the real date the mission starts; the time of day
// is the Local True Solar Time (LTST) at the site, which drives the Sun
// direction, surface temperature, terrain shadows and solar power.

export const SOL_SECONDS = 88775.244; // one Martian solar day, in seconds

const d2r = Math.PI / 180;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export interface MarsDate {
  msd: number; // Mars Sol Date
  ls: number; // areocentric solar longitude, degrees
  decl: number; // solar declination, degrees
  eot: number; // equation of time, degrees
  mst: number; // mean solar time at the prime meridian, hours
  rAU: number; // Sun–Mars distance, AU
}

/** Mars24 core quantities for a UTC instant. */
export function marsDate(utcMs: number): MarsDate {
  const jdUT = 2440587.5 + utcMs / 86400000;
  const jdTT = jdUT + 69.184 / 86400;
  const dt = jdTT - 2451545.0;
  const M = 19.3871 + 0.52402073 * dt;
  const aFMS = 270.3871 + 0.524038496 * dt;
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.002, 0.0018];
  const tau = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
  const phi = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];
  let pbs = 0;
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos(((0.985626 * dt) / tau[i] + phi[i]) * d2r);
  const Mr = M * d2r;
  const nuM =
    (10.691 + 3.0e-7 * dt) * Math.sin(Mr) +
    0.623 * Math.sin(2 * Mr) +
    0.05 * Math.sin(3 * Mr) +
    0.005 * Math.sin(4 * Mr) +
    0.0005 * Math.sin(5 * Mr) +
    pbs;
  const ls = mod(aFMS + nuM, 360);
  const lr = ls * d2r;
  const eot = 2.861 * Math.sin(2 * lr) - 0.071 * Math.sin(4 * lr) + 0.002 * Math.sin(6 * lr) - nuM;
  const decl = Math.asin(0.42565 * Math.sin(lr)) / d2r + 0.25 * Math.sin(lr);
  const mst = mod(24 * ((jdTT - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626), 24);
  const msd = (jdTT - 2405522.0028779) / 1.0274912517;
  const rAU = 1.5236 * (1.00436 - 0.09309 * Math.cos(Mr) - 0.004336 * Math.cos(2 * Mr) - 0.00031 * Math.cos(3 * Mr) - 0.00003 * Math.cos(4 * Mr));
  return { msd, ls, decl, eot, mst, rAU };
}

/** Local true solar time (hours) at an east longitude. */
export function ltstAt(d: MarsDate, lonEast: number): number {
  const lmst = mod(d.mst + lonEast / 15, 24);
  return mod(lmst + d.eot / 15, 24);
}

export interface SunState {
  ltst: number; // hours
  elevation: number; // degrees above the horizon
  azimuth: number; // degrees clockwise from north
  /** Unit vector toward the Sun in the world frame (+x east, +y up, −z north). */
  dir: { x: number; y: number; z: number };
  /** Direct + diffuse irradiance on a horizontal panel, W/m². */
  irradiance: number;
}

/** Sun position for a latitude, declination and LTST (hours). */
export function sunAt(latDeg: number, declDeg: number, ltst: number, rAU: number, tau = 0.6): SunState {
  const H = (ltst - 12) * 15 * d2r; // hour angle, positive in the afternoon
  const phi = latDeg * d2r;
  const del = declDeg * d2r;
  const e = -Math.cos(del) * Math.sin(H);
  const n = Math.sin(del) * Math.cos(phi) - Math.cos(del) * Math.sin(phi) * Math.cos(H);
  const u = Math.sin(del) * Math.sin(phi) + Math.cos(del) * Math.cos(phi) * Math.cos(H);
  const elevation = Math.asin(Math.max(-1, Math.min(1, u))) / d2r;
  const azimuth = mod(Math.atan2(e, n) / d2r, 360);
  const top = 1361 / (rAU * rAU);
  // Beer–Lambert direct beam through a dusty column plus a simple diffuse share.
  const mu = Math.max(0, u);
  const irradiance = mu > 0.01 ? top * mu * (Math.exp(-tau / mu) + 0.35 * (1 - Math.exp(-tau / mu))) : 0;
  return { ltst, elevation, azimuth, dir: { x: e, y: u, z: -n }, irradiance };
}

/** Find the LTST (hours) of sunset for a site (Sun crossing 0° after noon). */
export function sunsetLtst(latDeg: number, declDeg: number): number {
  const phi = latDeg * d2r;
  const del = declDeg * d2r;
  const c = -Math.tan(phi) * Math.tan(del);
  if (c <= -1) return 24; // polar day
  if (c >= 1) return 12; // polar night
  return 12 + Math.acos(c) / d2r / 15;
}

export const formatHours = (h: number) => {
  const hh = Math.floor(mod(h, 24));
  const mm = Math.floor((mod(h, 24) - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

/**
 * Simple diurnal ground temperature model (°C) driven by the Sun elevation,
 * with a thermal lag of about 1.5 h. Ranges are tuned to REMS-like values for
 * an equatorial site (≈ −85 °C before dawn, ≈ 0…+10 °C early afternoon).
 */
export function groundTempC(ltst: number, latDeg: number, declDeg: number, rAU: number): number {
  const lagged = sunAt(latDeg, declDeg, ltst - 1.5, rAU);
  const s = Math.max(0, Math.sin(lagged.elevation * d2r));
  const seasonal = 1 / (rAU * rAU) / (1 / (1.52 * 1.52));
  return -85 + 92 * Math.pow(s, 0.75) * seasonal;
}
