// Route evaluation with the same physics the planner uses: O₂ litres from the
// Pandolf model on the signed grade of every metre, plus rover energy and risk.
import { cellOf, costGrid, MAX_GRADE, MAX_SLOPE } from './costmap';
import { edgeO2, kcalPerHour, type EdgeCost } from './energy';
import { heightAt, sandAt, slopeDegAt, type XZ } from './terrain';
import type { Algo } from './pathfinding';

export interface RouteMetrics {
  algo: Algo | 'straight';
  lengthM: number;
  computeMs: number;
  expanded: number;
  litres: number; // walking O₂
  kcalTotal: number;
  kcalPerHr: number;
  o2SavedPct: number;
  batteryWh: number;
  batteryReservePct: number;
  slopeHazardPct: number;
  sandRiskPct: number;
  maxSlope: number;
  maxGrade: number;
  climbM: number;
  etaMin: number;
  classFrac: [number, number, number, number]; // safe, caution, impassable, uncharted
  feasible: boolean;
  fallback: boolean;
}

export const BATTERY_WH = 1800;
const tmp: EdgeCost = { litres: 0, seconds: 0, watts: 0, speed: 0 };

export function evaluateRoute(
  pts: XZ[],
  opts: { algo: RouteMetrics['algo']; batteryPct: number; computeMs?: number; expanded?: number; fallback?: boolean },
): RouteMetrics {
  let length = 0;
  let litres = 0;
  let joules = 0;
  let time = 0;
  let wh = 0;
  let steep = 0;
  let maxSlope = 0;
  let maxGrade = 0;
  let climb = 0;
  let sandSum = 0;
  let sandMax = 0;
  const frac = [0, 0, 0, 0];
  let feasible = true;
  // Grades are judged over ≥ 5 m: the smoothed curve wobbles within a 2.5 m cell.
  let gx = pts.length ? pts[0].x : 0;
  let gz = pts.length ? pts[0].z : 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ds = Math.hypot(b.x - a.x, b.z - a.z);
    if (ds < 1e-4) continue;
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const dh = heightAt(b.x, b.z) - heightAt(a.x, a.z);
    const G = (100 * dh) / ds;
    const slope = slopeDegAt(mx, mz);
    const sand = sandAt(mx, mz);
    const cls = costGrid.cls[cellOf({ x: mx, z: mz })];
    edgeO2(ds, G, 1 + 0.9 * sand, tmp);
    litres += tmp.litres;
    joules += tmp.watts * tmp.seconds;
    time += tmp.seconds;
    // Rover: rolling resistance grows with sand and with climbing.
    wh += ds * 0.32 * (1 + Math.max(G, 0) * 0.06 + sand * 1.8);
    const span = Math.hypot(b.x - gx, b.z - gz);
    if (span >= 5) {
      const Gw = (100 * (heightAt(b.x, b.z) - heightAt(gx, gz))) / span;
      maxGrade = Math.max(maxGrade, Math.abs(Gw));
      if (Math.abs(Gw) > MAX_GRADE + 3) feasible = false;
      gx = b.x;
      gz = b.z;
    }
    if (slope > MAX_SLOPE + 1 || cls === 2) feasible = false;
    length += ds;
    if (dh > 0) climb += dh;
    if (slope > 15) steep += ds;
    maxSlope = Math.max(maxSlope, slope);
    sandSum += sand * ds;
    sandMax = Math.max(sandMax, sand);
    frac[cls] += ds;
  }
  const L = Math.max(length, 1e-3);
  const kcal = joules / 4184;
  return {
    algo: opts.algo,
    lengthM: length,
    computeMs: opts.computeMs ?? 0,
    expanded: opts.expanded ?? 0,
    litres,
    kcalTotal: kcal,
    kcalPerHr: time > 0 ? kcalPerHour(joules / time) : 0,
    o2SavedPct: 0,
    batteryWh: wh,
    batteryReservePct: Math.max(0, opts.batteryPct - (wh / BATTERY_WH) * 100),
    slopeHazardPct: Math.min(100, (steep / L) * 160 + Math.max(0, maxSlope - 18) * 2),
    sandRiskPct: Math.min(99, (sandSum / L) * 70 + sandMax * 25),
    maxSlope,
    maxGrade,
    climbM: climb,
    etaMin: time / 60,
    classFrac: [frac[0] / L, frac[1] / L, frac[2] / L, frac[3] / L],
    feasible,
    fallback: opts.fallback ?? false,
  };
}
