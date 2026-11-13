// Keeps the picture fluid on any machine: watches the real frame rate and
// lowers the render resolution a step when it falls short, then creeps back
// up when there is headroom. Geometry and lighting stay the same; only the
// number of pixels changes, which is what integrated and phone GPUs run out of.
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Q } from './quality';

export const governorState = { fps: 60, dpr: 1 };

export function Governor({ target = 45, min = 0.6 }: { target?: number; min?: number }) {
  const setDpr = useThree((s) => s.setDpr);
  const max = Math.min(Q.dprMax, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const s = useRef({ t: 0, n: 0, dpr: max, low: 0, high: 0, warm: 0, locked: 0 });

  useEffect(() => {
    s.current.dpr = max;
    governorState.dpr = max;
    setDpr(max);
  }, [max, setDpr]);

  useFrame((_, dt) => {
    const g = s.current;
    g.warm += dt;
    if (g.warm < 5) return; // shaders are still compiling, textures still arriving
    g.t += dt;
    g.n++;
    if (g.t < 1) return;
    const fps = g.n / g.t;
    governorState.fps = fps;
    g.t = 0;
    g.n = 0;
    g.locked = Math.max(0, g.locked - 1);
    if (fps < target) {
      g.high = 0;
      if (++g.low >= 2 && g.dpr > min) {
        // The further below the target, the bigger the step down.
        g.dpr = Math.max(min, g.dpr * Math.max(0.72, Math.min(0.92, Math.sqrt(fps / target))));
        g.low = 0;
        g.locked = 12;
        governorState.dpr = g.dpr;
        setDpr(g.dpr);
      }
    } else {
      g.low = 0;
      if (fps > 57 && g.dpr < max && g.locked === 0 && ++g.high >= 6) {
        g.dpr = Math.min(max, g.dpr * 1.07);
        g.high = 0;
        governorState.dpr = g.dpr;
        setDpr(g.dpr);
      }
    }
  });
  return null;
}
