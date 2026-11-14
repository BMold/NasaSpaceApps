// Holographic interfaces (no flat 2D HUD): the suit's readouts are drawn as
// holograms projected on the inside of the helmet visor, as 3D objects 0.6 m in
// front of the eyes. Being part of the scene, the Cardboard draws them once
// per eye with the right depth (an HTML overlay cannot do that).
//
//   left  · O₂: ring gauge, litres, minutes left, margin and O2_minimo (§9)
//   right · pulse with a live ECG trace, VO₂ and metabolic rate
//   top   · alert banner only in a crisis (abort zone, empty tank, extreme cold)
//
// In the laptop's third-person view the same panels float beside the astronaut
// instead ("anchor = body").
//
// Also here: the visor lens layer (VisorFx), the sensory post-processing that
// works on the phone too (no post-processing pipeline in stereo): frost
// creeping in from the rim, a red vignette beating with the heart, and a
// hypoxia tunnel with a milky veil.
//
// Safety colours (green / amber / red) are used only for O₂ and alerts (§14).
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LEVEL_COLOR, bio, level, margenPct, minutesLeft, o2Minimo } from './bio';
import { vr } from '../vr/vrEngine';
import { heightAt } from '../lib/terrain';
import { missionAviso, missionView } from '../mission/mission';
import { jarvis } from '../jarvis/detector';

const CYAN = '#00f3ff';
const D = 0.6; // metres from the eyes to the hologram plane
const FONT = 'ui-monospace, Consolas, "Courier New", monospace';
const fmt = (v: number, d = 1) => v.toFixed(d).replace('.', ','); // canvas text skips the DOM localiser

// ---------------------------------------------------------------------------
// ECG: synthetic P-QRS-T beat at the measured pulse (display only)
// ---------------------------------------------------------------------------
function ecg(phase: number) {
  const g = (c: number, w: number, a: number) => a * Math.exp(-(((phase - c) / w) ** 2));
  return g(0.18, 0.035, 0.12) + g(0.3, 0.008, -0.12) + g(0.32, 0.012, 1) + g(0.345, 0.01, -0.28) + g(0.58, 0.06, 0.28);
}
const ECG_N = 160;

function canvasPanel(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  return { c, g: c.getContext('2d')!, tex };
}

const holoVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const holoFrag = /* glsl */ `
uniform sampler2D uMap; uniform float uTime; uniform float uAlpha;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uMap, vUv);
  float scan = 0.88 + 0.12 * sin(vUv.y * 220.0 - uTime * 8.0);
  float flick = 0.96 + 0.04 * sin(uTime * 31.0);
  gl_FragColor = vec4(c.rgb * scan * 1.15, c.a * uAlpha * flick);
}`;

function holoMaterial(map: THREE.Texture) {
  return new THREE.ShaderMaterial({
    vertexShader: holoVert,
    fragmentShader: holoFrag,
    uniforms: { uMap: { value: map }, uTime: { value: 0 }, uAlpha: { value: 0.92 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function frame(g: CanvasRenderingContext2D, w: number, h: number, color: string) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(6, 14, 26, 0.55)';
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(4, 4, w - 8, h - 8, 22);
  g.fill();
  g.stroke();
  // corner brackets: the "projected" look
  g.lineWidth = 6;
  for (const [x, y, dx, dy] of [[10, 10, 1, 1], [w - 10, 10, -1, 1], [10, h - 10, 1, -1], [w - 10, h - 10, -1, -1]]) {
    g.beginPath();
    g.moveTo(x, y + dy * 26);
    g.lineTo(x, y);
    g.lineTo(x + dx * 26, y);
    g.stroke();
  }
}

function drawO2(g: CanvasRenderingContext2D, w: number, h: number) {
  const lv = level();
  const col = LEVEL_COLOR[lv];
  frame(g, w, h, col);
  const frac = Math.max(0, Math.min(1, bio.O2 / Math.max(1e-6, bio.O2_0)));
  // ring gauge
  const cx = 128, cy = h / 2, R = 88;
  g.lineWidth = 20;
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.beginPath();
  g.arc(cx, cy, R, -Math.PI * 1.25, Math.PI * 0.25);
  g.stroke();
  g.strokeStyle = col;
  g.shadowColor = col;
  g.shadowBlur = 16;
  g.beginPath();
  g.arc(cx, cy, R, -Math.PI * 1.25, -Math.PI * 1.25 + frac * Math.PI * 1.5);
  g.stroke();
  // O2_minimo tick: the fixed line of the O₂ bar (§14)
  const mfrac = Math.min(1, o2Minimo() / Math.max(1e-6, bio.O2_0));
  if (Number.isFinite(mfrac)) {
    const a = -Math.PI * 1.25 + mfrac * Math.PI * 1.5;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (R - 16), cy + Math.sin(a) * (R - 16));
    g.lineTo(cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16));
    g.stroke();
  }
  g.shadowBlur = 0;
  g.fillStyle = col;
  g.textAlign = 'center';
  g.font = `bold 50px ${FONT}`;
  g.fillText(`${Math.round(frac * 100)}%`, cx, cy + 10);
  g.font = `28px ${FONT}`;
  g.fillText('O₂', cx, cy + 44);
  g.textAlign = 'left';
  const x = 250;
  g.fillStyle = CYAN;
  g.font = `26px ${FONT}`;
  g.fillText('EVA-SUIT · O₂', x, 56);
  g.fillStyle = '#ffffff';
  g.font = `bold 56px ${FONT}`;
  g.fillText(`${fmt(bio.O2)} L`, x, 112);
  g.font = `30px ${FONT}`;
  g.fillStyle = '#d8e6f2';
  g.fillText(`≈ ${Math.floor(minutesLeft())} min${bio.timeScale > 1 ? `  (×${bio.timeScale})` : ''}`, x, 152);
  const m = margenPct();
  g.fillStyle = col;
  g.font = `bold 30px ${FONT}`;
  g.fillText(Number.isFinite(m) ? `margen ${Math.round(m)} %` : 'en el hábitat', x, 196);
  g.fillStyle = '#d8e6f2';
  g.font = `26px ${FONT}`;
  g.fillText(Number.isFinite(bio.R) ? `volver: ${fmt(bio.R)} L · mín ${fmt(o2Minimo())} L` : 'sin camino de vuelta', x, 232);
}

function drawBio(g: CanvasRenderingContext2D, w: number, h: number, trace: Float32Array, head: number) {
  const fc = bio.FC;
  const col = fc > 170 ? LEVEL_COLOR.rojo : fc > 150 ? LEVEL_COLOR.ambar : CYAN;
  frame(g, w, h, col);
  g.fillStyle = CYAN;
  g.font = `26px ${FONT}`;
  g.fillText('BIOMETRÍA', 28, 56);
  g.fillStyle = col;
  g.font = `bold 60px ${FONT}`;
  g.fillText(`♥ ${Math.round(fc)}`, 28, 118);
  g.font = `28px ${FONT}`;
  g.fillText('lpm', 250, 118);
  g.fillStyle = '#d8e6f2';
  g.font = `28px ${FONT}`;
  g.fillText(`VO₂ ${fmt(bio.VO2, 2)} L/min`, 340, 70);
  g.fillText(`M ${Math.round(bio.M)} W`, 340, 108);
  // ECG trace, newest sample on the right
  const x0 = 28, x1 = w - 28, yb = h - 52, amp = 70;
  g.strokeStyle = col;
  g.lineWidth = 3;
  g.shadowColor = col;
  g.shadowBlur = 10;
  g.beginPath();
  for (let i = 0; i < ECG_N; i++) {
    const v = trace[(head + i) % ECG_N];
    const x = x0 + ((x1 - x0) * i) / (ECG_N - 1);
    const y = yb - v * amp;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
  g.shadowBlur = 0;
}

function drawAlert(g: CanvasRenderingContext2D, w: number, h: number): boolean {
  const lv = level();
  const now = performance.now();
  // Priority: empty tank > the optimizer's 4 s notice (replan / abort) > abort zone > solar storm > cold > heart.
  type A = { t: string; d: string; col: string; icon: string };
  const notice = missionAviso.hasta > now && missionAviso.texto;
  const a: A | null =
    bio.O2 <= 0
      ? { t: 'SIN OXÍGENO', d: 'cambiar a la reserva de emergencia', col: LEVEL_COLOR.rojo, icon: '⚠' }
      : notice
        ? { t: missionAviso.texto, d: missionAviso.detalle, col: missionAviso.nivel === 'alerta' ? LEVEL_COLOR.rojo : CYAN, icon: missionAviso.nivel === 'alerta' ? '⚠' : '↻' }
        : lv === 'rojo'
          ? { t: 'ZONA DE ABORTO', d: `volver al hábitat · necesitás ${fmt(o2Minimo())} L`, col: LEVEL_COLOR.rojo, icon: '⚠' }
          : missionView.activo && missionView.spe
            ? { t: missionView.spe === 'critico' ? 'TORMENTA SOLAR CRÍTICA' : 'ALERTA SPE', d: missionView.spe === 'critico' ? 'volver al hábitat' : 'reserva de O₂ al 25 %', col: missionView.spe === 'critico' ? LEVEL_COLOR.rojo : LEVEL_COLOR.ambar, icon: '☢' }
            : bio.frost > 0.6
              ? { t: 'FRÍO EXTREMO', d: 'salir de la sombra · calefacción al máximo', col: LEVEL_COLOR.ambar, icon: '⚠' }
              : bio.FC > 170
                ? { t: 'TAQUICARDIA', d: 'detenerse y descansar', col: LEVEL_COLOR.rojo, icon: '⚠' }
                : null;
  g.clearRect(0, 0, w, h);
  if (!a) return false;
  frame(g, w, h, a.col);
  g.textAlign = 'center';
  g.fillStyle = a.col;
  // Long notices shrink to fit.
  let size = 52;
  g.font = `bold ${size}px ${FONT}`;
  while (size > 26 && g.measureText(`${a.icon} ${a.t}`).width > w - 60) g.font = `bold ${(size -= 2)}px ${FONT}`;
  g.fillText(`${a.icon} ${a.t}`, w / 2, 78);
  g.fillStyle = '#ffffff';
  g.font = `26px ${FONT}`;
  g.fillText(a.d, w / 2, 122);
  g.textAlign = 'left';
  return true;
}

// ---------------------------------------------------------------------------
// Visor lens layer
// ---------------------------------------------------------------------------
const fxFrag = /* glsl */ `
uniform float uFrost; uniform float uRed; uniform float uBeat; uniform float uHyp; uniform float uTime; uniform float uAspect;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float edge = max(abs(q.x), abs(q.y));
  float r = length(q * vec2(1.0, 0.85));
  vec2 pa = vec2(vUv.x * uAspect, vUv.y);
  // Frost: crystals grow from the rim inwards with uFrost; feathery, uneven front.
  float front = 1.0 - uFrost * 0.4 + (fbm(pa * 5.0) - 0.5) * 0.3;
  float frost = smoothstep(front, front + 0.22, edge) * uFrost;
  float fern = pow(abs(sin(fbm(pa * 18.0) * 14.0)), 6.0);
  vec3 frostCol = vec3(0.86, 0.93, 1.0) * (0.75 + 0.35 * fern);
  float aFrost = frost * (0.35 + 0.45 * fern);
  // Red vignette, beating with the heart.
  float vig = smoothstep(0.45, 1.35, r);
  float aRed = vig * uRed * (0.35 + 0.65 * uBeat);
  // Hypoxia: tunnel vision (periphery goes dark) and a milky veil that swims.
  float tunnel = smoothstep(0.75 - 0.55 * uHyp, 1.25 - 0.4 * uHyp, r) * uHyp;
  float veil = uHyp * (0.18 + 0.1 * fbm(pa * 3.0 + uTime * 0.15));
  vec3 col = vec3(0.0);
  float a = 0.0;
  // back to front: veil, tunnel, red, frost
  col = mix(col, vec3(0.75, 0.72, 0.7), veil); a = a + veil * (1.0 - a);
  col = mix(col, vec3(0.0), tunnel); a = a + tunnel * (1.0 - a);
  col = mix(col, vec3(0.75, 0.02, 0.02), aRed / max(1e-3, a + aRed)); a = a + aRed * (1.0 - a);
  col = mix(col, frostCol, aFrost / max(1e-3, a + aFrost)); a = a + aFrost * (1.0 - a);
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}`;

const fx = { frost: 0, red: 0, hyp: 0, beatPhase: 0 };

/** Heartbeat envelope (0..1) at the measured pulse. */
function beat(dt: number) {
  fx.beatPhase = (fx.beatPhase + (dt * bio.FC) / 60) % 1;
  return Math.exp(-((fx.beatPhase / 0.12) ** 2)) + 0.5 * Math.exp(-(((fx.beatPhase - 0.3) / 0.1) ** 2));
}

/** Crisis intensities, smoothed, shared by the lens layer and the laptop's post-processing. */
export const crisis = { red: 0, frost: 0, hyp: 0, beat: 0, blur: 0 };

export function updateCrisis(dt: number) {
  const lv = level();
  const targetRed = (bio.O2 <= 0 ? 1 : lv === 'rojo' ? 0.85 : lv === 'ambar' ? 0.3 : 0) + (bio.FC > 170 ? 0.35 : bio.FC > 150 ? 0.15 : 0);
  const k = 1 - Math.exp(-dt * 3);
  crisis.red += (Math.min(1, targetRed) - crisis.red) * k;
  crisis.frost += (bio.frost - crisis.frost) * k;
  crisis.hyp += (bio.hyp - crisis.hyp) * k;
  crisis.beat = beat(dt);
  // Blur on the laptop: hypoxia, and a little when the heart races.
  crisis.blur = Math.min(1, crisis.hyp + (bio.FC > 170 ? 0.25 : 0));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function VisorHud({ anchor = 'visor', stereo = false, fxStrength = 1 }: { anchor?: 'visor' | 'body'; stereo?: boolean; fxStrength?: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const root = useRef<THREE.Group>(null);
  const left = useRef<THREE.Mesh>(null);
  const right = useRef<THREE.Mesh>(null);
  const top = useRef<THREE.Mesh>(null);
  const lens = useRef<THREE.Mesh>(null);

  // 720 × 256: room for the larger type of the JARVIS visor.
  const o2 = useMemo(() => canvasPanel(720, 256), []);
  const bp = useMemo(() => canvasPanel(720, 256), []);
  const al = useMemo(() => canvasPanel(768, 150), []);
  const mats = useMemo(() => ({ o2: holoMaterial(o2.tex), bio: holoMaterial(bp.tex), alert: holoMaterial(al.tex) }), [o2, bp, al]);
  const lensMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: holoVert,
        fragmentShader: fxFrag,
        uniforms: { uFrost: { value: 0 }, uRed: { value: 0 }, uBeat: { value: 0 }, uHyp: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  useEffect(
    () => () => {
      [o2, bp, al].forEach((p) => p.tex.dispose());
      Object.values(mats).forEach((m) => m.dispose());
      lensMat.dispose();
    },
    [o2, bp, al, mats, lensMat],
  );

  const trace = useMemo(() => new Float32Array(ECG_N), []);
  const st = useRef({ head: 0, phase: 0, acc: 0, draw: 0, alert: false });

  // Runs after the views have placed the camera (they use priorities −2 and 0) and before the render (1).
  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const t = state.clock.elapsedTime;
    updateCrisis(dt);
    const s = st.current;

    // ECG samples at a fixed 40 Hz (the trace covers 4 s).
    s.acc += dt;
    while (s.acc >= 0.025) {
      s.acc -= 0.025;
      s.phase = (s.phase + (0.025 * bio.FC) / 60) % 1;
      trace[s.head] = ecg(s.phase);
      s.head = (s.head + 1) % ECG_N;
    }
    // Redraw the panels at 15 Hz.
    if (t - s.draw > 1 / 15) {
      s.draw = t;
      drawO2(o2.g, o2.c.width, o2.c.height);
      drawBio(bp.g, bp.c.width, bp.c.height, trace, s.head);
      s.alert = drawAlert(al.g, al.c.width, al.c.height);
      o2.tex.needsUpdate = bp.tex.needsUpdate = al.tex.needsUpdate = true;
    }
    for (const m of Object.values(mats)) m.uniforms.uTime.value = t;
    mats.alert.uniforms.uAlpha.value = 0.75 + 0.25 * Math.sin(t * 6);

    const g = root.current;
    if (!g || !left.current || !right.current || !top.current) return;
    top.current.visible = s.alert;
    // Normal view: only the safety alerts and the lens effects; the readouts come back with JARVIS.
    left.current.visible = right.current.visible = jarvis.on;

    if (anchor === 'visor') {
      // The group rides with the eyes; panels sit near the lower corners of the view, turned
      // a little toward the centre like the inside of a curved visor.
      g.position.copy(camera.position);
      g.quaternion.copy(camera.quaternion);
      g.scale.setScalar(1);
      const halfH = D * Math.tan(((camera.fov ?? 70) * Math.PI) / 360);
      const halfW = halfH * (camera.aspect / (stereo ? 2 : 1));
      // Two panels side by side must fit in the eye's width (narrow in stereo or portrait).
      const ph = Math.min(halfH * 0.36, (halfW * 0.88) / 2.8125);
      const pw = ph * 2.8125;
      left.current.scale.set(pw, ph, 1);
      right.current.scale.set(pw, ph, 1);
      left.current.position.set(-halfW + pw * 0.5 + halfW * 0.06, -halfH + ph * 0.5 + halfH * 0.1, -D);
      right.current.position.set(halfW - pw * 0.5 - halfW * 0.06, -halfH + ph * 0.5 + halfH * 0.1, -D);
      left.current.rotation.set(0.12, 0.28, 0);
      right.current.rotation.set(0.12, -0.28, 0);
      const ah = ph * 0.7;
      top.current.scale.set(ah * 5.1, ah, 1);
      top.current.position.set(0, halfH * 0.55, -D);
      top.current.rotation.set(-0.08, 0, 0);
    } else {
      // Third person: beside the astronaut's head, facing the camera, at a readable size.
      const y = heightAt(vr.x, vr.z) + 2.3;
      g.position.set(vr.x, y, vr.z);
      g.quaternion.copy(camera.quaternion);
      const d = camera.position.distanceTo(g.position);
      g.scale.setScalar(Math.max(1, d / 4));
      left.current.scale.set(1.125, 0.4, 1);
      right.current.scale.set(1.125, 0.4, 1);
      left.current.position.set(-0.85, 0, 0);
      right.current.position.set(0.85, 0, 0);
      left.current.rotation.set(0, 0, 0);
      right.current.rotation.set(0, 0, 0);
      top.current.scale.set(1.8, 0.35, 1);
      top.current.position.set(0, 0.55, 0);
      top.current.rotation.set(0, 0, 0);
    }

    // Lens layer, just behind the near plane, covering the whole view.
    if (lens.current) {
      const dl = Math.max(camera.near * 1.5, 0.12);
      const hh = dl * Math.tan(((camera.fov ?? 70) * Math.PI) / 360) * 1.08;
      const ww = hh * camera.aspect * 1.08;
      lens.current.position.copy(camera.position);
      lens.current.quaternion.copy(camera.quaternion);
      lens.current.translateZ(-dl);
      lens.current.scale.set(ww * 2, hh * 2, 1);
      const u = lensMat.uniforms;
      u.uFrost.value = crisis.frost * fxStrength;
      u.uRed.value = crisis.red * fxStrength;
      u.uBeat.value = crisis.beat;
      u.uHyp.value = crisis.hyp * fxStrength;
      u.uTime.value = t;
      u.uAspect.value = camera.aspect / (stereo ? 2 : 1);
      lens.current.visible = crisis.frost + crisis.red + crisis.hyp > 0.01;
    }
  }, 0.5);

  return (
    <>
      <group ref={root}>
        <mesh ref={left} material={mats.o2} renderOrder={1000} frustumCulled={false}>
          <planeGeometry args={[1, 1]} />
        </mesh>
        <mesh ref={right} material={mats.bio} renderOrder={1000} frustumCulled={false}>
          <planeGeometry args={[1, 1]} />
        </mesh>
        <mesh ref={top} material={mats.alert} renderOrder={1001} frustumCulled={false} visible={false}>
          <planeGeometry args={[1, 1]} />
        </mesh>
      </group>
      <mesh ref={lens} material={lensMat} renderOrder={999} frustumCulled={false} visible={false}>
        <planeGeometry args={[1, 1]} />
      </mesh>
    </>
  );
}
