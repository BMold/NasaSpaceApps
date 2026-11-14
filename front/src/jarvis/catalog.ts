// JARVIS: what is out there, and what the database already knows.
//
// SIMULATED, stated as such: there is no camera neural network here. The scene
// knows its own objects (boulders, CRISM sites, habitat, hazards, the field
// anomalies below), and "detection" is what a suit sensor would report: the
// objects in its field of view, in range and in line of sight, with a measured
// size. The "database" is a simulated orbital survey (HiRISE resolves boulders
// of ~0.5 m and up): most large boulders are catalogued with measurement noise,
// some are missing, and the field anomalies are not in it at all.
//
// Matching = nearest catalogue entry of the same class, scored on position and
// size (and shape): ≥ 75 % catalogued, 45–75 % similar (check), below → NEW.
// A NEW object is "worth documenting" when it is unusual (an anomaly class),
// large, or sits next to a mineral site.
import { mulberry32 } from '../lib/noise';
import { BASE_A, ROCKS, heightAt, terrainInfo, type XZ } from '../lib/terrain';
import { SITES } from '../lib/sites';

export type Clase = 'roca' | 'bloque' | 'meteorito' | 'veta' | 'concrecion' | 'sitio' | 'habitat' | 'peligro';

export const CLASE_NOMBRE: Record<Clase, string> = {
  roca: 'Roca',
  bloque: 'Bloque',
  meteorito: 'Posible meteorito metálico',
  veta: 'Veta clara (posible sulfato de calcio)',
  concrecion: 'Concreciones oscuras',
  sitio: 'Sitio CRISM',
  habitat: 'Hábitat',
  peligro: 'Peligro',
};

/** Something in the field (ground truth of the scene). */
export interface FieldObject {
  id: string;
  clase: Clase;
  x: number;
  z: number;
  /** Bounding radius (m) and height of its centre above the ground (m). */
  r: number;
  h: number;
  /** Shape ratio (height / width), for the matching. */
  forma: number;
  nota?: string;
}

/** A catalogue entry: what the orbital survey measured (with noise). */
export interface DbEntry {
  id: string;
  clase: Clase;
  x: number;
  z: number;
  r: number;
  forma: number;
}

/** Field anomalies: real-looking finds the orbital survey cannot know (rendered by Anomalies.tsx). */
export interface Anomaly extends FieldObject {
  rot: number;
}

export const field = { objects: [] as FieldObject[], anomalies: [] as Anomaly[], db: [] as DbEntry[], version: -1, nDb: 0 };

const MIN_R = 0.25; // boulders of 0.5 m and up are worth reporting (and the size HiRISE starts to resolve)
const SURVEY_COVERAGE = 0.82; // fraction of those boulders in the orbital catalogue

/** Rebuild everything when the terrain (and so the boulders and sites) changes. Deterministic: seed 42. */
export function ensureField() {
  if (field.version === terrainInfo.version && field.objects.length) return field;
  field.version = terrainInfo.version;
  const rng = mulberry32(42);
  const objects: FieldObject[] = [];
  const db: DbEntry[] = [];

  ROCKS.forEach((r, i) => {
    if (r.s < MIN_R) return;
    const sy = r.sy ?? 0.8;
    const o: FieldObject = { id: `R-${String(i + 1).padStart(4, '0')}`, clase: r.s >= 0.8 ? 'bloque' : 'roca', x: r.x, z: r.z, r: r.s, h: r.s * sy * 0.5, forma: sy };
    objects.push(o);
    if (rng() < SURVEY_COVERAGE) {
      // Orbital measurement: ±0.4 m in position, ±12 % in size, shape from shadows (±15 %).
      db.push({ id: o.id, clase: o.clase, x: o.x + (rng() - 0.5) * 0.8, z: o.z + (rng() - 0.5) * 0.8, r: o.r * (1 + (rng() - 0.5) * 0.24), forma: o.forma * (1 + (rng() - 0.5) * 0.3) });
    }
  });

  for (const s of SITES) {
    if (!s.mineralKey) continue;
    const o: FieldObject = { id: s.code, clase: 'sitio', x: s.x, z: s.z, r: 1.5, h: 2.7, forma: 1, nota: s.mineral };
    objects.push(o);
    db.push({ id: o.id, clase: 'sitio', x: s.x, z: s.z, r: 1.5, forma: 1 });
  }
  objects.push({ id: 'H', clase: 'habitat', x: BASE_A.x - 7, z: BASE_A.z - 7, r: 6, h: 2, forma: 0.5 });
  db.push({ id: 'H', clase: 'habitat', x: BASE_A.x - 7, z: BASE_A.z - 7, r: 6, forma: 0.5 });

  // Anomalies near the first mineral sites (where a geologist would be looking).
  const kinds: Clase[] = ['meteorito', 'veta', 'concrecion'];
  const anomalies: Anomaly[] = [];
  SITES.filter((s) => s.mineralKey)
    .slice(0, 6)
    .forEach((s, i) => {
      const a = rng() * Math.PI * 2;
      const d = 7 + rng() * 6;
      const clase = kinds[i % kinds.length];
      const x = s.x + Math.cos(a) * d;
      const z = s.z + Math.sin(a) * d;
      const r = clase === 'meteorito' ? 0.32 + rng() * 0.15 : clase === 'veta' ? 0.7 : 0.45;
      anomalies.push({
        id: `A-${i + 1}`,
        clase,
        x,
        z,
        r,
        h: clase === 'veta' ? 0.08 : r * 0.6,
        forma: clase === 'veta' ? 0.15 : 0.8,
        rot: rng() * Math.PI,
        nota: `a ${d.toFixed(0)} m del sitio ${s.code}`,
      });
    });
  objects.push(...anomalies);

  field.objects = objects;
  field.anomalies = anomalies;
  field.db = db;
  field.nDb = db.length;
  return field;
}

export type Estado = 'catalogado' | 'similar' | 'nuevo';

export interface Match {
  estado: Estado;
  similitud: number; // 0..1 with the best entry
  ref: DbEntry | null;
  /** Worth documenting (0..1) and why. */
  interes: number;
  motivo: string;
}

/** Compare a detection with the catalogue (measured size, as a suit sensor would). */
export function matchObject(o: FieldObject, rMedido: number): Match {
  let best: DbEntry | null = null;
  let bs = 0;
  for (const e of field.db) {
    // Classes that cannot be confused are skipped; rock and boulder can (a size threshold).
    const compatible = e.clase === o.clase || ((e.clase === 'roca' || e.clase === 'bloque') && (o.clase === 'roca' || o.clase === 'bloque'));
    if (!compatible) continue;
    const dx = e.x - o.x;
    const dz = e.z - o.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 9) continue; // > 3 m away: not the same object
    const pos = Math.exp(-d2 / (2 * 0.6 * 0.6));
    const size = Math.exp(-((Math.log(rMedido / e.r) / 0.25) ** 2) / 2);
    const shape = Math.exp(-(((o.forma - e.forma) / 0.35) ** 2) / 2);
    const s = pos * (0.55 + 0.45 * size) * (0.7 + 0.3 * shape);
    if (s > bs) {
      bs = s;
      best = e;
    }
  }
  const estado: Estado = bs >= 0.75 ? 'catalogado' : bs >= 0.45 ? 'similar' : 'nuevo';
  // Interest: unusual classes first; then a big unknown boulder; a bonus next to a mineral site.
  let interes = 0;
  let motivo = '';
  if (o.clase === 'meteorito') [interes, motivo] = [0.95, 'composición metálica: no es roca local'];
  else if (o.clase === 'veta') [interes, motivo] = [0.85, 'material claro: posible agua en el pasado'];
  else if (o.clase === 'concrecion') [interes, motivo] = [0.75, 'concreciones: química en medio acuoso'];
  else if (estado === 'nuevo' && (o.clase === 'bloque' || o.clase === 'roca')) [interes, motivo] = [o.r >= 0.8 ? 0.5 : 0.25, 'no figura en el relevamiento orbital'];
  if (interes > 0) {
    const near = SITES.some((s) => s.mineralKey && Math.hypot(s.x - o.x, s.z - o.z) < 20);
    if (near) interes = Math.min(1, interes + 0.1);
  }
  return { estado, similitud: bs, ref: best, interes, motivo };
}

/** Ground height at an object's centre. */
export const objectCenterY = (o: FieldObject) => heightAt(o.x, o.z) + o.h;

export const distXZ = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z);
