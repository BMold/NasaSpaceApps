// The astronaut: a procedurally built EVA suit (vr/suit/build.ts) animated by
// a small physics-aware rig (vr/suit/rig.ts). It is drawn on both devices:
// in third person you see the whole figure; in first person the helmet is
// hidden, so looking down shows your own chest unit, arms, legs and boots —
// and your shadow on the ground, helmet included.
//
// ► Your own model: put a glTF at public/models/traje-ligero.glb (metres,
//   feet at y = 0, facing +Z) and it replaces the built-in suit in the
//   third-person view. It follows the body but, having no known skeleton,
//   it is not animated.
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { rt } from '../store/simEngine';
import { SuitRig } from './suit/rig';
import { SuitFx, type SuitFxHandle } from './suit/SuitFx';
import { suitState } from './suit/state';

export const SUIT_GLB_URL = '/models/traje-ligero.glb';

function GlbSuit() {
  const { scene } = useGLTF(SUIT_GLB_URL);
  const root = useRef<THREE.Group>(null);
  useEffect(() => {
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }, [scene]);
  useFrame(() => {
    const g = root.current;
    if (!g) return;
    g.position.set(rt.astro.x, rt.astro.y, rt.astro.z);
    g.rotation.y = Math.PI - rt.astro.heading;
  });
  return (
    <group ref={root}>
      <primitive object={scene} />
    </group>
  );
}

class GlbBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Is there a real glTF at SUIT_GLB_URL? (dev servers answer HTML for missing files) */
function useHasGlb() {
  const [has, setHas] = useState(false);
  useEffect(() => {
    fetch(SUIT_GLB_URL, { method: 'HEAD' })
      .then((r) => {
        const type = r.headers.get('content-type') ?? '';
        setHas(r.ok && !type.includes('text/html'));
      })
      .catch(() => setHas(false));
  }, []);
  return has;
}

/**
 * firstPerson: the camera is inside the helmet (helmet hidden, shadow kept).
 * The rig runs before the cameras are placed (priority −1), after the body has moved (priority −2).
 */
export function SuitModel({ firstPerson }: { firstPerson: boolean }) {
  const rig = useMemo(() => new SuitRig(), []);
  const fx = useRef<SuitFxHandle>(null);
  const hasGlb = useHasGlb();
  const useGlb = hasGlb && !firstPerson;

  useEffect(() => {
    rig.onStep = (e) => fx.current?.step(e);
    return () => {
      rig.onStep = null;
      suitState.dockValid = false;
    };
  }, [rig]);

  useFrame((_, dt) => {
    rig.update(dt, { x: rt.astro.x, z: rt.astro.z, bodyYaw: rt.astro.heading, headYaw: suitState.lookYaw, headPitch: suitState.lookPitch, firstPerson });
    suitState.dockPos.copy(rig.dockPos);
    suitState.dockQuat.copy(rig.dockQuat);
    suitState.dockValid = true;
    suitState.neck.copy(rig.neck);
    suitState.speed = rig.speed;
    suitState.debug = rig.debug;
    rig.root.visible = !useGlb;
  }, -1);

  return (
    <>
      <primitive object={rig.root} />
      <SuitFx ref={fx} />
      {useGlb && (
        <GlbBoundary fallback={null}>
          <Suspense fallback={null}>
            <GlbSuit />
          </Suspense>
        </GlbBoundary>
      )}
    </>
  );
}
