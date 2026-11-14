// Dynamic hazards of the mission (`peligro` events, INTEGRACION §5.4):
// `bloqueo` red, `multiplicador` amber (safety colours, CLAUDE.md §14);
// `radio_m: 0` removes it. A translucent cylinder of light on the exact circle,
// with a label drawn into a texture (visible in both eyes of the headset).
import { useEffect, useMemo, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { heightAt } from '../lib/terrain';
import { UNLIT } from '../render/unlit';
import { LEVEL_COLOR } from '../hud/bio';
import { missionView, type MissionViewNet } from './mission';

type H = MissionViewNet['peligros'][number];

const wallFrag = /* glsl */ `
uniform vec3 uColor; uniform float uTime;
varying vec2 vUv;
void main() {
  float up = vUv.y;
  float a = (1.0 - up) * (0.35 + 0.25 * sin(vUv.x * 60.0 + uTime * 2.0)) + (1.0 - smoothstep(0.0, 0.06, up)) * 0.6;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const uvVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

function label(h: H, color: string) {
  const c = document.createElement('canvas');
  c.width = 384;
  c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(8,14,24,0.8)';
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(4, 4, 376, 88, 14);
  g.fill();
  g.stroke();
  g.fillStyle = color;
  g.font = 'bold 34px ui-monospace, Consolas, monospace';
  g.fillText(`⚠ ${h.id} · ${h.efecto === 'bloqueo' ? 'BLOQUEO' : `×${h.factor} O₂`}`, 20, 44);
  g.fillStyle = '#e6edf5';
  g.font = '24px ui-monospace, Consolas, monospace';
  g.fillText(`radio ${String(h.r).replace('.', ',')} m`, 20, 78);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function Hazard({ h }: { h: H }) {
  const color = h.efecto === 'bloqueo' ? LEVEL_COLOR.rojo : LEVEL_COLOR.ambar;
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: uvVert,
        fragmentShader: wallFrag,
        uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(UNLIT * 1.4) }, uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    [color],
  );
  const tex = useMemo(() => label(h, color), [h, color]);
  useEffect(
    () => () => {
      mat.dispose();
      tex.dispose();
    },
    [mat, tex],
  );
  useFrame((s) => (mat.uniforms.uTime.value = s.clock.elapsedTime));
  const y = heightAt(h.x, h.z);
  const height = Math.max(2, h.r * 0.8);
  return (
    <group position={[h.x, y, h.z]}>
      <mesh position-y={height / 2} material={mat} renderOrder={6}>
        <cylinderGeometry args={[h.r, h.r, height, 48, 1, true]} />
      </mesh>
      <sprite position-y={height + 1.4} scale={[4, 1, 1]} renderOrder={9}>
        <spriteMaterial map={tex} transparent depthWrite={false} toneMapped={false} />
      </sprite>
    </group>
  );
}

export function MissionHazards() {
  const [, setV] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setV(missionView.version), 250);
    return () => window.clearInterval(id);
  }, []);
  if (!missionView.activo) return null;
  return (
    <>
      {missionView.peligros.map((h) => (
        <Hazard key={`${h.id}-${h.x}-${h.z}-${h.r}`} h={h} />
      ))}
    </>
  );
}
