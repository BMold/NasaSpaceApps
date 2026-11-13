export const SOL_START = 142;
export const START_SEC = 14 * 3600 + 32 * 60; // 14:32 MTC

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');

export function missionClock(sec: number) {
  const sol = SOL_START + Math.floor(sec / 86400);
  const s = sec % 86400;
  return { sol, hhmm: `${pad(s / 3600)}:${pad((s % 3600) / 60)}`, hhmmss: `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}` };
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
export const signed = (v: number, d = 1) => (v >= 0 ? '+' : '') + fmt(v, d);
