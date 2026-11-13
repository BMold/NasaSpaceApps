// NASA Mars Trek (https://trek.nasa.gov/mars) WMTS integration.
//
// Two ways of building the site:
//  • 'hires' (Gale): a true-scale 240 m site centred on Curiosity's latest
//    reported position (NASA MMGIS feed). Surface image from the HiRISE
//    Curiosity mosaic (0.64 m/px at zoom 16) and regional slope fitted on the
//    HiRISE Gale DEM. The 8-bit DEM tiles were calibrated against 174 traverse
//    elevations: elevation ≈ −4600 m + 18.613 m × DN (RMS 5.7 m).
//  • 'analog' (Jezero, Meridiani): a 1.6° crop of the global MOLA DEM and
//    Viking colour mosaic compressed into the 240 m site (shape only).
import type { GridData } from './terrain';

const TREK = 'https://trek.nasa.gov/tiles/Mars/EQ';
const M_PER_DEG = 59157; // metres per degree of latitude (R = 3389.5 km)

interface Layer {
  id: string;
  ext: 'png' | 'jpg';
  maxZoom: number;
  label: string;
}

export const TREK_LAYERS: Record<'dem' | 'albedo' | 'hirise' | 'galeDem', Layer> = {
  dem: { id: 'Mars_MGS_MOLA_DEM_mosaic_global_463m_8', ext: 'png', maxZoom: 5, label: 'MGS MOLA DEM 463 m' },
  albedo: { id: 'Mars_Viking_MDIM21_ClrMosaic_global_232m', ext: 'jpg', maxZoom: 7, label: 'Viking MDIM 2.1 colour 232 m' },
  hirise: { id: 'curiosity_hirise_mosaic', ext: 'png', maxZoom: 16, label: 'MRO HiRISE Curiosity mosaic 0.64 m' },
  galeDem: { id: 'Gale_DEM_SMG_1m', ext: 'png', maxZoom: 14, label: 'MRO HiRISE Gale DEM (8-bit)' },
};

const GALE_DEM_CAL = { mPerDN: 18.613, offset: -4600 };

export interface Region {
  id: string;
  name: string;
  mission: string;
  lat: number;
  lon: number;
  span: number; // degrees (analog mode)
  mode: 'hires' | 'analog' | 'procedural';
  feed?: string; // MMGIS JSON with the rover's latest waypoint
  sol?: number;
}

export const REGIONS: Region[] = [
  {
    id: 'gale',
    name: 'Gale Crater · Mount Sharp (true scale)',
    mission: 'Curiosity (MSL)',
    lat: -4.82525828,
    lon: 137.3889348,
    span: 0,
    mode: 'hires',
    // Last Curiosity waypoint read from NASA MMGIS on 2026-11-09 (sol 5069). The
    // feed blocks browser CORS requests, so it is baked in; set `feed` to try it.
    sol: 5069,
  },
  { id: 'jezero', name: 'Jezero Crater · western delta (analog)', mission: 'Perseverance (M2020)', lat: 18.44, lon: 77.45, span: 1.6, mode: 'analog' },
  { id: 'meridiani', name: 'Meridiani Planum · Endeavour rim (analog)', mission: 'Opportunity (MER-B)', lat: -2.3, lon: -5.3, span: 1.6, mode: 'analog' },
  { id: 'procedural', name: 'Procedural analog site', mission: 'Offline', lat: 0, lon: 0, span: 0, mode: 'procedural' },
];

export const tileUrl = (layer: Layer, z: number, row: number, col: number) =>
  `${TREK}/${layer.id}/1.0.0/default/default028mm/${z}/${row}/${col}.${layer.ext}`;

function loadImage(url: string, timeoutMs = 15000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error(`timeout ${url}`)), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`failed ${url}`));
    };
    img.src = url;
  });
}

/** Stitch the WMTS tiles covering a lat/lon box and resample it to outW × outH. */
async function fetchBox(layer: Layer, z: number, latMin: number, latMax: number, lonMin: number, lonMax: number, outW: number, outH: number): Promise<ImageData> {
  const deg = 180 / 2 ** z; // tile size in degrees (equirectangular, 2×1 tiles at z=0)
  const c0 = Math.floor((lonMin + 180) / deg);
  const c1 = Math.floor((lonMax + 180) / deg);
  const r0 = Math.floor((90 - latMax) / deg);
  const r1 = Math.floor((90 - latMin) / deg);
  const mosaic = document.createElement('canvas');
  mosaic.width = (c1 - c0 + 1) * 256;
  mosaic.height = (r1 - r0 + 1) * 256;
  const mctx = mosaic.getContext('2d')!;
  const jobs: Promise<void>[] = [];
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++)
      jobs.push(loadImage(tileUrl(layer, z, r, c)).then((img) => mctx.drawImage(img, (c - c0) * 256, (r - r0) * 256, 256, 256)));
  await Promise.all(jobs);
  const sx = ((lonMin + 180) / deg - c0) * 256;
  const sy = ((90 - latMax) / deg - r0) * 256;
  const sw = ((lonMax - lonMin) / deg) * 256;
  const sh = ((latMax - latMin) / deg) * 256;
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(mosaic, sx, sy, sw, sh, 0, 0, outW, outH);
  return ctx.getImageData(0, 0, outW, outH);
}

function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += src[j * n + Math.min(n - 1, Math.max(0, i + k))];
      tmp[j * n + i] = s / (2 * radius + 1);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[Math.min(n - 1, Math.max(0, j + k)) * n + i];
      dst[j * n + i] = s / (2 * radius + 1);
    }
  return dst;
}

export interface SiteInfo {
  lat: number;
  lon: number;
  sol: number | null;
  elevation: number | null; // metres, Mars geoid
  slopeDeg: number; // regional slope fitted on the DEM
  uphillAzimuth: number; // degrees from north
  live: boolean; // position came from the live feed
}

export interface TrekData {
  dem: GridData | null; // normalised macro relief (analog mode)
  albedo: GridData | null;
  hiRes: boolean;
  tilt: { east: number; north: number }; // metres of rise per metre
  demRange: number;
  albedoPreview: string | null;
  site: SiteInfo;
}

async function latestWaypoint(region: Region): Promise<{ lat: number; lon: number; sol: number | null; elev: number | null; live: boolean }> {
  const fallback = { lat: region.lat, lon: region.lon, sol: region.sol ?? null, elev: null, live: false };
  if (!region.feed) return fallback;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${region.feed}?t=${Math.floor(Date.now() / 3.6e6)}`, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    const json = await res.json();
    const p = json?.features?.[0]?.properties;
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') return fallback;
    // Only accept positions inside the HiRISE mosaic coverage.
    if (p.lat < -4.92 || p.lat > -4.25 || p.lon < 137.13 || p.lon > 137.72) return fallback;
    return { lat: p.lat, lon: p.lon, sol: p.sol ?? null, elev: p.elev_geoid ?? null, live: true };
  } catch {
    return fallback;
  }
}

/** Least-squares plane z = a·east + b·north + c over a calibrated DEM window. */
function fitPlane(img: ImageData, widthM: number, heightM: number) {
  let n = 0;
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (let j = 0; j < img.height; j++)
    for (let i = 0; i < img.width; i++) {
      const k = (j * img.width + i) * 4;
      if (img.data[k + 3] < 200) continue;
      const zM = GALE_DEM_CAL.offset + GALE_DEM_CAL.mPerDN * img.data[k];
      const x = ((i + 0.5) / img.width - 0.5) * widthM; // east
      const y = (0.5 - (j + 0.5) / img.height) * heightM; // north
      n++;
      sx += x; sy += y; sz += zM; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * zM; syz += y * zM;
    }
  if (n < 50) return null;
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  const cxz = sxz / n - mx * mz, cyz = syz / n - my * mz;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < 1e-9) return null;
  return { east: (cxz * cyy - cyz * cxy) / det, north: (cyz * cxx - cxz * cxy) / det, mean: mz };
}

/**
 * The Gale site baked by scripts/bake-gale.py (same NASA sources, already
 * cropped and calibrated). Served by this app, so the phone and the laptop
 * get the identical site without reaching trek.nasa.gov.
 */
async function loadBakedSite(): Promise<TrekData | null> {
  try {
    const base = import.meta.env.BASE_URL;
    const res = await fetch(`${base}gale/site.json`);
    if (!res.ok) return null;
    const site = (await res.json()) as { lat: number; lon: number; sol: number; elevation: number; tilt: { east: number; north: number } };
    const img = await loadImage(`${base}gale/site-hirise.jpg`, 20000);
    const N = img.naturalWidth;
    const c = document.createElement('canvas');
    c.width = N;
    c.height = N;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, N, N);
    const data = new Float32Array(N * N * 3);
    for (let k = 0; k < N * N; k++) data[k * 3] = data[k * 3 + 1] = data[k * 3 + 2] = px.data[k * 4] / 255;
    const g = Math.hypot(site.tilt.east, site.tilt.north);
    return {
      dem: null,
      albedo: { data, n: N },
      hiRes: true,
      tilt: site.tilt,
      demRange: 0,
      albedoPreview: c.toDataURL('image/jpeg', 0.85),
      site: {
        lat: site.lat,
        lon: site.lon,
        sol: site.sol,
        elevation: site.elevation,
        slopeDeg: (Math.atan(g) * 180) / Math.PI,
        uphillAzimuth: ((Math.atan2(site.tilt.east, site.tilt.north) * 180) / Math.PI + 360) % 360,
        live: false,
      },
    };
  } catch {
    return null;
  }
}

async function loadHiRes(region: Region): Promise<TrekData> {
  const baked = await loadBakedSite();
  if (baked) return baked;
  const wp = await latestWaypoint(region);
  const cosLat = Math.cos((wp.lat * Math.PI) / 180);
  const half = 120; // metres
  const dLat = half / M_PER_DEG;
  const dLon = half / (M_PER_DEG * cosLat);
  const N = 512;
  const img = await fetchBox(TREK_LAYERS.hirise, 16, wp.lat - dLat, wp.lat + dLat, wp.lon - dLon, wp.lon + dLon, N, N);

  // HiRISE RED is panchromatic: stretch it and tint it with a Mars palette.
  const gray = new Float32Array(N * N);
  let lo = 255, hi = 0;
  for (let k = 0; k < N * N; k++) {
    const v = img.data[k * 4];
    gray[k] = v;
    if (img.data[k * 4 + 3] > 0) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const span = Math.max(1, hi - lo);
  const data = new Float32Array(N * N * 3);
  const prev = document.createElement('canvas');
  prev.width = N;
  prev.height = N;
  const pctx = prev.getContext('2d')!;
  const pimg = pctx.createImageData(N, N);
  for (let k = 0; k < N * N; k++) {
    // Grey level 0..1: the ground shader maps it to Martian soil, sand and rock.
    const g = Math.min(1, Math.max(0, (gray[k] - lo) / span));
    data[k * 3] = data[k * 3 + 1] = data[k * 3 + 2] = g;
    const l = 0.18 + 0.82 * g;
    pimg.data[k * 4] = Math.min(255, l * 0.97 * 255);
    pimg.data[k * 4 + 1] = Math.min(255, l * 0.66 * 255);
    pimg.data[k * 4 + 2] = Math.min(255, l * 0.46 * 255);
    pimg.data[k * 4 + 3] = 255;
  }
  pctx.putImageData(pimg, 0, 0);

  // Regional slope: plane fitted on a 1.2 km window of the calibrated DEM.
  let tilt = { east: 0, north: 0 };
  let elevation = wp.elev;
  try {
    const W = 600;
    const dem = await fetchBox(
      TREK_LAYERS.galeDem,
      14,
      wp.lat - W / M_PER_DEG,
      wp.lat + W / M_PER_DEG,
      wp.lon - W / (M_PER_DEG * cosLat),
      wp.lon + W / (M_PER_DEG * cosLat),
      96,
      96,
    );
    const plane = fitPlane(dem, 2 * W, 2 * W);
    if (plane) {
      tilt = { east: plane.east, north: plane.north };
      elevation ??= plane.mean;
    }
  } catch {
    /* keep a flat regional plane */
  }
  const g = Math.hypot(tilt.east, tilt.north);
  return {
    dem: null,
    albedo: { data, n: N },
    hiRes: true,
    tilt,
    demRange: 0,
    albedoPreview: prev.toDataURL('image/jpeg', 0.85),
    site: {
      lat: wp.lat,
      lon: wp.lon,
      sol: wp.sol,
      elevation,
      slopeDeg: (Math.atan(g) * 180) / Math.PI,
      uphillAzimuth: ((Math.atan2(tilt.east, tilt.north) * 180) / Math.PI + 360) % 360,
      live: wp.live,
    },
  };
}

async function fetchRegion(layer: Layer, region: Region, outSize: number): Promise<ImageData> {
  return fetchBox(layer, layer.maxZoom, region.lat - region.span / 2, region.lat + region.span / 2, region.lon - region.span / 2, region.lon + region.span / 2, outSize, outSize);
}

async function loadAnalog(region: Region): Promise<TrekData> {
  const DEM_N = 128;
  const demImg = await fetchRegion(TREK_LAYERS.dem, region, DEM_N);
  let raw = new Float32Array(DEM_N * DEM_N);
  for (let k = 0; k < raw.length; k++) raw[k] = demImg.data[k * 4];
  raw = boxBlur(boxBlur(raw, DEM_N, 3), DEM_N, 2); // 8-bit terraces after upsampling
  let min = Infinity;
  let max = -Infinity;
  for (const v of raw) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = Math.max(1, max - min);
  for (let k = 0; k < raw.length; k++) raw[k] = (raw[k] - min) / span - 0.5;

  let albedo: GridData | null = null;
  let albedoPreview: string | null = null;
  try {
    const ALB_N = 192;
    const img = await fetchRegion(TREK_LAYERS.albedo, region, ALB_N);
    const data = new Float32Array(ALB_N * ALB_N * 3);
    for (let k = 0; k < ALB_N * ALB_N; k++) {
      data[k * 3] = img.data[k * 4] / 255;
      data[k * 3 + 1] = img.data[k * 4 + 1] / 255;
      data[k * 3 + 2] = img.data[k * 4 + 2] / 255;
    }
    albedo = { data, n: ALB_N };
    const c = document.createElement('canvas');
    c.width = ALB_N;
    c.height = ALB_N;
    c.getContext('2d')!.putImageData(img, 0, 0);
    albedoPreview = c.toDataURL('image/jpeg', 0.85);
  } catch {
    albedo = null;
  }
  return {
    dem: { data: raw, n: DEM_N },
    albedo,
    hiRes: false,
    tilt: { east: 0, north: 0 },
    demRange: max - min,
    albedoPreview,
    site: { lat: region.lat, lon: region.lon, sol: null, elevation: null, slopeDeg: 0, uphillAzimuth: 0, live: false },
  };
}

export async function loadMarsTrekRegion(region: Region): Promise<TrekData> {
  return region.mode === 'hires' ? loadHiRes(region) : loadAnalog(region);
}
