// Simulation engine: per-frame kinematics for astronaut, rover and scout drone,
// the science tour, Martian time, O₂ bookkeeping and hazard injection. Hot
// per-frame state lives in the mutable `rt` object (read by the 3D components
// inside useFrame); anything the HUD needs is pushed into the zustand store at
// event time or by the 10 Hz telemetry loop.
import * as THREE from 'three';
import { cellOf, computeCostmap, costGrid, type Hazard } from '../lib/costmap';
import { evaluateRoute, type RouteMetrics } from '../lib/metrics';
import {
  dijkstra,
  fieldAt,
  fieldPathHome,
  fieldPathTo,
  planAStar,
  planGreedy,
  resample,
  type Algo,
  type Field,
  type PlanResult,
} from '../lib/pathfinding';
import { fowValueAt, resetFow, revealCircle, terrainUniforms, updateCostTexture } from '../lib/gpuMaps';
import { BASE_A, CANYON, applyBumps, canyonMask, CRATERS, dist, heightAt, normalAt, sandAt, type XZ } from '../lib/terrain';
import { mulberry32 } from '../lib/noise';
import { KAPPA_O2, M_WORK, Q_O2, RHO, STANDING_W, pandolfWatts, walkSpeed } from '../lib/energy';
import { SOL_SECONDS, formatHours, groundTempC, marsDate, sunAt, sunsetLtst, type MarsDate, type SunState } from '../lib/marsTime';
import { HABITAT, HABITAT_DOSE_FACTOR, SITES, expectedDose, findShelters, skyViewFactor, speRate, type ScienceSite, type ShelterCandidate } from '../lib/sites';
import { solveTour, type TourPlan } from '../lib/tour';
import { siteMineral, siteName } from '../i18n';
import { emptyHistory, initialTelemetry, useSimStore, type DroneState, type LogLevel, type MissionMode } from './useSimStore';

export const ROVER_LEAD = 15; // metres ahead of the astronaut
export const STORM_MINUTES = 40; // mission minutes of solar particle flux
export const FFWD = 60; // time acceleration while everyone is stationary
export const SPEEDS = [1, 4, 10];
const HOUR = SOL_SECONDS / 24; // one Martian hour, in seconds
const RESCUE_O2_LPM = 1.6; // umbilical O₂ supply, litres per mission minute
// SPE profile (peak, decay) lives in sites.ts: speRate(t).

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------
export interface Route {
  xs: Float32Array;
  zs: Float32Array;
  cum: Float32Array;
  len: number;
  n: number;
}

export function makeRoute(pts: XZ[]): Route {
  const n = pts.length;
  const xs = new Float32Array(n);
  const zs = new Float32Array(n);
  const cum = new Float32Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i].x;
    zs[i] = pts[i].z;
    if (i > 0) len += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    cum[i] = len;
  }
  return { xs, zs, cum, len, n };
}

export function sampleRoute(r: Route, s: number, out: XZ = { x: 0, z: 0 }): XZ {
  if (r.n === 0) return out;
  if (r.n === 1 || s <= 0) {
    out.x = r.xs[0];
    out.z = r.zs[0];
    return out;
  }
  if (s >= r.len) {
    out.x = r.xs[r.n - 1];
    out.z = r.zs[r.n - 1];
    return out;
  }
  let lo = 0;
  let hi = r.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = r.cum[hi] - r.cum[lo] || 1;
  const t = (s - r.cum[lo]) / seg;
  out.x = r.xs[lo] + (r.xs[hi] - r.xs[lo]) * t;
  out.z = r.zs[lo] + (r.zs[hi] - r.zs[lo]) * t;
  return out;
}

export const headingOf = (dx: number, dz: number) => Math.atan2(dx, -dz);
const angleDiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const clampAbs = (v: number, m: number) => Math.max(-m, Math.min(m, v));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const _a: XZ = { x: 0, z: 0 };
const _b: XZ = { x: 0, z: 0 };
export function routeHeading(r: Route, s: number): number {
  sampleRoute(r, s - 1.5, _a);
  sampleRoute(r, s + 1.5, _b);
  if (Math.abs(_b.x - _a.x) + Math.abs(_b.z - _a.z) < 1e-4) return NaN;
  return headingOf(_b.x - _a.x, _b.z - _a.z);
}

/** Signed grade (%) of the route around arc length s. */
function routeGrade(r: Route, s: number): number {
  sampleRoute(r, s, _a);
  sampleRoute(r, s + 1.5, _b);
  const d = Math.hypot(_b.x - _a.x, _b.z - _a.z);
  if (d < 0.2) return 0;
  return (100 * (heightAt(_b.x, _b.z) - heightAt(_a.x, _a.z))) / d;
}

function routeSlice(r: Route, s0: number, s1: number): XZ[] {
  const out: XZ[] = [];
  if (s1 - s0 < 0.5) return out;
  out.push(sampleRoute(r, s0, { x: 0, z: 0 }));
  for (let i = 0; i < r.n; i++) if (r.cum[i] > s0 && r.cum[i] < s1) out.push({ x: r.xs[i], z: r.zs[i] });
  out.push(sampleRoute(r, s1, { x: 0, z: 0 }));
  return out;
}

const polyLen = (pts: XZ[]) => {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  return l;
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------
type RoverMode = 'follow' | 'transit' | 'docked';
type AstroMode = 'idle' | 'walk' | 'hold' | 'collapsed' | 'busy';
export type ActivityKind = 'sample' | 'wait' | 'shelter' | 'stabilize';

export interface Stop {
  s: number; // arc length on the route
  site: ScienceSite;
  done: boolean;
}

export interface Activity {
  kind: ActivityKind;
  until: number; // mission seconds (Infinity = until an event ends it)
  site?: ScienceSite;
}

function freshRuntime() {
  return {
    route: makeRoute([BASE_A]),
    transit: null as Route | null,
    ghost: [] as XZ[],
    stops: [] as Stop[],
    homeBound: false, // the route ends at the habitat
    sRover: 0,
    sAstro: 0,
    startDelay: 2.5,
    lead: ROVER_LEAD,
    activity: null as Activity | null,
    o2: Q_O2,
    massKg: 0,
    minerals: {} as Record<string, number>,
    visited: new Set<number>(),
    homeField: null as Field | null,
    shelter: null as ShelterCandidate | null,
    watts: STANDING_W,
    rover: {
      x: BASE_A.x + 2,
      z: BASE_A.z + 2,
      y: 0,
      heading: Math.PI * 0.75,
      speed: 0,
      yawRate: 0,
      mode: 'follow' as RoverMode,
      purpose: 'rejoin' as 'rejoin' | 'rescue',
      sTransit: 0,
      maxSpeed: 2.4,
      joinS: 0,
      transitTime: 0,
      bestEnd: Infinity,
      wheelRot: 0,
      arm: 0,
      flood: 0,
      quat: new THREE.Quaternion(),
      pitch: 0,
      roll: 0,
    },
    astro: {
      x: BASE_A.x,
      z: BASE_A.z,
      y: 0,
      heading: Math.PI * 0.75,
      speed: 0,
      mode: 'idle' as AstroMode,
      walkPhase: 0,
      collapse: 0,
      moving: false,
      grade: 0,
    },
    drone: {
      x: BASE_A.x,
      y: 0,
      z: BASE_A.z,
      heading: 0,
      state: 'docked' as DroneState,
      t: 0,
      tx: 0,
      tz: 0,
      scanProgress: 0,
      rotor: 0,
      toCanyon: false,
      ox: 0,
      oz: 0,
    },
    elapsed: 0,
    missionSec: 0,
    scale: 1, // current effective time scale (for the HUD)
    stormT: -1, // mission seconds since the SPE started (−1 = none)
    stormIntensity: 0,
    fowTimer: 0,
    alarm: 0,
    sunTimer: 0,
    checkTimer: 0,
    rescueT: 0,
    lastScan: -1e9, // mission second of the last panoramic drone scan
    trapped: false, // no safe path home: crew holds position
    // Martian time & place
    lat: -4.8253,
    lon: 137.389,
    startLtst: 8,
    mars: marsDate(Date.now()) as MarsDate,
    sun: sunAt(-4.8, 0, 8, 1.5) as SunState,
    sunset: 18,
  };
}

export const rt = freshRuntime();

export const ltstNow = () => rt.startLtst + rt.missionSec / HOUR;

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------
const S = () => useSimStore.getState();
let logId = 0;
export function log(level: LogLevel, msg: string) {
  const clock = formatHours(ltstNow());
  useSimStore.setState((s) => ({ log: [{ id: ++logId, clock, level, msg }, ...s.log].slice(0, 40) }));
}
const bumpRoute = () => useSimStore.setState((s) => ({ routeVersion: s.routeVersion + 1 }));
const setMode = (m: MissionMode) => useSimStore.setState({ missionMode: m });

function updateSun() {
  rt.sun = sunAt(rt.lat, rt.mars.decl, ltstNow(), rt.mars.rAU);
}

function recost() {
  const st = S();
  updateSun();
  computeCostmap(st.hazards, st.canyonScanned, rt.sun, (x, z) => fowValueAt(x, z) > 0.35);
  updateCostTexture();
  rt.homeField = dijkstra(HABITAT, false);
  useSimStore.setState((s) => ({ costVersion: s.costVersion + 1 }));
}

/** O₂ litres needed to walk home from p (the return field R(p)). */
export const returnLitres = (p: XZ) => (rt.homeField ? fieldAt(rt.homeField, p) : 0);
export const returnSeconds = (p: XZ) => (rt.homeField ? fieldAt(rt.homeField, p, 'time') : 0);

function runPlanner(algo: Algo, start: XZ, goal: XZ): PlanResult {
  if (algo === 'astar') return planAStar(start, goal);
  const g = planGreedy(start, goal);
  if (g.ok) return g;
  const a = planAStar(start, goal);
  return { ...a, algo: 'greedy', fallback: true, computeMs: a.computeMs + g.computeMs, expanded: a.expanded + g.expanded };
}

// ---------------------------------------------------------------------------
// Tour planning
// ---------------------------------------------------------------------------
let lastPlan: TourPlan | null = null;

function remainingSites(): ScienceSite[] {
  const busy = rt.activity?.site?.id;
  return SITES.filter((s) => !rt.visited.has(s.id) && s.id !== busy);
}

function planFrom(start: XZ, ltst: number): TourPlan {
  return solveTour(remainingSites(), {
    start,
    home: HABITAT,
    o2Litres: rt.o2,
    ltst,
    massKg: rt.massKg,
    mineralCounts: rt.minerals,
    sunsetLtst: rt.sunset,
  });
}

/** Legs for a fixed order of stops, using the chosen planner between them. */
function legsWith(algo: Algo, start: XZ, order: XZ[]): { pts: XZ[]; stopS: number[]; ms: number; expanded: number; fallback: boolean } {
  const pts: XZ[] = [start];
  const stopS: number[] = [];
  let ms = 0;
  let expanded = 0;
  let fallback = false;
  let from = start;
  for (const p of [...order, HABITAT]) {
    const res = runPlanner(algo, from, p);
    ms += res.computeMs;
    expanded += res.expanded;
    fallback ||= !!res.fallback;
    pts.push(...res.points.slice(1));
    stopS.push(polyLen(pts));
    from = p;
  }
  stopS.pop(); // last one is home
  return { pts, stopS, ms, expanded, fallback };
}

function publishTour(plan: TourPlan | null) {
  lastPlan = plan;
  if (!plan) return useSimStore.setState({ tour: null });
  useSimStore.setState({
    tour: {
      stops: plan.stops.map((s) => ({
        code: s.site.code,
        name: siteName(s.site.code, s.site.name),
        mineral: siteMineral(s.site.code, s.site.mineral),
        arrive: s.arrive,
        leave: s.leave,
        wait: s.wait,
        o2After: s.o2After,
        gain: s.gain,
        done: false,
      })),
      z: plan.z,
      o2Home: plan.o2Home,
      homeLtst: plan.homeLtst,
      explored: plan.nodesExplored,
      computeMs: plan.computeMs,
      skipped: plan.skipped.map((k) => ({ code: k.site.code, reason: k.reason })),
      matrix: plan.matrix,
    },
  });
}

function markStopsDone() {
  const t = S().tour;
  if (!t) return;
  useSimStore.setState({ tour: { ...t, stops: t.stops.map((s) => ({ ...s, done: SITES.some((x) => x.code === s.code && rt.visited.has(x.id)) })) } });
}

function updateMetrics(start: XZ, active: { pts: XZ[]; ms: number; expanded: number; fallback: boolean }, other: { pts: XZ[]; ms: number; expanded: number; fallback: boolean }, straightPts: XZ[]) {
  const st = S();
  const batteryPct = st.telemetry.battery;
  const straight = evaluateRoute(straightPts, { algo: 'straight', batteryPct });
  const ev = (algo: Algo, p: typeof active): RouteMetrics => {
    const m = evaluateRoute(p.pts, { algo, batteryPct, computeMs: p.ms, expanded: p.expanded, fallback: p.fallback });
    m.o2SavedPct = straight.litres > 0 ? ((straight.litres - m.litres) / straight.litres) * 100 : 0;
    return m;
  };
  const otherAlgo: Algo = st.algorithm === 'astar' ? 'greedy' : 'astar';
  const ma = ev(st.algorithm, active);
  const mo = ev(otherAlgo, other);
  // Savings are reported against the other planner on the same stop order
  // (the straight line is only a reference: it crosses impassable ground).
  const vs = (m: RouteMetrics, o: RouteMetrics) => (o.litres > 0 ? ((o.litres - m.litres) / o.litres) * 100 : 0);
  const sa = vs(ma, mo);
  const so = vs(mo, ma);
  ma.o2SavedPct = sa;
  mo.o2SavedPct = so;
  useSimStore.setState({
    metrics: {
      astar: st.algorithm === 'astar' ? ma : mo,
      greedy: st.algorithm === 'greedy' ? ma : mo,
      straight,
    },
  });
  void start;
}

/**
 * Build the science tour from `start` and turn it into the route.
 * prefix: path already committed (astronaut → rover) that the crew walks first.
 */
function buildTourRoute(start: XZ, prefix: XZ[], ltstAtStart: number) {
  const st = S();
  const plan = planFrom(start, ltstAtStart);
  publishTour(plan);
  const order = plan.order.map((s) => ({ x: s.x, z: s.z }));
  const active = legsWith(st.algorithm, start, order);
  const other = legsWith(st.algorithm === 'astar' ? 'greedy' : 'astar', start, order);
  const straightPts = [start, ...order, HABITAT];
  const pre = prefix.length > 1 ? polyLen(prefix) : 0;
  const pts = prefix.length > 1 ? prefix.concat(active.pts.slice(1)) : active.pts;
  rt.route = makeRoute(resample(pts, 1));
  rt.stops = plan.order.map((site, i) => ({ s: pre + active.stopS[i], site, done: false }));
  rt.homeBound = true;
  rt.ghost = other.pts;
  updateMetrics(start, active, other, straightPts);
  return plan;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
export function initSimulation() {
  const st = S();
  const keep = { lat: rt.lat, lon: rt.lon };
  Object.assign(rt, freshRuntime());
  rt.lat = keep.lat;
  rt.lon = keep.lon;
  rt.startLtst = st.startLtst;
  rt.mars = marsDate(Date.now());
  rt.sunset = sunsetLtst(rt.lat, rt.mars.decl);
  useSimStore.setState({
    missionMode: 'nominal',
    completeReason: '',
    hazards: [],
    stormActive: false,
    canyonScanned: false,
    droneState: 'docked',
    rescuePhase: null,
    freezeAlert: false,
    walkbackAlert: false,
    telemetry: initialTelemetry(),
    history: emptyHistory(),
    log: [],
    shelter: null,
    sunsetLtst: rt.sunset,
    ls: rt.mars.ls,
  });
  applyBumps([]);
  useSimStore.setState((s) => ({ terrainVersion: s.terrainVersion + 1 }));
  resetFow();
  revealCircle(BASE_A.x, BASE_A.z, 32);
  for (const s of SITES) if (!s.needsScan) revealCircle(s.x, s.z, 8);
  recost();
  const plan = buildTourRoute(BASE_A, [], rt.startLtst);
  const h = routeHeading(rt.route, 2);
  if (!Number.isNaN(h)) rt.rover.heading = rt.astro.heading = h;
  placeRoverOnRoute();
  bumpRoute();
  log('info', `Salida de la EVA a las ${formatHours(rt.startLtst)} LTST (Ls ${rt.mars.ls.toFixed(0)}°, atardecer ${formatHours(rt.sunset)}). AresCompanion abre camino 15 m adelante.`);
  log(
    'info',
    plan.order.length
      ? `Tour CTOPTW: ${plan.order.map((s) => s.code).join(' → ')} → hábitat · ciencia ${plan.z.toFixed(1)} · ${plan.nodesExplored} nodos de ramificación y poda en ${plan.computeMs.toFixed(0)} ms.`
      : 'Ningún sitio científico entra en el presupuesto de O₂, masa y luz: sólo una caminata corta.',
  );
}

function placeRoverOnRoute() {
  sampleRoute(rt.route, rt.sRover, _a);
  rt.rover.x = _a.x;
  rt.rover.z = _a.z;
}

/** Re-plan the remaining tour from the rover's position (keeps the crew trail). */
export function replanMain(reason?: string) {
  const st = S();
  const t0 = performance.now();
  recost();
  const mode = st.missionMode;
  if (mode === 'rescue' || mode === 'complete') {
    bumpRoute();
    return;
  }
  const r = rt.rover;
  if (mode === 'shelter') {
    goToShelter(false);
  } else if (mode === 'abort' || mode === 'medevac') {
    routeHomeFromAstro(null);
  } else if (r.mode === 'follow') {
    const prefix = routeSlice(rt.route, rt.sAstro, rt.sRover);
    const start = { x: r.x, z: r.z };
    const preLen = polyLen(prefix);
    rt.sAstro = 0;
    rt.sRover = prefix.length > 1 ? preLen : 0;
    const plan = buildTourRoute(start, prefix, ltstNow() + preLen / 0.8 / HOUR);
    const m = S().metrics[S().algorithm === 'astar' ? 'astar' : 'greedy'];
    useSimStore.setState({ replanInfo: { ms: performance.now() - t0, nodes: plan.nodesExplored + (m?.expanded ?? 0), litres: m?.litres ?? 0, at: Date.now() } });
  }
  bumpRoute();
  if (reason) log('ok', reason);
}

// ---------------------------------------------------------------------------
// Obstacles placed and dragged by the user (drone view)
// ---------------------------------------------------------------------------
let userSeq = 0;

function makeRocks(x: number, z: number, r: number, seed: number) {
  const rng = mulberry32(seed);
  return Array.from({ length: 30 }, () => {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * r;
    return { x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, s: 0.3 + Math.pow(rng(), 2) * 1.0, rot: rng() * 6.28 };
  });
}

/** Keep a dropped obstacle from landing on top of the crew or the rover. */
function keepClear(x: number, z: number, r: number) {
  const p = { x, z };
  for (const e of [rt.astro, rt.rover]) {
    const dx = p.x - e.x;
    const dz = p.z - e.z;
    const d = Math.hypot(dx, dz);
    const min = r + 3;
    if (d < min) {
      const k = d > 0.01 ? min / d : 1;
      p.x = e.x + (d > 0.01 ? dx * k : min);
      p.z = e.z + (d > 0.01 ? dz * k : 0);
    }
  }
  return p;
}

export const HILL_HEIGHT = 12;
export const HILL_WIDTH = 13;

/** Re-shape the terrain with every user hill. */
function syncHills() {
  const hills = S().hazards.filter((h) => h.kind === 'hill');
  applyBumps(hills.map((h) => ({ x: h.x, z: h.z, h: h.height ?? HILL_HEIGHT, r: h.r })));
  useSimStore.setState((s) => ({ terrainVersion: s.terrainVersion + 1 }));
}

export function addUserHazard(kind: 'rocks' | 'cold' | 'hill', x0: number, z0: number): string {
  const id = `user-${kind}-${++userSeq}`;
  const radius = kind === 'cold' ? 9 : kind === 'hill' ? HILL_WIDTH : 6;
  const { x, z } = keepClear(x0, z0, kind === 'hill' ? radius * 1.3 : radius);
  const h: Hazard =
    kind === 'cold'
      ? { id, kind, x, z, r: radius }
      : kind === 'hill'
        ? { id, kind, x, z, r: radius, height: HILL_HEIGHT }
        : { id, kind, x, z, r: radius, rocks: makeRocks(x, z, 6, 1000 + userSeq) };
  useSimStore.setState((s) => ({ hazards: [...s.hazards, h] }));
  if (kind === 'hill') syncHills();
  revealCircle(x, z, 14);
  return id;
}

export function moveUserHazard(id: string, x0: number, z0: number) {
  useSimStore.setState((s) => ({
    hazards: s.hazards.map((h) => {
      if (h.id !== id) return h;
      const { x, z } = keepClear(x0, z0, h.kind === 'hill' ? h.r * 1.3 : h.r);
      const dx = x - h.x;
      const dz = z - h.z;
      return { ...h, x, z, rocks: h.rocks?.map((r) => ({ ...r, x: r.x + dx, z: r.z + dz })) };
    }),
  }));
  if (id.includes('-hill-')) syncHills();
  revealCircle(x0, z0, 14);
}

export function removeHazard(id: string) {
  useSimStore.setState((s) => ({ hazards: s.hazards.filter((h) => h.id !== id) }));
  if (id.includes('-hill-')) syncHills();
}

export function clearUserHazards() {
  useSimStore.setState((s) => ({ hazards: s.hazards.filter((h) => !h.id.startsWith('user')) }));
  syncHills();
  liveReplan(true, 'Obstáculos del usuario eliminados: ruta y tour recalculados.');
}

/** Hazard under a point (for the move / erase tools). */
export function hazardAt(x: number, z: number) {
  let best: Hazard | null = null;
  let bd = Infinity;
  for (const h of S().hazards) {
    const d = Math.hypot(h.x - x, h.z - z);
    if (d < h.r + 2 && d < bd) {
      bd = d;
      best = h;
    }
  }
  return best;
}

let lastLive = 0;
let pendingLive = 0;
/** Re-plan while an obstacle is being dragged (throttled) and once more on release. */
export function liveReplan(final: boolean, reason?: string) {
  const now = performance.now();
  window.clearTimeout(pendingLive);
  if (!final && now - lastLive < 220) {
    pendingLive = window.setTimeout(() => liveReplan(false), 230 - (now - lastLive));
    return;
  }
  lastLive = now;
  const mode = S().missionMode;
  if (mode === 'complete') return;
  replanMain(final ? reason : undefined);
  if (final && !reason) {
    const info = S().replanInfo;
    log('ok', info ? `Obstáculo colocado: grafo, R(p) y tour recalculados en ${info.ms.toFixed(0)} ms.` : 'Obstáculo colocado: ruta recalculada.');
  }
}

export function setAlgorithm(algo: Algo) {
  if (S().algorithm === algo) return;
  useSimStore.setState({ algorithm: algo });
  log('info', algo === 'astar' ? 'Tramos con A* GLOBAL (costo O₂ de Pandolf, heurística admisible).' : 'Tramos con planificador VORAZ local (modo de bajo consumo, CPU resistente a la radiación).');
  replanMain();
}

export function setTimeScale(k: number) {
  useSimStore.setState({ timeScale: k });
}

// ---------------------------------------------------------------------------
// Re-routing from the astronaut (aborts, shelter, medevac)
// ---------------------------------------------------------------------------
/** The crew walks `pts` from where they stand; the rover rejoins 15 m ahead. */
function adoptFromAstro(pts: XZ[]) {
  rt.route = makeRoute(resample(pts, 1));
  rt.sAstro = 0;
  rt.stops = [];
  const joinS = Math.min(rt.lead, rt.route.len);
  const jp = sampleRoute(rt.route, joinS, { x: 0, z: 0 });
  const r = rt.rover;
  if (dist(r, jp) < 2.5) {
    r.mode = 'follow';
    rt.sRover = joinS;
    rt.transit = null;
    if (rt.astro.mode !== 'collapsed') rt.astro.mode = 'walk';
  } else {
    const tr = planAStar({ x: r.x, z: r.z }, jp);
    rt.transit = makeRoute(tr.points);
    r.mode = 'transit';
    r.purpose = 'rejoin';
    r.sTransit = 0;
    r.joinS = joinS;
    r.maxSpeed = 2.4;
    r.transitTime = 0;
    r.bestEnd = Infinity;
    if (rt.astro.mode !== 'collapsed') rt.astro.mode = 'hold';
  }
  bumpRoute();
}

function routeHomeFromAstro(reason: string | null) {
  const a = { x: rt.astro.x, z: rt.astro.z };
  const field = rt.homeField ?? dijkstra(HABITAT, false);
  const algo = S().algorithm;
  const pts = algo === 'astar' ? fieldPathHome(field, a, HABITAT) : runPlanner(algo, a, HABITAT).points;
  rt.homeBound = true;
  rt.activity = null;
  publishTour(null);
  adoptFromAstro(pts);
  const ret = evaluateRoute(pts, { algo, batteryPct: S().telemetry.battery });
  rt.ghost = [];
  useSimStore.setState((s) => ({ metrics: { ...s.metrics, [algo === 'astar' ? 'astar' : 'greedy']: ret } }));
  if (reason) log('crit', reason);
}

function abortHome(reason: string) {
  if (S().missionMode !== 'nominal') return;
  setMode('abort');
  routeHomeFromAstro(reason);
}

// ---------------------------------------------------------------------------
// Hazard / event triggers
// ---------------------------------------------------------------------------
function aheadPoint(dAhead: number, lateral = 0): XZ {
  const r = rt.rover;
  let p: XZ;
  let h: number;
  if (r.mode === 'follow' && rt.route.len > 2) {
    const s = Math.min(rt.route.len - 6, rt.sRover + dAhead);
    p = sampleRoute(rt.route, Math.max(rt.sRover + 4, s), { x: 0, z: 0 });
    h = routeHeading(rt.route, s);
    if (Number.isNaN(h)) h = r.heading;
  } else {
    p = { x: r.x + Math.sin(r.heading) * dAhead, z: r.z - Math.cos(r.heading) * dAhead };
    h = r.heading;
  }
  p.x += Math.cos(h) * lateral;
  p.z += Math.sin(h) * lateral;
  return p;
}

const busyForEvents = () => {
  const m = S().missionMode;
  return m === 'complete' || m === 'rescue';
};

export function triggerColdShadow() {
  const st = S();
  if (busyForEvents()) return;
  const c = aheadPoint(24, 3);
  const hz: Hazard = { id: `cold-${Date.now()}`, kind: 'cold', x: c.x, z: c.z, r: 12 };
  useSimStore.setState({ hazards: st.hazards.filter((h) => h.kind !== 'cold' || h.id.startsWith('user')).concat(hz) });
  revealCircle(c.x, c.z, 20);
  log('warn', 'IR térmico: sombra de cráter a −100 °C adelante. Riesgo de congelar el lubricante de los actuadores.');
  replanMain('Ruta desviada de la zona fría hacia suelo soleado.');
}

export function triggerRockField() {
  const st = S();
  if (busyForEvents()) return;
  const c = aheadPoint(20, 0);
  const rng = mulberry32(Date.now() & 0xffff);
  const rocks = Array.from({ length: 46 }, () => {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * 7.5;
    return { x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d, s: 0.3 + Math.pow(rng(), 2) * 1.1, rot: rng() * 6.28 };
  });
  const hz: Hazard = { id: `rocks-${Date.now()}`, kind: 'rocks', x: c.x, z: c.z, r: 7.5, rocks };
  useSimStore.setState({ hazards: st.hazards.filter((h) => h.kind !== 'rocks' || h.id.startsWith('user')).concat(hz) });
  revealCircle(c.x, c.z, 18);
  log('warn', 'Cámara de peligros: campo de rocas sin mapear y regolito suelto 20 m adelante.');
  replanMain('Curva de evasión calculada alrededor del campo de rocas.');
}

/** Pick the shelter with the lowest expected dose: travel in the open + waiting there. */
function chooseShelter(from: XZ): { c: ShelterCandidate; field: Field; dose: number; travelMin: number } {
  const st = S();
  const field = dijkstra(from, true);
  const cands = findShelters(
    (p) => Number.isFinite(costGrid.cost[cellOf(p)]),
    st.canyonScanned,
    (p) => canyonMask(p.x, p.z) > 0.3,
    (p) => CRATERS.some((c) => Math.hypot(p.x - c.x, p.z - c.z) < c.r * 1.2),
  );
  const t0 = Math.max(0, rt.stormT);
  const tEnd = STORM_MINUTES * 60;
  let best = { c: cands[0], dose: Infinity, travelMin: 0 };
  for (const c of cands) {
    const travel = fieldAt(field, c, 'time'); // seconds walking in the open
    if (!Number.isFinite(travel)) continue;
    // Integrate the SPE profile: open sky while walking, shielded once there.
    const dose = expectedDose(t0, travel, c.svf, tEnd);
    if (dose < best.dose) best = { c, dose, travelMin: travel / 60 };
  }
  return { ...best, field };
}

function goToShelter(announce: boolean) {
  const a = { x: rt.astro.x, z: rt.astro.z };
  const pick = chooseShelter(a);
  rt.shelter = pick.c;
  const pts = fieldPathTo(pick.field, a, pick.c);
  rt.homeBound = pick.c.kind === 'habitat';
  // In a natural shelter the rover parks right beside the crew as extra shielding.
  rt.lead = pick.c.kind === 'habitat' ? ROVER_LEAD : 6;
  rt.activity = null;
  publishTour(null);
  adoptFromAstro(pts);
  rt.ghost = [];
  useSimStore.setState({ shelter: { kind: pick.c.kind, svf: pick.c.svf, x: pick.c.x, z: pick.c.z, dose: pick.dose } });
  if (announce) {
    const where = pick.c.kind === 'habitat' ? 'el hábitat' : pick.c.kind === 'canyon' ? 'el fondo del cañón' : pick.c.kind === 'crater' ? 'una pared de cráter' : 'el reparo de la loma';
    log(
      'crit',
      `Refugio: ${where}, a ${pick.travelMin.toFixed(0)} min, factor de dosis ×${pick.c.svf.toFixed(2)} (cielo visible × escudo del rover) → dosis esperada ${pick.dose.toFixed(2)} mSv.`,
    );
  }
}

export function triggerStorm() {
  const st = S();
  if (st.stormActive || st.missionMode === 'complete') return;
  rt.stormT = 0;
  useSimStore.setState({ stormActive: true });
  log('crit', `EVENTO DE PARTÍCULAS SOLARES detectado por RAD: pico ≈ ${(speRate(60) + 0).toFixed(1)} mSv/h a cielo abierto, decae en ~${STORM_MINUTES} min.`);
  if (st.missionMode === 'nominal' || st.missionMode === 'abort') {
    setMode('shelter');
    goToShelter(true);
  }
}

function endStorm() {
  rt.stormT = -1;
  useSimStore.setState({ stormActive: false });
  log('ok', 'El flujo de partículas volvió al fondo. Se reevalúa el tour con el O₂ y la luz que quedan.');
  if (S().missionMode !== 'shelter') return;
  rt.activity = null;
  rt.shelter = null;
  rt.lead = ROVER_LEAD;
  useSimStore.setState({ shelter: null });
  setMode('nominal');
  recost();
  const a = { x: rt.astro.x, z: rt.astro.z };
  const plan = planFrom(a, ltstNow());
  if (plan.order.length === 0) {
    setMode('abort');
    routeHomeFromAstro('Tras la tormenta ya no entra ninguna parada científica: regreso al hábitat.');
    return;
  }
  publishTour(plan);
  const order = plan.order.map((s) => ({ x: s.x, z: s.z }));
  const active = legsWith(S().algorithm, a, order);
  const other = legsWith(S().algorithm === 'astar' ? 'greedy' : 'astar', a, order);
  adoptFromAstro(active.pts);
  rt.stops = plan.order.map((site, i) => ({ s: active.stopS[i], site, done: false }));
  rt.homeBound = true;
  rt.ghost = other.pts;
  updateMetrics(a, active, other, [a, ...order, HABITAT]);
  log('ok', `Tour reanudado: ${plan.order.map((s) => s.code).join(' → ')} → hábitat.`);
}

export const SCAN_ALT = 40; // m above the ground: panoramic vantage point
export const SCAN_RADIUS = 80; // m of terrain the lidar maps from that height
export const SCAN_EVERY_S = 15 * 60; // automatic scan every 15 mission minutes

/**
 * Panoramic scout: the drone climbs straight above the rover, drifts ~25 m
 * ahead along the route, maps 80 m around from 40 m up and the planner
 * re-optimises with what it saw.
 */
export function deployDrone(auto = false) {
  const st = S();
  const d = rt.drone;
  if (d.state !== 'docked' || st.missionMode === 'complete') return;
  const tgt = aheadPoint(25);
  d.toCanyon = false;
  d.tx = tgt.x;
  d.tz = tgt.z;
  rt.lastScan = rt.missionSec;
  log('info', auto ? 'Dron automático: sube sobre el rover para ver el terreno de adelante desde 40 m.' : 'Dron: vista panorámica solicitada, sube sobre el rover.');
  setDroneState('launch');
}

function autoDrone() {
  const st = S();
  if (st.paused || st.missionMode !== 'nominal' || rt.drone.state !== 'docked') return;
  if (rt.astro.mode !== 'walk' || rt.activity || rt.rover.mode !== 'follow') return;
  if (rt.missionSec - rt.lastScan < SCAN_EVERY_S) return;
  deployDrone(true);
}

export function triggerRescue() {
  const st = S();
  if (st.missionMode === 'rescue' || st.missionMode === 'complete' || st.missionMode === 'medevac') return;
  setMode('rescue');
  useSimStore.setState({ rescuePhase: 'inbound' });
  const a = rt.astro;
  const r = rt.rover;
  a.mode = 'collapsed';
  a.speed = 0;
  rt.activity = null;
  rt.rescueT = 0;
  log('crit', 'EMERGENCIA DE TRIPULACIÓN: taquicardia > 165 lpm, SpO₂ en descenso. Astronauta caído.');
  log('crit', 'RESCATE AUTÓNOMO: tour suspendido, giro de 180°, el rover corre hacia el astronauta.');
  startRescueTransit();
  r.flood = 1;
  bumpRoute();
}

function startRescueTransit() {
  const a = rt.astro;
  const r = rt.rover;
  const dx = r.x - a.x;
  const dz = r.z - a.z;
  const d = Math.hypot(dx, dz) || 1;
  const target = d < 3.4 ? { x: r.x, z: r.z } : { x: a.x + (dx / d) * 3.4, z: a.z + (dz / d) * 3.4 };
  const tr = planAStar({ x: r.x, z: r.z }, target);
  rt.transit = makeRoute(tr.ok ? tr.points : [{ x: r.x, z: r.z }, target]);
  r.mode = 'transit';
  r.purpose = 'rescue';
  r.sTransit = 0;
  r.maxSpeed = 3.4;
  r.transitTime = 0;
  r.bestEnd = Infinity;
  if (d < 3.4) arriveTransit();
}

/** Once vitals are stable the astronaut stands up and the rover escorts them home. */
function startMedevac() {
  const a = rt.astro;
  const r = rt.rover;
  a.mode = 'hold';
  a.collapse = 0;
  r.flood = 0;
  r.arm = 0;
  r.mode = 'follow';
  rt.lead = 8; // stay close on the way back
  useSimStore.setState({ rescuePhase: null });
  setMode('medevac');
  recost();
  routeHomeFromAstro('Signos vitales estables: el astronauta se levanta. EVACUACIÓN — el rover lo escolta a 8 m hasta el hábitat.');
}

export function resetSimulation() {
  initSimulation();
}

function setDroneState(s: DroneState) {
  rt.drone.state = s;
  rt.drone.t = 0;
  useSimStore.setState({ droneState: s });
}

// ---------------------------------------------------------------------------
// Environment model
// ---------------------------------------------------------------------------
export function surfaceTempAt(x: number, z: number): number {
  const lt = ltstNow();
  let t = groundTempC(lt, rt.lat, rt.mars.decl, rt.mars.rAU);
  if (rt.sun.elevation > 0 && costGrid.shade[cellOf({ x, z })]) t -= 18 * Math.min(1, rt.sun.elevation / 30);
  for (const h of S().hazards) {
    if (h.kind !== 'cold') continue;
    const d = Math.hypot(x - h.x, z - h.z);
    const k = 1 - Math.min(1, Math.max(0, (d - h.r * 0.6) / (h.r * 0.7)));
    t += (-101 - t) * k;
  }
  return t;
}

export const doseFactorAt = (p: XZ) => {
  if (rt.activity?.kind === 'shelter' && rt.shelter) return rt.shelter.kind === 'habitat' ? HABITAT_DOSE_FACTOR : rt.shelter.svf;
  return skyViewFactor(p.x, p.z, 60, 1.2);
};
export const stormRate = () => (rt.stormT >= 0 ? speRate(rt.stormT) : 0);

// ---------------------------------------------------------------------------
// Per-frame step
// ---------------------------------------------------------------------------
const _n = new THREE.Vector3();
const _f = new THREE.Vector3();
const _x = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const tmp: XZ = { x: 0, z: 0 };
const tmp2: XZ = { x: 0, z: 0 };

/** Everyone is stationary, so mission time can run fast without visible jumps. */
function canFastForward() {
  const r = rt.rover;
  const busy = rt.activity && (rt.activity.kind === 'sample' || rt.activity.kind === 'wait' || rt.activity.kind === 'shelter' || rt.activity.kind === 'stabilize');
  return !!busy && r.mode !== 'transit' && Math.abs(r.speed) < 0.08 && Math.abs(rt.astro.speed) < 0.05 && rt.drone.state === 'docked';
}

export function stepSim(dtReal: number) {
  const st = S();
  if (st.paused) {
    rt.scale = 0;
    updateGpu(dtReal);
    return;
  }
  rt.elapsed += dtReal;
  const ff = canFastForward();
  rt.scale = st.timeScale * (ff ? FFWD : 1);
  const total = Math.min(dtReal, 0.05) * rt.scale;
  // Kinematics never integrate more than 50 ms at a time.
  const n = ff ? 1 : Math.max(1, Math.ceil(total / 0.05));
  const dt = total / n;
  for (let i = 0; i < n; i++) step(dt, ff);
  orientRover(Math.min(dtReal, 0.05));
  rt.alarm = S().missionMode === 'rescue' ? (rt.alarm + dtReal) % 1 : 0;
  updateGpu(dtReal);
}

function step(dt: number, ff: boolean) {
  const st = S();
  rt.missionSec += dt;
  stepStorm(dt);
  if (st.missionMode !== 'complete') {
    if (!ff) {
      stepRover(dt);
      stepAstro(dt);
    }
    stepActivity();
    consume(dt);
    checkRules(dt);
    checkCompletion();
  } else {
    rt.rover.speed *= 0.9;
    rt.astro.speed = 0;
    rt.astro.moving = false;
    consume(dt);
  }
  if (!ff) stepDrone(dt);
  autoDrone();
  // The Sun moves ~0.25° per mission minute: refresh shadows every 10 minutes.
  rt.sunTimer += dt;
  updateSun();
  if (rt.sunTimer > 600) {
    rt.sunTimer = 0;
    recost();
  }
}

function stepStorm(dt: number) {
  if (rt.stormT >= 0) {
    rt.stormT += dt;
    const up = Math.min(1, rt.stormT / 90);
    const down = 1 - Math.min(1, Math.max(0, (rt.stormT - (STORM_MINUTES * 60 - 180)) / 180));
    rt.stormIntensity = up * down;
    if (rt.stormT > STORM_MINUTES * 60) endStorm();
  } else {
    rt.stormIntensity = Math.max(0, rt.stormIntensity - dt * 0.02);
  }
}

function consume(dt: number) {
  const a = rt.astro;
  const r = rt.rover;
  let watts = STANDING_W;
  if (a.mode === 'collapsed') watts = r.mode === 'docked' && r.arm > 0.95 ? 160 : 430;
  else if (rt.activity?.kind === 'sample') watts = M_WORK;
  else if (a.moving) watts = pandolfWatts(a.grade, 1 + 0.9 * sandAt(a.x, a.z), a.speed);
  rt.watts = watts;
  if (a.mode === 'collapsed' && r.mode === 'docked' && r.arm > 0.95) {
    rt.o2 = Math.min(Q_O2, rt.o2 + (RESCUE_O2_LPM * dt) / 60); // umbilical feeds the PLSS
  } else {
    rt.o2 = Math.max(0, rt.o2 - (watts * KAPPA_O2 * dt) / 60);
  }
}

/** Flight rules: point of no return (O₂) and daylight, checked once per mission second. */
function checkRules(dt: number) {
  rt.checkTimer += dt;
  if (rt.checkTimer < 1) return;
  rt.checkTimer = 0;
  const st = S();
  if (rt.astro.mode === 'idle' || rt.astro.mode === 'collapsed') return;
  const p = { x: rt.astro.x, z: rt.astro.z };
  const R = returnLitres(p);
  // Completely enclosed: no walkable path home exists. Never walk through an
  // impassable obstacle: hold position, keep the rover on station and wait
  // until the obstacle is cleared (or ground support re-routes).
  if (!Number.isFinite(R)) {
    if (!rt.trapped) {
      rt.trapped = true;
      rt.astro.mode = 'hold';
      log('crit', 'SIN RUTA SEGURA: no existe camino transitable hacia el hábitat. Tripulación detenida, el rover queda de escolta y se pide apoyo.');
    }
    return;
  }
  if (rt.trapped) {
    rt.trapped = false;
    if (rt.rover.mode === 'follow') rt.astro.mode = 'walk';
    log('ok', 'Ruta segura restablecida: la tripulación retoma la marcha.');
  }
  if (st.missionMode !== 'nominal') return;
  if (rt.o2 < (1 + RHO) * R + 2) {
    abortHome(`PUNTO DE NO RETORNO: O₂ ${rt.o2.toFixed(0)} L < (1 + ρ)·R(p) = ${((1 + RHO) * R).toFixed(0)} L. Ciencia cancelada, regreso por la ruta de menor O₂.`);
    return;
  }
  const backAt = ltstNow() + returnSeconds(p) / HOUR;
  if (backAt > rt.sunset - 0.5) abortHome(`LUZ DEL DÍA: llegar al hábitat a las ${formatHours(backAt)} sería después del atardecer (${formatHours(rt.sunset)}) − 30 min.`);
}

function stepActivity() {
  const act = rt.activity;
  if (!act) return;
  const lt = ltstNow();
  if (act.kind === 'wait' && act.site && lt >= act.site.window[0]) {
    rt.activity = { kind: 'sample', until: rt.missionSec + act.site.drillMin * 60, site: act.site };
    log('info', `${act.site.code} · se abrió la ventana: muestreo de ${siteName(act.site.code)} (${act.site.drillMin} min).`);
    return;
  }
  if (act.kind === 'sample' && act.site && rt.missionSec >= act.until) {
    const s = act.site;
    rt.visited.add(s.id);
    rt.massKg += s.massKg;
    rt.minerals[s.mineral] = (rt.minerals[s.mineral] ?? 0) + 1;
    const stop = rt.stops.find((x) => x.site.id === s.id);
    if (stop) stop.done = true;
    rt.activity = null;
    rt.astro.mode = 'walk';
    markStopsDone();
    log('ok', `${s.code} · ${siteName(s.code)}: ${s.massKg.toFixed(1)} kg de ${siteMineral(s.code).toLowerCase()} guardados (${rt.massKg.toFixed(1)} kg en total).`);
  }
  if (act.kind === 'stabilize' && rt.missionSec >= act.until) {
    rt.activity = null;
    startMedevac();
  }
}

function arriveAtStop(stop: Stop) {
  const lt = ltstNow();
  const s = stop.site;
  const a = rt.astro;
  if (rt.visited.has(s.id)) {
    stop.done = true;
    return;
  }
  a.speed = 0;
  a.mode = 'busy';
  if (lt > s.window[1]) {
    stop.done = true;
    rt.visited.add(s.id);
    a.mode = 'walk';
    log('warn', `${s.code} · la ventana cerró a las ${formatHours(s.window[1])}: sitio omitido.`);
    return;
  }
  if (lt < s.window[0]) {
    rt.activity = { kind: 'wait', until: Infinity, site: s };
    log('info', `${s.code} · esperando la ventana de las ${formatHours(s.window[0])} (${((s.window[0] - lt) * 60).toFixed(0)} min).`);
  } else {
    rt.activity = { kind: 'sample', until: rt.missionSec + s.drillMin * 60, site: s };
    log('info', `${s.code} · muestreo de ${siteName(s.code)} (${s.drillMin} min).`);
  }
}

function stepRover(dt: number) {
  const r = rt.rover;
  if (r.mode === 'follow') {
    const route = rt.route;
    const gap = rt.sRover - rt.sAstro;
    let target = 0;
    if (rt.astro.mode !== 'collapsed' && rt.sRover < route.len - 0.05) {
      // Match the astronaut's speed and correct the remaining gap error.
      const slope = costGrid.slope[cellOf(r)] ?? 0;
      const maxSpeed = 1.7 * (1 - Math.min(slope, 25) / 60);
      target = Math.max(0, Math.min(maxSpeed, rt.astro.speed + 0.8 * (rt.lead - gap)));
    }
    r.speed += (target - r.speed) * Math.min(1, dt * 2.5);
    rt.sRover = Math.min(route.len, rt.sRover + r.speed * dt);
    placeRoverOnRoute();
    const th = routeHeading(route, rt.sRover + 1);
    if (!Number.isNaN(th)) r.heading += clampAbs(angleDiff(r.heading, th), 1.8 * dt);
  } else if (r.mode === 'transit' && rt.transit) {
    const tr = rt.transit;
    let guard = 0;
    while (r.sTransit < tr.len && guard++ < 200) {
      sampleRoute(tr, r.sTransit, tmp);
      if (Math.hypot(tmp.x - r.x, tmp.z - r.z) >= 3) break;
      r.sTransit += 0.5;
    }
    const look = sampleRoute(tr, Math.min(tr.len, r.sTransit + 2.5), tmp);
    const end = sampleRoute(tr, tr.len, tmp2);
    const dEnd = Math.hypot(end.x - r.x, end.z - r.z);
    const aim = dEnd < 4 ? end : look;
    const desired = headingOf(aim.x - r.x, aim.z - r.z);
    const err = angleDiff(r.heading, desired);
    const yaw = clampAbs(err * 3, 2.2) * dt;
    r.heading += yaw;
    r.yawRate = yaw / dt;
    const align = Math.max(0.06, Math.pow(Math.cos(Math.min(Math.abs(err), Math.PI / 2)), 2));
    const target = r.maxSpeed * align * Math.min(1, dEnd / 4 + 0.25);
    r.speed += (target - r.speed) * Math.min(1, dt * 3);
    r.x += Math.sin(r.heading) * r.speed * dt;
    r.z -= Math.cos(r.heading) * r.speed * dt;
    // Watchdog: if the rover stops closing in on the end point (circling or
    // blocked), it re-plans; after 90 s it docks where it is.
    r.transitTime += dt;
    if (dEnd < r.bestEnd - 0.3) r.bestEnd = dEnd;
    if (dEnd < 1.2 || (r.purpose === 'rescue' && dEnd < 2.2 && r.speed < 0.3)) arriveTransit();
    else if (r.transitTime > 90) arriveTransit();
    else if (r.transitTime > 20 && dEnd > r.bestEnd + 1.5) {
      const t = planAStar({ x: r.x, z: r.z }, end);
      rt.transit = makeRoute(t.ok ? t.points : [{ x: r.x, z: r.z }, { ...end }]);
      r.sTransit = 0;
      r.transitTime = 0;
      r.bestEnd = Infinity;
    }
  } else if (r.mode === 'docked') {
    r.speed *= 0.85;
    r.arm = Math.min(1, r.arm + dt / 2.5);
    const a = rt.astro;
    r.heading += clampAbs(angleDiff(r.heading, headingOf(a.x - r.x, a.z - r.z)), 1.2 * dt);
    if (r.arm >= 1 && S().rescuePhase !== 'docked') {
      useSimStore.setState({ rescuePhase: 'docked' });
      // Stabilisation is a stationary activity: mission time can run fast.
      rt.activity = { kind: 'stabilize', until: rt.missionSec + 12 * 60 };
      log('ok', 'Umbilical conectado al traje. Flujo de O₂ de emergencia y refrigeración restablecidos. Estabilización de 12 min; telemetría enviada al médico del hábitat.');
    }
  }
  r.wheelRot += (r.speed * dt) / 0.34 + Math.abs(r.yawRate) * dt * 0.6;
  r.yawRate *= 0.9;
}

function arriveTransit() {
  const r = rt.rover;
  if (r.purpose === 'rescue') {
    r.mode = 'docked';
    r.speed = 0;
    rt.transit = null;
    log('ok', 'Rover junto al astronauta. Focos encendidos. Desplegando el brazo umbilical de soporte vital.');
  } else {
    r.mode = 'follow';
    rt.sRover = r.joinS;
    rt.transit = null;
    if (rt.astro.mode === 'hold') rt.astro.mode = 'walk';
    log('ok', 'El rover vuelve a abrir camino.');
  }
  bumpRoute();
}

function stepAstro(dt: number) {
  const a = rt.astro;
  if (a.mode === 'idle') {
    rt.startDelay -= dt;
    if (rt.startDelay <= 0) a.mode = 'walk';
  }
  if (a.mode === 'walk') {
    a.grade = routeGrade(rt.route, rt.sAstro);
    const sand = sandAt(a.x, a.z);
    let v = walkSpeed(a.grade, 1 + 0.9 * sand);
    if (S().missionMode === 'medevac') v *= 0.7;
    const next = rt.stops.find((s) => !s.done);
    const stopAt = next ? next.s : Infinity;
    const maxS = Math.min(rt.rover.mode === 'follow' ? Math.max(0, rt.sRover - 5) : rt.sAstro, stopAt);
    if (rt.sAstro >= maxS - 0.01) v = 0;
    a.speed += (v - a.speed) * Math.min(1, dt * 3);
    rt.sAstro = Math.min(maxS, rt.sAstro + Math.max(0, a.speed) * dt);
    sampleRoute(rt.route, rt.sAstro, tmp);
    a.x = tmp.x;
    a.z = tmp.z;
    const th = routeHeading(rt.route, rt.sAstro + 1);
    if (!Number.isNaN(th)) a.heading += clampAbs(angleDiff(a.heading, th), 2.5 * dt);
    if (next && rt.sAstro >= next.s - 0.05) arriveAtStop(next);
    // Arrived at the shelter: wait out the storm (fast-forwarded).
    if (S().missionMode === 'shelter' && rt.sAstro >= rt.route.len - 6.5 && !rt.activity) {
      a.speed = 0;
      a.mode = 'busy';
      rt.activity = { kind: 'shelter', until: Infinity };
      log('ok', 'Tripulación en el refugio. Esperando que pase la tormenta.');
    }
  } else if (a.mode === 'hold' || a.mode === 'busy') {
    a.speed *= 0.8;
    if (a.mode === 'hold') {
      const r = rt.rover;
      a.heading += clampAbs(angleDiff(a.heading, headingOf(r.x - a.x, r.z - a.z)), 1.5 * dt);
    }
  } else if (a.mode === 'collapsed') {
    a.speed = 0;
    a.collapse = Math.min(1, a.collapse + dt * 0.9);
  }
  a.moving = a.speed > 0.15;
  a.walkPhase += a.speed * dt * 3.4;
  a.y = heightAt(a.x, a.z);
}

function checkCompletion() {
  const st = S();
  const m = st.missionMode;
  if (m !== 'nominal' && m !== 'abort' && m !== 'medevac') return;
  if (rt.rover.mode !== 'follow' || rt.route.len < 5 || !rt.homeBound) return;
  if (rt.stops.some((s) => !s.done)) return;
  if (rt.sAstro >= rt.route.len - 6.5 && rt.sRover >= rt.route.len - 0.2) {
    const samples = rt.visited.size;
    const reason =
      m === 'medevac'
        ? 'Tripulación de vuelta en el hábitat tras la emergencia médica. El médico se hace cargo.'
        : m === 'abort'
          ? `Tripulación a salvo en el hábitat (aborto). ${samples} sitio(s) muestreados, ${rt.massKg.toFixed(1)} kg, quedan ${rt.o2.toFixed(0)} L de O₂.`
          : `Tour completo: ${samples} sitio(s), ${rt.massKg.toFixed(1)} kg de muestras, quedan ${rt.o2.toFixed(0)} L de O₂ (${((rt.o2 / Q_O2) * 100).toFixed(0)} %).`;
    rt.activity = null;
    setMode('complete');
    useSimStore.setState({ completeReason: reason });
    log('ok', reason);
  }
}

function orientRover(dt: number) {
  const r = rt.rover;
  r.y = heightAt(r.x, r.z);
  normalAt(r.x, r.z, _n, 1.3);
  _f.set(Math.sin(r.heading), 0, -Math.cos(r.heading));
  _f.addScaledVector(_n, -_f.dot(_n)).normalize();
  _x.crossVectors(_n, _f).normalize();
  _m.makeBasis(_x, _n, _f);
  _q.setFromRotationMatrix(_m);
  r.quat.slerp(_q, Math.min(1, dt * 8));
  r.pitch = (Math.asin(Math.max(-1, Math.min(1, _f.y))) * 180) / Math.PI;
  r.roll = (Math.asin(Math.max(-1, Math.min(1, _x.y))) * 180) / Math.PI;
}

export function roverBedPos(out: THREE.Vector3) {
  const r = rt.rover;
  return out.set(0, 1.42, -0.85).applyQuaternion(r.quat).add(_v.set(r.x, r.y, r.z));
}

const _bed = new THREE.Vector3();
function flyToward(tx: number, tz: number, speed: number, alt: number, dt: number) {
  const d = rt.drone;
  const dx = tx - d.x;
  const dz = tz - d.z;
  const dd = Math.hypot(dx, dz);
  const step = Math.min(dd, speed * dt);
  if (dd > 1e-3) {
    d.x += (dx / dd) * step;
    d.z += (dz / dd) * step;
    d.heading += clampAbs(angleDiff(d.heading, headingOf(dx, dz)), 3 * dt);
  }
  const gy = heightAt(d.x, d.z) + alt;
  d.y += (gy - d.y) * Math.min(1, dt * 2);
  return dd;
}

function stepDrone(dt: number) {
  const d = rt.drone;
  roverBedPos(_bed);
  d.t += dt;
  switch (d.state) {
    case 'docked':
      d.x = _bed.x;
      d.y = _bed.y;
      d.z = _bed.z;
      d.heading = rt.rover.heading;
      d.rotor = Math.max(0, d.rotor - dt * 2);
      break;
    case 'launch':
      d.rotor = Math.min(1, d.rotor + dt * 2);
      d.x = _bed.x;
      d.z = _bed.z;
      d.y = _bed.y + ease(Math.min(1, d.t / 1.6)) * 8;
      if (d.t >= 1.6) setDroneState('outbound');
      break;
    case 'outbound': {
      const dd = flyToward(d.tx, d.tz, 6, SCAN_ALT, dt);
      if (dd < 0.8) {
        d.ox = d.x;
        d.oz = d.z;
        setDroneState('scan');
        log('info', `Barrido LIDAR panorámico desde ${SCAN_ALT} m (radio ${SCAN_RADIUS} m)…`);
      }
      break;
    }
    case 'scan':
      d.scanProgress = Math.min(1, d.t / 5.5);
      d.heading += dt * 0.7;
      flyToward(d.ox, d.oz, 2, SCAN_ALT, dt);
      if (d.t >= 5.5) {
        completeScan();
        setDroneState('return');
      }
      break;
    case 'return': {
      const dx = _bed.x - d.x;
      const dz = _bed.z - d.z;
      const dh = Math.hypot(dx, dz);
      if (dh > 2.5) flyToward(_bed.x, _bed.z, 13, 12, dt);
      else {
        flyToward(_bed.x, _bed.z, 6, 0, dt);
        d.y += (_bed.y - d.y) * Math.min(1, dt * 2.5);
        if (dh < 0.3 && Math.abs(d.y - _bed.y) < 0.15) {
          setDroneState('docked');
          log('info', 'Dron recuperado sobre el rover. Cargando.');
        }
      }
      break;
    }
  }
  d.scanProgress = d.state === 'scan' ? d.scanProgress : 0;
}

function completeScan() {
  const d = rt.drone;
  revealCircle(d.x, d.z, SCAN_RADIUS);
  const before = S().metrics[S().algorithm === 'astar' ? 'astar' : 'greedy']?.litres ?? NaN;
  if (!S().canyonScanned && dist(d, CANYON) < SCAN_RADIUS) {
    useSimStore.setState({ canyonScanned: true });
    log('ok', 'LIDAR: el cañón quedó dentro de la vista — rugosidad 0,4 m, pendiente máx. 7°. Atajo y estratos (C) HABILITADOS.');
  }
  if (S().missionMode === 'nominal' && rt.rover.mode === 'follow' && !rt.activity) {
    replanMain();
    const after = S().metrics[S().algorithm === 'astar' ? 'astar' : 'greedy']?.litres ?? NaN;
    log(
      'ok',
      Number.isFinite(before) && Number.isFinite(after)
        ? `Vista panorámica: ${SCAN_RADIUS} m mapeados. Ruta reoptimizada con terreno verificado: ${before.toFixed(1)} → ${after.toFixed(1)} L de O₂ al caminar.`
        : `Vista panorámica: ${SCAN_RADIUS} m mapeados, ruta reoptimizada.`,
    );
  } else {
    recost();
    log('ok', `Vista panorámica: ${SCAN_RADIUS} m mapeados.`);
  }
}

function updateGpu(dtReal: number) {
  const st = S();
  const r = rt.rover;
  const u = terrainUniforms;
  u.uRoverPos.value.set(r.x, r.z);
  u.uRoverDir.value.set(Math.sin(r.heading), -Math.cos(r.heading));
  u.uTime.value = rt.elapsed;
  u.uCostOn.value = st.cameraMode === 'rover' ? 1 : 0;
  const fowTarget = st.cameraMode === 'drone' ? 1 : 0;
  u.uFowStrength.value += (fowTarget - u.uFowStrength.value) * Math.min(1, dtReal * 3);
  const d = rt.drone;
  u.uScanPos.value.set(d.x, d.y, d.z);
  u.uScanOn.value = d.state === 'scan' ? 1 : 0;

  rt.fowTimer += dtReal;
  if (rt.fowTimer > 0.25) {
    rt.fowTimer = 0;
    revealCircle(r.x, r.z, 26);
    revealCircle(rt.astro.x, rt.astro.z, 16);
    if (d.state !== 'docked') revealCircle(d.x, d.z, d.state === 'scan' ? 30 : 22);
  }
}

/** Site context set by the Mars Trek loader before initSimulation(). */
export function setSiteLocation(lat: number, lon: number) {
  rt.lat = lat;
  rt.lon = lon;
}

export const activityLabel = (): string => {
  const a = rt.activity;
  const m = S().missionMode;
  if (rt.astro.mode === 'collapsed') return S().rescuePhase === 'docked' ? 'Estabilizándose con el umbilical' : 'Desvanecido';
  if (a?.kind === 'sample') return `Muestreando ${a.site?.code} · ${siteName(a.site?.code ?? '')}`;
  if (a?.kind === 'wait') return `Esperando la ventana de ${a.site?.code}`;
  if (a?.kind === 'shelter') return 'Refugiado de la tormenta';
  if (rt.astro.mode === 'hold') return 'Esperando al rover';
  if (m === 'complete') return 'En reposo';
  if (m === 'shelter') return 'Caminando al refugio';
  if (m === 'abort' || m === 'medevac') return 'Volviendo al hábitat';
  if (rt.astro.mode === 'idle') return 'Saliendo';
  const next = rt.stops.find((s) => !s.done);
  return next ? `Caminando a ${next.site.code}` : 'Volviendo a casa';
};

export const nextStop = () => rt.stops.find((s) => !s.done) ?? null;
export const lastPlanned = () => lastPlan;

// Development-only handle for automated UI tests.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __ares: unknown }).__ares = { rt, addUserHazard, liveReplan, clearUserHazards, heightAt, store: useSimStore };
}
