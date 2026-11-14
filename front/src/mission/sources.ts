// Where the mission messages come from.
//
//   Recorded mission (?modo=mision): logs/<registro>.jsonl + .marcadores.json,
//     played at ×30 by default (CLAUDE.md §5), with play / pause / speed and
//     jumps (§5.6: empty state, re-apply every message with t ≤ target, no
//     animation; a marker starts 30 s early to see it happen).
//   Live (?modo=vivo): the backend's WebSocket, /ws?rol=vr (proxied by Vite to
//     ARES_BACKEND). It sends a snapshot on connect, then the telemetry's
//     events and the Motor's messages as they happen. Positions are shown one
//     telemetry interval (10 s simulated) behind, so they can be interpolated.
import { apply, mission, resetMission, type Msg } from './mission';

export const DEFAULT_LOG = 'sesion-2026-11-12-mision';

export interface Marcador {
  id: string;
  t: number;
  min: number;
  clase: string;
  titulo: string;
  detalle: string;
  nivel: number;
  sitio_id?: number;
}

export const player = {
  msgs: [] as Msg[],
  marcadores: [] as Marcador[],
  idx: 0,
  /** Display clock, simulated seconds. */
  clock: 0,
  duration: 0,
  playing: true,
  factor: 30,
  nombre: '',
};

// ---------------------------------------------------------------------------
// Recorded mission
// ---------------------------------------------------------------------------
export async function loadReplay(nombre = DEFAULT_LOG) {
  mission.modo = 'mision';
  mission.estadoFuente = `Cargando logs/${nombre}.jsonl…`;
  const res = await fetch(`/logs/${nombre}.jsonl`);
  if (!res.ok) throw new Error(`logs/${nombre}.jsonl: ${res.status}`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new Error(`logs/${nombre}.jsonl no existe`);
  player.msgs = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Msg);
  player.duration = player.msgs.reduce((m, x) => Math.max(m, typeof x.t === 'number' ? x.t : 0), 0);
  player.nombre = nombre;
  try {
    const mk = await (await fetch(`/logs/${nombre}.marcadores.json`)).json();
    player.marcadores = (mk.marcadores ?? []) as Marcador[];
  } catch {
    player.marcadores = [];
  }
  mission.estadoFuente = `Registro ${nombre}.jsonl · ${player.msgs.length} mensajes · ${(player.duration / 60).toFixed(0)} min simulados`;
  jump(0);
}

/** Preload the whole telemetry track: the recording knows where the astronaut will be. */
function preloadTrack() {
  mission.track = [];
  for (const m of player.msgs)
    if (m.tipo === 'telemetria_astronauta') {
      const d = m.datos as { x: number; y: number };
      mission.track.push({ t: m.t ?? 0, x: d.x, y: d.y });
    }
}

/** Empty the state and re-apply everything up to t, without animating. */
export function jump(t: number) {
  resetMission();
  preloadTrack();
  const target = Math.max(0, Math.min(player.duration, t));
  let i = 0;
  for (; i < player.msgs.length && (player.msgs[i].t ?? 0) <= target; i++) apply(player.msgs[i], false);
  player.idx = i;
  player.clock = target;
  mission.t = target;
  mission.version++;
}

export const jumpToMarker = (m: Marcador) => jump(m.t - 30);

export function stepReplay(dtReal: number) {
  if (!player.msgs.length) return;
  if (player.playing) player.clock = Math.min(player.duration, player.clock + dtReal * player.factor);
  while (player.idx < player.msgs.length && (player.msgs[player.idx].t ?? 0) <= player.clock) apply(player.msgs[player.idx++], true);
  mission.t = player.clock;
  if (player.clock >= player.duration) player.playing = false;
}

// ---------------------------------------------------------------------------
// Live (backend WebSocket)
// ---------------------------------------------------------------------------
export const live = {
  ws: null as WebSocket | null,
  connected: false,
  lastTelT: 0,
  lastTelAt: 0,
  factor: 30,
  mensajes: 0,
  error: '',
};

const TEL_LAG = 10; // s simulated: one telemetry interval

export function connectLive() {
  mission.modo = 'vivo';
  resetMission();
  const token = (import.meta.env?.VITE_ARES_TOKEN as string | undefined) ?? '';
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?rol=vr${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const open = () => {
    mission.estadoFuente = 'Conectando al backend…';
    const ws = new WebSocket(url);
    live.ws = ws;
    ws.onopen = () => {
      live.connected = true;
      live.error = '';
      mission.estadoFuente = 'Backend en vivo · esperando telemetría';
    };
    ws.onmessage = (ev) => {
      let m: Msg;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      live.mensajes++;
      if (m.tipo === 'perfil') live.factor = typeof m.factor_tiempo === 'number' ? m.factor_tiempo : 30;
      if (m.tipo === 'error') live.error = String(m.detalle ?? m.codigo ?? 'error');
      if (m.tipo === 'telemetria_astronauta' && typeof m.t === 'number') {
        live.lastTelT = m.t;
        live.lastTelAt = performance.now();
        mission.estadoFuente = `Backend en vivo · t = ${(m.t / 60).toFixed(1)} min · ${live.mensajes} mensajes`;
      }
      apply(m, true);
    };
    ws.onclose = (ev) => {
      live.connected = false;
      live.error = ev.reason || live.error || 'sin conexión';
      mission.estadoFuente = `Backend desconectado (${live.error}) · reintentando…`;
      setTimeout(open, 2000);
    };
  };
  open();
}

/** Live display clock: one telemetry interval behind the newest message, advancing at the profile's pace. */
export function liveClock() {
  if (!live.lastTelAt) return 0;
  const ahead = ((performance.now() - live.lastTelAt) / 1000) * live.factor;
  return Math.min(live.lastTelT, live.lastTelT - TEL_LAG + ahead);
}

// Development hook for automated checks (same module instances as the app).
if (import.meta.env.DEV && typeof window !== 'undefined')
  (window as unknown as { __aresMission?: unknown }).__aresMission = { mission, player, live, jump, jumpToMarker };
