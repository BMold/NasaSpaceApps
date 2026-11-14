// Laptop, mission mode: every frame, turn the mission state (messages) into the
// scene the VR engine already knows how to draw and stream to the phone.
//   position  ← interpolated telemetry track      (setMissionPose)
//   route     ← plan.polilinea, or the escape after abortar (setMissionRoute)
//   sun       ← telemetria.hora_solar (Mars24 sun of the scene)
//   suit HUD  ← estado_aborto + telemetria (bioFromMission)
//   sites, hazards, notices → missionView (pushed to the phone on change)
import { enuToScene } from '../lib/realTerrain';
import { rt } from '../store/simEngine';
import { useSimStore } from '../store/useSimStore';
import { bioFromMission } from '../hud/bio';
import { onWorldChange, setMissionPose, setMissionRoute, setSolarTime, vr } from '../vr/vrEngine';
import { projectOnRoute } from '../vr/useDynamicRoute';
import { mission, positionAt, refreshMissionView, toScene } from './mission';
import { liveClock, player, stepReplay } from './sources';

const applied = { plan: -1, terrain: -1, routeId: -1 };
let viewClock = 0;

/** Simulated time being displayed. */
export const displayTime = () => (mission.modo === 'mision' ? player.clock : liveClock());

export function stepMission(dtReal: number) {
  if (mission.modo === 'mision') stepReplay(dtReal);
  const t = displayTime();

  // Position and heading from the telemetry track.
  const p = positionAt(t);
  if (p) {
    const s = enuToScene(p.x, p.y);
    const v = Math.hypot(p.dx, p.dy); // m per simulated second: the suit walks at this pace
    // ENU (east, north) → yaw clockwise from north.
    setMissionPose(s.x, s.z, Math.min(1.6, v), Math.atan2(p.dx, p.dy));
  }

  // Route: the plan's polyline; after an abort, the escape route.
  const terrainVersion = useSimStore.getState().terrainVersion;
  // Anything else that redraws the route (initVR, the R key) is undone: the optimizer's plan wins.
  if (mission.planVersion !== applied.plan || terrainVersion !== applied.terrain || vr.routeId !== applied.routeId) {
    const pts = mission.abortado && mission.escape ? mission.escape : (mission.plan?.polilinea ?? []);
    const label = mission.abortado
      ? `Escape al hábitat (${mission.abortado.motivo})`
      : mission.plan
        ? `Plan ${mission.plan.plan_id}: ${mission.plan.paradas.length} paradas, ${mission.plan.O2_total_L.toFixed(1)} L de O₂ (optimizador)`
        : 'Esperando el plan del optimizador';
    setMissionRoute(
      toScene(pts).map((q) => ({ x: q.x, z: q.z })),
      mission.plan?.O2_total_L ?? 0,
      label,
    );
    applied.plan = mission.planVersion;
    applied.terrain = terrainVersion;
    applied.routeId = vr.routeId;
    const mode = mission.abortado ? 'abort' : 'nominal';
    if (useSimStore.getState().missionMode !== mode) useSimStore.setState({ missionMode: mode });
  }
  // The walked part of the ribbon dims behind the astronaut.
  if (rt.route.n > 1) rt.sAstro = Math.max(rt.sAstro, projectOnRoute(vr.x, vr.z).s);

  // Sun from the telemetry's local solar time.
  if (Number.isFinite(mission.horaSolar) && Math.abs(mission.horaSolar - rt.sun.ltst) > 0.004) setSolarTime(mission.horaSolar);

  bioFromMission(mission, dtReal);

  // Sites, hazards and notices for both devices (4 Hz is plenty).
  viewClock += dtReal;
  if (viewClock > 0.25) {
    viewClock = 0;
    if (refreshMissionView()) onWorldChange?.();
  }
}
