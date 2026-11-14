// ─── VALUES OXYGEN ──────────────────────────────────────
export const TANK_CAPACITY_L = 450;
export const START_LITRES = 225;
export const CONSUMPTION_LPM = 0.75;
export const DEFAULT_TIME_SCALE = 1;
// ────────────────────────────────────────────────────────────────────────────
import { create } from 'zustand';

export const TIME_SCALES = [
  { value: 1, label: 'Realista' },
  { value: 300, label: 'Turbo' },
] as const;

export const minutesLeft = (litres: number) => litres / CONSUMPTION_LPM;
export const percentOf = (litres: number) => (litres / TANK_CAPACITY_L) * 100;

const clampLitres = (l: number) => Math.max(0, Math.min(TANK_CAPACITY_L, l));

interface OxygenState {
  litres: number;
  active: boolean;
  timeScale: number;
  setLitres: (l: number) => void;
  setTimeScale: (k: number) => void;
  toggle: () => void;
  reload: () => void;
  attach: () => void;
  detach: () => void;
}

let timer: ReturnType<typeof setInterval> | null = null;
let mounted = 0;
let last = 0;

const stopTimer = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

export const useOxygenStore = create<OxygenState>((set, get) => {
  const restart = () => {
    stopTimer();
    const { active, litres } = get();
    if (mounted <= 0 || !active || litres <= 0) return;
    last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      const dtMin = (now - last) / 60000; // real time in minutes
      last = now;
      const { litres: cur, timeScale } = get();
      const next = Math.max(0, cur - CONSUMPTION_LPM * timeScale * dtMin);
      set({ litres: next });
      if (next <= 0) stopTimer();
    }, 100);
  };

  return {
    litres: clampLitres(START_LITRES),
    active: true,
    timeScale: DEFAULT_TIME_SCALE,
    setLitres: (l) => {
      set({ litres: clampLitres(l) });
      restart();
    },
    setTimeScale: (k) => set({ timeScale: k }),
    toggle: () => {
      set((s) => ({ active: !s.active }));
      restart();
    },
    reload: () => {
      set({ litres: TANK_CAPACITY_L, active: true });
      restart();
    },
    attach: () => {
      mounted++;
      restart();
    },
    detach: () => {
      mounted = Math.max(0, mounted - 1);
      if (mounted === 0) stopTimer();
    },
  };
});
export const setOxygenLitres = (l: number) => useOxygenStore.getState().setLitres(l);
