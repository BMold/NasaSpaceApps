// Analytic model of the Martian sky: sunlight scattered by suspended dust.
//
// One GLSL function (marsSky) is shared by the sky dome, the haze of the far
// terrain and the environment map, and mirrored in TypeScript (skyRadiance)
// to derive the sun light, the ambient light, the fog colour and the exposure.
// That is what keeps ground, haze and sky consistent with each other.
//
// Physics kept: single scattering through a dust layer of optical depth tau
// (exact slab solution), a strongly forward-peaked phase function that is
// narrower in blue (blue glow around the Sun, butterscotch sky elsewhere),
// dust that absorbs blue (single-scattering albedo 0.975 / 0.885 / 0.70), and a
// diffuse multiple-scattering term fitted so that the direct / diffuse split
// on the ground matches published values for Mars (tau 0.6: about half each).

/**
 * Fraction of the dust optical depth that removes light from the sunbeam. Dust scatters about
 * half of what it intercepts into a glow within 30° of the Sun; an object that hides the Sun hides
 * that glow too, so it is carried by the sun light (and left out of the ambient light).
 */
export const BEAM_TAU = 0.48;
const FOUR_PI = 4 * Math.PI;
const W0 = [0.975, 0.885, 0.7];
const GF = [0.7, 0.745, 0.82];
const GB = -0.3;
const FWD = 0.88;
const KMS = 1.75;
const ENV_COS = Math.cos((30 * Math.PI) / 180);

export const SKY_GLSL = /* glsl */ `
const vec3 SKY_W0 = vec3(${W0.join(', ')});
const vec3 SKY_GF = vec3(${GF.join(', ')});
const float SKY_ENV_COS = ${ENV_COS.toFixed(6)};
float skyAirmass(float mu) { float m = max(mu, 0.0); return 1.0 / (m + 0.045 * exp(-10.0 * m)); }
vec3 skyPhase(float c) {
  vec3 g2 = SKY_GF * SKY_GF;
  vec3 fwd = (1.0 - g2) / pow(max(vec3(1e-4), 1.0 + g2 - 2.0 * SKY_GF * c), vec3(1.5));
  float back = ${(1 - GB * GB).toFixed(4)} / pow(${(1 + GB * GB).toFixed(4)} - ${(2 * GB).toFixed(4)} * c, 1.5);
  return fwd * ${FWD.toFixed(2)} + back * ${(1 - FWD).toFixed(2)};
}
/** Sky radiance towards v (world, unit). envMode 1 leaves out the bright core around the Sun (the sun light carries it). */
vec3 marsSky(vec3 v, vec3 sunDir, float tau, float sunE, float envMode) {
  float mV = skyAirmass(v.y);
  float mS = skyAirmass(sunDir.y);
  float a = tau * mS;
  float b = tau * mV;
  float f = abs(mV - mS) < 0.02 ? b * exp(-b) : mV * (exp(-a) - exp(-b)) / (mV - mS);
  float c = dot(v, sunDir);
  c = mix(c, min(c, SKY_ENV_COS), envMode);
  vec3 single = SKY_W0 * skyPhase(c) * f;
  float day = smoothstep(-0.12, 0.10, sunDir.y);
  vec3 w2 = SKY_W0 * SKY_W0;
  vec3 multi = w2 * w2 * ${KMS.toFixed(2)} * (1.0 - exp(-0.55 * b)) * exp(-0.22 * a) * day;
  return sunE * (single * day + multi) / ${FOUR_PI.toFixed(5)};
}
`;

const airmass = (mu: number) => {
  const m = Math.max(mu, 0);
  return 1 / (m + 0.045 * Math.exp(-10 * m));
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Same as the GLSL marsSky, for sunE = 1. */
export function skyRadiance(vx: number, vy: number, vz: number, sun: Vec3Like, tau: number, envMode: boolean, out: number[]) {
  const mV = airmass(vy);
  const mS = airmass(sun.y);
  const a = tau * mS;
  const b = tau * mV;
  const f = Math.abs(mV - mS) < 0.02 ? b * Math.exp(-b) : (mV * (Math.exp(-a) - Math.exp(-b))) / (mV - mS);
  let c = vx * sun.x + vy * sun.y + vz * sun.z;
  if (envMode) c = Math.min(c, ENV_COS);
  const day = smooth(-0.12, 0.1, sun.y);
  const back = (1 - GB * GB) / Math.pow(1 + GB * GB - 2 * GB * c, 1.5);
  const ms = KMS * (1 - Math.exp(-0.55 * b)) * Math.exp(-0.22 * a) * day;
  for (let i = 0; i < 3; i++) {
    const g = GF[i];
    const fwd = (1 - g * g) / Math.pow(Math.max(1e-4, 1 + g * g - 2 * g * c), 1.5);
    const w2 = W0[i] * W0[i];
    out[i] = (W0[i] * (fwd * FWD + back * (1 - FWD)) * f * day + w2 * w2 * ms) / FOUR_PI;
  }
  return out;
}

export interface SkyLight {
  /** Irradiance of the sharp sunbeam on a plane facing the Sun (sunE = 1), per channel. */
  beam: [number, number, number];
  /** Irradiance of the sky (without the solar core) on horizontal ground. */
  skyIrradiance: [number, number, number];
  /** Mean radiance of the sky just above the horizon: the colour of distant haze. */
  horizon: [number, number, number];
  /** Mean radiance near the zenith. */
  zenith: [number, number, number];
}

const tmp = [0, 0, 0];

/** Integrates the sky model: what the Sun and the sky deliver to the ground. */
export function skyLight(sun: Vec3Like, tau: number): SkyLight {
  const mS = airmass(sun.y);
  const day = smooth(-0.02, 0.06, sun.y);
  // Low Sun: the long path reddens the beam a little before the blue glow takes over.
  const t = Math.exp(-BEAM_TAU * tau * mS) * day;
  const warm = Math.exp(-0.035 * tau * mS);
  const beam: [number, number, number] = [t, t * (0.93 + 0.07 * warm), t * (0.84 + 0.16 * warm)];

  const E: [number, number, number] = [0, 0, 0];
  const hor: [number, number, number] = [0, 0, 0];
  const zen: [number, number, number] = [0, 0, 0];
  const NA = 24;
  const NE = 12;
  let nh = 0;
  for (let j = 0; j < NE; j++) {
    const mu = (j + 0.5) / NE; // cos(zenith), uniform in solid angle
    const s = Math.sqrt(1 - mu * mu);
    for (let i = 0; i < NA; i++) {
      const az = ((i + 0.5) / NA) * Math.PI * 2;
      skyRadiance(Math.cos(az) * s, mu, Math.sin(az) * s, sun, tau, true, tmp);
      const w = (mu * 2 * Math.PI) / (NA * NE);
      E[0] += tmp[0] * w;
      E[1] += tmp[1] * w;
      E[2] += tmp[2] * w;
    }
  }
  for (let i = 0; i < NA; i++) {
    const az = ((i + 0.5) / NA) * Math.PI * 2;
    const c = Math.cos(az) * sun.x + Math.sin(az) * sun.z;
    if (c > 0.82) continue; // the glow around a low Sun is added per pixel by the haze shader
    skyRadiance(Math.cos(az) * 0.9994, 0.035, Math.sin(az) * 0.9994, sun, tau, true, tmp);
    hor[0] += tmp[0];
    hor[1] += tmp[1];
    hor[2] += tmp[2];
    nh++;
  }
  skyRadiance(0.05, 0.9987, 0, sun, tau, true, zen);
  return { beam, skyIrradiance: E, horizon: [hor[0] / nh, hor[1] / nh, hor[2] / nh], zenith: [zen[0], zen[1], zen[2]] };
}
