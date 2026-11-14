// The field anomalies of jarvis/catalog.ts, drawn in the scene (same seed on
// both devices): a dark metallic stone (possible iron meteorite), a light-toned
// vein in the bedrock (possible calcium sulfate, like Gale's veins) and a
// cluster of dark spherules (concretions). They are scenario objects, not data.
import { useMemo } from 'react';
import * as THREE from 'three';
import { useSimStore } from '../store/useSimStore';
import { heightAt } from '../lib/terrain';
import { ensureField, type Anomaly } from './catalog';

const metal = new THREE.MeshStandardMaterial({ color: '#2b2a2c', metalness: 0.85, roughness: 0.32 });
const vein = new THREE.MeshStandardMaterial({ color: '#efe9da', roughness: 0.75 });
const nodule = new THREE.MeshStandardMaterial({ color: '#3a2420', roughness: 0.55, metalness: 0.15 });

function meteoriteGeometry(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // Regmaglypts: shallow thumbprint dimples on a rounded body.
    const k = 1 + 0.08 * Math.sin(v.x * 7 + seed) * Math.sin(v.y * 6 - seed) * Math.sin(v.z * 8 + seed * 0.5);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y * 0.75, v.z * 1.1);
  }
  g.computeVertexNormals();
  return g;
}

function One({ a }: { a: Anomaly }) {
  const y = heightAt(a.x, a.z);
  const meteo = useMemo(() => (a.clase === 'meteorito' ? meteoriteGeometry(a.rot * 10) : null), [a.clase, a.rot]);
  if (a.clase === 'meteorito')
    return <mesh geometry={meteo!} material={metal} position={[a.x, y + a.r * 0.45, a.z]} rotation-y={a.rot} scale={a.r} castShadow receiveShadow />;
  if (a.clase === 'veta')
    return (
      <group position={[a.x, y, a.z]} rotation-y={a.rot}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} material={vein} position={[(i - 1) * 0.42, 0.03, Math.sin(i * 2.1) * 0.08]} rotation-y={(i - 1) * 0.25} castShadow receiveShadow>
            <boxGeometry args={[0.55, 0.09, 0.08 + 0.03 * i]} />
          </mesh>
        ))}
      </group>
    );
  // concreciones: a scatter of 2–4 cm spherules
  return (
    <group position={[a.x, y, a.z]}>
      {Array.from({ length: 14 }).map((_, i) => {
        const ang = i * 2.39996 + a.rot;
        const d = 0.08 + 0.33 * Math.sqrt(i / 14);
        const s = 0.025 + 0.015 * ((i * 7) % 3);
        return (
          <mesh key={i} material={nodule} position={[Math.cos(ang) * d, s * 0.6, Math.sin(ang) * d]} castShadow>
            <sphereGeometry args={[s, 10, 8]} />
          </mesh>
        );
      })}
    </group>
  );
}

export function Anomalies() {
  const version = useSimStore((s) => s.terrainVersion);
  const list = useMemo(() => ensureField().anomalies.slice(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {list.map((a) => (
        <One key={`${a.id}-${version}`} a={a} />
      ))}
    </>
  );
}
