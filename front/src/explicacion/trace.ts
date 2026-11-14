// Same A* and greedy as src/lib/pathfinding.ts (same heap, formulas and neighbour
// order), but they record every decision so the page can replay it step by step.
// The page compares the node counts against the real planners on the real grid.
//
// A view either brings its own directed edge weights (the real O₂ graph) or a
// per-cell cost; in that case an edge costs ℓ · cell · (c_a + c_b) / 2.
import { DIRS, MinHeap } from '../lib/pathfinding';

export interface GridView {
  w: number;
  h: number;
  cell: number;
  cost: ArrayLike<number>;
  /** Directed edge weight k → neighbour d (index into DIRS); ∞ = not walkable. */
  edge?: (k: number, d: number) => number;
  /** Heuristic cost per metre (the cheapest edge per metre). Defaults to 1. */
  hScale?: number;
}

export type NeighborStatus = 'mejora' | 'no mejora' | 'cerrado' | 'bloqueado' | 'esquina' | 'visitado' | 'elegido' | 'descartado';

export interface NeighborEval {
  id: number;
  ell: number;
  cn: number;
  status: NeighborStatus;
  edge?: number;
  g?: number;
  h?: number;
  f?: number;
  penalty?: number;
  score?: number;
}

export interface Step {
  cur: number;
  g: number;
  h: number;
  f: number;
  neighbors: NeighborEval[];
  openSize: number;
  action?: 'avanza' | 'retrocede' | 'meta';
  best?: number;
}

export interface Trace {
  ok: boolean;
  steps: Step[];
  path: number[];
  expanded: number;
  order: Int32Array; // step at which each cell was closed / visited, -1 if never
}

const octile = (v: GridView, a: number, b: number) => {
  const dx = Math.abs((a % v.w) - (b % v.w));
  const dz = Math.abs(Math.floor(a / v.w) - Math.floor(b / v.w));
  return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * v.cell * (v.hScale ?? 1);
};

const cornerBlocked = (v: GridView, ci: number, cj: number, ni: number, nj: number) =>
  !Number.isFinite(v.cost[cj * v.w + ni]) || !Number.isFinite(v.cost[nj * v.w + ci]);

/** Edge weight and why it may be unusable. */
function edgeOf(v: GridView, k: number, d: number): { w: number; status?: NeighborStatus } {
  const [di, dj, ell] = DIRS[d];
  const ci = k % v.w;
  const cj = Math.floor(k / v.w);
  const ni = ci + di;
  const nj = cj + dj;
  const n = nj * v.w + ni;
  if (v.edge) {
    const w = v.edge(k, d);
    return Number.isFinite(w) ? { w } : { w: Infinity, status: 'bloqueado' };
  }
  if (!Number.isFinite(v.cost[n]) || !Number.isFinite(v.cost[k])) return { w: Infinity, status: 'bloqueado' };
  if (ell > 1 && cornerBlocked(v, ci, cj, ni, nj)) return { w: Infinity, status: 'esquina' };
  return { w: ell * v.cell * (v.cost[k] + v.cost[n]) * 0.5 };
}

export function traceAStar(v: GridView, s: number, g: number, record = true): Trace {
  const n = v.w * v.h;
  const G = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const order = new Int32Array(n).fill(-1);
  const heap = new MinHeap();
  const steps: Step[] = [];
  G[s] = 0;
  heap.push(s, octile(v, s, g));
  let expanded = 0;
  let found = false;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    order[cur] = expanded;
    expanded++;
    const hc = octile(v, cur, g);
    const step: Step = { cur, g: G[cur], h: hc, f: G[cur] + hc, neighbors: [], openSize: heap.size };
    if (record) steps.push(step);
    if (cur === g) {
      found = true;
      break;
    }
    const ci = cur % v.w;
    const cj = Math.floor(cur / v.w);
    for (let d = 0; d < 8; d++) {
      const [di, dj, ell] = DIRS[d];
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= v.w || nj >= v.h) continue;
      const id = nj * v.w + ni;
      const cn = v.cost[id];
      if (closed[id]) {
        if (record) step.neighbors.push({ id, ell, cn, status: 'cerrado' });
        continue;
      }
      const e = edgeOf(v, cur, d);
      if (e.status) {
        if (record) step.neighbors.push({ id, ell, cn, status: e.status });
        continue;
      }
      const ng = G[cur] + e.w;
      const h = octile(v, id, g);
      const better = ng < G[id];
      if (better) {
        G[id] = ng;
        came[id] = cur;
        heap.push(id, ng + h);
      }
      if (record) step.neighbors.push({ id, ell, cn, edge: e.w, g: ng, h, f: ng + h, status: better ? 'mejora' : 'no mejora' });
    }
  }
  const path: number[] = [];
  if (found) {
    for (let c = g; c !== -1; c = came[c]) path.push(c);
    path.reverse();
  }
  return { ok: found, steps, path, expanded, order };
}

export function traceGreedy(v: GridView, s: number, g: number, record = true): Trace {
  const n = v.w * v.h;
  const visited = new Uint8Array(n);
  const order = new Int32Array(n).fill(-1);
  const stack = [s];
  const steps: Step[] = [];
  visited[s] = 1;
  order[s] = 0;
  let iter = 0;
  const maxIter = Math.ceil((octile(v, s, g) / (v.cell * (v.hScale ?? 1))) * 3) + 150;
  while (stack.length && iter++ < maxIter) {
    const cur = stack[stack.length - 1];
    const step: Step = { cur, g: 0, h: octile(v, cur, g), f: 0, neighbors: [], openSize: stack.length };
    if (record) steps.push(step);
    if (cur === g) {
      step.action = 'meta';
      break;
    }
    const ci = cur % v.w;
    const cj = Math.floor(cur / v.w);
    let best = -1;
    let bestScore = Infinity;
    for (let d = 0; d < 8; d++) {
      const [di, dj, ell] = DIRS[d];
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= v.w || nj >= v.h) continue;
      const id = nj * v.w + ni;
      const cn = v.cost[id];
      if (visited[id]) {
        if (record) step.neighbors.push({ id, ell, cn, status: 'visitado' });
        continue;
      }
      const e = edgeOf(v, cur, d);
      if (e.status) {
        if (record) step.neighbors.push({ id, ell, cn, status: e.status });
        continue;
      }
      const h = octile(v, id, g);
      const penalty = e.w;
      const score = h + penalty;
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
      if (record) step.neighbors.push({ id, ell, cn, h, penalty, score, status: 'descartado' });
    }
    if (best < 0) {
      stack.pop();
      step.action = 'retrocede';
    } else {
      visited[best] = 1;
      order[best] = iter;
      stack.push(best);
      step.action = 'avanza';
      step.best = best;
      const chosen = step.neighbors.find((e) => e.id === best);
      if (chosen) chosen.status = 'elegido';
    }
  }
  const ok = stack.length > 0 && stack[stack.length - 1] === g;
  return { ok, steps, path: ok ? stack.slice() : [], expanded: iter, order };
}

/** Graph cost of a cell path with the view's own edge weights. */
export function pathCost(v: GridView, path: number[]) {
  let cost = 0;
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const di = (b % v.w) - (a % v.w);
    const dj = Math.floor(b / v.w) - Math.floor(a / v.w);
    const d = DIRS.findIndex(([x, z]) => x === di && z === dj);
    const ell = DIRS[d][2];
    const e = edgeOf(v, a, d);
    cost += Number.isFinite(e.w) ? e.w : ell * v.cell * 5;
    len += ell * v.cell;
  }
  return { cost, len };
}
