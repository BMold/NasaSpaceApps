// Route drawn on the ground as a faint survey line + ghost path of the other planner.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { useSimStore } from '../../store/useSimStore';
import { rt, type Route } from '../../store/simEngine';
import { heightAt } from '../../lib/terrain';
import { UNLIT } from '../../render/unlit';

const vert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const frag = /* glsl */ `
uniform float uTime; uniform vec3 uColor; uniform float uProgress; uniform float uOpacity;
varying vec2 vUv;
void main() {
  float across = abs(vUv.y - 0.5) * 2.0;
  // A projected guide line (helmet display), not paint: soft edges, a brighter rim, dashes every 2 m.
  float body = 1.0 - smoothstep(0.35, 1.0, across);
  float rim = smoothstep(0.55, 0.8, across) * (1.0 - smoothstep(0.8, 1.0, across));
  float dash = smoothstep(0.30, 0.36, fract(vUv.x * 0.5)) * (1.0 - smoothstep(0.94, 1.0, fract(vUv.x * 0.5)));
  float behind = step(vUv.x, uProgress);
  float a = (body * (0.10 + 0.20 * dash) + rim * 0.30) * mix(1.0, 0.22, behind) * uOpacity;
  gl_FragColor = vec4(uColor * ${UNLIT.toFixed(3)} * 1.5, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function buildRibbon(route: Route, width: number, lift: number): THREE.BufferGeometry {
  const step = 0.8;
  const n = Math.max(2, Math.floor(route.len / step) + 1);
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  const p = { x: 0, z: 0 };
  const q = { x: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    const s = Math.min(route.len, i * step);
    sampleAt(route, s, p);
    sampleAt(route, Math.min(route.len, s + 0.5), q);
    let tx = q.x - p.x;
    let tz = q.z - p.z;
    if (Math.abs(tx) + Math.abs(tz) < 1e-5) {
      sampleAt(route, Math.max(0, s - 0.5), q);
      tx = p.x - q.x;
      tz = p.z - q.z;
    }
    const l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l;
    const nz = tx / l;
    const lx = p.x + nx * width * 0.5;
    const lz = p.z + nz * width * 0.5;
    const rx = p.x - nx * width * 0.5;
    const rz = p.z - nz * width * 0.5;
    pos.set([lx, heightAt(lx, lz) + lift, lz, rx, heightAt(rx, rz) + lift, rz], i * 6);
    uv.set([s, 0, s, 1], i * 4);
    if (i < n - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function sampleAt(r: Route, s: number, out: { x: number; z: number }) {
  if (r.n < 2) {
    out.x = r.xs[0] ?? 0;
    out.z = r.zs[0] ?? 0;
    return;
  }
  let i = 0;
  while (i < r.n - 2 && r.cum[i + 1] < s) i++;
  const seg = r.cum[i + 1] - r.cum[i] || 1;
  const t = Math.min(1, Math.max(0, (s - r.cum[i]) / seg));
  out.x = r.xs[i] + (r.xs[i + 1] - r.xs[i]) * t;
  out.z = r.zs[i] + (r.zs[i + 1] - r.zs[i]) * t;
}

function Ribbon({ kind }: { kind: 'main' | 'transit' }) {
  const routeVersion = useSimStore((s) => s.routeVersion);
  const terrainVersion = useSimStore((s) => s.terrainVersion);
  const missionMode = useSimStore((s) => s.missionMode);
  const route = kind === 'main' ? rt.route : rt.transit;
  const geometry = useMemo(
    () => (route && route.n > 1 ? buildRibbon(route, kind === 'main' ? 0.42 : 0.34, 0.05) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeVersion, terrainVersion, kind],
  );
  useEffect(() => () => geometry?.dispose(), [geometry]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new THREE.Color('#bfe9ff') },
          uProgress: { value: 0 },
          uOpacity: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
    [],
  );

  const color = kind === 'transit' ? '#ff8a5c' : missionMode === 'abort' || missionMode === 'medevac' ? '#ffd28a' : missionMode === 'shelter' ? '#ffb070' : '#bfe9ff';
  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime * (kind === 'transit' ? 2.2 : 1);
    material.uniforms.uProgress.value = kind === 'main' ? rt.sAstro : 0;
    material.uniforms.uOpacity.value = kind === 'main' && missionMode === 'rescue' ? 0.35 : 1;
    (material.uniforms.uColor.value as THREE.Color).set(color);
  });

  if (!geometry) return null;
  return <mesh geometry={geometry} material={material} renderOrder={5} frustumCulled={false} />;
}

function GhostPath() {
  const routeVersion = useSimStore((s) => s.routeVersion);
  const algorithm = useSimStore((s) => s.algorithm);
  const missionMode = useSimStore((s) => s.missionMode);
  const [pts, setPts] = useState<THREE.Vector3[] | null>(null);
  useEffect(() => {
    if (rt.ghost.length < 2 || missionMode === 'rescue') return setPts(null);
    const step = Math.max(1, Math.floor(rt.ghost.length / 400));
    const v: THREE.Vector3[] = [];
    for (let i = 0; i < rt.ghost.length; i += step) {
      const p = rt.ghost[i];
      v.push(new THREE.Vector3(p.x, heightAt(p.x, p.z) + 0.35, p.z));
    }
    const last = rt.ghost[rt.ghost.length - 1];
    v.push(new THREE.Vector3(last.x, heightAt(last.x, last.z) + 0.35, last.z));
    setPts(v);
  }, [routeVersion, missionMode]);
  if (!pts) return null;
  return (
    <Line
      points={pts}
      color={algorithm === 'astar' ? '#e0b070' : '#a8d8e0'}
      lineWidth={1}
      dashed
      dashSize={1.2}
      gapSize={1.4}
      transparent
      opacity={0.35}
    />
  );
}

export function ProjectedPath() {
  const ref = useRef<THREE.Group>(null);
  return (
    <group ref={ref}>
      <Ribbon kind="main" />
      <Ribbon kind="transit" />
      <GhostPath />
    </group>
  );
}
