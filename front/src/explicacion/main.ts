// Widgets of the explainer page. Section 5 runs the simulator's real planners;
// the other widgets repeat the engine formulas on small, controllable inputs.
import { CELL, COST_N, cellOf, computeCostmap, costGrid, type Hazard } from '../lib/costmap';
import { evaluateRoute, type RouteMetrics } from '../lib/metrics';
import { REGIONS, loadMarsTrekRegion } from '../lib/marsTrek';
import { chaikin, planAStar, planGreedy, resample, straightLine, type PlanResult } from '../lib/pathfinding';
import { BASE_A, TARGET_B, buildHeightfield, heightAt, type XZ } from '../lib/terrain';
import { formatHours, groundTempC, marsDate, sunAt, sunsetLtst } from '../lib/marsTime';
import { L_EFF, Q_O2, RHO, edgeO2, kcalPerHour, pandolfWatts, walkSpeed } from '../lib/energy';
import { SITES } from '../lib/sites';
import { solveTour } from '../lib/tour';
import { pathCost, traceAStar, traceGreedy, type GridView, type NeighborEval, type Trace } from './trace';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => Number($<HTMLInputElement>(id).value);
const n1 = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '∞');
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const C = { cyan: '#00f0ff', amber: '#ff9900', red: '#ff003c', green: '#00ff78', yellow: '#ffc800', violet: '#aa5aff', text: '#dbe4ee', muted: '#94a3b6', line: '#243041' };
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------
const redraws: (() => void)[] = [];

function prep(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || Number(canvas.getAttribute('height')) || 200;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

interface Series {
  data: number[];
  color: string;
  label: string;
}

function chart(
  ctx: CanvasRenderingContext2D,
  r: { x: number; y: number; w: number; h: number },
  series: Series[],
  yMin: number,
  yMax: number,
  opts: { marker?: number; bands?: number[]; title?: string; xMax: number },
) {
  const px = (t: number) => r.x + (t / opts.xMax) * r.w;
  const py = (v: number) => r.y + r.h - ((clamp(v, yMin, yMax) - yMin) / (yMax - yMin)) * r.h;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.font = '11px "JetBrains Mono", monospace';
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  ctx.fillText(String(yMax), r.x - 4, r.y + 9);
  ctx.fillText(String(yMin), r.x - 4, r.y + r.h);
  for (const b of opts.bands ?? []) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#55617a';
    ctx.beginPath();
    ctx.moveTo(r.x, py(b));
    ctx.lineTo(r.x + r.w, py(b));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'right';
    ctx.fillText(String(b).replace('.', ','), r.x + r.w - 3, py(b) - 3);
  }
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    const stride = Math.max(1, Math.floor(s.data.length / r.w));
    for (let i = 0; i < s.data.length; i += stride) {
      const x = r.x + (i / Math.max(1, s.data.length - 1)) * ((s.data.length - 1) / (opts.xMax * 60)) * r.w;
      const y = py(s.data[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  let lx = r.x + 6;
  ctx.textAlign = 'left';
  if (opts.title) {
    ctx.fillStyle = C.text;
    ctx.fillText(opts.title, lx, r.y + 14);
    lx += ctx.measureText(opts.title).width + 12;
  }
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillText(s.label, lx, r.y + 14);
    lx += ctx.measureText(s.label).width + 12;
  }
  if (opts.marker !== undefined) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(opts.marker), r.y);
    ctx.lineTo(px(opts.marker), r.y + r.h);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// 1. Slope
// ---------------------------------------------------------------------------
function initSlope() {
  const ids = ['inW', 'inE', 'inN', 'inS'];
  const outs = ['hW', 'hE', 'hN', 'hS'];
  const update = () => {
    const [w, e, n, s] = ids.map(num);
    ids.forEach((id, i) => ($(outs[i]).textContent = `${num(id).toFixed(1)} m`));
    const E = 1.25;
    const gx = (e - w) / (2 * E);
    const gz = (s - n) / (2 * E);
    const mag = Math.hypot(gx, gz);
    const deg = (Math.atan(mag) * 180) / Math.PI;
    const cls = deg > 30 ? 'infranqueable: sin apoyo' : deg > 24 ? 'sólo en zigzag (el paso recto supera 45 %)' : deg > 16 ? 'precaución' : 'cómoda';
    $('slopeCalc').innerHTML =
      `g<sub>x</sub> = (${e.toFixed(1)} − ${w.toFixed(1)}) / 2,5 = ${n1(gx, 3)}<br>` +
      `g<sub>z</sub> = (${s.toFixed(1)} − ${n.toFixed(1)}) / 2,5 = ${n1(gz, 3)}<br>` +
      `s = atan(√(${n1(gx, 3)}² + ${n1(gz, 3)}²)) = <span class="res">${n1(deg, 1)}°</span> → ${cls}`;
    const run = 220;
    const rise = clamp(mag * run * 0.45, 0, 100);
    const color = deg > 30 ? C.red : deg > 16 ? C.yellow : C.green;
    $('rampa').innerHTML =
      `<polygon points="50,115 ${50 + run},115 ${50 + run},${115 - rise}" fill="${color}22" stroke="${color}" stroke-width="2"/>` +
      `<text x="${50 + run / 2}" y="129" fill="${C.muted}" font-size="11" text-anchor="middle">distancia</text>` +
      `<text x="${55 + run}" y="${115 - rise / 2}" fill="${C.muted}" font-size="11">|∇h|</text>` +
      `<text x="86" y="110" fill="${color}" font-size="15" font-weight="700">${n1(deg, 1)}°</text>`;
  };
  ids.forEach((id) => $(id).addEventListener('input', update));
  update();
}

// ---------------------------------------------------------------------------
// 2. O₂ cost of a step (same functions as src/lib/energy.ts and costmap.ts)
// ---------------------------------------------------------------------------
const per100 = (G: number, eta: number) => edgeO2(100, G, eta).litres;

function initCost() {
  const canvas = $<HTMLCanvasElement>('costPlot');
  const draw = () => {
    const G = num('cS');
    const sand = num('cA');
    const unknown = $<HTMLInputElement>('cU').checked;
    const cold = $<HTMLInputElement>('cC').checked;
    const rocks = $<HTMLInputElement>('cR').checked;
    $('cSo').textContent = `${G > 0 ? '+' : ''}${G.toFixed(0)} %`;
    $('cAo').textContent = sand.toFixed(2);
    const eta = 1 + 0.9 * sand;
    const v = walkSpeed(G, eta);
    const M = pandolfWatts(G, eta, v);
    const L = per100(G, eta);
    const f = (unknown ? 7 : 1) * (cold ? 4 : 1);
    const blocked = rocks || Math.abs(G) > 45;
    $('costCalc').innerHTML =
      `L<sub>eff</sub> = (80 + 150)·0,38 − 80 = ${n1(L_EFF, 1)} kg · η = ${n1(eta)}<br>` +
      `v = 1,2·e<sup>−0,042·${Math.abs(G).toFixed(0)}</sup>·(1 − 0,28·${n1(eta)}) = <span class="res">${n1(v, 3)} m/s</span><br>` +
      `M = <span class="res">${n1(M, 0)} W</span> (${n1(kcalPerHour(M), 0)} kcal/h)<br>` +
      `O₂ cada 100 m = M · 100/(60·v) · 0,00298 = <span class="res">${n1(L, 2)} L</span>` +
      (blocked ? `<br>paso <span class="res" style="color:${C.red}">prohibido</span>${rocks ? ' (rocas)' : ' (|G| > 45 %)'}` : f > 1 ? `<br>para decidir: ×${f} → ${n1(L * f, 2)} L` : '') +
      `<br>al revés (−G): ${n1(per100(-G, eta), 2)} L`;

    const { ctx, w, h } = prep(canvas);
    const m = { l: 38, r: 12, t: 12, b: 28 };
    const pw = w - m.l - m.r;
    const ph = h - m.t - m.b;
    const yMax = 12;
    const X = (g: number) => m.l + ((g + 60) / 120) * pw;
    const Y = (v2: number) => m.t + ph - (clamp(v2, 0, yMax) / yMax) * ph;
    ctx.fillStyle = `${C.red}22`;
    ctx.fillRect(X(-60), m.t, X(-45) - X(-60), ph);
    ctx.fillRect(X(45), m.t, X(60) - X(45), ph);
    ctx.strokeStyle = C.line;
    ctx.strokeRect(m.l, m.t, pw, ph);
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'center';
    for (const tk of [-45, -20, 0, 20, 45]) ctx.fillText(`${tk}%`, X(tk), h - 10);
    ctx.textAlign = 'right';
    for (const tk of [0, 4, 8, 12]) ctx.fillText(String(tk), m.l - 5, Y(tk) + 4);
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let g = -45; g <= 45; g += 0.5) {
      const y = Y(per100(g, eta));
      if (g === -45) ctx.moveTo(X(g), y);
      else ctx.lineTo(X(g), y);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(X(clamp(G, -45, 45)), Y(L), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left';
    ctx.fillText('L de O₂ / 100 m', m.l + 6, m.t + 14);
  };
  ['cS', 'cA', 'cU', 'cC', 'cR'].forEach((id) => $(id).addEventListener('input', draw));
  redraws.push(draw);
  draw();
}

// ---------------------------------------------------------------------------
// 3. Edge weight
// ---------------------------------------------------------------------------
function initEdge() {
  const update = () => {
    const ha = num('inCa');
    const hb = num('inCb');
    const diag = $<HTMLInputElement>('inDiag').checked;
    const ell = diag ? Math.SQRT2 : 1;
    $('ca').textContent = `${ha.toFixed(2)} m`;
    $('cb').textContent = `${hb.toFixed(2)} m`;
    const dd = ell * CELL;
    const G = (100 * (hb - ha)) / dd;
    const wab = edgeO2(dd, G, 1).litres;
    const wba = edgeO2(dd, -G, 1).litres;
    const bad = Math.abs(G) > 45;
    $('edgeCalc').innerHTML =
      `Δd = ${diag ? '√2 · ' : ''}2,5 = ${n1(dd)} m · G = 100·(${hb.toFixed(2)} − ${ha.toFixed(2)})/${n1(dd)} = ${n1(G, 1)} %<br>` +
      `w(a → b) = <span class="res">${bad ? '∞ (|G| > 45 %)' : `${(wab * 1000).toFixed(1)} mL`}</span><br>` +
      `w(b → a) = <span class="res">${bad ? '∞' : `${(wba * 1000).toFixed(1)} mL`}</span>` +
      (bad ? '' : ` · subir cuesta ${n1(Math.max(wab, wba) / Math.min(wab, wba), 1)} veces bajar`);
    const S = 52;
    const ox = 72;
    const oy = 12;
    let html = '';
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        const isA = i === 1 && j === 1;
        const isB = diag ? i === 2 && j === 0 : i === 2 && j === 1;
        const fill = isA ? '#0a5560' : isB ? '#6a4310' : '#172030';
        html += `<rect x="${ox + i * S}" y="${oy + j * S}" width="${S - 2}" height="${S - 2}" rx="3" fill="${fill}" stroke="#2b3a4e"/>`;
        if (isA) html += `<text x="${ox + i * S + 25}" y="${oy + j * S + 30}" text-anchor="middle" fill="#fff" font-size="15">a</text>`;
        if (isB) html += `<text x="${ox + i * S + 25}" y="${oy + j * S + 30}" text-anchor="middle" fill="#fff" font-size="15">b</text>`;
        if (!isA) {
          const x2 = ox + i * S + 25;
          const y2 = oy + j * S + 25;
          html += `<line x1="${ox + S + 25}" y1="${oy + S + 25}" x2="${x2}" y2="${y2}" stroke="${isB ? C.amber : '#55617a'}" stroke-width="${isB ? 3 : 1}"/>`;
        }
      }
    }
    $('edgeSvg').innerHTML = html;
  };
  ['inCa', 'inCb', 'inDiag'].forEach((id) => $(id).addEventListener('input', update));
  update();
}

// ---------------------------------------------------------------------------
// 4. Step-by-step A* and greedy on a small editable grid
// ---------------------------------------------------------------------------
const GW = 16;
const GH = 10;

const grid = {
  cost: new Float32Array(GW * GH).fill(1),
  s: 0,
  g: 0,
  a: null as Trace | null,
  b: null as Trace | null,
  k: 0,
  brush: 'inf',
  playing: 0,
};
const view: GridView = { w: GW, h: GH, cell: CELL, cost: grid.cost };
const idx = (x: number, y: number) => y * GW + x;
const label = (id: number) => `(${id % GW},${Math.floor(id / GW)})`;

function loadPreset(name: string) {
  grid.cost.fill(1);
  const wall = (x: number, y: number, v = Infinity) => {
    grid.cost[idx(x, y)] = v;
  };
  if (name === 'wall') {
    for (let y = 0; y < GH - 1; y++) wall(7, y);
    for (let x = 10; x < 13; x++) for (let y = 2; y < 6; y++) wall(x, y, 4.2);
    grid.s = idx(1, 3);
    grid.g = idx(14, 3);
  } else if (name === 'u') {
    for (let y = 1; y < 9; y++) wall(10, y);
    for (let x = 5; x < 11; x++) {
      wall(x, 1);
      wall(x, 8);
    }
    grid.s = idx(2, 4);
    grid.g = idx(14, 4);
  } else {
    for (let y = 1; y < 9; y++) wall(8, y, y === 4 || y === 5 ? (name === 'canyon' ? 39 : 1) : Infinity);
    grid.s = idx(1, 5);
    grid.g = idx(14, 5);
  }
  retrace();
}

function retrace() {
  grid.a = traceAStar(view, grid.s, grid.g);
  grid.b = traceGreedy(view, grid.s, grid.g);
  grid.k = 0;
  const slider = $<HTMLInputElement>('pSlider');
  slider.max = String(maxK());
  slider.value = '0';
  renderGrid();
}

const maxK = () => Math.max(grid.a!.steps.length, grid.b!.steps.length) - 1;

function cellColor(c: number) {
  if (!Number.isFinite(c)) return '#05070c';
  if (c >= 30) return '#5a3a91';
  if (c >= 7) return '#a8541e';
  if (c >= 2.3) return '#7a6220';
  return '#1c2636';
}

function drawBoard(canvas: HTMLCanvasElement, t: Trace, kind: 'a' | 'g') {
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width || 500;
  const S = cssW / GW;
  canvas.style.height = `${S * GH}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(S * GH * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const k = Math.min(grid.k, t.steps.length - 1);
  const step = t.steps[k];

  // replay up to step k
  const f = new Float32Array(GW * GH).fill(NaN);
  const came = new Int32Array(GW * GH).fill(-1);
  const stack: number[] = [grid.s];
  for (let i = 0; i <= k; i++) {
    const st = t.steps[i];
    if (kind === 'a') {
      for (const n of st.neighbors) {
        if (n.status === 'mejora') {
          f[n.id] = n.f!;
          came[n.id] = st.cur;
        }
      }
    } else if (i < k) {
      if (st.action === 'avanza') stack.push(st.best!);
      else if (st.action === 'retrocede') stack.pop();
    }
  }
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const id = idx(x, y);
      ctx.fillStyle = cellColor(grid.cost[id]);
      ctx.fillRect(x * S, y * S, S - 1, S - 1);
      const done = t.order[id] >= 0 && t.order[id] <= k;
      if (done) {
        ctx.fillStyle = kind === 'a' ? 'rgba(0,240,255,0.26)' : 'rgba(255,153,0,0.26)';
        ctx.fillRect(x * S, y * S, S - 1, S - 1);
      } else if (kind === 'a' && !Number.isNaN(f[id])) {
        ctx.strokeStyle = 'rgba(0,240,255,0.8)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x * S + 1.5, y * S + 1.5, S - 4, S - 4);
      }
      if (S >= 26 && kind === 'a' && !Number.isNaN(f[id])) {
        ctx.fillStyle = '#dff';
        ctx.font = `${Math.min(11, S * 0.32)}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(f[id].toFixed(0), x * S + S / 2, y * S + S / 2 + 4);
      }
    }
  }
  // neighbours under evaluation
  for (const n of step.neighbors) {
    const nx = n.id % GW;
    const ny = Math.floor(n.id / GW);
    if (n.status === 'elegido' || n.status === 'mejora') {
      ctx.strokeStyle = n.status === 'elegido' ? '#fff' : C.green;
      ctx.lineWidth = 2;
      ctx.strokeRect(nx * S + 2, ny * S + 2, S - 5, S - 5);
    }
  }
  // active path
  const line: number[] = [];
  if (kind === 'a') {
    if (k === t.steps.length - 1 && t.ok) line.push(...t.path);
    else for (let c = step.cur; c !== -1; c = came[c]) line.unshift(c);
  } else {
    line.push(...stack);
  }
  ctx.strokeStyle = kind === 'a' ? C.cyan : C.amber;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  line.forEach((c, i) => {
    const x = (c % GW) * S + S / 2;
    const y = Math.floor(c / GW) * S + S / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const mark = (id: number, col: string, txt: string) => {
    const x = (id % GW) * S;
    const y = Math.floor(id / GW) * S;
    ctx.fillStyle = col;
    ctx.fillRect(x + 2, y + 2, S - 5, S - 5);
    ctx.fillStyle = '#04121a';
    ctx.font = `700 ${Math.min(14, S * 0.42)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(txt, x + S / 2, y + S / 2 + 5);
  };
  mark(grid.s, C.green, 'A');
  mark(grid.g, C.amber, 'B');
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.strokeRect((step.cur % GW) * S + 1, Math.floor(step.cur / GW) * S + 1, S - 3, S - 3);
}

function neighborTable(el: HTMLElement, list: NeighborEval[], kind: 'a' | 'g') {
  if (!list.length) {
    el.innerHTML = '';
    return;
  }
  const head =
    kind === 'a'
      ? '<tr><th>vecino</th><th>ℓ</th><th>c</th><th>w</th><th>g</th><th>h</th><th>f</th><th>resultado</th></tr>'
      : '<tr><th>vecino</th><th>ℓ</th><th>c</th><th>h</th><th>2,2·2,5·ℓ·c</th><th>score</th><th>resultado</th></tr>';
  const rows = list
    .map((n) => {
      const cl = n.status === 'mejora' || n.status === 'elegido' ? 'win' : n.g === undefined && n.score === undefined ? 'dim' : '';
      const c = n1(n.cn, 1);
      const ell = n.ell > 1 ? '√2' : '1';
      return kind === 'a'
        ? `<tr class="${cl}"><td>${label(n.id)}</td><td>${ell}</td><td>${c}</td><td>${n.edge !== undefined ? n1(n.edge, 1) : '—'}</td><td>${n.g !== undefined ? n1(n.g, 1) : '—'}</td><td>${n.h !== undefined ? n1(n.h, 1) : '—'}</td><td>${n.f !== undefined ? n1(n.f, 1) : '—'}</td><td>${n.status}</td></tr>`
        : `<tr class="${cl}"><td>${label(n.id)}</td><td>${ell}</td><td>${c}</td><td>${n.h !== undefined ? n1(n.h, 1) : '—'}</td><td>${n.penalty !== undefined ? n1(n.penalty, 1) : '—'}</td><td>${n.score !== undefined ? n1(n.score, 1) : '—'}</td><td>${n.status}</td></tr>`;
    })
    .join('');
  el.innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
}

function renderGrid() {
  const a = grid.a!;
  const b = grid.b!;
  $('pStep').textContent = `${grid.k} / ${maxK()}`;
  $<HTMLInputElement>('pSlider').value = String(grid.k);
  drawBoard($<HTMLCanvasElement>('gridA'), a, 'a');
  drawBoard($<HTMLCanvasElement>('gridG'), b, 'g');

  const summary = (t: Trace) => {
    if (!t.ok) return `Sin camino · ${t.expanded} nodos`;
    const { cost, len } = pathCost(view, t.path);
    return `costo ${cost.toFixed(1)} · ${len.toFixed(1)} m · ${t.expanded} nodos`;
  };
  $('sumA').textContent = summary(a);
  $('sumG').textContent = summary(b);

  const ka = Math.min(grid.k, a.steps.length - 1);
  const sa = a.steps[ka];
  $('descA').innerHTML =
    sa.cur === grid.g
      ? `Se extrae la meta ${label(sa.cur)} con f = ${n1(sa.f, 1)}. Ningún camino abierto puede ser más barato: terminó.`
      : `Se extrae el nodo abierto con menor f: <b>${label(sa.cur)}</b>, con g = ${n1(sa.g, 1)} + h = ${n1(sa.h, 1)} = f ${n1(sa.f, 1)}. Quedan ${sa.openSize} en la cola.`;
  neighborTable($('tabA'), sa.neighbors, 'a');

  const kb = Math.min(grid.k, b.steps.length - 1);
  const sb = b.steps[kb];
  const best = sb.neighbors.find((n) => n.status === 'elegido');
  $('descG').innerHTML =
    sb.action === 'meta'
      ? `Llegó a la meta ${label(sb.cur)} y se detiene, sin comprobar si había un camino mejor.`
      : sb.action === 'retrocede'
        ? `En <b>${label(sb.cur)}</b> no quedan vecinos disponibles: retrocede una celda.`
        : `En <b>${label(sb.cur)}</b> elige el menor score: ${best ? `${label(best.id)} con ${n1(best.score!, 1)}` : '—'}. Nunca vuelve a evaluar lo ya elegido.`;
  neighborTable($('tabG'), sb.neighbors, 'g');
}

function initGrid() {
  const paint = (e: PointerEvent, canvas: HTMLCanvasElement) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * GW);
    const y = Math.floor(((e.clientY - r.top) / r.height) * GH);
    if (x < 0 || y < 0 || x >= GW || y >= GH) return;
    const id = idx(x, y);
    if (grid.brush === 'start' || grid.brush === 'goal') {
      if (id === (grid.brush === 'start' ? grid.g : grid.s)) return;
      grid.cost[id] = 1;
      if (grid.brush === 'start') grid.s = id;
      else grid.g = id;
    } else {
      if (id === grid.s || id === grid.g) return;
      const v = grid.brush === 'inf' ? Infinity : Number(grid.brush);
      if (grid.cost[id] === v) return;
      grid.cost[id] = v;
    }
    stop();
    retrace();
    grid.k = maxK();
    renderGrid();
  };
  for (const id of ['gridA', 'gridG']) {
    const c = $<HTMLCanvasElement>(id);
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      paint(e, c);
    });
    c.addEventListener('pointermove', (e) => {
      if (e.buttons) paint(e, c);
    });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-preset]').forEach((o) => o.classList.remove('on'));
      b.classList.add('on');
      stop();
      loadPreset(b.dataset.preset!);
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-brush]').forEach((o) => o.classList.remove('on'));
      b.classList.add('on');
      grid.brush = b.dataset.brush!;
    }),
  );
  const go = (k: number) => {
    grid.k = clamp(k, 0, maxK());
    renderGrid();
  };
  const stop = () => {
    window.clearInterval(grid.playing);
    grid.playing = 0;
    $('pPlay').textContent = '▶ Reproducir';
  };
  $('pFirst').addEventListener('click', () => (stop(), go(0)));
  $('pPrev').addEventListener('click', () => (stop(), go(grid.k - 1)));
  $('pNext').addEventListener('click', () => (stop(), go(grid.k + 1)));
  $('pLast').addEventListener('click', () => (stop(), go(maxK())));
  $('pSlider').addEventListener('input', () => (stop(), go(num('pSlider'))));
  $('pPlay').addEventListener('click', () => {
    if (grid.playing) return stop();
    if (grid.k >= maxK()) grid.k = 0;
    $('pPlay').textContent = '⏸ Pausar';
    grid.playing = window.setInterval(() => {
      if (grid.k >= maxK()) return stop();
      go(grid.k + 1);
    }, 160);
  });
  loadPreset('wall');
  grid.k = maxK();
  renderGrid();
  redraws.push(renderGrid);
}

// ---------------------------------------------------------------------------
// 5. The real 96×96 map, using the simulator's own modules
// ---------------------------------------------------------------------------
const real = {
  lat: -4.8253,
  hazards: [] as Hazard[],
  scanned: false,
  tool: 'info',
  base: document.createElement('canvas'),
  a: null as PlanResult | null,
  g: null as PlanResult | null,
  traceA: null as Trace | null,
  traceG: null as Trace | null,
  anim: 0,
  animKind: 'a' as 'a' | 'g',
  animK: -1,
};

const costView = (): GridView => ({ w: COST_N, h: COST_N, cell: CELL, cost: costGrid.cost, edge: (k, d) => costGrid.edgeL[k * 8 + d], hScale: costGrid.wMinPerM });
const mars = marsDate(Date.now());
const sun10 = () => sunAt(real.lat, mars.decl, 10, mars.rAU);

function rebuildReal() {
  computeCostmap(real.hazards, real.scanned, sun10());
  const b = real.base;
  b.width = COST_N;
  b.height = COST_N;
  const ctx = b.getContext('2d')!;
  const img = ctx.createImageData(COST_N, COST_N);
  const col: [number, number, number][] = [[0, 190, 95], [255, 200, 0], [255, 0, 60], [170, 90, 255]];
  for (let j = 0; j < COST_N; j++) {
    for (let i = 0; i < COST_N; i++) {
      const k = j * COST_N + i;
      const x = -120 + (i + 0.5) * CELL;
      const z = -120 + (j + 0.5) * CELL;
      const shade = clamp(0.55 - (heightAt(x + 1.25, z) - heightAt(x - 1.25, z)) * 0.14 - (heightAt(x, z + 1.25) - heightAt(x, z - 1.25)) * 0.08, 0.15, 1);
      const c = col[costGrid.cls[k]];
      const mix = costGrid.cls[k] === 0 ? 0.22 : 0.72;
      img.data[k * 4] = (70 * shade) * (1 - mix) + c[0] * mix * (0.5 + shade * 0.5);
      img.data[k * 4 + 1] = (72 * shade) * (1 - mix) + c[1] * mix * (0.5 + shade * 0.5);
      img.data[k * 4 + 2] = (80 * shade) * (1 - mix) + c[2] * mix * (0.5 + shade * 0.5);
      img.data[k * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  real.a = planAStar(BASE_A, TARGET_B);
  real.g = planGreedy(BASE_A, TARGET_B);
  const v = costView();
  const s = cellOf(BASE_A);
  const g = cellOf(TARGET_B);
  real.traceA = traceAStar(v, s, g, false);
  real.traceG = traceGreedy(v, s, g, false);
  real.animK = -1;
  renderRealTable();
  drawReal();
  if (document.getElementById('tourTable')) runTour();
  const ok = real.traceA.expanded === real.a.expanded && real.traceG.expanded === real.g.expanded;
  const verify = $('verify');
  verify.className = ok ? 'verify' : 'verify bad';
  verify.textContent = ok
    ? `✓ El trazador de la sección 4 coincide con el planificador real: A* ${real.a.expanded} nodos, voraz ${real.g.expanded} nodos.`
    : `✗ El trazador difiere: A* ${real.traceA.expanded}/${real.a.expanded}, voraz ${real.traceG.expanded}/${real.g.expanded}.`;
  const canyonCells = real.a.points.filter((p) => costGrid.cls[cellOf(p)] === 3).length;
  $('canyonNote').textContent = real.scanned
    ? `Con el cañón mapeado sus aristas cuestan solo el O₂ de Pandolf y A* lo usa como atajo. El dron acaba de ahorrar la subida a la cresta.`
    : `Sin mapear, cada arista del cañón cuesta ×7: A* prefiere subir la cresta en zigzag${canyonCells ? ', aunque en este mapa todavía cruza parte del cañón' : ''}. Marcá "Dron ya escaneó el cañón" y mirá cambiar la ruta.`;
}

function polyline(ctx: CanvasRenderingContext2D, pts: XZ[], S: number, color: string, width: number, dash: number[] = []) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = (p.x + 120) * S;
    const y = (p.z + 120) * S;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawReal() {
  const canvas = $<HTMLCanvasElement>('realMap');
  const size = canvas.clientWidth || 500;
  canvas.style.height = `${size}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(real.base, 0, 0, size, size);
  const S = size / 240;
  const cell = size / COST_N;

  const animating = real.animK >= 0;
  if (animating) {
    const t = real.animKind === 'a' ? real.traceA! : real.traceG!;
    ctx.fillStyle = real.animKind === 'a' ? 'rgba(0,240,255,0.42)' : 'rgba(255,153,0,0.5)';
    for (let k = 0; k < t.order.length; k++) {
      if (t.order[k] >= 0 && t.order[k] <= real.animK) ctx.fillRect((k % COST_N) * cell, Math.floor(k / COST_N) * cell, cell, cell);
    }
  }
  for (const h of real.hazards) {
    ctx.strokeStyle = h.kind === 'cold' ? '#7cd4ff' : '#ff8aa3';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc((h.x + 120) * S, (h.z + 120) * S, h.r * S, 0, Math.PI * 2);
    ctx.stroke();
  }
  const finished = !animating || real.animK >= (real.animKind === 'a' ? real.traceA! : real.traceG!).expanded - 1;
  polyline(ctx, [BASE_A, TARGET_B], S, 'rgba(255,255,255,0.75)', 1.5, [6, 6]);
  if (finished || real.animKind === 'a') if (real.g) polyline(ctx, real.g.points, S, finished ? C.amber : 'transparent', 2.5);
  if (finished || real.animKind === 'g') if (real.a) polyline(ctx, real.a.points, S, finished ? C.cyan : 'transparent', 3);
  const dot = (p: XZ, col: string, txt: string) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc((p.x + 120) * S, (p.z + 120) * S, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#04121a';
    ctx.font = '700 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(txt, (p.x + 120) * S, (p.z + 120) * S + 4);
  };
  dot(BASE_A, C.green, 'A');
  dot(TARGET_B, C.amber, 'B');
}

function renderRealTable() {
  const batteryPct = 87;
  const straight = evaluateRoute(straightLine(BASE_A, TARGET_B), { algo: 'straight', batteryPct });
  const ev = (p: PlanResult) => evaluateRoute(p.points, { algo: p.algo, batteryPct, computeMs: p.computeMs, expanded: p.expanded });
  const a = ev(real.a!);
  const g = ev(real.g!);
  const graphCost = (t: Trace | null) => (t && t.ok ? pathCost(costView(), t.path).cost : NaN);
  const rows: [string, (m: RouteMetrics) => string, string, string][] = [
    ['Longitud (m)', (m) => n1(m.lengthM, 0), n1(a.lengthM, 0), n1(g.lengthM, 0)],
    ['Costo Σw del grafo, L de O₂ con riesgo (lo que optimiza A*)', () => '', n1(graphCost(real.traceA), 2), n1(graphCost(real.traceG), 2)],
    ['Nodos expandidos', (m) => String(m.expanded), String(a.expanded), String(g.expanded)],
    ['Tiempo de cálculo (ms)', (m) => n1(m.computeMs), n1(a.computeMs), n1(g.computeMs)],
    ['O₂ al caminar, Pandolf (L)', (m) => n1(m.litres, 2), n1(a.litres, 2), n1(g.litres, 2)],
    ['Desnivel subido (m)', (m) => n1(m.climbM, 1), n1(a.climbM, 1), n1(g.climbM, 1)],
    ['Pendiente de arista máx. (%)', (m) => n1(m.maxGrade, 0), n1(a.maxGrade, 0), n1(g.maxGrade, 0)],
    ['Batería del rover al llegar', (m) => `${n1(m.batteryReservePct, 1)} %`, `${n1(a.batteryReservePct, 1)} %`, `${n1(g.batteryReservePct, 1)} %`],
    ['¿Transitable?', (m) => (m.feasible ? 'sí' : 'no'), a.feasible ? 'sí' : 'no', g.feasible ? 'sí' : 'no'],
  ];
  const valueStraight = (i: number) => (i === 1 || i === 2 || i === 3 ? '—' : rows[i][1](straight));
  $('realTable').innerHTML =
    `<thead><tr><th>Métrica</th><th style="color:${C.cyan}">A*</th><th style="color:${C.amber}">Voraz${real.g!.ok ? '' : ' (atascado: devuelve la recta)'}</th><th>Recta</th></tr></thead><tbody>` +
    rows.map((r, i) => `<tr><td style="white-space:normal">${r[0]}</td><td>${r[2]}</td><td>${r[3]}</td><td>${valueStraight(i)}</td></tr>`).join('') +
    '</tbody>';
}

function initReal() {
  const select = $<HTMLSelectElement>('region');
  select.innerHTML = REGIONS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
  const status = $('regionStatus');
  let token = 0;
  const load = async (id: string) => {
    const my = ++token;
    const region = REGIONS.find((r) => r.id === id)!;
    if (id === 'procedural') {
      buildHeightfield(null, null, 'procedural');
      status.textContent = 'Terreno procedural';
      rebuildReal();
      return;
    }
    status.textContent = 'Descargando de NASA Mars Trek…';
    try {
      const data = await loadMarsTrekRegion(region);
      if (my !== token) return;
      buildHeightfield(data.dem, data.albedo, region.name, { hiRes: data.hiRes, tilt: data.tilt });
      real.lat = data.site.lat;
      status.textContent = data.hiRes
        ? `HiRISE a escala real junto a Curiosity · pendiente regional ${data.site.slopeDeg.toFixed(1)}°`
        : 'Datos de NASA Mars Trek (modo análogo)';
    } catch {
      if (my !== token) return;
      buildHeightfield(null, null, 'procedural');
      status.textContent = 'Sin conexión con Mars Trek: terreno procedural';
    }
    rebuildReal();
  };
  select.addEventListener('change', () => load(select.value));

  const animate = (kind: 'a' | 'g') => {
    cancelAnimationFrame(real.anim);
    real.animKind = kind;
    const total = (kind === 'a' ? real.traceA! : real.traceG!).expanded;
    if (reducedMotion) {
      real.animK = total;
      drawReal();
      return;
    }
    const t0 = performance.now();
    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / 2600);
      real.animK = Math.floor(u * total);
      drawReal();
      if (u < 1) real.anim = requestAnimationFrame(tick);
    };
    real.anim = requestAnimationFrame(tick);
  };
  $('animA').addEventListener('click', () => animate('a'));
  $('animG').addEventListener('click', () => animate('g'));
  $('scanned').addEventListener('change', () => {
    real.scanned = $<HTMLInputElement>('scanned').checked;
    rebuildReal();
  });
  $('clearHz').addEventListener('click', () => {
    real.hazards = [];
    rebuildReal();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-tool]').forEach((o) => o.classList.remove('on'));
      b.classList.add('on');
      real.tool = b.dataset.tool!;
    }),
  );
  const canvas = $<HTMLCanvasElement>('realMap');
  const world = (e: MouseEvent): XZ => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 240 - 120, z: ((e.clientY - r.top) / r.height) * 240 - 120 };
  };
  const inspect = (e: MouseEvent) => {
    const p = world(e);
    const k = cellOf(p);
    const i = k % COST_N;
    const j = Math.floor(k / COST_N);
    const s = costGrid.slope[k];
    const sand = costGrid.sand[k];
    const f = costGrid.factor[k];
    const names = ['seguro', 'precaución', 'infranqueable', 'sin mapear'];
    // The 8 outgoing edges: litres to the east, north… show the asymmetry.
    const eN = costGrid.edgeL[k * 8 + 3];
    const eS = costGrid.edgeL[k * 8 + 2];
    const eE = costGrid.edgeL[k * 8 + 0];
    const eW = costGrid.edgeL[k * 8 + 1];
    const fmtL = (v: number) => (Number.isFinite(v) ? `${(v * 1000).toFixed(0)} mL` : '∞');
    $('cellInfo').innerHTML =
      `celda (${i}, ${j}) · x=${p.x.toFixed(0)} m, z=${p.z.toFixed(0)} m · altura ${costGrid.height[k].toFixed(1)} m<br>` +
      `pendiente máx. ${s.toFixed(1)}° · arena ${sand.toFixed(2)} → η = ${(1 + 0.9 * sand).toFixed(2)} · riesgo ×${f.toFixed(2)}${costGrid.shade[k] ? ' · en sombra' : ''}<br>` +
      `aristas hacia N ${fmtL(eN)} · S ${fmtL(eS)} · E ${fmtL(eE)} · O ${fmtL(eW)}<br>` +
      `clase: <span class="res">${names[costGrid.cls[k]]}</span>`;
  };
  canvas.addEventListener('pointermove', inspect);
  canvas.addEventListener('click', (e) => {
    inspect(e);
    if (real.tool === 'info') return;
    const p = world(e);
    const hz: Hazard = real.tool === 'cold' ? { id: 'cold', kind: 'cold', x: p.x, z: p.z, r: 12 } : { id: 'rocks', kind: 'rocks', x: p.x, z: p.z, r: 7.5 };
    real.hazards = real.hazards.filter((h) => h.kind !== hz.kind).concat(hz);
    rebuildReal();
  });
  rebuildReal();
  redraws.push(drawReal);
  load('gale');
}

// ---------------------------------------------------------------------------
// 6. Chaikin + resampling
// ---------------------------------------------------------------------------
function initChaikin() {
  const canvas = $<HTMLCanvasElement>('chCanvas');
  const stairs: XZ[] = [[0, 0], [2.5, 0], [5, 2.5], [7.5, 2.5], [10, 5], [10, 7.5], [12.5, 7.5], [15, 10], [17.5, 10], [20, 10]].map(([x, z]) => ({ x, z }));
  const length = (p: XZ[]) => p.slice(1).reduce((sum, v, i) => sum + Math.hypot(v.x - p[i].x, v.z - p[i].z), 0);
  const draw = () => {
    const it = num('chN');
    const showR = $<HTMLInputElement>('chR').checked;
    $('chO').textContent = String(it);
    const smooth = chaikin(stairs, it);
    const res = resample(smooth, 1);
    const { ctx, w, h } = prep(canvas);
    const S = Math.min((w - 40) / 20, (h - 40) / 10);
    const X = (p: XZ) => 20 + p.x * S;
    const Y = (p: XZ) => h - 20 - p.z * S;
    ctx.strokeStyle = '#1b2533';
    ctx.lineWidth = 1;
    for (let v = 0; v <= 20; v += 2.5) {
      ctx.beginPath();
      ctx.moveTo(20 + v * S, h - 20);
      ctx.lineTo(20 + v * S, h - 20 - 10 * S);
      ctx.stroke();
    }
    for (let v = 0; v <= 10; v += 2.5) {
      ctx.beginPath();
      ctx.moveTo(20, h - 20 - v * S);
      ctx.lineTo(20 + 20 * S, h - 20 - v * S);
      ctx.stroke();
    }
    const line = (p: XZ[], col: string, lw: number, dash: number[] = []) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.setLineDash(dash);
      ctx.beginPath();
      p.forEach((q, i) => (i ? ctx.lineTo(X(q), Y(q)) : ctx.moveTo(X(q), Y(q))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line(stairs, '#7c8ba0', 1.5, [5, 4]);
    line(smooth, C.cyan, 2.5);
    ctx.fillStyle = showR ? C.amber : C.cyan;
    for (const q of showR ? res : smooth) {
      ctx.beginPath();
      ctx.arc(X(q), Y(q), showR ? 3 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const L0 = length(stairs);
    const L = length(smooth);
    $('chCalc').innerHTML =
      `puntos: ${stairs.length} → ${smooth.length} (se duplica en cada pasada)<br>` +
      `longitud: ${L0.toFixed(2)} m → ${L.toFixed(2)} m (<span class="res">${(((L - L0) / L0) * 100).toFixed(1)} %</span>)<br>` +
      `tras remuestrear: ${res.length} puntos a 1 m`;
  };
  ['chN', 'chR'].forEach((id) => $(id).addEventListener('input', draw));
  redraws.push(draw);
  draw();
}

// ---------------------------------------------------------------------------
// 7. Speed controller: stepRover + stepAstro in follow mode
// ---------------------------------------------------------------------------
function simGap(slope: number, sand: number) {
  const dt = 1 / 60;
  const T = 90;
  let sr = 0;
  let sa = 0;
  let vr = 0;
  let va = 0;
  const out = { vr: [] as number[], va: [] as number[], gap: [] as number[], target: [] as number[], sr: [] as number[], dt, T };
  for (let k = 0; k < T / dt; k++) {
    const t = k * dt;
    const gap = sr - sa;
    const target = clamp(va + 0.8 * (15 - gap), 0, 1.7 * (1 - Math.min(slope, 25) / 60));
    vr += (target - vr) * Math.min(1, dt * 2.5);
    sr += vr * dt;
    if (t >= 2.5) {
      let v = (1 - Math.min(slope, 25) / 45) * (1 - sand * 0.25);
      const maxS = Math.max(0, sr - 5);
      if (sa >= maxS - 0.01) v = 0;
      va += (v - va) * Math.min(1, dt * 3);
      sa = Math.min(maxS, sa + Math.max(0, va) * dt);
    }
    out.vr.push(vr);
    out.va.push(va);
    out.gap.push(sr - sa);
    out.target.push(target);
    out.sr.push(sr);
  }
  return out;
}

function initGap() {
  const canvas = $<HTMLCanvasElement>('gapPlot');
  const draw = () => {
    const slope = num('gS');
    const sand = num('gA');
    const t = num('gT');
    $('gSo').textContent = `${slope}°`;
    $('gAo').textContent = sand.toFixed(2);
    $('gTo').textContent = `${t.toFixed(1)} s`;
    const sim = simGap(slope, sand);
    const k = Math.min(sim.vr.length - 2, Math.floor(t / sim.dt));
    const gain = Math.min(1, 2.5 * sim.dt);
    const prev = k > 0 ? sim.vr[k - 1] : 0;
    $('gapCalc').innerHTML =
      `gap = <span class="res">${sim.gap[k].toFixed(2)} m</span> → v<sub>obj</sub> = ${sim.target[k].toFixed(3)} m/s<br>` +
      `v = ${prev.toFixed(3)} + (${sim.target[k].toFixed(3)} − ${prev.toFixed(3)})·${gain.toFixed(4)} = ${sim.vr[k].toFixed(3)} m/s<br>` +
      `s = ${sim.sr[k].toFixed(2)} m (Δt = 1/60 s)<br>` +
      `astronauta: ${sim.va[k].toFixed(3)} m/s`;
    const { ctx, w, h } = prep(canvas);
    const half = (h - 34) / 2;
    chart(ctx, { x: 30, y: 8, w: w - 40, h: half }, [{ data: sim.gap, color: C.amber, label: 'gap (m)' }], 0, 20, { xMax: sim.T, marker: t, bands: [15] });
    chart(
      ctx,
      { x: 30, y: half + 22, w: w - 40, h: half },
      [
        { data: sim.vr, color: C.cyan, label: 'v rover' },
        { data: sim.va, color: '#fff', label: 'v astronauta' },
      ],
      0,
      2,
      { xMax: sim.T, marker: t },
    );
    const tail = sim.gap.slice(-1800);
    const min = Math.min(...tail);
    const max = Math.max(...tail);
    $('gapNote').textContent =
      `Resultado con estos valores: en los últimos 30 s el gap oscila entre ${min.toFixed(2)} y ${max.toFixed(2)} m. ` +
      `El rover copia la velocidad del astronauta y corrige el error restante, así que el error tiende a cero sin oscilar. En subidas fuertes su tope puede quedar por debajo de esa velocidad: ahí el astronauta se acerca hasta que el terreno mejora.`;
  };
  ['gS', 'gA', 'gT'].forEach((id) => $(id).addEventListener('input', draw));
  redraws.push(draw);
  draw();
}

// ---------------------------------------------------------------------------
// 8. Transit mode: 180° turn and lookahead tracking
// ---------------------------------------------------------------------------
const angleDiff = (a: number, b: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

function simTurn(errDeg: number, vmax: number) {
  const dt = 1 / 60;
  const L = 24;
  const dir = (errDeg * Math.PI) / 180;
  const ux = Math.sin(dir);
  const uz = -Math.cos(dir);
  const route = (s: number) => ({ x: ux * clamp(s, 0, L), z: uz * clamp(s, 0, L) });
  let x = 0;
  let z = 0;
  let th = 0;
  let v = 0;
  let sT = 0;
  const out = { xs: [] as number[], zs: [] as number[], ths: [] as number[], err: [] as number[], v: [] as number[], ux, uz, L, dt, arrive: 0, turnEnd: 0 };
  for (let k = 0; k < 40 / dt; k++) {
    let guard = 0;
    while (sT < L && guard++ < 200) {
      const q = route(sT);
      if (Math.hypot(q.x - x, q.z - z) >= 3) break;
      sT += 0.5;
    }
    const look = route(Math.min(L, sT + 2.5));
    const end = route(L);
    const dEnd = Math.hypot(end.x - x, end.z - z);
    const err = angleDiff(th, Math.atan2(look.x - x, -(look.z - z)));
    th += clamp(err * 3, -2.2, 2.2) * dt;
    const align = Math.max(0.06, Math.pow(Math.cos(Math.min(Math.abs(err), Math.PI / 2)), 2));
    const target = vmax * align * Math.min(1, dEnd / 4 + 0.25);
    v += (target - v) * Math.min(1, dt * 3);
    x += Math.sin(th) * v * dt;
    z -= Math.cos(th) * v * dt;
    out.xs.push(x);
    out.zs.push(z);
    out.ths.push(th);
    out.err.push((Math.abs(err) * 180) / Math.PI);
    out.v.push(v);
    if (!out.turnEnd && Math.abs(err) < (10 * Math.PI) / 180) out.turnEnd = k * dt;
    if (dEnd < 1.2) {
      out.arrive = k * dt;
      break;
    }
  }
  return out;
}

function initTurn() {
  const canvas = $<HTMLCanvasElement>('turnCanvas');
  let raf = 0;
  let u = 1;
  const draw = () => {
    const e = num('tE');
    const vmax = num('tV');
    $('tEo').textContent = `${e}°`;
    $('tVo').textContent = `${vmax.toFixed(1)} m/s`;
    const sim = simTurn(e, vmax);
    const n = sim.xs.length;
    const k = Math.min(n - 1, Math.floor(u * (n - 1)));
    const { ctx, w, h } = prep(canvas);
    const mapH = Math.min(h - 104, w * 0.6);
    const xs = [...sim.xs, 0, sim.ux * sim.L];
    const zs = [...sim.zs, 0, sim.uz * sim.L];
    const minX = Math.min(...xs) - 4;
    const maxX = Math.max(...xs) + 4;
    const minZ = Math.min(...zs) - 4;
    const maxZ = Math.max(...zs) + 4;
    const S = Math.min((w - 10) / (maxX - minX), mapH / (maxZ - minZ));
    const ox = (w - (maxX - minX) * S) / 2;
    const X = (v: number) => ox + (v - minX) * S;
    const Z = (v: number) => (v - minZ) * S;
    ctx.strokeStyle = '#55617a';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(X(0), Z(0));
    ctx.lineTo(X(sim.ux * sim.L), Z(sim.uz * sim.L));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i <= k; i += 2) (i ? ctx.lineTo(X(sim.xs[i]), Z(sim.zs[i])) : ctx.moveTo(X(sim.xs[i]), Z(sim.zs[i])));
    ctx.stroke();
    ctx.save();
    ctx.translate(X(sim.xs[k]), Z(sim.zs[k]));
    ctx.rotate(sim.ths[k]);
    ctx.fillStyle = C.amber;
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(7, 8);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(X(sim.ux * sim.L), Z(sim.uz * sim.L), 5, 0, Math.PI * 2);
    ctx.fill();
    const T = (n * sim.dt);
    const yy = mapH + 8;
    const ch = h - yy - 4;
    const half = ch / 2 - 3;
    chart(ctx, { x: 30, y: yy, w: w - 40, h: half }, [{ data: sim.err, color: C.red, label: '|e| (°)' }], 0, 180, { xMax: T, marker: k * sim.dt });
    chart(ctx, { x: 30, y: yy + half + 6, w: w - 40, h: half }, [{ data: sim.v, color: C.cyan, label: 'v (m/s)' }], 0, 4, { xMax: T, marker: k * sim.dt });
    $('turnCalc').innerHTML =
      `t = ${(k * sim.dt).toFixed(2)} s · |e| = ${sim.err[k].toFixed(1)}° · v = ${sim.v[k].toFixed(2)} m/s<br>` +
      `alineado (|e| &lt; 10°) a los <span class="res">${sim.turnEnd.toFixed(2)} s</span><br>` +
      `llega en <span class="res">${sim.arrive ? sim.arrive.toFixed(1) : '> 40'} s</span> para un tramo de ${sim.L} m`;
  };
  $('tPlay').addEventListener('click', () => {
    cancelAnimationFrame(raf);
    if (reducedMotion) {
      u = 1;
      return draw();
    }
    const n = simTurn(num('tE'), num('tV')).xs.length;
    const dur = n / 60 * 1000;
    const t0 = performance.now();
    const tick = (now: number) => {
      u = Math.min(1, (now - t0) / dur);
      draw();
      if (u < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
  ['tE', 'tV'].forEach((id) =>
    $(id).addEventListener('input', () => {
      cancelAnimationFrame(raf);
      u = 1;
      draw();
    }),
  );
  redraws.push(draw);
  draw();
}

// ---------------------------------------------------------------------------
// 10. Consumption calculator (Pandolf on a straight stretch)
// ---------------------------------------------------------------------------
function initMetrics() {
  const update = () => {
    const G = num('mG');
    const dist = num('mS');
    const sand = num('mA');
    $('mGo').textContent = `${G > 0 ? '+' : ''}${G.toFixed(0)} %`;
    $('mSo').textContent = `${dist.toFixed(0)} m`;
    $('mAo').textContent = sand.toFixed(2);
    const eta = 1 + 0.9 * sand;
    const e = edgeO2(dist, G, eta);
    const wh = dist * 0.32 * (1 + Math.max(G, 0) * 0.06 + sand * 1.8);
    $('metaCalc').innerHTML =
      `v = <span class="res">${n1(e.speed, 3)} m/s</span> · M = ${n1(e.watts, 0)} W<br>` +
      `tiempo = ${n1(dist, 0)} / ${n1(e.speed, 3)} = ${n1(e.seconds / 60, 1)} min<br>` +
      `O₂ = ${n1(e.watts, 0)} · ${n1(e.seconds / 60, 1)} · 0,00298 = <span class="res">${n1(e.litres, 2)} L</span> (${n1((e.litres / Q_O2) * 100, 2)} % del tanque)<br>` +
      `kcal = <span class="res">${n1((e.watts * e.seconds) / 4184, 1)}</span> · Wh del rover = <span class="res">${n1(wh, 1)}</span>`;
  };
  ['mG', 'mS', 'mA'].forEach((id) => $(id).addEventListener('input', update));
  update();
}

// ---------------------------------------------------------------------------
// 11. Sun over the day (Mars24 + elevation + ground temperature)
// ---------------------------------------------------------------------------
function initSun() {
  const canvas = $<HTMLCanvasElement>('sunPlot');
  const lat = -4.8253;
  const draw = () => {
    const H = num('sunH');
    $('sunHo').textContent = formatHours(H);
    const sun = sunAt(lat, mars.decl, H, mars.rAU);
    const T = groundTempC(H, lat, mars.decl, mars.rAU);
    const set = sunsetLtst(lat, mars.decl);
    const panel = sun.irradiance * 3.2 * 0.28;
    $('sunCalc').innerHTML =
      `Hoy: L<sub>s</sub> = ${n1(mars.ls, 1)}° · δ = ${n1(mars.decl, 2)}° · r = ${n1(mars.rAU, 3)} UA<br>` +
      `elevación = <span class="res">${n1(sun.elevation, 1)}°</span> · acimut ${n1(sun.azimuth, 0)}°<br>` +
      `irradiancia = ${n1(sun.irradiance, 0)} W/m² → panel del rover ${n1(panel, 0)} W<br>` +
      `suelo = <span class="res">${n1(T, 0)} °C</span> · atardecer ${formatHours(set)}` +
      (sun.elevation > 0 && sun.elevation < 15 ? '<br>Sol bajo: caminar hacia él cuesta ×1,25 (encandilamiento)' : '');
    const { ctx, w, h } = prep(canvas);
    const m = { l: 38, r: 38, t: 12, b: 28 };
    const pw = w - m.l - m.r;
    const ph = h - m.t - m.b;
    const X = (t: number) => m.l + ((t - 5) / 14) * pw;
    const Ye = (e: number) => m.t + ph - (clamp(e, -10, 90) + 10) / 100 * ph;
    const Yt = (c: number) => m.t + ph - (clamp(c, -90, 20) + 90) / 110 * ph;
    ctx.strokeStyle = C.line;
    ctx.strokeRect(m.l, m.t, pw, ph);
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'center';
    for (const t of [6, 9, 12, 15, 18]) ctx.fillText(`${t}:00`, X(t), h - 10);
    ctx.textAlign = 'right';
    for (const e of [0, 45, 90]) ctx.fillText(`${e}°`, m.l - 5, Ye(e) + 4);
    ctx.textAlign = 'left';
    for (const c of [-80, -40, 0]) ctx.fillText(`${c}`, w - m.r + 4, Yt(c) + 4);
    ctx.strokeStyle = '#3a4a5e';
    ctx.beginPath();
    ctx.moveTo(m.l, Ye(0));
    ctx.lineTo(w - m.r, Ye(0));
    ctx.stroke();
    const line = (f: (t: number) => number, col: string) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let t = 5; t <= 19; t += 0.1) {
        const y = f(t);
        if (t === 5) ctx.moveTo(X(t), y);
        else ctx.lineTo(X(t), y);
      }
      ctx.stroke();
    };
    line((t) => Ye(sunAt(lat, mars.decl, t, mars.rAU).elevation), C.amber);
    line((t) => Yt(groundTempC(t, lat, mars.decl, mars.rAU)), C.cyan);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(X(H), Ye(sun.elevation), 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.amber;
    ctx.fillText('elevación del Sol', m.l + 6, m.t + 14);
    ctx.fillStyle = C.cyan;
    ctx.fillText('suelo °C', m.l + 6, m.t + 28);
  };
  $('sunH').addEventListener('input', draw);
  redraws.push(draw);
  draw();
}

// ---------------------------------------------------------------------------
// 12. Point-of-no-return rule
// ---------------------------------------------------------------------------
function initAbort() {
  const update = () => {
    const Q = num('abQ');
    const R = num('abR');
    $('abQo').textContent = `${Q.toFixed(0)} L`;
    $('abRo').textContent = `${R.toFixed(1)} L`;
    const need = (1 + RHO) * R;
    const ok = Q >= need;
    $('abCalc').innerHTML =
      `(1 + ρ)·R(p) = 1,15 · ${n1(R, 1)} = ${n1(need, 1)} L<br>` +
      `O₂ = ${n1(Q, 0)} L ${ok ? '≥' : '<'} ${n1(need, 1)} L → <span class="res" style="color:${ok ? C.green : C.red}">${ok ? 'seguir con la misión' : 'ABORTAR: volver por la ruta de menor O₂'}</span><br>` +
      `margen: ${n1(Q - need, 1)} L ≈ ${n1((Q - need) / (121 * 0.00298), 0)} min parado`;
  };
  ['abQ', 'abR'].forEach((id) => $(id).addEventListener('input', update));
  update();
}

// ---------------------------------------------------------------------------
// 13. Science tour on the current real map
// ---------------------------------------------------------------------------
function runTour() {
  const plan = solveTour(SITES, {
    start: BASE_A,
    home: BASE_A,
    o2Litres: Q_O2,
    ltst: 8,
    massKg: 0,
    mineralCounts: {},
    sunsetLtst: sunsetLtst(real.lat, mars.decl),
  });
  $('tourStatus').textContent = `${plan.nodesExplored} nodos de ramificación y poda en ${plan.computeMs.toFixed(0)} ms`;
  $('tourTable').innerHTML =
    '<thead><tr><th>#</th><th>Sitio</th><th>Mineral</th><th>Llega</th><th>Espera</th><th>Sale</th><th>Valor S·ψ</th><th>O₂ al salir</th></tr></thead><tbody>' +
    plan.stops
      .map(
        (st, i) =>
          `<tr><td>${i + 1}</td><td>${st.site.code} · ${st.site.name}</td><td>${st.site.mineral}</td><td>${formatHours(st.arrive)}</td><td>${n1(st.wait, 0)} min</td><td>${formatHours(st.leave)}</td><td>${n1(st.gain, 2)}</td><td>${n1(st.o2After, 0)} L</td></tr>`,
      )
      .join('') +
    `<tr><td></td><td>Hábitat</td><td></td><td>${formatHours(plan.homeLtst)}</td><td></td><td></td><td>Z = ${n1(plan.z, 2)}</td><td>${n1(plan.o2Home, 0)} L</td></tr></tbody>`;
  const skipped = SITES.filter((x) => !plan.order.includes(x));
  $('tourNote').textContent =
    `Fuera del tour: ${skipped.map((x) => `${x.code} (${x.name})`).join(', ') || 'ninguno'}. ` +
    'La bolsa de 4 kg y el O₂ obligan a elegir; la escarcha (F) sólo se puede tomar temprano, antes de que el Sol la sublime. Abajo, la matriz D(i, j) en litros: no es simétrica.';
  const M = plan.matrix;
  $('tourMatrix').innerHTML =
    `<thead><tr><th>D (L)</th>${M.labels.slice(0, -1).map((l) => `<th>${l}</th>`).join('')}<th>R (casa)</th></tr></thead><tbody>` +
    M.litres.map((row, i) => `<tr><td>${M.labels[i]}</td>${row.map((v2) => `<td>${n1(v2, 2)}</td>`).join('')}</tr>`).join('') +
    '</tbody>';
}

function initTour() {
  $('tourRun').addEventListener('click', runTour);
}

// Spanish decimal comma for every computed value, without touching attributes.
const DECIMAL = /(\d)\.(\d)/g;
const localize = (root: Node) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t.parentElement?.closest('code')) continue;
    if (t.nodeValue && DECIMAL.test(t.nodeValue)) t.nodeValue = t.nodeValue.replace(DECIMAL, '$1,$2');
    DECIMAL.lastIndex = 0;
  }
};
new MutationObserver((records) => records.forEach((r) => localize(r.target))).observe(document.querySelector('main')!, {
  childList: true,
  characterData: true,
  subtree: true,
});

initSlope();
initCost();
initEdge();
initGrid();
initReal();
initChaikin();
initGap();
initTurn();
initMetrics();
initSun();
initAbort();
initTour();

let resizeTimer = 0;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => redraws.forEach((f) => f()), 120);
});
document.fonts?.ready.then(() => redraws.forEach((f) => f()));

// Opened from disk: the simulator needs the dev server, so link to it instead.
if (location.protocol === 'file:') {
  const back = document.querySelector<HTMLAnchorElement>('.back');
  if (back) {
    back.href = 'http://localhost:5173/';
    back.textContent = '← Ir al simulador (requiere npm run dev)';
  }
}
