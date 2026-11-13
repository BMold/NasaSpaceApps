// Terrain-draped hazard decals: cold crater shadow, rock field, uncharted canyon.
import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useSimStore } from '../../store/useSimStore';
import type { Hazard } from '../../lib/costmap';
import { CANYON, heightAt } from '../../lib/terrain';
import { RockInstances } from './Rocks';
import { UNLIT } from '../../render/unlit';

const decalVert = `varying vec2 vLocal; uniform float uR;
void main(){ vLocal = position.xz / uR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const decalFrag = `uniform vec3 uColor; uniform float uTime; uniform float uMode; varying vec2 vLocal;
void main(){
  float d = length(vLocal);
  if (d > 1.0) discard;
  float edge = smoothstep(0.86, 0.97, d) * (1.0 - smoothstep(0.97, 1.0, d));
  float fill = uMode > 0.5 ? (1.0 - smoothstep(0.2, 1.0, d)) * 0.16 : 0.0;
  float a = fill + edge * 0.12;
  gl_FragColor = vec4(uColor * ${UNLIT.toFixed(3)}, a * 1.6);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function DrapedDecal({ x, z, r, color, mode = 0 }: { x: number; z: number; r: number; color: string; mode?: number }) {
  const terrainVersion = useSimStore((s) => s.terrainVersion);
  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(r * 2, r * 2, 40, 40);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setY(i, heightAt(x + p.getX(i), z + p.getZ(i)) + 0.12);
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, z, r, terrainVersion]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: decalVert,
        fragmentShader: decalFrag,
        uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uMode: { value: mode }, uR: { value: r } },
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    [color, mode, r],
  );
  useFrame((s) => (material.uniforms.uTime.value = s.clock.elapsedTime));
  return <mesh geometry={geometry} material={material} position={[x, 0, z]} renderOrder={4} />;
}

function Label({ x, z, y = 4, text, color }: { x: number; z: number; y?: number; text: string; color: string }) {
  return (
    <Html position={[x, heightAt(x, z) + y, z]} center zIndexRange={[20, 0]} pointerEvents="none">
      <div className="label-3d" style={{ color }}>
        {text}
      </div>
    </Html>
  );
}

function RockField({ h }: { h: Hazard }) {
  const rocks = h.rocks ?? [];
  return (
    <group>
      <RockInstances rocks={rocks} version={`${h.id}:${h.x.toFixed(2)},${h.z.toFixed(2)}`} />
      <Label x={h.x} z={h.z} text="Campo de rocas · infranqueable" color="#f0a0a0" />
    </group>
  );
}

function ColdZone({ h }: { h: Hazard }) {
  const y = heightAt(h.x, h.z);
  return (
    <group>
      {/* frost on the ground of the cold trap */}
      <DrapedDecal x={h.x} z={h.z} r={h.r * 1.1} color="#dfe8f2" mode={1} />
      <Label x={h.x} z={h.z} y={4 + y * 0} text="Trampa fría −100 °C" color="#bcd8f0" />
    </group>
  );
}

function CanyonMarker() {
  const scanned = useSimStore((s) => s.canyonScanned);
  return (
    <group>
      <Label
        x={CANYON.x}
        z={CANYON.z}
        y={6}
        text={scanned ? 'Cañón mapeado' : 'Cañón sin mapear'}
        color={scanned ? '#b6e3c6' : '#c9b8e6'}
      />
    </group>
  );
}

export function HazardVisuals() {
  const hazards = useSimStore((s) => s.hazards);
  return (
    <group>
      {hazards.map((h) =>
        h.kind === 'cold' ? (
          <ColdZone key={h.id} h={h} />
        ) : h.kind === 'hill' ? (
          <Label key={h.id} x={h.x} z={h.z} y={3} text={`Montaña +${(h.height ?? 12).toFixed(0)} m`} color="#e8d2b8" />
        ) : (
          <RockField key={h.id} h={h} />
        ),
      )}
      <CanyonMarker />
    </group>
  );
}
