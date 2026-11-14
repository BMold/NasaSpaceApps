// VR mode engine. The astronaut is driven by hand from the laptop; the route
// is A* from wherever the astronaut stands to the current goal; the scout drone
// lives on the suit's backpack. The rover no longer exists.
//
// Reuses the shared runtime `rt` (read by the unchanged terrain, sky, route
// ribbon and drone components) but never runs the old rover simulation.
import { cellOf, computeCostmap, costGrid } from '../lib/costmap';
import { updateCostTexture, revealCircle } from '../lib/gpuMaps';
import { planAStar } from '../lib/pathfinding';
import { BASE_A, CANYON, HALF, ROCKS, heightAt, sandAt, type XZ } from '../lib/terrain';
import { REAL } from '../lib/realTerrain';
import { walkSpeed } from '../lib/energy';
import { SITES } from '../lib/sites';
import { makeRoute, rt } from '../store/simEngine';
import { useSimStore } from '../store/useSimStore';
import { sunAt } from '../lib/marsTime';
import { suitState } from './suit/state';

export const EYE_HEIGHT = 1.7;
export const DEVIATION_M = 3.5; // off the polyline by more than this → re-plan
export const GOAL_RADIUS = 4;

export interface Goal {
  code: string; // site code, or 'A' for the habitat
  x: number;
  z: number;
}

export const vr = {
  ready: false,
  x: BASE_A.x,
  z: BASE_A.z,
  heading: 0, // body yaw (rad), 0 = north (−z), clockwise
  moveYaw: 0, // direction of travel
  yawVel: 0, // how fast the body is turning (rad/s)
  turning: false, // turning on the spot to follow the head
  speed: 0,
  goals: [] as Goal[],
  goalIdx: 0,
  routeId: 0,
  routeLitres: 0,
  lastDeviation: 0,
  recalcs: 0,
  lastRecalcReason: '',
  message: '',
};

const S = () => useSimStore.getState();
const bumpRoute = () => useSimStore.setState((s) => ({ routeVersion: s.routeVersion + 1 }));

/** Called once the terrain and the tour are ready (after initSimulation). */
export function initVR() {
  const tour = S().tour;
  vr.goals = (tour?.stops ?? []).map((s) => {
    const site = SITES.find((x) => x.code === s.code)!;
    return { code: s.code, x: site.x, z: site.z };
  });
  vr.goals.push({ code: 'A', x: BASE_A.x, z: BASE_A.z });
  vr.goalIdx = 0;
  vr.x = BASE_A.x;
  vr.z = BASE_A.z;
  vr.heading = Math.PI * 0.75;
  // No rover, no alternative planner overlay, no transit leg.
  rt.ghost = [];
  rt.transit = null;
  rt.stops = [];
  rt.drone.state = 'docked';
  syncRuntime();
  useSimStore.setState({ cameraMode: 'astronaut' });
  vr.ready = true;
  recalculateRoute('inicio');
}

export const currentGoal = (): Goal | null => vr.goals[vr.goalIdx] ?? null;

/** Write the hand-driven pose into the shared runtime read by the 3D components. */
function syncRuntime() {
  const a = rt.astro;
  a.x = vr.x;
  a.z = vr.z;
  a.y = heightAt(vr.x, vr.z);
  a.heading = vr.heading;
  a.speed = vr.speed;
  a.moving = vr.speed > 0.15;
  a.mode = 'walk';
  // The sun light frames its shadow map on (rover + astronaut) / 2.
  rt.rover.x = vr.x;
  rt.rover.z = vr.z;
}

/**
 * A* from the astronaut's current position to the active goal. The ribbon on
 * the ground is rebuilt from here, so it always starts under the crew's feet.
 */
export function recalculateRoute(reason: string) {
  const goal = currentGoal();
  if (!goal) return;
  const t0 = performance.now();
  const res = planAStar({ x: vr.x, z: vr.z }, goal);
  rt.route = makeRoute(res.points);
  rt.sAstro = 0;
  vr.routeId++;
  vr.recalcs++;
  vr.routeLitres = res.litres;
  vr.lastRecalcReason = reason;
  vr.message = res.ok
    ? `Ruta ${reason}: ${rt.route.len.toFixed(0)} m, ${res.litres.toFixed(1)} L de O₂, A* ${res.expanded} nodos en ${(performance.now() - t0).toFixed(1)} ms`
    : 'SIN RUTA SEGURA hacia el objetivo';
  bumpRoute();
  onWorldChange?.();
}

/** Hook for the networking layer (the laptop pushes the world to the phone). */
export let onWorldChange: (() => void) | null = null;
export const setWorldListener = (fn: (() => void) | null) => {
  onWorldChange = fn;
};

const walkable = (x: number, z: number) => Number.isFinite(costGrid.cost[cellOf({ x, z })]);

/**
 * Move the astronaut from keyboard input, relative to the view yaw.
 * fwd / strafe ∈ [−1, 1]. Speed follows the Pandolf walking speed on the
 * local slope; impassable cells (rocks, > 30° slopes) stop the step.
 */
/** speed (m/s on flat ground) overrides the walking pace; slopes and sand slow it down to half at most. */
export function moveAstronaut(fwd: number, strafe: number, viewYaw: number, run: boolean, dt: number, speed?: number) {
  const len = Math.hypot(fwd, strafe);
  if (len < 1e-3) {
    vr.speed *= 0.8;
    syncRuntime();
    return;
  }
  const f = fwd / len;
  const s = strafe / len;
  // World frame: +x east, −z north. Yaw 0 looks north.
  const dirX = Math.sin(viewYaw) * f + Math.cos(viewYaw) * s;
  const dirZ = -Math.cos(viewYaw) * f + Math.sin(viewYaw) * s;
  const probe = 1.2;
  const G = (100 * (heightAt(vr.x + dirX * probe, vr.z + dirZ * probe) - heightAt(vr.x, vr.z))) / probe;
  const pace = walkSpeed(G, 1 + 0.9 * sandAt(vr.x, vr.z));
  // Speed chosen on the laptop: terrain may slow it, but never below half (it must stay brisk).
  const v = speed !== undefined ? speed * Math.max(0.5, pace / walkSpeed(0, 1)) : pace * (run ? 2.2 : 1.4);
  const step = v * dt;
  let nx = vr.x + dirX * step;
  let nz = vr.z + dirZ * step;
  // Slide along obstacles instead of stopping dead.
  if (!walkable(nx, nz)) {
    if (walkable(nx, vr.z)) nz = vr.z;
    else if (walkable(vr.x, nz)) nx = vr.x;
    else {
      nx = vr.x;
      nz = vr.z;
    }
  }
  // Boulders are solid: slide around them instead of walking through (the route only marks them as slow).
  for (let pass = 0; pass < 2; pass++)
    for (const r of ROCKS) {
      const reach = r.s * 0.95 + 0.26; // the rock plus half the width of a suited astronaut
      const dx = nx - r.x;
      const dz = nz - r.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= reach * reach) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-4) {
        nx = r.x - dirZ * reach;
        nz = r.z + dirX * reach;
      } else {
        nx = r.x + (dx / d) * reach;
        nz = r.z + (dz / d) * reach;
      }
    }
  const lim = HALF - 12; // the costmap marks the last 12 m of the tile as outside the site
  nx = Math.max(-lim, Math.min(lim, nx));
  nz = Math.max(-lim, Math.min(lim, nz));
  // Speed is what was actually covered: pressed against a rock, the stride shortens with it.
  vr.speed = Math.hypot(nx - vr.x, nz - vr.z) / dt;
  vr.x = nx;
  vr.z = nz;
  vr.moveYaw = Math.atan2(dirX, -dirZ);
  syncRuntime();
  checkGoal();
}

function checkGoal() {
  const g = currentGoal();
  if (!g) return;
  if (Math.hypot(g.x - vr.x, g.z - vr.z) > GOAL_RADIUS) return;
  const tour = S().tour;
  if (tour) useSimStore.setState({ tour: { ...tour, stops: tour.stops.map((s) => (s.code === g.code ? { ...s, done: true } : s)) } });
  vr.goalIdx++;
  const next = currentGoal();
  if (next) recalculateRoute(`hacia ${next.code === 'A' ? 'el hábitat' : next.code}`);
  else {
    rt.route = makeRoute([{ x: vr.x, z: vr.z }]);
    vr.message = 'EVA completa: tripulación en el hábitat';
    bumpRoute();
    onWorldChange?.();
  }
}

/** Skip to the next goal (laptop key N). */
export function nextGoal() {
  if (vr.goalIdx < vr.goals.length - 1) {
    vr.goalIdx++;
    recalculateRoute('objetivo siguiente');
  }
}

// ---------------------------------------------------------------------------
// Body orientation: the head turns first, the body follows
// ---------------------------------------------------------------------------
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** The neck and the helmet let the head turn about this far; past it the whole astronaut turns. */
export const HEAD_LIMIT = (55 * Math.PI) / 180;
const HEAD_SETTLE = (12 * Math.PI) / 180; // …and keeps turning until the head is this close to straight ahead
const TURN_RATE = 1.35; // rad/s on the spot (shuffling the feet in a pressurised suit)
const WALK_TURN_RATE = 3.6; // rad/s while walking

/**
 * Turn the body towards where the head looks, the way a person does:
 *  • standing: nothing happens while you look around within ±55°; beyond that the
 *    astronaut turns on the spot until the head is centred again;
 *  • walking: the body faces the direction of travel (backwards and sideways steps keep facing the view).
 * lookYaw: world yaw of the head (clockwise from north).
 */
export function updateBody(lookYaw: number, dt: number) {
  const rel = wrapAngle(lookYaw - vr.heading);
  let target: number | null = null;
  let rate = TURN_RATE;
  if (vr.speed > 0.2) {
    const off = Math.abs(wrapAngle(vr.moveYaw - lookYaw));
    target = off < 1.05 ? vr.moveYaw : off > 2.1 ? vr.moveYaw + Math.PI : lookYaw;
    rate = WALK_TURN_RATE;
    vr.turning = false;
  } else {
    if (Math.abs(rel) > HEAD_LIMIT) vr.turning = true;
    else if (Math.abs(rel) < HEAD_SETTLE) vr.turning = false;
    if (vr.turning) target = lookYaw;
  }
  const err = target === null ? 0 : wrapAngle(target - vr.heading);
  const want = Math.max(-rate, Math.min(rate, err * 4.5));
  vr.yawVel += (want - vr.yawVel) * (1 - Math.exp(-dt * 9)); // ease in and out: no snapping
  vr.heading = wrapAngle(vr.heading + vr.yawVel * dt);
  syncRuntime();
}

/** Local true solar time of the scene (hours): moves the Sun, the shadows and the sky. */
export function setSolarTime(ltst: number) {
  rt.startLtst = ltst;
  rt.sun = sunAt(rt.lat, rt.mars.decl, ltst, rt.mars.rAU);
}

// ---------------------------------------------------------------------------
// Scout drone docked on the backpack
// ---------------------------------------------------------------------------
const BACK_OFFSET = 0.205; // metres behind the spine (cradle on top of the life-support pack)
const BACK_HEIGHT = 1.57;
const SCAN_SECONDS = 5.5;

/** World position of the drone dock on the suit's backpack. */
export function backpackAnchor(out: { x: number; y: number; z: number }) {
  if (suitState.dockValid) {
    // The animated suit knows exactly where its cradle is (lean, bob and all).
    out.x = suitState.dockPos.x;
    out.y = suitState.dockPos.y;
    out.z = suitState.dockPos.z;
    return out;
  }
  out.x = vr.x - Math.sin(vr.heading) * BACK_OFFSET;
  out.z = vr.z + Math.cos(vr.heading) * BACK_OFFSET;
  out.y = heightAt(vr.x, vr.z) + BACK_HEIGHT;
  return out;
}

const anchor = { x: 0, y: 0, z: 0 };
let droneTarget: XZ = { ...CANYON };

/** DEPLOY DRONE: lift off the backpack, fly to the area, scan, update the costmap, dock again. */
export function deployDrone(target?: XZ) {
  const d = rt.drone;
  if (d.state !== 'docked') return false;
  // Real window: no canyon; the drone surveys the next goal.
  const g = currentGoal();
  target ??= REAL && g ? { x: g.x, z: g.z } : CANYON;
  droneTarget = { ...target };
  d.t = 0;
  d.state = 'launch';
  useSimStore.setState({ droneState: 'launch' });
  vr.message = `Dron despegando de la mochila → ${Math.hypot(target.x - vr.x, target.z - vr.z).toFixed(0)} m`;
  return true;
}

function setDrone(state: typeof rt.drone.state) {
  rt.drone.state = state;
  rt.drone.t = 0;
  useSimStore.setState({ droneState: state });
}

function flyToward(tx: number, tz: number, speed: number, alt: number, dt: number) {
  const d = rt.drone;
  const dx = tx - d.x;
  const dz = tz - d.z;
  const dd = Math.hypot(dx, dz);
  const k = Math.min(dd, speed * dt);
  if (dd > 1e-3) {
    d.x += (dx / dd) * k;
    d.z += (dz / dd) * k;
    d.heading = Math.atan2(dx, -dz);
  }
  d.y += (heightAt(d.x, d.z) + alt - d.y) * Math.min(1, dt * 2);
  return dd;
}

export function stepDrone(dt: number) {
  const d = rt.drone;
  backpackAnchor(anchor);
  d.t += dt;
  switch (d.state) {
    case 'docked':
      d.x = anchor.x;
      d.y = anchor.y;
      d.z = anchor.z;
      d.heading = vr.heading;
      d.rotor = Math.max(0, d.rotor - dt * 2);
      break;
    case 'launch': {
      // Blades unfold and spin up on the cradle (1.2 s), then it climbs straight up off the backpack.
      d.rotor = Math.min(1, d.rotor + dt * 1.1);
      const climb = Math.min(1, Math.max(0, (d.t - 1.2) / 1.9));
      d.x = anchor.x;
      d.z = anchor.z;
      d.y = anchor.y + climb * climb * (3 - 2 * climb) * 6;
      d.heading = vr.heading;
      if (d.t >= 3.1) setDrone('outbound');
      break;
    }
    case 'outbound':
      if (flyToward(droneTarget.x, droneTarget.z, 11, 16, dt) < 0.8) {
        d.ox = d.x;
        d.oz = d.z;
        setDrone('scan');
        vr.message = 'Dron: barrido LIDAR del área…';
      }
      break;
    case 'scan':
      d.scanProgress = Math.min(1, d.t / SCAN_SECONDS);
      d.heading += dt * 0.7;
      flyToward(d.ox, d.oz, 2, 16, dt);
      if (d.t >= SCAN_SECONDS) {
        completeScan();
        setDrone('return');
      }
      break;
    case 'return': {
      const dh = Math.hypot(anchor.x - d.x, anchor.z - d.z);
      if (dh > 1.5) flyToward(anchor.x, anchor.z, 13, 10, dt);
      else {
        // Final approach: match the walking astronaut and settle on the dock.
        d.x += (anchor.x - d.x) * Math.min(1, dt * 6);
        d.z += (anchor.z - d.z) * Math.min(1, dt * 6);
        d.y += (anchor.y - d.y) * Math.min(1, dt * 3);
        if (dh < 0.15 && Math.abs(d.y - anchor.y) < 0.12) {
          setDrone('docked');
          vr.message = 'Dron acoplado a la mochila.';
        }
      }
      break;
    }
  }
  if (d.state !== 'scan') d.scanProgress = 0;
}

/** The scan maps the area: the canyon stops being "uncharted" and the route is re-planned. */
function completeScan() {
  const d = rt.drone;
  revealCircle(d.x, d.z, 38);
  const st = S();
  const canyon = Math.hypot(d.x - CANYON.x, d.z - CANYON.z) < 30;
  if (canyon && !st.canyonScanned) useSimStore.setState({ canyonScanned: true });
  computeCostmap(st.hazards, S().canyonScanned, rt.sun);
  updateCostTexture();
  useSimStore.setState((s) => ({ costVersion: s.costVersion + 1 }));
  recalculateRoute(canyon ? 'con el cañón mapeado' : 'tras el escaneo');
}

/** Phone side: apply the scanned flag received from the laptop. */
export function applyCanyonScanned(scanned: boolean) {
  if (scanned === S().canyonScanned) return;
  useSimStore.setState({ canyonScanned: scanned });
  computeCostmap(S().hazards, scanned, rt.sun);
  updateCostTexture();
}

/** Phone side: replace the route polyline with the one planned on the laptop. */
export function applyRoute(points: [number, number][]) {
  rt.route = makeRoute(points.map(([x, z]) => ({ x, z })));
  rt.sAstro = 0;
  bumpRoute();
}

/** Phone side: place the astronaut where the laptop says. */
export function applyPose(x: number, z: number, heading: number) {
  vr.x = x;
  vr.z = z;
  vr.heading = heading;
  syncRuntime();
}
