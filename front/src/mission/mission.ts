// Mission state built ONLY from contract messages (CLAUDE.md §10–11,
// contratos/INTEGRACION.md §5.4): the 3D/VR view computes nothing here.
//
//   telemetria_astronauta → position track, hora_solar, FC, VO₂, speed, load
//   estado_aborto         → O₂, R, O2_minimo, margen (safety colour)
//   plan_actualizado      → route to walk, planned stops, 4 s notice (motivo ≠ inicial)
//   abortar               → escape route, destination, notice, 3 s far view
//   peligro / ventanas / SPE / hito / perfil / reinicio / snapshot
//
// The same `apply` serves the recorded mission (logs/*.jsonl, replay.ts) and
// the backend's live WebSocket (live.ts). Jumps rebuild the state by
// re-applying every message with t ≤ target WITHOUT animating (§5.6).
import { enuToScene } from '../lib/realTerrain';

export type Msg = { tipo?: string; t?: number; hora_solar?: number; datos?: Record<string, unknown>; [k: string]: unknown };

export interface Parada {
  id: number;
  x: number;
  y: number;
  llegada_s: number;
  salida_s: number;
  O2_acum_L: number;
}
export interface Plan {
  plan_id: string;
  factible: boolean;
  orden: (number | string)[];
  polilinea: [number, number][];
  paradas: Parada[];
  O2_total_L: number;
  ruta_escape: [number, number][];
}
export interface Peligro {
  id: string;
  x: number;
  y: number;
  radio_m: number;
  efecto: 'bloqueo' | 'multiplicador';
  factor: number;
}
export interface Aviso {
  texto: string;
  detalle: string;
  nivel: 'info' | 'alerta';
  /** performance.now() until which it shows (4 s). */
  hasta: number;
}

interface TrackPt {
  t: number;
  x: number;
  y: number;
}

function fresh() {
  return {
    t: 0,
    horaSolar: NaN,
    /** Telemetry positions (ENU). Replay preloads the whole track; live appends. */
    track: [] as TrackPt[],
    O2: NaN,
    O2_0: NaN,
    R: NaN,
    O2min: NaN,
    margen: NaN,
    FC: NaN,
    VO2: NaN,
    vel: 0,
    carga: 0,
    plan: null as Plan | null,
    planVersion: 0,
    escape: null as [number, number][] | null,
    abortado: null as { motivo: string; destino?: { x: number; y: number } } | null,
    peligros: new Map<string, Peligro>(),
    hazardVersion: 0,
    spe: null as { nivel: string; llegada_s: number } | null,
    llegadas: new Set<number>(),
    muestras: new Set<number>(),
    nMuestras: 0,
    aviso: null as Aviso | null,
    /** Set by the views: a far view of 3 s when an abort arrives live. */
    farViewUntil: 0,
    version: 0,
  };
}

export const mission = {
  /** 'libre' = the hand-driven walk; 'mision' = recorded log; 'vivo' = backend WebSocket. */
  modo: 'libre' as 'libre' | 'mision' | 'vivo',
  estadoFuente: '',
  ...fresh(),
};

export const missionActive = () => mission.modo !== 'libre';

export function resetMission(keepTrack = false) {
  const track = mission.track;
  Object.assign(mission, fresh());
  if (keepTrack) mission.track = track;
  mission.version++;
}

const num = (v: unknown, d = NaN) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const AVISO_MS = 4000;

const MOTIVO: Record<string, string> = {
  peligro: 'Ruta replanificada: peligro en el camino',
  recalibracion: 'Ruta replanificada: consumo de O₂ recalibrado',
  ventana: 'Ruta replanificada: se cerró la ventana de un sitio',
  spe_alerta: 'Ruta replanificada: alerta de tormenta solar',
  pedido: 'Plan nuevo a pedido',
  spe_critico: 'ABORTAR: tormenta solar crítica',
  no_retorno: 'ABORTAR: no queda O₂ para volver con reserva',
};

/** Apply one contract message. `animate` = it arrived live (notices, fades); false while re-applying after a jump. */
export function apply(m: Msg, animate: boolean) {
  const tipo = m.tipo;
  if (typeof m.t === 'number') mission.t = Math.max(mission.t, m.t);
  const d = (m.datos ?? {}) as Record<string, unknown>;
  switch (tipo) {
    case 'perfil': {
      resetMission();
      const a = (m.astronauta ?? {}) as Record<string, unknown>;
      mission.O2_0 = num(a.O2_inicial_L);
      break;
    }
    case 'reinicio':
      resetMission(mission.modo === 'mision');
      break;
    case 'telemetria_astronauta': {
      const t = num(m.t, 0);
      const x = num(d.x);
      const y = num(d.y);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const tr = mission.track;
        // Replay preloads the track; live appends in order.
        if (!tr.length || tr[tr.length - 1].t < t) tr.push({ t, x, y });
      }
      if (typeof m.hora_solar === 'number') mission.horaSolar = m.hora_solar;
      mission.FC = num(d.FC_lpm, mission.FC);
      mission.VO2 = num(d.VO2_L_min, mission.VO2);
      mission.vel = num(d.velocidad_m_s, 0);
      mission.carga = num(d.carga_kg, mission.carga);
      const o2 = num(d.O2_restante_L);
      if (Number.isFinite(o2)) {
        if (!Number.isFinite(mission.O2_0)) mission.O2_0 = o2;
        if (!Number.isFinite(mission.O2)) mission.O2 = o2;
      }
      break;
    }
    case 'estado_aborto':
      mission.O2 = num(m.O2_restante_L, mission.O2);
      mission.R = num(m.R_L, mission.R);
      mission.O2min = num(m.O2_minimo_L, mission.O2min);
      mission.margen = num(m.margen_pct, mission.margen);
      break;
    case 'plan_actualizado': {
      const plan = m.plan as Plan | undefined;
      if (!plan) break;
      mission.plan = plan;
      mission.planVersion++;
      const motivo = String(m.motivo ?? '');
      if (animate && motivo && motivo !== 'inicial')
        mission.aviso = { texto: MOTIVO[motivo] ?? `Plan nuevo (${motivo})`, detalle: `${plan.paradas.length} paradas · ${plan.O2_total_L.toFixed(1)} L de O₂`, nivel: 'info', hasta: performance.now() + AVISO_MS };
      break;
    }
    case 'abortar': {
      mission.escape = (m.ruta_escape as [number, number][]) ?? null;
      const dest = m.destino as { x: number; y: number } | undefined;
      mission.abortado = { motivo: String(m.motivo ?? ''), destino: dest };
      mission.planVersion++;
      if (animate) {
        mission.aviso = { texto: MOTIVO[String(m.motivo)] ?? 'ABORTAR', detalle: `volver al hábitat · O₂ previsto ${num(m.O2_previsto_L, 0).toFixed(1)} L`, nivel: 'alerta', hasta: performance.now() + AVISO_MS };
        mission.farViewUntil = performance.now() + 3000;
      }
      break;
    }
    case 'peligro': {
      const id = String(d.id ?? '');
      if (!id) break;
      if (num(d.radio_m, 0) <= 0) mission.peligros.delete(id);
      else
        mission.peligros.set(id, {
          id,
          x: num(d.x, 0),
          y: num(d.y, 0),
          radio_m: num(d.radio_m, 0),
          efecto: d.efecto === 'multiplicador' ? 'multiplicador' : 'bloqueo',
          factor: num(d.factor, 1),
        });
      mission.hazardVersion++;
      break;
    }
    case 'SPE':
      mission.spe = { nivel: String(d.nivel ?? ''), llegada_s: num(d.llegada_s, 0) };
      if (animate)
        mission.aviso = {
          texto: d.nivel === 'critico' ? 'TORMENTA SOLAR CRÍTICA' : 'ALERTA DE TORMENTA SOLAR',
          detalle: d.nivel === 'critico' ? 'protones en camino: volver al hábitat' : `llegada en ${Math.round(num(d.llegada_s, 0) / 60)} min · reserva ρ = 25 %`,
          nivel: 'alerta',
          hasta: performance.now() + AVISO_MS,
        };
      break;
    case 'hito': {
      const id = num(m.sitio_id);
      if (m.clase === 'llegada' && Number.isFinite(id)) mission.llegadas.add(id);
      if (m.clase === 'muestra' && Number.isFinite(id)) {
        mission.muestras.add(id);
        mission.nMuestras = num(m.n_muestras, mission.muestras.size);
        mission.carga = num(m.carga_kg, mission.carga);
      }
      break;
    }
    case 'snapshot': {
      // Backend's state on connect (Motor.estado + last telemetry).
      const est = (m.estado ?? null) as { plan?: Plan; estado_aborto?: Msg; peligros?: Record<string, unknown>[] } | null;
      const tel = (m.ultima_telemetria as Record<string, Msg> | undefined)?.telemetria_astronauta;
      if (m.perfil) apply({ ...(m.perfil as Msg), tipo: 'perfil' }, false);
      if (tel) apply(tel, false);
      if (est?.estado_aborto) apply({ ...est.estado_aborto, tipo: 'estado_aborto' }, false);
      if (est?.plan) apply({ tipo: 'plan_actualizado', motivo: 'inicial', plan: est.plan }, false);
      for (const p of est?.peligros ?? []) apply({ tipo: 'peligro', datos: p }, false);
      break;
    }
    default:
      return; // unknown types are ignored (§9)
  }
  mission.version++;
}

/** Interpolated position at simulated time t (ENU metres) and the walking direction. */
export function positionAt(t: number): { x: number; y: number; dx: number; dy: number } | null {
  const tr = mission.track;
  if (!tr.length) return null;
  if (t <= tr[0].t) return { x: tr[0].x, y: tr[0].y, dx: 0, dy: 0 };
  const last = tr[tr.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y, dx: 0, dy: 0 };
  let lo = 0;
  let hi = tr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = tr[lo];
  const b = tr[hi];
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dx: (b.x - a.x) / (b.t - a.t), dy: (b.y - a.y) / (b.t - a.t) };
}

/** Polyline in scene coordinates. */
export const toScene = (pts: [number, number][]) => pts.map(([x, y]) => enuToScene(x, y));

// ---------------------------------------------------------------------------
// What both devices draw (the laptop builds it, the phone receives it).
// ---------------------------------------------------------------------------
export type SiteStatus = 'next' | 'planned' | 'done' | 'out';
export interface MissionViewNet {
  activo: boolean;
  sitios: Record<number, { s: SiteStatus; o: number | null }>;
  peligros: { id: string; x: number; z: number; r: number; efecto: 'bloqueo' | 'multiplicador'; factor: number }[];
  escape: [number, number][] | null;
  aviso: { texto: string; detalle: string; nivel: 'info' | 'alerta'; ms: number } | null;
  spe: string | null;
}

export const missionView: MissionViewNet & { version: number } = { activo: false, sitios: {}, peligros: [], escape: null, aviso: null, spe: null, version: 0 };

/** Laptop: derive the drawable view from the mission state. */
export function buildMissionView(): MissionViewNet {
  const sitios: MissionViewNet['sitios'] = {};
  const paradas = mission.plan?.paradas ?? [];
  const pending = paradas.filter((p) => !mission.muestras.has(p.id));
  paradas.forEach((p, i) => {
    sitios[p.id] = { s: mission.muestras.has(p.id) ? 'done' : pending[0]?.id === p.id && !mission.abortado ? 'next' : 'planned', o: i + 1 };
  });
  for (const id of mission.muestras) sitios[id] = { s: 'done', o: sitios[id]?.o ?? null };
  const now = performance.now();
  return {
    activo: missionActive(),
    sitios,
    peligros: [...mission.peligros.values()].map((p) => {
      const s = enuToScene(p.x, p.y);
      return { id: p.id, x: s.x, z: s.z, r: p.radio_m, efecto: p.efecto, factor: p.factor };
    }),
    escape: mission.escape ? toScene(mission.escape).map((p) => [p.x, p.z] as [number, number]) : null,
    aviso: mission.aviso && mission.aviso.hasta > now ? { texto: mission.aviso.texto, detalle: mission.aviso.detalle, nivel: mission.aviso.nivel, ms: mission.aviso.hasta - now } : null,
    spe: mission.spe?.nivel ?? null,
  };
}

let viewKey = '';
/** Laptop: refresh missionView; returns true when it changed (then it is pushed to the phone). */
export function refreshMissionView(): boolean {
  const v = buildMissionView();
  const key = JSON.stringify({ ...v, aviso: v.aviso ? v.aviso.texto : null });
  if (key === viewKey) return false;
  viewKey = key;
  applyMissionView(v);
  return true;
}

/** Both devices: take a view (the phone from the network). */
export function applyMissionView(v: MissionViewNet) {
  Object.assign(missionView, v);
  if (v.aviso) missionAviso.hasta = performance.now() + v.aviso.ms;
  missionAviso.texto = v.aviso?.texto ?? '';
  missionAviso.detalle = v.aviso?.detalle ?? '';
  missionAviso.nivel = v.aviso?.nivel ?? 'info';
  missionView.version++;
}

/** The current notice, with a local clock (works on the phone too). */
export const missionAviso = { texto: '', detalle: '', nivel: 'info' as 'info' | 'alerta', hasta: 0 };
