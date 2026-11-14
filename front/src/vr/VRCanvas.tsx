// vr-client · the phone inside the Cardboard headset.
//
//  • Split-screen stereo (StereoEffect, two eyes, 64 mm apart).
//  • Head rotation from the phone's own orientation sensor, compass style
//    (see compass.ts): applied locally with zero network latency and streamed
//    to the laptop at ~60 Hz.
//  • Body POSITION comes only from the laptop (keyboard), smoothed here, so the
//    phone never moves the player by itself and never fights the sensor.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { StereoEffect } from 'three-stdlib';
import * as THREE from 'three';
import { connect, ping, type PoseNet, type SyncState, type WorldNet } from '../net/socket';
import { SharedWorld, useVRBoot } from './SharedWorld';
import { EYE_HEIGHT, applyCanyonScanned, applyPose, applyRoute, setSolarTime, vr } from './vrEngine';
import { SuitModel } from './SuitModel';
import { suitState } from './suit/state';
import { DIM } from './suit/build';
import { Governor } from '../render/Governor';
import { compass, compassQuaternion, gravity, gravityQuaternion, headingDeg, mag, magHeading, startMagnetometer, tiltRoll, requestCompassPermission, startCompass, startGenericSensor, startGravity, waitForCompass, waitForGravity } from './compass';
import { rt } from '../store/simEngine';
import { heightAt } from '../lib/terrain';
import { Q, toneMap } from '../render/quality';
import { VisorHud, applyBio } from '../hud';
import { JarvisOverlay } from '../jarvis/JarvisOverlay';
import { bindJarvisSync, toggleJarvis } from '../jarvis/sync';
import { applyMissionView } from '../mission/mission';
import { layerState, setLayer, type CapaId } from '../lib/layers';

const net = { state: null as SyncState | null, routeId: -1, pose: null as PoseNet | null, poseAt: 0, rtt: NaN };
/** Longest the phone extrapolates a pose (s): beyond it, a stalled laptop must not drift you away. */
const MAX_PREDICT = 0.15;
const live = { heading: 0, pitch: 0, sent: 0, turning: 0 };
/** Yaw owned by the phone in accelerometer mode (radians, clockwise from north). */
const headYaw = { v: NaN };
const TURN_DEAD = (10 * Math.PI) / 180; // head tilt below this does nothing
const TURN_MAX = (35 * Math.PI) / 180;
const TURN_SPEED = 2.4; // rad/s of yaw per rad of tilt beyond the dead zone (≈60°/s at 35°)

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
type Mode = 'sensor' | 'gravity' | 'none';

/** Renders both eyes side by side and takes over R3F's default render (priority 1). */
function StereoRenderer({ enabled }: { enabled: boolean }) {
  const { gl, scene, camera, size } = useThree();
  const effect = useMemo(() => new StereoEffect(gl), [gl]);
  useEffect(() => {
    effect.setEyeSeparation(0.064);
    effect.setSize(size.width, size.height);
  }, [effect, size]);
  useEffect(() => {
    // One shadow pass per frame serves both eyes.
    gl.shadowMap.autoUpdate = false;
    return () => {
      gl.shadowMap.autoUpdate = true;
    };
  }, [gl]);
  useFrame(() => {
    gl.shadowMap.needsUpdate = true;
    if (enabled) effect.render(scene, camera);
    else gl.render(scene, camera);
  }, 1);
  return null;
}

/**
 * Puts the camera at the astronaut's eyes; the sensor (or the mouse) turns it.
 * Runs before the suit is animated (priority −2), so the body you see when you
 * look down belongs to this very frame.
 */
function HeadRig({ mode, recenter }: { mode: Mode; recenter: number }) {
  const sensor = mode === 'sensor';
  const camera = useThree((s) => s.camera);
  const target = useMemo(() => new THREE.Quaternion(), []);
  const tilt = useMemo(() => new THREE.Quaternion(), []);
  const yawQ = useMemo(() => new THREE.Quaternion(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const mouse = useRef({ yaw: vr.heading, pitch: 0, down: false, lx: 0, ly: 0 });
  const lastSend = useRef(0);
  const socket = useMemo(() => connect('vr-client'), []);

  // Without a sensor (desktop testing): drag to look around.
  useEffect(() => {
    if (mode !== 'none') return;
    const m = mouse.current;
    const down = (e: PointerEvent) => {
      m.down = true;
      m.lx = e.clientX;
      m.ly = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!m.down) return;
      m.yaw += (e.clientX - m.lx) * 0.004;
      m.pitch = Math.max(-1.3, Math.min(1.3, m.pitch - (e.clientY - m.ly) * 0.004));
      m.lx = e.clientX;
      m.ly = e.clientY;
    };
    const up = () => (m.down = false);
    window.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [mode]);

  // Double tap: make "where I look now" the astronaut's forward direction.
  useEffect(() => {
    if (!recenter) return;
    if (sensor) {
      compassQuaternion(target);
      compass.yawOffset += (headingDeg(target) * Math.PI) / 180 - vr.heading;
    } else if (mode === 'gravity') {
      if (mag.samples) compass.yawOffset = (magHeading() ?? 0) - vr.heading;
      else headYaw.v = vr.heading;
    } else mouse.current.yaw = vr.heading;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenter]);

  useFrame((_, dt) => {
    const s = net.state;
    const p = net.pose;
    const age = (performance.now() - net.poseAt) / 1000;
    if (p && age < 0.5) {
      // Relayed pose (no wait for the server tick), extrapolated with the laptop's velocity
      // by its age plus half the round trip: what the laptop shows NOW. Light smoothing on top.
      const ahead = Math.min(MAX_PREDICT, age + (Number.isFinite(net.rtt) ? net.rtt / 2000 : 0.01));
      const k = 1 - Math.exp(-dt * 30);
      vr.x += (p.x + p.vx * ahead - vr.x) * k;
      vr.z += (p.z + p.vz * ahead - vr.z) * k;
      applyPose(vr.x, vr.z, p.h);
    } else if (s) {
      // No relayed pose (older server): the 60 Hz state, smoothed to hide the network steps.
      const k = 1 - Math.exp(-dt * 18);
      vr.x += (s.position.x - vr.x) * k;
      vr.z += (s.position.z - vr.z) * k;
      applyPose(vr.x, vr.z, s.heading);
    }
    if (s) {
      const k = 1 - Math.exp(-dt * 18);
      if (s.drone) {
        const d = rt.drone;
        d.x += (s.drone.x - d.x) * k;
        d.y += (s.drone.y - d.y) * k;
        d.z += (s.drone.z - d.z) * k;
        d.heading = s.drone.heading;
        d.state = s.drone.state as typeof d.state;
        d.rotor = s.drone.rotor;
        d.scanProgress = s.drone.scan;
      }
      // Time of day and dust are chosen on the laptop.
      if (typeof s.ltst === 'number' && Math.abs(s.ltst - rt.sun.ltst) > 0.004) setSolarTime(s.ltst);
      if (typeof s.storm === 'number') rt.stormIntensity = s.storm;
    }

    if (sensor) {
      // Light low-pass on the raw sensor removes jitter without visible lag.
      compassQuaternion(target);
      camera.quaternion.slerp(target, 1 - Math.exp(-dt * 40));
    } else if (mode === 'gravity') {
      // No gyroscope: up/down from gravity. Sideways: magnetometer compass if
      // Chrome exposes it, otherwise tilt the head to the side to turn.
      gravityQuaternion(tilt);
      if (Number.isNaN(headYaw.v)) headYaw.v = s?.lookYaw ?? vr.heading;
      const mh = mag.samples ? magHeading() : null;
      if (mh !== null) {
        headYaw.v += wrap(mh - compass.yawOffset - headYaw.v) * (1 - Math.exp(-dt * 8));
        live.turning = 0;
      } else {
        const r = tiltRoll();
        const over = Math.min(TURN_MAX, Math.abs(r)) - TURN_DEAD;
        live.turning = over > 0 ? Math.sign(r) : 0;
        if (over > 0) headYaw.v = wrap(headYaw.v + Math.sign(r) * over * TURN_SPEED * dt);
      }
      yawQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -headYaw.v);
      target.copy(yawQ).multiply(tilt);
      camera.quaternion.slerp(target, 1 - Math.exp(-dt * 20));
    } else {
      const m = mouse.current;
      camera.quaternion.setFromEuler(new THREE.Euler(m.pitch, -m.yaw, 0, 'YXZ'));
    }
    fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    const yaw = Math.abs(fwd.y) < 0.995 ? Math.atan2(fwd.x, -fwd.z) : suitState.lookYaw;
    live.heading = ((yaw * 180) / Math.PI + 360) % 360;
    live.pitch = (pitch * 180) / Math.PI;
    suitState.lookYaw = yaw;
    suitState.lookPitch = pitch;

    // Eyes: a hand's width ahead of the neck. Kept steady (no head bob): comfortable inside a headset.
    camera.position.set(vr.x + Math.sin(yaw) * DIM.EYE_FWD, heightAt(vr.x, vr.z) + EYE_HEIGHT, vr.z - Math.cos(yaw) * DIM.EYE_FWD);

    // Stream the head rotation (~60 Hz). Volatile: drop, never queue.
    const now = performance.now();
    if (now - lastSend.current > 15 && socket.connected) {
      lastSend.current = now;
      live.sent++;
      const q = camera.quaternion;
      socket.volatile.emit('rotation', [q.x, q.y, q.z, q.w]);
    }
  }, -2);

  return null;
}

const card = (h: number) => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(h / 45) % 8];

export function VRCanvas() {
  const status = useVRBoot();
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<Mode>('none');
  const sensor = mode === 'sensor';
  const [stereo, setStereo] = useState(true);
  const [recenter, setRecenter] = useState(0);
  // Cardboard button = one tap: JARVIS ↔ normal view. Two quick taps: recentre (as before).
  const tap = useRef({ timer: 0 });
  const onTap = () => {
    if (!started) return;
    if (tap.current.timer) {
      window.clearTimeout(tap.current.timer);
      tap.current.timer = 0;
      setRecenter((k) => k + 1);
      return;
    }
    tap.current.timer = window.setTimeout(() => {
      tap.current.timer = 0;
      toggleJarvis();
    }, 300);
  };
  const [problem, setProblem] = useState('');
  const [hud, setHud] = useState({ connected: false, host: false, ping: NaN, heading: 0, pitch: 0, source: '', samples: 0, sent: 0, walking: false, gazeSpeed: 0, poseRelay: false });
  const secure = window.isSecureContext;

  useEffect(() => {
    const socket = connect('vr-client');
    bindJarvisSync(socket);
    socket.on('state', (s: SyncState) => {
      net.state = s;
      if (s.bio) applyBio(s.bio);
    });
    socket.on('pose', (p: PoseNet) => {
      net.pose = p;
      net.poseAt = performance.now();
    });
    socket.on('world', (w: WorldNet) => {
      if (w.routeId !== net.routeId) {
        net.routeId = w.routeId;
        applyRoute(w.route);
      }
      applyCanyonScanned(w.canyonScanned);
      if (w.mission) applyMissionView(w.mission);
      if (w.capa && w.capa !== layerState.actual) void setLayer(w.capa as CapaId);
    });
    const id = window.setInterval(async () => {
      net.rtt = await ping();
      setHud({ connected: socket.connected, host: !!net.state?.host, ping: net.rtt, heading: live.heading, pitch: live.pitch, source: compass.source, samples: compass.samples + gravity.samples, sent: live.sent, walking: !!net.state?.gaze?.walking, gazeSpeed: net.state?.gaze?.speed ?? 0, poseRelay: performance.now() - net.poseAt < 500 });
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // In tilt-only mode the warning is informative: don't leave it in front of the eyes.
  useEffect(() => {
    if (!started || mode !== 'gravity' || !problem) return;
    const id = window.setTimeout(() => setProblem(''), 8000);
    return () => window.clearTimeout(id);
  }, [started, mode, problem]);

  const start = async () => {
    setProblem('');
    // Permission must be asked inside the tap (iOS). Start listening right away.
    const allowed = await requestCompassPermission();
    startCompass();
    let ok = allowed && (await waitForCompass(1500));
    // Nothing from the DOM events: try Chrome's Generic Sensor API, which also says why it fails.
    if (!ok && secure) ok = await startGenericSensor();
    // Still nothing: the accelerometer alone (look up/down and tilt; the laptop turns you).
    let tiltOnly = false;
    if (!ok && secure) {
      startGravity();
      tiltOnly = await waitForGravity(1500);
      if (tiltOnly) await startMagnetometer();
    }
    const forceStereo = new URLSearchParams(location.search).get('stereo') === '1';
    if (tiltOnly) {
      setProblem(
        mag.samples
          ? 'Sin giroscopio: se usa acelerómetro + magnetómetro (brújula). Girá el cuerpo para mirar a los costados.'
          : 'Sin giroscopio ni brújula: inclinar la cabeza hacia un costado gira la vista hacia ese lado (como un joystick). Volvé la cabeza derecha para dejar de girar.',
      );
    } else if (!ok) {
      setProblem(
        !secure
          ? 'Esta página no es segura (http). El celular sólo entrega el giroscopio con https.'
          : !allowed
            ? 'El permiso de movimiento fue rechazado. En iPhone: Ajustes › Safari › Movimiento y orientación.'
            : /denegado|NotAllowed/i.test(compass.sensorError)
              ? 'Chrome bloquea los sensores de este sitio: candado junto a la dirección › Permisos › Sensores de movimiento › Permitir, y recargá.'
              : `El navegador no envió datos del giroscopio${compass.sensorError ? ` (${compass.sensorError})` : ''}.`,
      );
    }
    setMode(ok ? 'sensor' : tiltOnly ? 'gravity' : 'none');
    setStereo(ok || tiltOnly || forceStereo);
    await document.documentElement.requestFullscreen?.().catch(() => undefined);
    const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await orient.lock?.('landscape').catch(() => undefined);
    await (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<unknown> } }).wakeLock?.request('screen').catch(() => undefined);
    setStarted(true);
  };

  const httpsUrl = `https://${location.host}${location.pathname}${location.search}`;

  return (
    // HTML labels are drawn for one camera only: hide them in the split-screen headset.
    <div className={`fixed inset-0 bg-black select-none ${started && stereo ? 'vr-stereo' : ''}`} onClick={onTap}>
      <Canvas
        shadows="percentage"
        dpr={[1, Q.dprMax]}
        gl={{ antialias: Q.antialias, powerPreference: 'high-performance', stencil: false, toneMapping: { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping }[toneMap], toneMappingExposure: 4 }}
        camera={{ fov: 80, near: 0.08, far: 160000 }}
      >
        <SharedWorld />
        {started && <HeadRig mode={mode} recenter={recenter} />}
        {/* Suit holograms on the visor (one per eye in stereo) and the lens layer. */}
        {started && <VisorHud stereo={stereo} />}
        {started && <JarvisOverlay stereo={stereo} />}
        {/* Your own body: look down and you see the suit, the boots and your shadow. */}
        <SuitModel firstPerson />
        <Governor target={38} min={0.7} />
        <StereoRenderer enabled={started && stereo} />
      </Canvas>

      {!started && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/75 text-center px-6">
          <div className="font-display text-2xl tracking-[0.25em] text-cyan-200">ARES-TWIN · CASCO</div>
          <p className="text-sm text-slate-300 max-w-md">
            Poné el celular en horizontal dentro del Cardboard. Al girar la cabeza gira la vista, como una brújula: mirar al norte real es mirar al norte en Marte.
            El avance lo maneja la laptop con el teclado.
          </p>
          {!secure && (
            <p className="text-sm text-amber-200 max-w-md">
              Esta página está en http: el giroscopio no va a funcionar. Abrí <span className="font-mono">{httpsUrl}</span> y aceptá el certificado.
            </p>
          )}
          <button onClick={start} disabled={status === 'loading'} className="px-6 py-3 rounded-lg border border-cyan-300 text-cyan-100 bg-cyan-500/20 text-lg disabled:opacity-40">
            {status === 'loading' ? 'Cargando Marte…' : 'Entrar al casco'}
          </button>
          <p className="text-[11px] text-slate-500">Un toque (botón del Cardboard): vista JARVIS o normal · Doble toque: tomar la dirección actual como «adelante».</p>
        </div>
      )}

      {started && (
        <div className="absolute top-1 inset-x-0 flex justify-around text-[10px] font-mono text-slate-200/85 pointer-events-none">
          {(stereo ? [0, 1] : [0]).map((i) => (
            <span key={i}>
              {hud.connected ? (hud.host ? 'laptop ✓' : 'esperando laptop') : 'sin servidor'} · {Number.isFinite(hud.ping) ? `${hud.ping.toFixed(0)} ms` : '—'}{hud.poseRelay ? ' · pose directa' : ''} · rumbo{' '}
              {hud.heading.toFixed(0)}° {card(hud.heading)}
              {sensor ? (hud.source === 'relative' || hud.source === 'generic-relative' ? ' · giroscopio (sin brújula)' : ' · brújula') : mode === 'gravity' ? (mag.samples ? ' · acelerómetro + brújula' : ` · inclinar para girar${live.turning ? (live.turning > 0 ? ' ▶' : ' ◀') : ''}`) : ' · sin sensor'}
              {' '}· lecturas {hud.samples} · enviados {hud.sent}
              {hud.walking && <b className="text-emerald-300"> · ▼ avanzando {hud.gazeSpeed.toFixed(1)} m/s</b>}
            </span>
          ))}
        </div>
      )}
      {started && problem && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-w-[90vw] rounded border border-amber-400/60 bg-black/80 px-3 py-2 text-[12px] text-amber-100 text-center">
          {problem} {mode === 'none' ? 'Mientras tanto podés arrastrar para mirar. ' : ''}
          <a href="?role=sensor-test" className="underline text-cyan-200 pointer-events-auto">Diagnóstico de sensores</a>
        </div>
      )}
    </div>
  );
}
