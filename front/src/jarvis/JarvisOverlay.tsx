// JARVIS view: targeting frames on the detected objects, a heading tape and a
// summary on the visor. Frames and labels are placed AT the object's depth
// (sprites in the scene), so the Cardboard shows each one once per eye at the
// right distance; they keep a readable angular size however far the object is.
//
// Colours: catalogued = cyan · similar = white · NEW = magenta · ★ worth
// documenting = gold star · hazard = red (safety colour, CLAUDE.md §14).
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CLASE_NOMBRE, field, objectCenterY } from './catalog';
import { jarvis, stepDetector, type Detection } from './detector';
import { suitState } from '../vr/suit/state';
import { currentGoal, vr } from '../vr/vrEngine';
import { BASE_A } from '../lib/terrain';
import { SITES } from '../lib/sites';
import { missionView } from '../mission/mission';
import { LEVEL_COLOR } from '../hud/bio';

const FONT = 'ui-monospace, Consolas, "Courier New", monospace';
const COLORS = { catalogado: '#00f3ff', similar: '#e6edf5', nuevo: '#ff4fd8', peligro: LEVEL_COLOR.rojo, sitio: '#00f3ff' };
const STAR = '#ffd84d';
const SLOTS = 8;
const D = 0.6;
const fmt = (v: number, d = 1) => v.toFixed(d).replace('.', ',');

type Style = keyof typeof COLORS;
const styleOf = (det: Detection): Style => (det.o.clase === 'peligro' ? 'peligro' : det.o.clase === 'sitio' || det.o.clase === 'habitat' ? 'sitio' : det.m.estado);

/** Corner brackets, one texture per style. */
const frameTextures = new Map<Style, THREE.CanvasTexture>();
function frameTexture(s: Style) {
  let t = frameTextures.get(s);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.strokeStyle = COLORS[s];
  g.lineWidth = 9;
  g.shadowColor = COLORS[s];
  g.shadowBlur = 10;
  const L = 62;
  for (const [x, y, dx, dy] of [[12, 12, 1, 1], [244, 12, -1, 1], [12, 244, 1, -1], [244, 244, -1, -1]]) {
    g.beginPath();
    g.moveTo(x, y + dy * L);
    g.lineTo(x, y);
    g.lineTo(x + dx * L, y);
    g.stroke();
  }
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(128 - 14, 128);
  g.lineTo(128 + 14, 128);
  g.moveTo(128, 128 - 14);
  g.lineTo(128, 128 + 14);
  g.stroke();
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  frameTextures.set(s, t);
  return t;
}

function drawLabel(g: CanvasRenderingContext2D, w: number, h: number, det: Detection) {
  const s = styleOf(det);
  const col = COLORS[s];
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(4, 10, 20, 0.72)';
  g.strokeStyle = col;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(4, 4, w - 8, h - 8, 16);
  g.fill();
  g.stroke();
  const o = det.o;
  const tam = o.clase === 'roca' || o.clase === 'bloque' || o.clase === 'meteorito' || o.clase === 'veta' || o.clase === 'concrecion' ? ` · ${fmt(det.rMedido * 2)} m` : '';
  const titulo = o.clase === 'sitio' ? `${o.id} · ${o.nota ?? 'sitio'}` : o.clase === 'peligro' ? `PELIGRO ${o.id}` : `${CLASE_NOMBRE[o.clase]}${tam}`;
  g.fillStyle = col;
  let size = 50;
  g.font = `bold ${size}px ${FONT}`;
  while (size > 30 && g.measureText(titulo).width > w - 40) g.font = `bold ${(size -= 2)}px ${FONT}`;
  g.fillText(titulo, 22, 62);
  g.fillStyle = '#ffffff';
  g.font = `40px ${FONT}`;
  const m = det.m;
  const linea2 =
    o.clase === 'peligro'
      ? 'reportado por la telemetría'
      : m.estado === 'catalogado'
        ? `EN BD ${m.ref?.id ?? ''} · ${Math.round(m.similitud * 100)} %`
        : m.estado === 'similar'
          ? `PARECIDO a ${m.ref?.id ?? '?'} · ${Math.round(m.similitud * 100)} %`
          : 'NUEVO · no está en la BD';
  g.fillText(`${linea2}   ${Math.round(det.d)} m`, 22, 118);
  if (m.interes >= 0.5) {
    g.fillStyle = STAR;
    g.font = `bold 36px ${FONT}`;
    g.fillText(`★ VALE LA PENA DOCUMENTAR`, 22, 168);
    g.fillStyle = '#d8e6f2';
    g.font = `28px ${FONT}`;
    g.fillText(m.motivo, 22, 204);
  }
}

function Slot({ i }: { i: number }) {
  const frame = useRef<THREE.Sprite>(null);
  const label = useRef<THREE.Sprite>(null);
  const lab = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 720;
    c.height = 224;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { c, g: c.getContext('2d')!, t, key: '' };
  }, []);
  const frameMat = useMemo(() => new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }), []);
  const labelMat = useMemo(() => new THREE.SpriteMaterial({ map: lab.t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }), [lab]);
  useEffect(
    () => () => {
      lab.t.dispose();
      frameMat.dispose();
      labelMat.dispose();
    },
    [lab, frameMat, labelMat],
  );

  useFrame((state) => {
    const det = jarvis.detections[i];
    const f = frame.current;
    const l = label.current;
    if (!f || !l) return;
    f.visible = l.visible = !!det && jarvis.on;
    if (!det || !jarvis.on) return;
    const o = det.o;
    const cy = objectCenterY(o);
    const d = state.camera.position.distanceTo(new THREE.Vector3(o.x, cy, o.z));
    // Frame around the object, never smaller than ~2.6° so far objects stay visible.
    const fs = Math.max(o.r * 2.6, d * 0.045);
    frameMat.map = frameTexture(styleOf(det));
    f.position.set(o.x, cy, o.z);
    f.scale.set(fs, fs, 1);
    // Label of constant angular size (~11° wide) above the frame.
    const lw = Math.max(1.3, d * 0.2);
    const lh = (lw * lab.c.height) / lab.c.width;
    l.position.set(o.x, cy + fs / 2 + lh / 2 + 0.05 * lw, o.z);
    l.scale.set(lw, lh, 1);
    const key = `${o.id}|${det.m.estado}|${Math.round(det.d)}|${Math.round(det.m.similitud * 100)}`;
    if (key !== lab.key) {
      lab.key = key;
      drawLabel(lab.g, lab.c.width, lab.c.height, det);
      lab.t.needsUpdate = true;
    }
    const pulse = det.m.interes >= 0.5 ? 0.75 + 0.25 * Math.sin(state.clock.elapsedTime * 6) : 1;
    frameMat.opacity = pulse;
  });

  return (
    <>
      <sprite ref={frame} material={frameMat} renderOrder={1002} visible={false} />
      <sprite ref={label} material={labelMat} renderOrder={1003} visible={false} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Visor: heading tape and summary
// ---------------------------------------------------------------------------
const wrap = (a: number) => ((a % 360) + 360) % 360;
const bearing = (x: number, z: number) => wrap((Math.atan2(x - vr.x, -(z - vr.z)) * 180) / Math.PI);

function drawTape(g: CanvasRenderingContext2D, w: number, h: number) {
  g.clearRect(0, 0, w, h);
  const head = wrap((suitState.lookYaw * 180) / Math.PI);
  const span = 120; // degrees across the tape
  const xOf = (deg: number) => w / 2 + ((((deg - head + 540) % 360) - 180) / span) * w;
  g.fillStyle = 'rgba(4, 10, 20, 0.45)';
  g.fillRect(0, 0, w, 96);
  g.strokeStyle = '#00f3ff';
  g.fillStyle = '#00f3ff';
  g.lineWidth = 3;
  g.textAlign = 'center';
  g.font = `bold 34px ${FONT}`;
  const card: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
  for (let d = Math.floor((head - span / 2) / 5) * 5; d <= head + span / 2; d += 5) {
    const x = xOf(d);
    const dd = wrap(d);
    const major = dd % 45 === 0;
    g.beginPath();
    g.moveTo(x, 96);
    g.lineTo(x, major ? 62 : dd % 15 === 0 ? 76 : 86);
    g.stroke();
    if (major) g.fillText(card[dd], x, 50);
  }
  // Markers: habitat and the next goal.
  const marks: [string, number, string][] = [['H', bearing(BASE_A.x, BASE_A.z), '#ffffff']];
  const next = missionView.activo ? SITES.find((s) => missionView.sitios[s.realId ?? -1]?.s === 'next') : null;
  const g2 = next ? { code: next.code, x: next.x, z: next.z } : currentGoal();
  if (g2 && g2.code !== 'A') marks.push([g2.code, bearing(g2.x, g2.z), '#ffd84d']);
  for (const [txt, b, col] of marks) {
    const rel = ((b - head + 540) % 360) - 180;
    const x = Math.abs(rel) < span / 2 ? xOf(b) : rel < 0 ? 30 : w - 30;
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(x, 100);
    g.lineTo(x - 14, 124);
    g.lineTo(x + 14, 124);
    g.closePath();
    g.fill();
    g.font = `bold 30px ${FONT}`;
    g.fillText(Math.abs(rel) < span / 2 ? txt : `${rel < 0 ? '◀' : ''}${txt}${rel > 0 ? '▶' : ''}`, x, 158);
  }
  // Centre index and heading.
  g.fillStyle = '#ffffff';
  g.font = `bold 38px ${FONT}`;
  g.fillText(`${Math.round(head)}°`, w / 2, h - 52);
  g.beginPath();
  g.moveTo(w / 2, 96);
  g.lineTo(w / 2 - 12, 112);
  g.lineTo(w / 2 + 12, 112);
  g.closePath();
  g.fill();
  // Summary
  const nuevos = jarvis.detections.filter((d) => d.m.estado === 'nuevo' && d.o.clase !== 'peligro').length;
  g.font = `28px ${FONT}`;
  g.fillStyle = '#d8e6f2';
  g.fillText(`JARVIS · BD orbital ${field.nDb} objetos · a la vista ${jarvis.vistos} · nuevos ${nuevos} · ★ hallazgos ${jarvis.hallazgos.length}`, w / 2, h - 12);
  g.textAlign = 'left';
}

export function JarvisOverlay({ anchor = 'visor', stereo = false }: { anchor?: 'visor' | 'world'; stereo?: boolean }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const tape = useRef<THREE.Mesh>(null);
  const tp = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 260;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { c, g: c.getContext('2d')!, t, at: 0 };
  }, []);
  const tapeMat = useMemo(() => new THREE.MeshBasicMaterial({ map: tp.t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }), [tp]);
  useEffect(
    () => () => {
      tp.t.dispose();
      tapeMat.dispose();
    },
    [tp, tapeMat],
  );

  useFrame((state, dt) => {
    stepDetector(state.camera, Math.min(dt, 0.1));
    const m = tape.current;
    if (!m) return;
    m.visible = jarvis.on && anchor === 'visor';
    if (!m.visible) return;
    const t = state.clock.elapsedTime;
    if (t - tp.at > 1 / 20) {
      tp.at = t;
      drawTape(tp.g, tp.c.width, tp.c.height);
      tp.t.needsUpdate = true;
    }
    const halfH = D * Math.tan(((camera.fov ?? 70) * Math.PI) / 360);
    const halfW = halfH * (camera.aspect / (stereo ? 2 : 1));
    const w = halfW * 1.1;
    const h = (w * tp.c.height) / tp.c.width;
    m.position.copy(camera.position);
    m.quaternion.copy(camera.quaternion);
    m.translateY(halfH - h * 0.62);
    m.translateZ(-D);
    m.scale.set(w, h, 1);
  }, 0.5);

  return (
    <>
      <mesh ref={tape} material={tapeMat} renderOrder={1001} frustumCulled={false} visible={false}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      {Array.from({ length: SLOTS }).map((_, i) => (
        <Slot key={i} i={i} />
      ))}
    </>
  );
}
