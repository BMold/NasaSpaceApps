import { create } from 'zustand';
import type { Hazard } from '../lib/costmap';
import type { RouteMetrics } from '../lib/metrics';
import type { Algo } from '../lib/pathfinding';
import { BASE_A } from '../lib/terrain';
import type { SiteInfo } from '../lib/marsTrek';

export type CameraMode = 'astronaut' | 'rover' | 'drone';
export type MissionMode = 'nominal' | 'abort' | 'shelter' | 'rescue' | 'medevac' | 'complete';
export type DroneState = 'docked' | 'launch' | 'outbound' | 'scan' | 'return';
export type LogLevel = 'info' | 'warn' | 'crit' | 'ok';
export type TrekStatus = 'loading' | 'online' | 'error' | 'procedural';
export type ObstacleTool = null | 'rocks' | 'cold' | 'hill' | 'move' | 'erase';

export interface LogEntry {
  id: number;
  clock: string;
  level: LogLevel;
  msg: string;
}

export interface EntityPos {
  x: number;
  z: number;
  h: number;
}

export interface Telemetry {
  bpm: number;
  o2: number;
  rad: number;
  dose: number;
  battery: number;
  motorTemp: number;
  surfaceTemp: number;
  irAhead: number;
  suitTemp: number;
  suitStatus: 'NOMINAL' | 'COLD' | 'HOT' | 'CRITICAL';
  walkback: number;
  o2Minutes: number;
  o2Litres: number;
  returnLitres: number; // R(p): O₂ needed to walk home from here
  returnMinutes: number;
  kcalRate: number;
  watts: number;
  ltst: number; // local true solar time, hours
  sunEl: number;
  sunAz: number;
  groundTemp: number;
  solarW: number;
  svf: number; // sky-view factor at the crew position
  massKg: number;
  activity: string;
  pitch: number;
  roll: number;
  wheelSlip: number[];
  roverSpeed: number;
  gap: number;
  distToBase: number;
  distToTarget: number;
  astro: EntityPos;
  rover: EntityPos;
  drone: EntityPos & { alt: number; progress: number };
  missionSec: number;
}

export interface TourStopView {
  code: string;
  name: string;
  mineral: string;
  arrive: number;
  leave: number;
  wait: number;
  o2After: number;
  gain: number;
  done: boolean;
}

export interface TourView {
  stops: TourStopView[];
  z: number;
  o2Home: number;
  homeLtst: number;
  explored: number;
  computeMs: number;
  skipped: { code: string; reason: string }[];
  matrix: { labels: string[]; litres: number[][]; minutes: number[][] };
}

export interface History {
  bpm: number[];
  o2: number[];
  rad: number[];
  battery: number[];
  motorTemp: number[];
}

export const HISTORY_LEN = 150;

export const initialTelemetry = (): Telemetry => ({
  bpm: 82,
  o2: 64,
  rad: 0.15,
  dose: 0.42,
  battery: 87,
  motorTemp: 22,
  surfaceTemp: -36,
  irAhead: -36,
  suitTemp: 21.4,
  suitStatus: 'NOMINAL',
  walkback: 270,
  o2Minutes: 480,
  o2Litres: 380,
  returnLitres: 0,
  returnMinutes: 0,
  kcalRate: 104,
  watts: 121,
  ltst: 8,
  sunEl: 20,
  sunAz: 90,
  groundTemp: -60,
  solarW: 0,
  svf: 1,
  massKg: 0,
  activity: 'Saliendo',
  pitch: 0,
  roll: 0,
  wheelSlip: [0, 0, 0, 0, 0, 0],
  roverSpeed: 0,
  gap: 0,
  distToBase: 0,
  distToTarget: 0,
  astro: { x: BASE_A.x, z: BASE_A.z, h: 0 },
  rover: { x: BASE_A.x, z: BASE_A.z, h: 0 },
  drone: { x: BASE_A.x, z: BASE_A.z, h: 0, alt: 0, progress: 0 },
  missionSec: 0,
});

export const emptyHistory = (): History => ({ bpm: [], o2: [], rad: [], battery: [], motorTemp: [] });

interface SimStore {
  cameraMode: CameraMode;
  algorithm: Algo;
  missionMode: MissionMode;
  completeReason: string;
  routeVersion: number;
  costVersion: number;
  terrainVersion: number;
  metrics: { astar: RouteMetrics | null; greedy: RouteMetrics | null; straight: RouteMetrics | null };
  hazards: Hazard[];
  stormActive: boolean;
  canyonScanned: boolean;
  droneState: DroneState;
  rescuePhase: null | 'inbound' | 'docked';
  freezeAlert: boolean;
  walkbackAlert: boolean;
  telemetry: Telemetry;
  history: History;
  log: LogEntry[];
  dataRegion: string;
  trekStatus: TrekStatus;
  trekMessage: string;
  trekPreview: string | null;
  siteInfo: SiteInfo | null;
  tour: TourView | null;
  shelter: { kind: string; svf: number; x: number; z: number; dose: number } | null;
  startLtst: number;
  timeScale: number;
  sol: number;
  sunsetLtst: number;
  ls: number;
  paused: boolean;
  obstacleTool: ObstacleTool;
  replanInfo: { ms: number; nodes: number; litres: number; at: number } | null;
  panels: { left: boolean; right: boolean };
  setCameraMode: (m: CameraMode) => void;
  setDataRegion: (id: string) => void;
  setStartLtst: (h: number) => void;
  setPaused: (p: boolean) => void;
  setObstacleTool: (t: ObstacleTool) => void;
  setTimeScale: (k: number) => void;
  togglePanel: (side: 'left' | 'right') => void;
}

const wide = typeof window !== 'undefined' ? window.innerWidth >= 1100 : true;

export const useSimStore = create<SimStore>((set) => ({
  cameraMode: 'drone',
  algorithm: 'astar',
  missionMode: 'nominal',
  completeReason: '',
  routeVersion: 0,
  costVersion: 0,
  terrainVersion: 0,
  metrics: { astar: null, greedy: null, straight: null },
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
  dataRegion: 'gale',
  trekStatus: 'loading',
  trekMessage: 'Conectando con NASA Mars Trek (WMTS)…',
  trekPreview: null,
  siteInfo: null,
  tour: null,
  shelter: null,
  startLtst: 8,
  timeScale: 4,
  sol: 0,
  sunsetLtst: 18,
  ls: 0,
  paused: false,
  obstacleTool: null,
  replanInfo: null,
  panels: { left: wide, right: wide },
  setCameraMode: (m) => set({ cameraMode: m }),
  setDataRegion: (id) => set({ dataRegion: id }),
  setStartLtst: (h) => set({ startLtst: h }),
  setPaused: (p) => set({ paused: p }),
  setObstacleTool: (t) => set({ obstacleTool: t }),
  setTimeScale: (k) => set({ timeScale: k }),
  togglePanel: (side) => set((s) => ({ panels: { ...s.panels, [side]: !s.panels[side] } })),
}));
