// Real topography of Gale crater around the site, baked by scripts/bake-gale.py:
//   mid  ±5.5 km, 21 m per sample  (MRO HiRISE DEM, feathered into MOLA)
//   far  ±110 km, 573 m per sample (MGS MOLA)
// Heights are metres relative to the site. If the files are missing the land
// beyond the site falls back to a synthetic crater with the same layout.
import * as THREE from 'three';
import { fbm, ridged } from '../lib/noise';
import { regionUniforms } from './groundMaterial';
import { Q } from './quality';

export interface GaleSite {
  lat: number;
  lon: number;
  sol: number;
  elevation: number;
  tilt: { east: number; north: number };
  midDem: { n: number; half: number; unit: number };
  farDem: { n: number; half: number; unit: number };
}

export const gale = {
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'missing',
  site: null as GaleSite | null,
  mid: null as Int16Array | null,
  far: null as Int16Array | null,
};

const BASE = import.meta.env.BASE_URL;
let pending: Promise<boolean> | null = null;

/** Load the baked DEMs and imagery once. Resolves false if they are not there. */
export function loadGale(): Promise<boolean> {
  pending ??= (async () => {
    gale.status = 'loading';
    try {
      const site = (await (await fetch(`${BASE}gale/site.json`)).json()) as GaleSite;
      const [mid, far] = await Promise.all(
        ['mid-dem.bin', 'far-dem.bin'].map(async (f) => {
          const res = await fetch(`${BASE}gale/${f}`);
          if (!res.ok) throw new Error(f);
          return new Int16Array(await res.arrayBuffer());
        }),
      );
      if (mid.length !== site.midDem.n ** 2 || far.length !== site.farDem.n ** 2) throw new Error('size');
      gale.site = site;
      gale.mid = mid;
      gale.far = far;
      gale.status = 'ready';
      loadRegionImagery();
      return true;
    } catch {
      gale.status = 'missing';
      return false;
    }
  })();
  return pending;
}

function loadRegionImagery() {
  const loader = new THREE.TextureLoader();
  let left = 3;
  const one = (file: string, slot: 'uMidAlb' | 'uRegAlb' | 'uFarAlb') => {
    const t = loader.load(`${BASE}gale/${file}`, () => {
      if (--left === 0) regionUniforms.uRegionOn.value = 1;
    });
    t.flipY = false;
    t.colorSpace = THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = Q.aniso;
    regionUniforms[slot].value = t;
  };
  one('mid-hirise.jpg', 'uMidAlb');
  one('regional-ctx.jpg', 'uRegAlb');
  one('far-ctx.jpg', 'uFarAlb');
}

/** Catmull-Rom bicubic sample of a square Int16 grid covering ±half metres. */
function sampleGrid(a: Int16Array, n: number, half: number, x: number, z: number): number {
  const fx = Math.min(n - 1, Math.max(0, ((x + half) / (2 * half)) * n - 0.5));
  const fz = Math.min(n - 1, Math.max(0, ((z + half) / (2 * half)) * n - 0.5));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const w = (t: number, out: number[]) => {
    const t2 = t * t;
    const t3 = t2 * t;
    out[0] = -0.5 * t3 + t2 - 0.5 * t;
    out[1] = 1.5 * t3 - 2.5 * t2 + 1;
    out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    out[3] = 0.5 * t3 - 0.5 * t2;
  };
  w(tx, wx);
  w(tz, wz);
  let sum = 0;
  for (let dj = 0; dj < 4; dj++) {
    const jj = Math.min(n - 1, Math.max(0, j + dj - 1)) * n;
    let row = 0;
    for (let di = 0; di < 4; di++) row += a[jj + Math.min(n - 1, Math.max(0, i + di - 1))] * wx[di];
    sum += row * wz[dj];
  }
  return sum;
}
const wx = [0, 0, 0, 0];
const wz = [0, 0, 0, 0];

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Stand-in for the real data: a crater floor, a central mound to the south-east and a far rim. */
function syntheticRegion(x: number, z: number): number {
  const mound = 4600 * Math.exp(-((x - 16000) ** 2 + (z - 24000) ** 2) / (2 * 15000 ** 2));
  const rc = Math.hypot(x - 24000, z - 34000);
  const rim = 3200 * Math.exp(-(((rc - 77000) / 11000) ** 2));
  const slope = 900 * Math.tanh((0.06 * x + 0.15 * z) / 900);
  return slope + mound + rim - 4600 * Math.exp(-(16000 ** 2 + 24000 ** 2) / (2 * 15000 ** 2));
}

/** Height of the land around the site, metres relative to the site (before the planet's curvature). */
export function regionalHeight(x: number, z: number): number {
  let h: number;
  if (gale.status === 'ready' && gale.site && gale.mid && gale.far) {
    const { midDem, farDem } = gale.site;
    h = sampleGrid(gale.far, farDem.n, farDem.half, x, z) * farDem.unit;
    const edge = Math.max(Math.abs(x), Math.abs(z)) / midDem.half;
    if (edge < 1) h += (sampleGrid(gale.mid, midDem.n, midDem.half, x, z) * midDem.unit - h) * (1 - sstep(0.86, 0.99, edge));
  } else h = syntheticRegion(x, z);
  // Relief the data cannot resolve: gullies and benches on the slopes, more of it where only MOLA (573 m) exists.
  const r = Math.hypot(x, z);
  const fine = fbm(x / 160 + 7.3, z / 160 - 2.1, 4) * 5.5 * sstep(200, 1200, r);
  const coarse = (ridged(x / 2600 + 1.7, z / 2600 + 9.2, 4) - 0.45) * 190 * sstep(5200, 13000, r);
  const mid = fbm(x / 700 - 3.1, z / 700 + 5.4, 4) * 26 * sstep(4800, 9000, r);
  return h + fine + mid + coarse;
}
