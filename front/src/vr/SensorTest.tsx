// ?role=sensor-test · tells you, on the phone itself, why the headset gets no
// orientation: insecure page, blocked permission, events that never arrive,
// Generic Sensor errors… Everything is read live, nothing is sent anywhere.
import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { compass, hasGenericSensor, mag, startGravity, startMagnetometer, requestCompassPermission, startCompass, startGenericSensor } from './compass';

// n = events received, ok = events with real numbers (Chrome also fires them EMPTY when it has no sensor).
type Counter = { n: number; ok: number; a: number | null; b: number | null; g: number | null; extra?: string };
const empty = (): Counter => ({ n: 0, ok: 0, a: null, b: null, g: null });
const valid = (...v: (number | null | undefined)[]) => v.every((x) => typeof x === 'number' && !Number.isNaN(x));

const f = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(1));

async function perm(name: string) {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state;
  } catch {
    return 'no consultable';
  }
}

function Row({ k, v, ok }: { k: string; v: string; ok?: boolean | null }) {
  const color = ok === true ? 'text-emerald-300' : ok === false ? 'text-rose-300' : 'text-slate-200';
  return (
    <div className="flex justify-between gap-3 py-1 border-b border-white/5">
      <span className="text-slate-400">{k}</span>
      <span className={`font-mono text-right break-all ${color}`}>{v}</span>
    </div>
  );
}

export function SensorTest() {
  const data = useRef({ ori: empty(), abs: empty(), motion: empty(), grav: empty() });
  const [net, setNet] = useState('');
  const [magRes, setMagRes] = useState('');
  const [, force] = useState(0);
  const [perms, setPerms] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [iosPerm, setIosPerm] = useState('');
  const [generic, setGeneric] = useState('');

  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: unknown } | undefined;

  useEffect(() => {
    (async () => {
      const out: Record<string, string> = {};
      for (const n of ['accelerometer', 'gyroscope', 'magnetometer']) out[n] = await perm(n);
      setPerms(out);
    })();
    const id = setInterval(() => force((k) => k + 1), 200);
    return () => clearInterval(id);
  }, []);

  const run = async () => {
    setRunning(true);
    // Connection to the laptop's sync server (diagnostic role: does not take the headset's place).
    setNet('conectando…');
    const sock = io(location.origin, { path: '/socket.io', transports: ['websocket'], timeout: 4000 });
    const t0 = performance.now();
    sock.on('connect', () =>
      sock.emit('ping-ares', 0, () => {
        setNet(`conectado · ${(performance.now() - t0).toFixed(0)} ms`);
        sock.close();
      }),
    );
    sock.on('connect_error', (e) => setNet(`error: ${e.message}`));
    const ok = await requestCompassPermission();
    setIosPerm(typeof DOE?.requestPermission === 'function' ? (ok ? 'concedido' : 'rechazado') : 'no hace falta');
    const d = data.current;
    window.addEventListener('deviceorientation', (e) => {
      const ev = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
      d.ori = { n: d.ori.n + 1, ok: d.ori.ok + (valid(ev.alpha, ev.beta, ev.gamma) ? 1 : 0), a: ev.alpha, b: ev.beta, g: ev.gamma, extra: ev.webkitCompassHeading !== undefined ? `brújula iOS ${f(ev.webkitCompassHeading)}°` : ev.absolute ? 'absolute' : '' };
    });
    window.addEventListener('deviceorientationabsolute' as 'deviceorientation', (e) => {
      d.abs = { n: d.abs.n + 1, ok: d.abs.ok + (valid(e.alpha, e.beta, e.gamma) ? 1 : 0), a: e.alpha, b: e.beta, g: e.gamma };
    });
    window.addEventListener('devicemotion', (e) => {
      const r = e.rotationRate;
      d.motion = { n: d.motion.n + 1, ok: d.motion.ok + (valid(r?.alpha, r?.beta, r?.gamma) ? 1 : 0), a: r?.alpha ?? null, b: r?.beta ?? null, g: r?.gamma ?? null };
      const ag = e.accelerationIncludingGravity;
      d.grav = { n: d.grav.n + 1, ok: d.grav.ok + (valid(ag?.x, ag?.y, ag?.z) ? 1 : 0), a: ag?.x ?? null, b: ag?.y ?? null, g: ag?.z ?? null };
    });
    startCompass();
    setGeneric('probando…');
    const gOk = await startGenericSensor();
    setGeneric(gOk ? `funciona (${compass.source})` : `falló: ${compass.sensorError}`);
    startGravity();
    setMagRes('probando…');
    setMagRes((await startMagnetometer()) ? 'funciona: girar a los costados usa la brújula' : `no: ${mag.error} → se gira inclinando la cabeza`);
    const out: Record<string, string> = {};
    for (const n of ['accelerometer', 'gyroscope', 'magnetometer']) out[n] = await perm(n);
    setPerms(out);
  };

  const d = data.current;
  const secure = window.isSecureContext;
  const gyro = d.ori.ok + d.abs.ok > 0 || generic.startsWith('funciona');
  const onlyGravity = !gyro && d.grav.ok > 0;
  const anyData = gyro || onlyGravity;
  const waiting = generic.startsWith('probando');

  let verdict = '';
  if (!secure) verdict = 'La página no es segura (http). Abrila con https:// y aceptá el certificado: sin eso el celular no entrega sensores.';
  else if (Object.values(perms).includes('denied'))
    verdict = 'Chrome tiene bloqueados los sensores para este sitio. Tocá el candado (o «No es seguro») junto a la dirección › Permisos › Sensores de movimiento › Permitir, y recargá.';
  else if (running && gyro) verdict = '¡El giroscopio funciona! Volvé al casco: debería girar la vista.';
  else if (running && onlyGravity && !waiting)
    verdict =
      'Llegan eventos pero VACÍOS: este celular no expone giroscopio ni brújula a Chrome (o no los tiene). El casco usa el acelerómetro para mirar arriba/abajo. Para los costados usa el magnetómetro si Chrome lo da (ver abajo); si no, inclinás la cabeza hacia un lado para girar.';
  else if (running && !waiting && d.ori.n + d.abs.n > 0)
    verdict = 'Llegan eventos pero vacíos y sin acelerómetro: Chrome no tiene acceso a ningún sensor. Revisá los permisos de sensores de movimiento del sitio.';
  else if (running && d.ori.n + d.abs.n + d.motion.n === 0 && !waiting)
    verdict =
      'No llega ningún evento. Revisá en Chrome: Configuración › Configuración de sitios › Sensores de movimiento (debe estar permitido). Si el certificado es autofirmado y sigue sin andar, probá la opción de flags que explica el README.';

  return (
    <div className="min-h-screen bg-space text-slate-200 p-4 text-[13px]">
      <div className="max-w-xl mx-auto space-y-4">
        <div>
          <div className="font-display text-xl tracking-[0.25em] text-cyan-200">DIAGNÓSTICO DE SENSORES</div>
          <p className="text-slate-400 mt-1">Abrí esta página en el celular, tocá «Iniciar prueba» y mové el teléfono.</p>
        </div>

        {!running && (
          <button onClick={run} className="w-full px-5 py-3 rounded-lg border border-cyan-300 text-cyan-100 bg-cyan-500/20 text-base">
            Iniciar prueba
          </button>
        )}

        {verdict && <div className={`glass p-3 ${gyro && secure ? 'text-emerald-200' : 'text-amber-200'}`}>{verdict}</div>}

        <div className="glass p-3">
          <div className="text-cyan-100 mb-1">Página</div>
          <Row k="Contexto seguro" v={secure ? 'sí' : 'no'} ok={secure} />
          <Row k="Protocolo" v={location.protocol} ok={location.protocol === 'https:'} />
          <Row k="DeviceOrientationEvent" v={DOE ? 'existe' : 'no existe'} ok={!!DOE} />
          <Row k="requestPermission (iOS)" v={iosPerm || (typeof DOE?.requestPermission === 'function' ? 'disponible' : 'no aplica')} />
          <Row k="Generic Sensor API" v={hasGenericSensor() ? 'disponible' : 'no disponible'} />
        </div>

        <div className="glass p-3">
          <div className="text-cyan-100 mb-1">Permisos</div>
          {['accelerometer', 'gyroscope', 'magnetometer'].map((n) => (
            <Row key={n} k={n} v={perms[n] ?? '…'} ok={perms[n] === 'granted' ? true : perms[n] === 'denied' ? false : null} />
          ))}
        </div>

        <div className="glass p-3">
          <div className="text-cyan-100 mb-1">Eventos en vivo</div>
          <div className="text-[11px] text-slate-500 mb-1">eventos recibidos / con valores reales</div>
          <Row k="deviceorientation" v={`${d.ori.n}/${d.ori.ok} · α ${f(d.ori.a)} β ${f(d.ori.b)} γ ${f(d.ori.g)} ${d.ori.extra ?? ''}`} ok={running ? d.ori.ok > 0 : null} />
          <Row k="deviceorientationabsolute" v={`${d.abs.n}/${d.abs.ok} · α ${f(d.abs.a)} β ${f(d.abs.b)} γ ${f(d.abs.g)}`} ok={running ? d.abs.ok > 0 : null} />
          <Row k="devicemotion · giroscopio °/s" v={`${d.motion.n}/${d.motion.ok} · ${f(d.motion.a)} ${f(d.motion.b)} ${f(d.motion.g)}`} ok={running ? d.motion.ok > 0 : null} />
          <Row k="devicemotion · acelerómetro m/s²" v={`${d.grav.n}/${d.grav.ok} · ${f(d.grav.a)} ${f(d.grav.b)} ${f(d.grav.g)}`} ok={running ? d.grav.ok > 0 : null} />
          <Row k="Generic Sensor" v={generic || '—'} ok={generic ? generic.startsWith('funciona') : null} />
          <Row k="Magnetómetro (giro sin giroscopio)" v={magRes ? `${magRes}${mag.samples ? ` · ${f(mag.x)} ${f(mag.y)} ${f(mag.z)} µT` : ''}` : '—'} ok={magRes ? magRes.startsWith('funciona') : null} />
          <Row k="Fuente elegida por el casco" v={compass.source || (onlyGravity ? 'acelerómetro (sólo inclinación)' : '—')} />
          <Row k="Conexión con la laptop" v={net || '—'} ok={net ? net.startsWith('conectado') : null} />
        </div>

        <div className="glass p-3">
          <div className="text-cyan-100 mb-1">Navegador</div>
          <div className="font-mono text-[11px] text-slate-400 break-all">{navigator.userAgent}</div>
        </div>

        <a href="?role=vr" className="block text-center text-cyan-200 underline">Volver al casco</a>
      </div>
    </div>
  );
}
