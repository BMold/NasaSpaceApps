// Real terrain package (repo `terreno/`, CLAUDE.md §6): USGS DEM, HiRISE
// orthophoto and the CRISM mineral sites, the same data the optimizer uses.
//
// Sources, in order:
//   1. Albert's backend   GET /api/v1/terreno, /api/v1/terreno/sitios, /api/v1/terreno/capas/elevacion
//   2. the package itself /terreno/…  (served by Vite / server.js straight from ../terreno, never copied)
//
// Frames. Package: local ENU, origin = SW corner, x = east, y = north, metres,
// .bin row 0 = SOUTH, orthophoto row 0 = NORTH. Scene: centred on the window,
// +x = east, −z = north (heading 0 = north). So:
//     scene.x = x − 240      scene.z = 240 − y
//
// `?terreno=procedural` keeps the old analog site (240 m, canyon, drone story).

export type Mineral = 'filosilicatos' | 'sulfatos' | 'hematita' | 'silice';

export interface SitioReal {
  id: number;
  x: number;
  y: number;
  valor: number;
  mineral: Mineral;
  masa_kg: number;
  perforacion_min: number;
  ventana: [number, number];
  lon?: number;
  lat?: number;
  fuente?: string;
}

export interface ManifestReal {
  sitio: string;
  fuente_dem: string;
  tam_celda_m: number;
  filas: number;
  columnas: number;
  fila_0: string;
  habitat: { id: string; x: number; y: number };
  georreferencia?: { esquina_sw: { lon_este_deg: number; lat_deg: number }; esquina_ne: { lon_este_deg: number; lat_deg: number } };
}

export interface RealPackage {
  manifest: ManifestReal;
  sitios: SitioReal[];
  /** Elevation, float32, row 0 = south (as stored). */
  elevacion: Float32Array;
  /** Orthophoto as a grey level 0..1, row 0 = north, n × n. */
  orto: { data: Float32Array; n: number } | null;
  /** Where the sites came from. */
  fuenteSitios: 'backend' | 'paquete';
  fuenteCapas: 'backend' | 'paquete';
}

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
const isDocPage = typeof location !== 'undefined' && /explicacion/.test(location.pathname);

/** Real terrain package (default) or the old procedural analog (`?terreno=procedural`). */
export const REAL = typeof location !== 'undefined' && !isDocPage && params.get('terreno') !== 'procedural';

/** Half side of the package window (480 m). */
export const REAL_HALF = 240;

export const enuToScene = (x: number, y: number) => ({ x: x - REAL_HALF, z: REAL_HALF - y });
export const sceneToEnu = (x: number, z: number) => ({ x: x + REAL_HALF, y: REAL_HALF - z });

/** Closed mineral list and the agreed colours and shapes (CLAUDE.md §7, §14). */
export const MINERALES: Record<Mineral, { color: string; forma: 'circulo' | 'rombo' | 'triangulo' | 'cuadrado'; nombre: string }> = {
  filosilicatos: { color: '#7F77DD', forma: 'circulo', nombre: 'Filosilicatos' },
  sulfatos: { color: '#D4537E', forma: 'rombo', nombre: 'Sulfatos' },
  hematita: { color: '#712B13', forma: 'triangulo', nombre: 'Hematita' },
  silice: { color: '#378ADD', forma: 'cuadrado', nombre: 'Sílice' },
};

// Optional read token for the backend (ARES_READ_TOKEN on Albert's side).
const TOKEN = (import.meta.env?.VITE_ARES_TOKEN as string | undefined) ?? '';
const headers: HeadersInit = TOKEN ? { 'X-API-Key': TOKEN } : {};

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res;
  } finally {
    clearTimeout(id);
  }
}

/** Backend first; if it is down (or not proxied), the package served from ../terreno. */
async function backendOr<T>(api: string, file: string, read: (r: Response) => Promise<T>): Promise<{ value: T; from: 'backend' | 'paquete' }> {
  try {
    const r = await fetchWithTimeout(api, 1500);
    // Vite answers unknown paths with index.html: make sure the backend really answered.
    if ((r.headers.get('content-type') ?? '').includes('text/html')) throw new Error('no backend');
    return { value: await read(r), from: 'backend' };
  } catch {
    return { value: await read(await fetchWithTimeout(file, 8000)), from: 'paquete' };
  }
}

const MINERAL_SET = new Set(Object.keys(MINERALES));

function validSites(raw: unknown): SitioReal[] {
  const list = (raw as { sitios?: unknown[] })?.sitios;
  if (!Array.isArray(list)) throw new Error('sitios.json sin lista "sitios"');
  return list.filter((s): s is SitioReal => {
    const o = s as SitioReal;
    return Number.isFinite(o?.x) && Number.isFinite(o?.y) && Number.isInteger(o?.id) && MINERAL_SET.has(o?.mineral);
  });
}

/** Orthophoto (1920², false colour IR/RED/BG) → grey level from the RED band, stretched 2–98 %. */
async function loadOrtho(url: string, n = 1024): Promise<{ data: Float32Array; n: number } | null> {
  try {
    const blob = await (await fetchWithTimeout(url, 15000)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, n, n);
    const px = ctx.getImageData(0, 0, n, n).data;
    const hist = new Uint32Array(256);
    for (let k = 0; k < n * n; k++) hist[px[k * 4 + 1]]++;
    const pct = (p: number) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= p * n * n) return v;
      return 255;
    };
    const lo = pct(0.02);
    const span = Math.max(1, pct(0.98) - lo);
    const data = new Float32Array(n * n * 3);
    for (let k = 0; k < n * n; k++) data[k * 3] = data[k * 3 + 1] = data[k * 3 + 2] = Math.min(1, Math.max(0, (px[k * 4 + 1] - lo) / span));
    return { data, n };
  } catch {
    return null;
  }
}

export async function loadRealPackage(): Promise<RealPackage> {
  const manifest = await backendOr('/api/v1/terreno', '/terreno/manifest.json', (r) => r.json() as Promise<ManifestReal>);
  const sitios = await backendOr('/api/v1/terreno/sitios', '/terreno/sitios.json', async (r) => validSites(await r.json()));
  const elev = await backendOr('/api/v1/terreno/capas/elevacion', '/terreno/elevacion.bin', (r) => r.arrayBuffer());
  const m = manifest.value;
  const n = m.filas * m.columnas;
  if (elev.value.byteLength !== n * 4) throw new Error(`elevacion.bin: ${elev.value.byteLength} bytes, se esperaban ${n * 4}`);
  if (m.fila_0 !== 'sur') throw new Error(`fila_0 = ${m.fila_0}: este visor espera "sur"`);
  // float32 little-endian (DataView: correct on any host byte order).
  const dv = new DataView(elev.value);
  const elevacion = new Float32Array(n);
  for (let k = 0; k < n; k++) elevacion[k] = dv.getFloat32(k * 4, true);
  const orto = await loadOrtho('/terreno/ortofoto.jpg');
  return { manifest: m, sitios: sitios.value, elevacion, orto, fuenteSitios: sitios.from, fuenteCapas: elev.from };
}

/** Bilinear height of the package DEM at a scene point (cell centres, clamped at the border). */
export function demSampler(pkg: RealPackage) {
  const { filas, columnas, tam_celda_m: cell } = pkg.manifest;
  const e = pkg.elevacion;
  return (x: number, z: number) => {
    const p = sceneToEnu(x, z);
    const fc = Math.min(columnas - 1, Math.max(0, p.x / cell - 0.5));
    const fr = Math.min(filas - 1, Math.max(0, p.y / cell - 0.5));
    const c0 = Math.min(columnas - 2, Math.floor(fc));
    const r0 = Math.min(filas - 2, Math.floor(fr));
    const tx = fc - c0;
    const tr = fr - r0;
    const k = r0 * columnas + c0;
    const a = e[k];
    const b = e[k + 1];
    const c = e[k + columnas];
    const d = e[k + columnas + 1];
    return (a * (1 - tx) + b * tx) * (1 - tr) + (c * (1 - tx) + d * tx) * tr;
  };
}

/** Least-squares plane of the DEM: mean height and rise per metre east / north. */
export function fitPlane(pkg: RealPackage) {
  const { filas, columnas, tam_celda_m: cell } = pkg.manifest;
  let sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  const n = filas * columnas;
  for (let i = 0; i < filas; i++)
    for (let j = 0; j < columnas; j++) {
      const x = (j + 0.5) * cell - REAL_HALF;
      const y = (i + 0.5) * cell - REAL_HALF;
      const z = pkg.elevacion[i * columnas + j];
      sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
    }
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
  const cxz = sxz / n - mx * mz, cyz = syz / n - my * mz;
  const det = cxx * cyy - cxy * cxy || 1;
  const east = (cxz * cyy - cyz * cxy) / det;
  const north = (cyz * cxx - cxz * cxy) / det;
  return { mean: mz - east * mx - north * my, east, north };
}
