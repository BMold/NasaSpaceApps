// The Martian scene both devices render: unchanged sky, light and terrain,
// landmarks, hazards, the route ribbon and the backpack drone.
import { useEffect, useRef } from 'react';
import { Suspense } from 'react';
import { Atmosphere, Lights } from '../components/canvas/Environment';
import { Terrain } from '../components/canvas/Terrain';
import { Landmarks } from '../components/canvas/Landmarks';
import { HazardVisuals } from '../components/canvas/HazardVisuals';
import { ProjectedPath } from '../components/canvas/ProjectedPath';
import { ScoutDrone } from '../components/canvas/ScoutDrone';
import { useMarsTrek } from '../hooks/useMarsTrek';
import { useSimStore } from '../store/useSimStore';
import { initVR } from './vrEngine';
import { ReturnBarrier } from '../hud';
import { MissionHazards } from '../mission/MissionHazards';
import { Anomalies } from '../jarvis/Anomalies';

export function SharedWorld() {
  return (
    <>
      <Atmosphere />
      <Lights />
      <Suspense fallback={null}>
        <Terrain />
        <Landmarks />
        <HazardVisuals />
        <ProjectedPath />
        <ReturnBarrier />
        <MissionHazards />
        <Anomalies />
        <ScoutDrone />
      </Suspense>
    </>
  );
}

/**
 * Loads the Mars Trek site (the same deterministic terrain on both devices) and
 * starts the VR engine each time the terrain is ready.
 */
export function useVRBoot() {
  useMarsTrek();
  const status = useSimStore((s) => s.trekStatus);
  const terrainVersion = useSimStore((s) => s.terrainVersion);
  const booted = useRef(-1);
  useEffect(() => {
    if (status === 'loading' || terrainVersion === booted.current || terrainVersion === 0) return;
    booted.current = terrainVersion;
    initVR();
  }, [status, terrainVersion]);
  return status;
}
