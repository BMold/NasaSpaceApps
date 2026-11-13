// Route search over the directed O₂ graph (see costmap.ts):
//  • A* – global optimum; heuristic h(n) = octile(n, goal) · w_min, where w_min
//    is the cheapest litres-per-metre of any edge, so h never overestimates.
//  • Greedy ("Voraz") – myopic, step-by-step local choice with backtracking.
//  • Dijkstra – one search gives the cost to every cell: used for the tour
//    matrix D(i, j) and, on the reversed graph, for the return field R(p).
import { COST_N, CELL, DIRS, cellCenter, cellOf, costGrid, isWalkableCell } from './costmap';
import { heightAt, type XZ } from './terrain';

export { DIRS };
export type Algo = 'greedy' | 'astar';

export interface PlanResult {
  algo: Algo;
  ok: boolean;
  points: XZ[];
  computeMs: number;
  expanded: number;
  litres: number; // O₂ along the graph path
  seconds: number; // walking time along the graph path
  fallback?: boolean;
}

const NN = COST_N * COST_N;
/** Opposite direction index for each entry of DIRS. */
export const OPP = [1, 0, 3, 2, 7, 6, 5, 4];

export class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mk = lastKey;
        if (l < n && keys[l] < mk) {
          m = l;
          mk = keys[l];
        }
        if (r < n && keys[r] < mk) m = r;
        if (m === i) break;
        ids[i] = ids[m];
        keys[i] = keys[m];
        i = m;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

/** Octile distance in metres between two cells. */
export function octile(a: number, b: number) {
  const dx = Math.abs((a % COST_N) - (b % COST_N));
  const dz = Math.abs(((a / COST_N) | 0) - ((b / COST_N) | 0));
  return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * CELL;
}

/** Nearest walkable cell (breadth-first), so a start inside a hazard can still leave it. */
export function nearestWalkable(k: number): number {
  if (isWalkableCell(k)) return k;
  const seen = new Uint8Array(NN);
  const q = [k];
  seen[k] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const ci = c % COST_N;
    const cj = (c / COST_N) | 0;
    for (const [di, dj] of DIRS) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= COST_N || nj >= COST_N) continue;
      const n = nj * COST_N + ni;
      if (seen[n]) continue;
      if (isWalkableCell(n)) return n;
      seen[n] = 1;
      q.push(n);
    }
  }
  return k;
}

function pathSums(cells: number[]) {
  let litres = 0;
  let seconds = 0;
  for (let i = 0; i < cells.length - 1; i++) {
    const a = cells[i];
    const di = (cells[i + 1] % COST_N) - (a % COST_N);
    const dj = ((cells[i + 1] / COST_N) | 0) - ((a / COST_N) | 0);
    for (let d = 0; d < 8; d++)
      if (DIRS[d][0] === di && DIRS[d][1] === dj) {
        litres += costGrid.edgeL[a * 8 + d];
        seconds += costGrid.edgeT[a * 8 + d];
      }
  }
  return { litres, seconds };
}

export function planAStar(start: XZ, goal: XZ): PlanResult {
  const t0 = performance.now();
  const { edgeL, wMinPerM } = costGrid;
  const s = nearestWalkable(cellOf(start));
  const g = nearestWalkable(cellOf(goal));
  const G = new Float32Array(NN).fill(Infinity);
  const came = new Int32Array(NN).fill(-1);
  const closed = new Uint8Array(NN);
  const heap = new MinHeap();
  G[s] = 0;
  heap.push(s, octile(s, g) * wMinPerM);
  let expanded = 0;
  let found = false;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    expanded++;
    if (cur === g) {
      found = true;
      break;
    }
    const ci = cur % COST_N;
    const cj = (cur / COST_N) | 0;
    for (let d = 0; d < 8; d++) {
      const w = edgeL[cur * 8 + d];
      if (!Number.isFinite(w)) continue;
      const n = (cj + DIRS[d][1]) * COST_N + ci + DIRS[d][0];
      if (closed[n]) continue;
      const ng = G[cur] + w;
      if (ng < G[n]) {
        G[n] = ng;
        came[n] = cur;
        heap.push(n, ng + octile(n, g) * wMinPerM);
      }
    }
  }
  const computeMs = performance.now() - t0;
  if (!found) return { algo: 'astar', ok: false, points: straightLine(start, goal), computeMs, expanded, litres: Infinity, seconds: Infinity };
  const cells: number[] = [];
  for (let c = g; c !== -1; c = came[c]) cells.push(c);
  cells.reverse();
  return { algo: 'astar', ok: true, points: cellsToPoints(cells, start, goal), computeMs, expanded, ...pathSums(cells) };
}

export function planGreedy(start: XZ, goal: XZ): PlanResult {
  const t0 = performance.now();
  const { edgeL, wMinPerM } = costGrid;
  const s = nearestWalkable(cellOf(start));
  const g = nearestWalkable(cellOf(goal));
  const visited = new Uint8Array(NN);
  const stack = [s];
  visited[s] = 1;
  let iter = 0;
  // A local planner that has not arrived after ~3× the straight-line cell count
  // is wandering in a local minimum: declare it stuck.
  const maxIter = Math.ceil((octile(s, g) / CELL) * 3) + 150;
  while (stack.length && iter++ < maxIter) {
    const cur = stack[stack.length - 1];
    if (cur === g) break;
    const ci = cur % COST_N;
    const cj = (cur / COST_N) | 0;
    let best = -1;
    let bestScore = Infinity;
    for (let d = 0; d < 8; d++) {
      const w = edgeL[cur * 8 + d];
      if (!Number.isFinite(w)) continue;
      const n = (cj + DIRS[d][1]) * COST_N + ci + DIRS[d][0];
      if (visited[n]) continue;
      // Myopic: the next edge's cost plus the optimistic estimate of what is left.
      const score = octile(n, g) * wMinPerM + w;
      if (score < bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best < 0) stack.pop();
    else {
      visited[best] = 1;
      stack.push(best);
    }
  }
  const computeMs = performance.now() - t0;
  const ok = stack.length > 0 && stack[stack.length - 1] === g;
  if (!ok) return { algo: 'greedy', ok: false, points: straightLine(start, goal), computeMs, expanded: iter, litres: Infinity, seconds: Infinity };
  return { algo: 'greedy', ok: true, points: cellsToPoints(stack, start, goal), computeMs, expanded: iter, ...pathSums(stack) };
}

export interface Field {
  cost: Float32Array; // litres
  time: Float32Array; // seconds
  parent: Int32Array; // next cell toward the source (reverse) or previous cell from the source (forward)
  source: number;
}

/**
 * Dijkstra over the directed graph.
 * forward = true: cost from `source` to every cell (parent = previous cell).
 * forward = false: cost from every cell TO `source` on the same directed edges,
 * i.e. a search on the reversed graph (parent = next cell toward the source).
 */
export function dijkstra(sourceP: XZ, forward: boolean): Field {
  const { edgeL, edgeT } = costGrid;
  const source = nearestWalkable(cellOf(sourceP));
  const cost = new Float32Array(NN).fill(Infinity);
  const time = new Float32Array(NN).fill(Infinity);
  const parent = new Int32Array(NN).fill(-1);
  const closed = new Uint8Array(NN);
  const heap = new MinHeap();
  cost[source] = 0;
  time[source] = 0;
  heap.push(source, 0);
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = cur % COST_N;
    const cj = (cur / COST_N) | 0;
    for (let d = 0; d < 8; d++) {
      const ni = ci + DIRS[d][0];
      const nj = cj + DIRS[d][1];
      if (ni < 0 || nj < 0 || ni >= COST_N || nj >= COST_N) continue;
      const n = nj * COST_N + ni;
      if (closed[n]) continue;
      // Forward uses cur→n; reverse uses n→cur, the opposite direction seen from n.
      const e = forward ? cur * 8 + d : n * 8 + OPP[d];
      const w = edgeL[e];
      if (!Number.isFinite(w)) continue;
      const nc = cost[cur] + w;
      if (nc < cost[n]) {
        cost[n] = nc;
        time[n] = time[cur] + edgeT[e];
        parent[n] = cur;
        heap.push(n, nc);
      }
    }
  }
  return { cost, time, parent, source };
}

/** Polyline from a forward field's source to `target`. */
export function fieldPathTo(f: Field, from: XZ, target: XZ): XZ[] {
  const t = nearestWalkable(cellOf(target));
  if (!Number.isFinite(f.cost[t])) return straightLine(from, target);
  const cells: number[] = [];
  for (let c = t; c !== -1; c = f.parent[c]) cells.push(c);
  cells.reverse();
  return cellsToPoints(cells, from, target);
}

/** Polyline from `start` down a reverse field to its source. */
export function fieldPathHome(f: Field, start: XZ, home: XZ): XZ[] {
  let c = nearestWalkable(cellOf(start));
  if (!Number.isFinite(f.cost[c])) return straightLine(start, home);
  const cells: number[] = [c];
  let guard = 0;
  while (c !== f.source && guard++ < NN) {
    c = f.parent[c];
    if (c < 0) break;
    cells.push(c);
  }
  return cellsToPoints(cells, start, home);
}

/** Field value at a world point (bilinear-free: the containing cell). */
export const fieldAt = (f: Field, p: XZ, which: 'cost' | 'time' = 'cost') => f[which][nearestWalkable(cellOf(p))];

export function straightLine(a: XZ, b: XZ, step = 1): XZ[] {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(d / step));
  const pts: XZ[] = [];
  for (let i = 0; i <= n; i++) pts.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n });
  return pts;
}

export function chaikin(pts: XZ[], iterations: number): XZ[] {
  let p = pts;
  for (let it = 0; it < iterations; it++) {
    if (p.length < 3) return p;
    const out: XZ[] = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

export function resample(pts: XZ[], step = 1): XZ[] {
  if (pts.length < 2) return pts.slice();
  const out: XZ[] = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    let t = step - carry;
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, z: a.z + ((b.z - a.z) * t) / seg });
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > 0.05) out.push(last);
  return out;
}

export function cellsToPoints(cells: number[], start: XZ, goal: XZ): XZ[] {
  const pts = cells.map((c) => cellCenter(c % COST_N, (c / COST_N) | 0));
  pts[0] = { ...start };
  if (pts.length > 1) pts[pts.length - 1] = { ...goal };
  else pts.push({ ...goal });
  return resample(chaikin(pts, 3), 1);
}

export const pathHeight = (p: XZ) => heightAt(p.x, p.z);
