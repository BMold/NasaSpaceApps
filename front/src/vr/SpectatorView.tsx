// spectator-host · the laptop.
//
//  • Full-screen view that follows the phone's head rotation (WebSocket).
//  • WASD / arrow keys move the astronaut, relative to where the head looks.
//  • Sends the position (+ the backpack drone) to the phone at 60 Hz and the
//    route polyline whenever it changes, so the player walks without nausea:
//    the phone only turns the head, the body moves smoothly from here.
//  • Runs the dynamic route (useDynamicRoute): leave the optimal polyline and
//    A* is re-run from your feet to the goal.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Effects } from '../components/canvas/Effects';
import { connect, ping, type SyncState, type WorldNet } from '../net/socket';
import { SharedWorld, useVRBoot } from './SharedWorld';
import { SuitModel } from './SuitModel';
import { useDynamicRoute } from './useDynamicRoute';
import { EYE_HEIGHT, currentGoal, deployDrone, moveAstronaut, nextGoal, recalculateRoute, setSolarTime, setWorldListener, stepDrone, updateBody, vr } from './vrEngine';
import { Governor, governorState } from '../render/Governor';
import { formatHours } from '../lib/marsTime';
import { suitState } from './suit/state';
import { DIM } from './suit/build';
import { rt } from '../store/simEngine';
import { useSimStore } from '../store/useSimStore';
import { heightAt } from '../lib/terrain';
import { siteName } from '../i18n';
import { Q, toneMap } from '../render/quality';
import { REAL } from '../lib/realTerrain';
import { SITES } from '../lib/sites';

const keys = new Set<string>();
/** Look-down-to-walk: tilting the head below `thr` degrees walks forward at `speed` m/s. Set from the laptop. */
export const gaze = { on: true, speed: 3, thr: 25, walking: false, ramp: 0 };
const remote = { q: new THREE.Quaternion(), has: false, vrConnected: false, fresh: false, last: 0, tiltOnly: false };
const _yawQ = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
/** The headset gives the yaw, unless it is a phone without gyroscope (tilt only). */
const phoneYaw = () => remote.vrConnected && remote.has && !remote.tiltOnly;
const local = { yaw: Math.PI * 0.75, pitch: -0.12 };
const _fwd = new THREE.Vector3();

// Development hook: lets automated captures place the astronaut and aim the view.
/** Test autopilot (development only): walk along a fixed heading while the camera looks from elsewhere. */
const auto = { on: false, yaw: 0, speed: 1.2, camDist: 4.4 };
if (import.meta.env.DEV) (window as unknown as { __ares?: unknown }).__ares = { vr, rt, local, gaze, remote, keys, auto, suitState };

/** Yaw (clockwise from north) the player is looking at: the phone's, or the mouse's. */
function viewYaw() {
  if (phoneYaw()) {
    _fwd.set(0, 0, -1).applyQuaternion(remote.q);
    return Math.atan2(_fwd.x, -_fwd.z);
  }
  return local.yaw;
}

function HostLoop({ thirdPerson }: { thirdPerson: boolean }) {
  const camera = useThree((s) => s.camera);
  const socket = useMemo(() => connect('spectator-host'), []);
  const lastSend = useRef(0);
  const camQ = useMemo(() => new THREE.Quaternion(), []);
  const target = useMemo(() => new THREE.Vector3(), []);
  const camPos = useMemo(() => new THREE.Vector3(), []);
  const follow = useRef({ ready: false });
  // Body velocity (smoothed), sent with the pose so the phone can extrapolate across network jitter.
  const vel = useRef({ x: 0, z: 0, px: NaN, pz: NaN });

  // 1) Input → body. Runs before the suit is animated (priority −2).
  useFrame((_, dtRaw) => {
    if (!vr.ready) return;
    const dt = Math.min(dtRaw, 0.05);
    // Keyboard → body motion, relative to the head's yaw.
    const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    if (!phoneYaw()) local.yaw += ((keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)) * dt * 1.6;

    // Head orientation: the phone's quaternion when the headset is on.
    if (phoneYaw()) camQ.slerp(remote.q, 1 - Math.exp(-dt * 25));
    else if (remote.vrConnected && remote.has) camQ.slerp(_yawQ.setFromAxisAngle(_up, -local.yaw).multiply(remote.q), 1 - Math.exp(-dt * 25));
    else camQ.setFromEuler(new THREE.Euler(local.pitch, -local.yaw, 0, 'YXZ'));
    _fwd.set(0, 0, -1).applyQuaternion(camQ);
    const lookPitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
    const lookYaw = Math.abs(_fwd.y) < 0.995 ? Math.atan2(_fwd.x, -_fwd.z) : suitState.lookYaw;

    // Look down → walk forward (hands-free inside the Cardboard). Keys take priority.
    const pitchDeg = (lookPitch * 180) / Math.PI;
    const want = gaze.on && !fwd && !strafe && -pitchDeg > gaze.thr ? Math.min(1, (-pitchDeg - gaze.thr) / 8) : 0;
    gaze.ramp += (want - gaze.ramp) * (1 - Math.exp(-dt * 6)); // ease in/out, no jolts
    gaze.walking = gaze.ramp > 0.05;
    if (auto.on) moveAstronaut(1, 0, auto.yaw, false, dt, auto.speed);
    else if (gaze.walking) moveAstronaut(1, 0, viewYaw(), false, dt, gaze.speed * gaze.ramp);
    else moveAstronaut(fwd, strafe, viewYaw(), keys.has('ShiftLeft') || keys.has('ShiftRight'), dt);

    // The head turns first; past ~55° the astronaut turns to follow it.
    suitState.lookYaw = auto.on ? auto.yaw : lookYaw; // (test autopilot: the head looks where it walks)
    suitState.lookPitch = auto.on ? 0 : lookPitch;
    updateBody(suitState.lookYaw, dt);
    stepDrone(dt);
    const v = vel.current;
    if (Number.isFinite(v.px) && dt > 0) {
      const a = 1 - Math.exp(-dt * 12);
      v.x += ((vr.x - v.px) / dt - v.x) * a;
      v.z += ((vr.z - v.pz) / dt - v.z) * a;
    }
    v.px = vr.x;
    v.pz = vr.z;

    // 60 Hz position stream to the server (and on to the phone).
    const now = performance.now();
    if (now - lastSend.current > 15 && socket.connected) {
      lastSend.current = now;
      const d = rt.drone;
      socket.volatile.emit('position', {
        x: vr.x,
        y: heightAt(vr.x, vr.z),
        z: vr.z,
        heading: vr.heading,
        vx: v.x,
        vz: v.z,
        lookYaw: viewYaw(),
        ltst: rt.sun.ltst,
        storm: rt.stormIntensity,
        gaze: { on: gaze.on, speed: gaze.speed, thr: gaze.thr, walking: gaze.walking },
        drone: { x: d.x, y: d.y, z: d.z, heading: d.heading, state: d.state, rotor: d.rotor, scan: d.scanProgress },
      });
    }
  }, -2);

  // 2) Camera, once the suit has been posed (its rig runs at priority −1).
  useFrame((_, dtRaw) => {
    if (!vr.ready) return;
    const dt = Math.min(dtRaw, 0.05);
    const ground = heightAt(vr.x, vr.z);
    _fwd.set(0, 0, -1).applyQuaternion(camQ);
    if (!thirdPerson) {
      // Eyes: just above and ahead of the neck joint, so the camera rides the body's own motion.
      const yaw = suitState.lookYaw;
      const neckY = suitState.dockValid ? suitState.neck.y : ground + EYE_HEIGHT - DIM.EYE_UP;
      const nx = suitState.dockValid ? suitState.neck.x : vr.x;
      const nz = suitState.dockValid ? suitState.neck.z : vr.z;
      camera.position.set(nx + Math.sin(yaw) * DIM.EYE_FWD, neckY + DIM.EYE_UP, nz - Math.cos(yaw) * DIM.EYE_FWD);
      camera.quaternion.copy(camQ);
      follow.current.ready = false;
    } else {
      // Third person: a few metres behind the suit, looking where the head looks; the camera trails smoothly.
      target.set(vr.x, ground + 1.45, vr.z);
      camPos.set(vr.x - _fwd.x * auto.camDist, ground + 2.3 - _fwd.y * 3, vr.z - _fwd.z * auto.camDist);
      camPos.y = Math.max(camPos.y, heightAt(camPos.x, camPos.z) + 0.5);
      if (!follow.current.ready || camera.position.distanceTo(camPos) > 12) {
        camera.position.copy(camPos);
        follow.current.ready = true;
      } else camera.position.lerp(camPos, 1 - Math.exp(-dt * 9));
      camera.lookAt(target);
    }
  });
  return null;
}

function worldSnapshot(): WorldNet {
  const r = rt.route;
  const route: [number, number][] = [];
  for (let i = 0; i < r.n; i++) route.push([Math.round(r.xs[i] * 100) / 100, Math.round(r.zs[i] * 100) / 100]);
  const g = currentGoal();
  return {
    routeId: vr.routeId,
    route,
    canyonScanned: useSimStore.getState().canyonScanned,
    goal: g ? { code: g.code, x: g.x, z: g.z } : null,
    litres: vr.routeLitres,
  };
}

export function SpectatorView() {
  const status = useVRBoot();
  const [thirdPerson, setThirdPerson] = useState(true);
  const [gazeUi, setGazeUi] = useState({ on: gaze.on, speed: gaze.speed, thr: gaze.thr });
  const setGaze = (g: Partial<typeof gazeUi>) =>
    setGazeUi((cur) => {
      const n = { ...cur, ...g };
      n.speed = Math.max(0.5, Math.min(10, Math.round(n.speed * 2) / 2));
      n.thr = Math.max(10, Math.min(60, n.thr));
      Object.assign(gaze, n);
      return n;
    });
  // Scene controls: time of day, airborne dust, labels.
  const [envUi, setEnvUi] = useState({ ltst: 8, storm: 0, labels: true });
  useEffect(() => {
    if (status !== 'loading') setEnvUi((e) => ({ ...e, ltst: rt.sun.ltst }));
  }, [status]);
  const setLtst = (h: number) => {
    setSolarTime(h);
    setEnvUi((e) => ({ ...e, ltst: h }));
  };
  const setStorm = (v: number) => {
    rt.stormIntensity = v;
    setEnvUi((e) => ({ ...e, storm: v }));
  };
  const [hud, setHud] = useState({ connected: false, vr: false, tilt: false, walking: false, fps: 60, scale: 1, ping: NaN, msg: '', dev: 0, goal: '', dist: 0, litres: 0, recalcs: 0, drone: 'docked', head: 0, headAge: 0 });
  const scanned = useSimStore((s) => s.canyonScanned);
  useDynamicRoute(status !== 'loading');

  // Socket: phone rotation in, world out.
  useEffect(() => {
    const socket = connect('spectator-host');
    socket.on('state', (s: SyncState) => {
      remote.vrConnected = s.vr;
      if (s.vr && s.rotation && !remote.fresh) {
        remote.q.set(s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3]);
        remote.tiltOnly = s.rotation[4] === 1;
        remote.has = true;
      }
    });
    // Head rotation relayed the instant the phone sends it (lower latency than the 60 Hz tick).
    socket.on('rotation', (q: number[]) => {
      remote.q.set(q[0], q[1], q[2], q[3]);
      remote.tiltOnly = q[4] === 1;
      remote.has = true;
      remote.vrConnected = true;
      remote.fresh = true;
      remote.last = performance.now();
    });
    const push = () => socket.connected && socket.emit('world', worldSnapshot());
    setWorldListener(push);
    socket.on('connect', () => setTimeout(push, 200));
    socket.on('presence', () => setTimeout(push, 100));
    const id = window.setInterval(async () => {
      const g = currentGoal();
      setHud({
        connected: socket.connected,
        vr: remote.vrConnected,
        tilt: remote.tiltOnly,
        walking: gaze.walking,
        fps: governorState.fps,
        scale: governorState.dpr,
        ping: await ping(),
        msg: vr.message,
        dev: vr.lastDeviation,
        goal: g ? (g.code === 'A' ? 'Hábitat (A)' : `${g.code} · ${siteName(g.code)}`) : '—',
        dist: g ? Math.hypot(g.x - vr.x, g.z - vr.z) : 0,
        litres: vr.routeLitres,
        recalcs: vr.recalcs,
        drone: rt.drone.state,
        head: ((viewYaw() * 180) / Math.PI + 360) % 360,
        headAge: remote.last ? performance.now() - remote.last : Infinity,
      });
    }, 100);
    return () => {
      setWorldListener(null);
      window.clearInterval(id);
    };
  }, []);

  // Keyboard + mouse look (when no headset is connected).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keys.add(e.code);
      if (e.code === 'KeyV') setThirdPerson((t) => !t);
      if (e.code === 'KeyF' || e.code === 'Space') deployDrone();
      if (e.code === 'KeyR') recalculateRoute('recalculada a pedido');
      if (e.code === 'KeyN') nextGoal();
      if (e.code === 'KeyG') setGaze({ on: !gaze.on });
      if (e.code === 'KeyL') setEnvUi((v) => ({ ...v, labels: !v.labels }));
      if (e.code === 'BracketRight' || e.code === 'NumpadAdd' || e.code === 'Equal') setGaze({ speed: gaze.speed + 0.5 });
      if (e.code === 'BracketLeft' || e.code === 'NumpadSubtract' || e.code === 'Minus') setGaze({ speed: gaze.speed - 0.5 });
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    };
    const up = (e: KeyboardEvent) => keys.delete(e.code);
    const blur = () => keys.clear();
    let drag = false;
    let lx = 0;
    let ly = 0;
    const pd = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      drag = true;
      lx = e.clientX;
      ly = e.clientY;
    };
    const pm = (e: PointerEvent) => {
      if (!drag || phoneYaw()) return;
      local.yaw += (e.clientX - lx) * 0.004;
      local.pitch = Math.max(-1.2, Math.min(1.2, local.pitch - (e.clientY - ly) * 0.004));
      lx = e.clientX;
      ly = e.clientY;
    };
    const pu = () => (drag = false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('pointerdown', pd);
    window.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pointerdown', pd);
      window.removeEventListener('pointermove', pm);
      window.removeEventListener('pointerup', pu);
    };
  }, []);

  return (
    <div className={`fixed inset-0 bg-black select-none ${envUi.labels ? '' : 'no-labels'}`}>
      <Canvas
        shadows="percentage"
        dpr={[1, Q.dprMax]}
        gl={{ antialias: Q.post === 'none' && Q.antialias, powerPreference: 'high-performance', stencil: false, toneMapping: { agx: THREE.AgXToneMapping, aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping }[toneMap], toneMappingExposure: 4 }}
        camera={{ fov: 62, near: 0.08, far: 160000 }}
      >
        <SharedWorld />
        <SuitModel firstPerson={!thirdPerson} />
        <HostLoop thirdPerson={thirdPerson} />
        <Governor />
        <Effects />
      </Canvas>

      <div className="absolute top-3 left-3 glass p-3 w-[min(360px,calc(100vw-24px))] text-[11px] text-slate-200 space-y-1.5">
        <div className="font-display tracking-[0.25em] text-cyan-200 text-sm">ARES-TWIN · ESPECTADOR</div>
        <div className="flex gap-3 font-mono">
          <span className={hud.connected ? 'text-emerald-300' : 'text-red-300'}>● servidor</span>
          <span className={hud.vr ? 'text-emerald-300' : 'text-slate-500'}>● casco VR {hud.vr ? 'conectado' : 'no conectado'}</span>
          <span className="text-slate-400">{Number.isFinite(hud.ping) ? `${hud.ping.toFixed(0)} ms` : '—'}</span>
        </div>
        <div className="font-mono">
          Casco: rumbo <b className="text-cyan-200">{hud.head.toFixed(0)}°</b>{' '}
          {hud.vr ? (hud.headAge < 500 ? <span className="text-emerald-300">· en vivo</span> : <span className="text-amber-300">· sin datos del celular</span>) : <span className="text-slate-500">· mouse / Q-E</span>}
        </div>
        <div>
          Objetivo: <b className="text-amber-200">{hud.goal}</b> · {hud.dist.toFixed(0)} m · ruta {hud.litres.toFixed(1)} L de O₂
        </div>
        <div className="text-slate-400">
          Desvío de la ruta óptima: <span className={hud.dev > 3.5 ? 'text-amber-300' : 'text-slate-200'}>{hud.dev.toFixed(1)} m</span> (recalcula sobre 3,5 m) · {hud.recalcs} cálculos A*
        </div>
        <div className="text-emerald-200/90 leading-snug">{hud.msg}</div>
        {REAL && SITES.length > 0 && (
          <div className="text-slate-400">
            Terreno real 480 m · {SITES.length} sitios CRISM desde <b className="text-slate-200">{SITES[0].source === 'backend' ? 'el backend' : 'terreno/sitios.json'}</b>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <button onClick={() => deployDrone()} disabled={hud.drone !== 'docked'} className="px-2 py-1 rounded border border-cyan-400/60 text-cyan-100 disabled:opacity-40">
            {hud.drone === 'docked' ? (REAL ? 'Dron: explorar el objetivo (F)' : scanned ? 'Dron: re-escanear cañón (F)' : 'Dron: escanear cañón (F)') : `Dron: ${hud.drone}`}
          </button>
          <button onClick={() => setThirdPerson((t) => !t)} className="px-2 py-1 rounded border border-slate-600">
            {thirdPerson ? '1ª persona (V)' : '3ª persona (V)'}
          </button>
          <button onClick={() => recalculateRoute('recalculada a pedido')} className="px-2 py-1 rounded border border-slate-600">
            Recalcular (R)
          </button>
        </div>
        <div className="rounded border border-slate-700/80 p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setGaze({ on: !gazeUi.on })} className={`px-2 py-1 rounded border ${gazeUi.on ? 'border-emerald-400/70 text-emerald-200' : 'border-slate-600 text-slate-400'}`}>
              Mirar abajo para avanzar: {gazeUi.on ? 'SÍ' : 'NO'} (G)
            </button>
            <span className={`font-mono ${hud.walking ? 'text-emerald-300' : 'text-slate-500'}`}>{hud.walking ? '▼ avanzando' : 'quieto'}</span>
          </div>
          <label className="flex items-center gap-2">
            <span className="w-24 text-slate-400">Velocidad</span>
            <input type="range" min={0.5} max={10} step={0.5} value={gazeUi.speed} onChange={(e) => setGaze({ speed: +e.target.value })} className="flex-1 accent-cyan-400" />
            <span className="w-16 text-right font-mono text-cyan-200">{gazeUi.speed.toFixed(1)} m/s</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-slate-400">Mirar abajo de</span>
            <input type="range" min={10} max={60} step={1} value={gazeUi.thr} onChange={(e) => setGaze({ thr: +e.target.value })} className="flex-1 accent-cyan-400" />
            <span className="w-16 text-right font-mono text-cyan-200">{gazeUi.thr}°</span>
          </label>
          <div className="text-[10px] text-slate-500">[ / ] o − / +: bajar o subir la velocidad · una persona camina a ~1,4 m/s</div>
        </div>
        <div className="rounded border border-slate-700/80 p-2 space-y-1.5">
          <label className="flex items-center gap-2">
            <span className="w-24 text-slate-400">Hora solar</span>
            <input type="range" min={5.6} max={18.9} step={0.05} value={envUi.ltst} onChange={(e) => setLtst(+e.target.value)} className="flex-1 accent-amber-400" />
            <span className="w-16 text-right font-mono text-amber-200">{formatHours(envUi.ltst)}</span>
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-slate-400">Polvo en el aire</span>
            <input type="range" min={0} max={1} step={0.02} value={envUi.storm} onChange={(e) => setStorm(+e.target.value)} className="flex-1 accent-amber-400" />
            <span className="w-16 text-right font-mono text-amber-200">τ {(0.6 + 3.4 * envUi.storm).toFixed(1)}</span>
          </label>
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setEnvUi((v) => ({ ...v, labels: !v.labels }))} className="px-2 py-1 rounded border border-slate-600">
              Etiquetas: {envUi.labels ? 'SÍ' : 'NO'} (L)
            </button>
            <span className="font-mono text-slate-500">
              {hud.fps.toFixed(0)} fps · resolución {(hud.scale * 100).toFixed(0)} %
            </span>
          </div>
        </div>
        <div className="text-[10px] text-slate-500 leading-snug">
          WASD / flechas: caminar hacia donde mira el casco · Shift: más rápido · N: siguiente objetivo
          {!hud.vr && ' · sin casco: arrastrá el mouse o Q/E para girar'}
          {hud.vr && hud.tilt && ' · el celular no tiene giroscopio: girá con Q/E o el mouse'}
        </div>
      </div>
      {status === 'loading' && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 glass px-3 py-1.5 text-[11px] text-cyan-200">{REAL ? 'Cargando el terreno real (DEM, HiRISE, sitios CRISM)…' : 'Cargando Marte desde NASA Mars Trek…'}</div>}
    </div>
  );
}
