// JARVIS detector (simulated sensor, see catalog.ts): 10 times a second, the
// objects inside the view frustum, in range and in line of sight (the terrain
// can hide them), with a measured size whose error grows with distance; each
// is compared with the orbital catalogue. NEW objects worth documenting go to
// the findings log (once each).
import * as THREE from 'three';
import { heightAt } from '../lib/terrain';
import { sceneToEnu } from '../lib/realTerrain';
import { missionView } from '../mission/mission';
import { mission } from '../mission/mission';
import { ensureField, matchObject, objectCenterY, type FieldObject, type Match } from './catalog';

export interface Detection {
  o: FieldObject;
  d: number;
  rMedido: number;
  m: Match;
  prioridad: number;
}

export interface Hallazgo {
  id: string;
  clase: FieldObject['clase'];
  motivo: string;
  interes: number;
  /** ENU position (m) and when (simulated minutes in a mission, else real seconds since start). */
  x: number;
  y: number;
  cuando: string;
}

export const jarvis = {
  /** JARVIS view (detections, compass, panels) or the clean normal view. Shared by laptop and phone. */
  on: true,
  detections: [] as Detection[],
  hallazgos: [] as Hallazgo[],
  vistos: 0,
  version: 0,
};

const RANGE: Record<FieldObject['clase'], number> = {
  roca: 28,
  bloque: 45,
  meteorito: 30,
  veta: 25,
  concrecion: 18,
  sitio: 160,
  habitat: 400,
  peligro: 80,
};
const MAX_SHOWN = 8;

const frustum = new THREE.Frustum();
const pv = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const center = new THREE.Vector3();

/** Deterministic per-object noise in [−1, 1]. */
const hashNoise = (id: string) => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967295) * 2 - 1;
};

function lineOfSight(from: THREE.Vector3, to: THREE.Vector3) {
  const n = 12;
  for (let i = 1; i < n; i++) {
    const k = i / n;
    const x = from.x + (to.x - from.x) * k;
    const z = from.z + (to.z - from.z) * k;
    const y = from.y + (to.y - from.y) * k;
    if (heightAt(x, z) > y + 0.15) return false;
  }
  return true;
}

let clock = 0;
const t0 = performance.now();

export function stepDetector(camera: THREE.Camera, dt: number) {
  clock += dt;
  if (clock < 0.1) return;
  clock = 0;
  if (!jarvis.on) {
    if (jarvis.detections.length) {
      jarvis.detections = [];
      jarvis.version++;
    }
    return;
  }
  const f = ensureField();
  camera.updateMatrixWorld();
  pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(pv);
  const eye = camera.position;

  // Mission hazards are detections too (from the peligro messages).
  const hazards: FieldObject[] = missionView.activo ? missionView.peligros.map((p) => ({ id: p.id, clase: 'peligro', x: p.x, z: p.z, r: p.r, h: 1, forma: 1 })) : [];

  const out: Detection[] = [];
  for (const o of [...f.objects, ...hazards]) {
    const d = Math.hypot(o.x - eye.x, o.z - eye.z);
    if (d > RANGE[o.clase] || d < 0.6) continue;
    center.set(o.x, objectCenterY(o), o.z);
    sphere.set(center, Math.max(0.3, o.r));
    if (!frustum.intersectsSphere(sphere)) continue;
    if (o.clase !== 'habitat' && o.clase !== 'sitio' && !lineOfSight(eye, center)) continue;
    // Range-finder error: 2 % + 0.25 % per metre.
    const rMedido = o.r * (1 + hashNoise(o.id) * (0.02 + 0.0025 * d));
    const m = o.clase === 'peligro' ? { estado: 'nuevo' as const, similitud: 0, ref: null, interes: 0, motivo: 'peligro reportado' } : matchObject(o, rMedido);
    const prioridad = (o.clase === 'peligro' ? 4 : 0) + m.interes * 3 + (m.estado === 'nuevo' ? 0.6 : 0) + (o.clase === 'sitio' ? 1 : 0) - d / 40;
    out.push({ o, d, rMedido, m, prioridad });

    if (m.estado === 'nuevo' && m.interes >= 0.5 && !jarvis.hallazgos.some((h) => h.id === o.id)) {
      const enu = sceneToEnu(o.x, o.z);
      jarvis.hallazgos.unshift({
        id: o.id,
        clase: o.clase,
        motivo: m.motivo,
        interes: m.interes,
        x: Math.round(enu.x * 10) / 10,
        y: Math.round(enu.y * 10) / 10,
        cuando: mission.modo !== 'libre' ? `min ${(mission.t / 60).toFixed(1)}` : `${Math.round((performance.now() - t0) / 1000)} s`,
      });
    }
  }
  out.sort((a, b) => b.prioridad - a.prioridad);
  jarvis.vistos = out.length;
  jarvis.detections = out.slice(0, MAX_SHOWN);
  jarvis.version++;
}

// Development hook for automated checks (same module instances as the app).
if (import.meta.env.DEV && typeof window !== 'undefined') (window as unknown as { __aresJarvis?: unknown }).__aresJarvis = { jarvis, field: () => ensureField() };
