// Spanish labels for data that lives in src/lib (shared with explicacion.html,
// which keeps its own wording). Only the simulator UI uses these.
import type { MissionMode } from './store/useSimStore';

const SITE_ES: Record<string, { name: string; mineral: string }> = {
  B: { name: 'Afloramiento boxwork', mineral: 'Sulfatos' },
  C: { name: 'Estratos del cañón', mineral: 'Sedimentos lacustres' },
  F: { name: 'Escarcha matinal', mineral: 'Hielo de agua' },
  K: { name: 'Banco de arcillas', mineral: 'Filosilicatos' },
  Y: { name: 'Vetas de yeso', mineral: 'Sulfatos' },
  D: { name: 'Dunas activas', mineral: 'Arena basáltica' },
  H: { name: 'Nódulos de hematita', mineral: 'Óxidos' },
};
export const siteName = (code: string, fallback = code) => SITE_ES[code]?.name ?? fallback;
export const siteMineral = (code: string, fallback = '') => SITE_ES[code]?.mineral ?? fallback;

const REGION_ES: Record<string, { name: string; mission: string }> = {
  gale: { name: 'Cráter Gale · Mount Sharp (escala real)', mission: 'Curiosity (MSL)' },
  jezero: { name: 'Cráter Jezero · delta oeste (análogo)', mission: 'Perseverance (M2020)' },
  meridiani: { name: 'Meridiani Planum · borde de Endeavour (análogo)', mission: 'Opportunity (MER-B)' },
  procedural: { name: 'Sitio procedural', mission: 'Sin conexión' },
};
export const regionName = (id: string, fallback: string) => REGION_ES[id]?.name ?? fallback;
export const regionMission = (id: string, fallback: string) => REGION_ES[id]?.mission ?? fallback;

const REASON_ES: Record<string, string> = {
  'no walkable path': 'sin camino transitable',
  'window closed': 'ventana cerrada',
  'bag full': 'bolsa llena',
  'O₂ reserve': 'reserva de O₂',
  daylight: 'luz del día',
};
export const reasonEs = (r: string) => REASON_ES[r] ?? r;

export const MODE_ES: Record<MissionMode, string> = {
  nominal: 'NOMINAL',
  abort: 'ABORTO',
  shelter: 'REFUGIO',
  rescue: 'RESCATE',
  medevac: 'EVACUACIÓN',
  complete: 'COMPLETA',
};

export const SUIT_ES: Record<string, string> = { NOMINAL: 'NOMINAL', COLD: 'FRÍO', HOT: 'CALOR', CRITICAL: 'CRÍTICO' };

export const DRONE_ES: Record<string, string> = {
  docked: 'ACOPLADO',
  launch: 'DESPEGUE',
  outbound: 'EN VUELO',
  scan: 'ESCANEO',
  return: 'REGRESO',
};
