// Route reactivity for the manual override. Runs on the laptop (the position
// authority). Every 100 ms it projects the astronaut onto the optimal
// polyline:
//   • on the path  → advance the progress mark (the ribbon dims behind you);
//   • off the path → if the deviation exceeds DEVIATION_M, recalculateRoute()
//                    re-runs A* from the current coordinates to the goal and the
//                    ribbon on the ground is redrawn from your feet.
// It also re-plans when the costmap changes (drone scan, new hazards).
import { useEffect, useRef } from 'react';
import { rt } from '../store/simEngine';
import { useSimStore } from '../store/useSimStore';
import { DEVIATION_M, recalculateRoute, vr } from './vrEngine';

const CHECK_MS = 100;
const MIN_GAP_MS = 400; // never re-plan more often than this

/** Distance from p to the route polyline and the arc length of the closest point. */
export function projectOnRoute(px: number, pz: number): { dist: number; s: number } {
  const r = rt.route;
  if (r.n < 2) return { dist: Infinity, s: 0 };
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < r.n - 1; i++) {
    const ax = r.xs[i];
    const az = r.zs[i];
    const bx = r.xs[i + 1];
    const bz = r.zs[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const L2 = vx * vx + vz * vz || 1e-9;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / L2));
    const qx = ax + vx * t;
    const qz = az + vz * t;
    const d = Math.hypot(px - qx, pz - qz);
    if (d < best) {
      best = d;
      bestS = r.cum[i] + Math.sqrt(L2) * t;
    }
  }
  return { dist: best, s: bestS };
}

export function useDynamicRoute(enabled: boolean) {
  const costVersion = useSimStore((s) => s.costVersion);
  const lastRecalc = useRef(0);
  const seenCost = useRef(costVersion);

  // Costmap changed (scan, hazards): the old polyline may no longer be optimal.
  useEffect(() => {
    if (!enabled || !vr.ready || costVersion === seenCost.current) return;
    seenCost.current = costVersion;
    lastRecalc.current = performance.now();
    recalculateRoute('mapa de costos actualizado');
  }, [costVersion, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (!vr.ready || rt.route.n < 2) return;
      const { dist, s } = projectOnRoute(vr.x, vr.z);
      vr.lastDeviation = dist;
      if (dist > DEVIATION_M) {
        const now = performance.now();
        if (now - lastRecalc.current < MIN_GAP_MS) return;
        lastRecalc.current = now;
        recalculateRoute(`recalculada (desvío ${dist.toFixed(1)} m)`);
      } else {
        // Never move the progress mark backwards: walking back is a deviation.
        rt.sAstro = Math.max(rt.sAstro, s);
      }
    }, CHECK_MS);
    return () => window.clearInterval(id);
  }, [enabled]);
}
