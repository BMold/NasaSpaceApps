// Science tour planner (CTOPTW: capacitated team orienteering problem with
// time windows, single team). Builds the asymmetric O₂ matrix D(i, j) with one
// Dijkstra per node, then runs an exact branch & bound over visit orders.
import { costGrid, cellOf, COST_N } from './costmap';
import { RHO, STANDING_W, M_WORK, KAPPA_O2 } from './energy';
import { dijkstra, fieldPathHome, fieldPathTo, nearestWalkable, type Field } from './pathfinding';
import { PSI_ALPHA, Q_KG, psi, type ScienceSite } from './sites';
import type { XZ } from './terrain';

export interface TourState {
  start: XZ; // current crew position
  home: XZ; // habitat
  o2Litres: number; // O₂ left in the PLSS
  ltst: number; // current local true solar time, hours
  massKg: number; // samples already in the bag
  mineralCounts: Record<string, number>; // samples already taken per class
  sunsetLtst: number;
  lambda?: number; // risk weight in the objective
}

export interface Stop {
  site: ScienceSite;
  arrive: number; // LTST hours
  wait: number; // minutes waiting for the window to open
  leave: number; // LTST hours
  o2After: number; // litres left after sampling
  gain: number; // S_i · ψ
}

export interface TourPlan {
  order: ScienceSite[];
  stops: Stop[];
  z: number; // objective
  o2Home: number; // litres left on arrival at the habitat
  homeLtst: number;
  litres: number; // walking O₂ of the whole tour
  workLitres: number;
  nodesExplored: number;
  computeMs: number;
  legs: XZ[][]; // polylines: start → stop1 → … → home
  matrix: { labels: string[]; litres: number[][]; minutes: number[][] };
  skipped: { site: ScienceSite; reason: string }[];
}

const RETURN_MARGIN_H = 0.5; // be back 30 min before sunset
const MU_O2 = 0.01; // objective points per litre of O₂ (tie-break only)

/** Risk of a leg: metres walked through caution / uncharted cells, per 100 m. */
function legRisk(f: Field, target: XZ): number {
  let c = nearestWalkable(cellOf(target));
  let risk = 0;
  let guard = 0;
  while (c !== -1 && c !== f.source && guard++ < COST_N * COST_N) {
    const k = costGrid.cls[c];
    if (k === 1) risk += 2.5;
    if (k === 3) risk += 7.5;
    c = f.parent[c];
  }
  return risk / 100;
}

export function solveTour(sites: ScienceSite[], st: TourState): TourPlan {
  const t0 = performance.now();
  const lambda = st.lambda ?? 1;
  const nodes: XZ[] = [st.start, ...sites];
  const n = nodes.length;
  // One forward Dijkstra per node gives a full row of D; one reverse search from
  // the habitat gives every node's cost to get home, R(p).
  const fields = nodes.map((p) => dijkstra(p, true));
  const home = dijkstra(st.home, false);
  const D: number[][] = [];
  const T: number[][] = []; // minutes
  const RISK: number[][] = [];
  for (let i = 0; i < n; i++) {
    D.push([]);
    T.push([]);
    RISK.push([]);
    for (let j = 0; j < n; j++) {
      const k = nearestWalkable(cellOf(nodes[j]));
      D[i].push(i === j ? 0 : fields[i].cost[k]);
      T[i].push(i === j ? 0 : fields[i].time[k] / 60);
      RISK[i].push(i === j || !Number.isFinite(fields[i].cost[k]) ? 0 : legRisk(fields[i], nodes[j]));
    }
  }
  const R = nodes.map((p) => home.cost[nearestWalkable(cellOf(p))]);
  const TH = nodes.map((p) => home.time[nearestWalkable(cellOf(p))] / 60);
  const deadline = st.sunsetLtst - RETURN_MARGIN_H;
  const standLpm = STANDING_W * KAPPA_O2;
  const workLpm = M_WORK * KAPPA_O2;

  // Individually infeasible sites are reported, not searched.
  const skipped: { site: ScienceSite; reason: string }[] = [];
  const candidates: number[] = [];
  for (let j = 1; j < n; j++) {
    const s = sites[j - 1];
    const arrive = st.ltst + T[0][j] / 60;
    const start = Math.max(arrive, s.window[0]);
    const o2 = st.o2Litres - D[0][j] - (start - arrive) * 60 * standLpm - s.drillMin * workLpm;
    if (!Number.isFinite(D[0][j])) skipped.push({ site: s, reason: 'no walkable path' });
    else if (start > s.window[1]) skipped.push({ site: s, reason: 'window closed' });
    else if (st.massKg + s.massKg > Q_KG + 1e-6) skipped.push({ site: s, reason: 'bag full' });
    else if (o2 < (1 + RHO) * R[j]) skipped.push({ site: s, reason: 'O₂ reserve' });
    else if (start + s.drillMin / 60 + TH[j] / 60 > deadline) skipped.push({ site: s, reason: 'daylight' });
    else candidates.push(j);
  }

  let best = { z: -Infinity, order: [] as number[] };
  let explored = 0;
  const counts = { ...st.mineralCounts };
  const order: number[] = [];

  const dfs = (i: number, ltst: number, o2: number, kg: number, z: number) => {
    explored++;
    // The tour may end here: the crew must still be able to walk home safely.
    if (o2 >= (1 + RHO) * R[i] && ltst + TH[i] / 60 <= deadline && z > best.z) best = { z, order: order.slice() };
    // Optimistic bound: every remaining candidate at full value.
    let bound = z;
    for (const j of candidates) if (!order.includes(j)) bound += sites[j - 1].value;
    if (bound <= best.z) return;
    for (const j of candidates) {
      if (order.includes(j)) continue;
      const s = sites[j - 1];
      const arrive = ltst + T[i][j] / 60;
      if (arrive > s.window[1]) continue; // window prune
      const begin = Math.max(arrive, s.window[0]);
      const leave = begin + s.drillMin / 60;
      const o2After = o2 - D[i][j] - (begin - arrive) * 60 * standLpm - s.drillMin * workLpm;
      if (o2After < (1 + RHO) * R[j]) continue; // abort / point-of-no-return prune
      if (kg + s.massKg > Q_KG + 1e-6) continue; // capacity prune
      if (leave + TH[j] / 60 > deadline) continue; // daylight prune
      const c = (counts[s.mineral] ?? 0) + 1;
      // Tie-break: among equally valuable tours prefer the one that burns less O₂.
      const gain = s.value * psi(c, PSI_ALPHA) - lambda * RISK[i][j] - MU_O2 * (o2 - o2After);
      counts[s.mineral] = c;
      order.push(j);
      dfs(j, leave, o2After, kg + s.massKg, z + gain);
      order.pop();
      counts[s.mineral] = c - 1;
    }
  };
  dfs(0, st.ltst, st.o2Litres, st.massKg, 0);

  // Rebuild the chosen tour with arrival times, O₂ and the leg polylines.
  const stops: Stop[] = [];
  const legs: XZ[][] = [];
  let i = 0;
  let ltst = st.ltst;
  let o2 = st.o2Litres;
  let litres = 0;
  let workLitres = 0;
  const cnt = { ...st.mineralCounts };
  for (const j of best.order) {
    const s = sites[j - 1];
    const arrive = ltst + T[i][j] / 60;
    const begin = Math.max(arrive, s.window[0]);
    const wait = (begin - arrive) * 60;
    const leave = begin + s.drillMin / 60;
    litres += D[i][j];
    workLitres += s.drillMin * workLpm + wait * standLpm;
    o2 -= D[i][j] + wait * standLpm + s.drillMin * workLpm;
    const c = (cnt[s.mineral] ?? 0) + 1;
    cnt[s.mineral] = c;
    stops.push({ site: s, arrive, wait, leave, o2After: o2, gain: s.value * psi(c) });
    legs.push(fieldPathTo(fields[i], nodes[i], nodes[j]));
    ltst = leave;
    i = j;
  }
  legs.push(fieldPathHome(home, nodes[i], st.home));
  litres += R[i];
  const labels = ['Start', ...sites.map((s) => s.code)];
  return {
    order: best.order.map((j) => sites[j - 1]),
    stops,
    z: Math.max(0, best.z),
    o2Home: o2 - R[i],
    homeLtst: ltst + TH[i] / 60,
    litres,
    workLitres,
    nodesExplored: explored,
    computeMs: performance.now() - t0,
    legs,
    matrix: { labels: [...labels, 'Home'], litres: D.map((row, r) => [...row, R[r]]), minutes: T.map((row, r) => [...row, TH[r]]) },
    skipped,
  };
}
