// Base habitat (A), science-site survey flags and the active storm shelter.
import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useSimStore } from '../../store/useSimStore';
import { BASE_A, heightAt } from '../../lib/terrain';
import { SITES } from '../../lib/sites';
import { siteName } from '../../i18n';
import { UNLIT } from '../../render/unlit';

const shelterRing = new THREE.Color('#ffb070').multiplyScalar(UNLIT);

const hull = new THREE.MeshStandardMaterial({ color: '#d9d5cb', roughness: 0.62, metalness: 0.05 });
const hullDark = new THREE.MeshStandardMaterial({ color: '#5d6168', roughness: 0.55, metalness: 0.35 });
const trim = new THREE.MeshStandardMaterial({ color: '#8a8f96', roughness: 0.38, metalness: 0.85 });
const pad = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.125, 0.07), roughness: 1 });
const berm = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.3, 0.185, 0.1), roughness: 1 });
const pole = new THREE.MeshStandardMaterial({ color: '#c9c9c9', roughness: 0.4, metalness: 0.6 });
const cells = new THREE.MeshStandardMaterial({ color: '#0c1a3a', roughness: 0.2, metalness: 0.6 });
const windowGlow = new THREE.MeshStandardMaterial({ color: '#201a10', roughness: 0.2, emissive: '#ffd9a0', emissiveIntensity: 0.12 });
const lampGlow = new THREE.MeshStandardMaterial({ color: '#222', emissive: '#fff1d6', emissiveIntensity: 0.6 });

/** Surface habitat: inflatable dome under a regolith berm, three rigid modules, airlock, power and comms. */
function Habitat() {
  useSimStore((s) => s.terrainVersion);
  const y = heightAt(BASE_A.x, BASE_A.z);
  return (
    <group position={[BASE_A.x - 7, y, BASE_A.z - 7]}>
      {/* compacted pad */}
      <mesh position-y={0.04} material={pad} receiveShadow>
        <cylinderGeometry args={[9, 9.5, 0.1, 64]} />
      </mesh>
      {/* dome with its panel seams */}
      <mesh position-y={0.1} material={hull} castShadow receiveShadow>
        <sphereGeometry args={[3.4, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2]} />
      </mesh>
      {[0.55, 1.05].map((a) => (
        <mesh key={a} position-y={0.1 + 3.4 * Math.cos(a)} rotation-x={Math.PI / 2} material={trim}>
          <torusGeometry args={[3.41 * Math.sin(a), 0.022, 6, 64]} />
        </mesh>
      ))}
      {Array.from({ length: 8 }).map((_, i) => (
        <mesh key={i} position-y={0.1} rotation-y={(i / 8) * Math.PI * 2} material={trim}>
          <torusGeometry args={[3.41, 0.018, 6, 32, Math.PI / 2]} />
        </mesh>
      ))}
      {/* regolith piled against the dome: radiation shielding */}
      <mesh position-y={0.25} rotation-x={Math.PI / 2} material={berm} castShadow receiveShadow scale={[1, 1, 1.5]}>
        <torusGeometry args={[3.55, 0.62, 10, 48]} />
      </mesh>
      {/* rigid modules */}
      {[0, 1, 2].map((i) => {
        const a = (i / 3) * Math.PI * 2 + 0.4;
        return (
          <group key={i} position={[Math.cos(a) * 5.3, 1.3, Math.sin(a) * 5.3]} rotation-y={-a}>
            <mesh rotation-z={Math.PI / 2} material={hull} castShadow receiveShadow>
              <cylinderGeometry args={[1.2, 1.2, 3.6, 40]} />
            </mesh>
            {[-1.2, 0, 1.2].map((x) => (
              <mesh key={x} position-x={x} rotation-y={Math.PI / 2} material={trim}>
                <torusGeometry args={[1.205, 0.03, 6, 40]} />
              </mesh>
            ))}
            {/* end cap with a hatch */}
            <mesh position-x={1.82} rotation-z={Math.PI / 2} material={hullDark} castShadow>
              <cylinderGeometry args={[1.22, 1.22, 0.1, 40]} />
            </mesh>
            <mesh position-x={1.89} rotation-z={Math.PI / 2} material={trim}>
              <cylinderGeometry args={[0.62, 0.62, 0.06, 32]} />
            </mesh>
            {/* portholes */}
            {[-0.8, 0.5].map((x) => (
              <mesh key={x} position={[x, 0.35, 1.19]} material={windowGlow}>
                <circleGeometry args={[0.2, 20]} />
              </mesh>
            ))}
            {/* cradle */}
            {[-1.1, 1.1].map((x) => (
              <mesh key={x} position={[x, -1.02, 0]} material={hullDark} castShadow>
                <boxGeometry args={[0.25, 0.5, 2.1]} />
              </mesh>
            ))}
            {i === 0 && (
              <>
                {/* airlock: door, frame, step and work light */}
                <mesh position={[2.0, -0.18, 0]} material={hullDark} castShadow>
                  <boxGeometry args={[0.16, 1.9, 1.1]} />
                </mesh>
                <mesh position={[2.09, -0.18, 0]} material={trim}>
                  <boxGeometry args={[0.03, 1.7, 0.9]} />
                </mesh>
                <mesh position={[2.35, -1.2, 0]} material={trim} castShadow receiveShadow>
                  <boxGeometry args={[0.7, 0.08, 1.3]} />
                </mesh>
                <mesh position={[2.1, 0.9, 0]} material={lampGlow}>
                  <boxGeometry args={[0.05, 0.06, 0.5]} />
                </mesh>
              </>
            )}
          </group>
        );
      })}
      {/* communications mast with a dish */}
      <mesh position={[0, 4.6, 0]} material={trim} castShadow>
        <cylinderGeometry args={[0.04, 0.06, 2.6, 8]} />
      </mesh>
      <group position={[0.35, 5.6, 0]} rotation={[0, 0.6, -0.9]}>
        <mesh material={hull} castShadow>
          <sphereGeometry args={[0.75, 28, 10, 0, Math.PI * 2, 0, 0.75]} />
        </mesh>
        <mesh position-y={0.42} material={trim}>
          <cylinderGeometry args={[0.012, 0.012, 0.7, 6]} />
        </mesh>
      </group>
      {/* solar array on a low frame, beside the pad */}
      <group position={[-6.2, 0.1, 4.2]} rotation-y={0.5}>
        {[-1.7, 1.7].map((x) => (
          <group key={x} position={[x, 1.05, 0]} rotation-x={-0.45}>
            <mesh material={cells} castShadow receiveShadow>
              <boxGeometry args={[3.2, 0.05, 1.7]} />
            </mesh>
            <mesh position-y={-0.04} material={trim}>
              <boxGeometry args={[3.26, 0.03, 1.76]} />
            </mesh>
          </group>
        ))}
        {[-2.9, -0.5, 0.5, 2.9].map((x) => (
          <mesh key={x} position={[x, 0.5, 0.1]} material={trim} castShadow>
            <cylinderGeometry args={[0.03, 0.03, 1.1, 6]} />
          </mesh>
        ))}
      </group>
      {/* supply crates */}
      {[
        [4.2, 0.35, -5.6, 0.3],
        [5.1, 0.3, -5.0, 1.1],
        [4.5, 0.95, -5.5, 0.6],
      ].map(([x, yy, z, r], i) => (
        <mesh key={i} position={[x, yy, z]} rotation-y={r} material={i === 2 ? hullDark : hull} castShadow receiveShadow>
          <boxGeometry args={[0.9, i === 2 ? 0.5 : 0.7, 0.7]} />
        </mesh>
      ))}
      <Html position={[0, 7.4, 0]} center zIndexRange={[20, 0]} pointerEvents="none">
        <div className="label-3d" style={{ color: '#d6e8dc' }}>
          A · Hábitat
        </div>
      </Html>
    </group>
  );
}

function SiteFlag({ code, name, x, z }: { code: string; name: string; x: number; z: number }) {
  useSimStore((s) => s.terrainVersion);
  const tour = useSimStore((s) => s.tour);
  const stop = tour?.stops.find((s) => s.code === code);
  const done = !!stop?.done;
  const planned = !!stop;
  const y = heightAt(x, z);
  const flagMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#d9822b', roughness: 0.8, side: THREE.DoubleSide }), []);
  flagMat.color.set(done ? '#4f9f6f' : planned ? '#d9822b' : '#8b8f96');
  return (
    <group position={[x, y, z]}>
      <mesh position-y={0.9} material={pole} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 1.8, 6]} />
      </mesh>
      <mesh position={[0.22, 1.6, 0]} material={flagMat} castShadow>
        <planeGeometry args={[0.44, 0.28]} />
      </mesh>
      <Html position={[0, 2.6, 0]} center zIndexRange={[20, 0]} pointerEvents="none">
        <div className="label-3d" style={{ color: done ? '#9fe0b4' : planned ? '#f2c38a' : '#a9b0ba', opacity: planned || done ? 1 : 0.7 }}>
          {code} · {name}
          {done ? ' ✓' : ''}
        </div>
      </Html>
    </group>
  );
}

function ShelterMarker() {
  const shelter = useSimStore((s) => s.shelter);
  if (!shelter || shelter.kind === 'habitat') return null;
  const y = heightAt(shelter.x, shelter.z);
  return (
    <group position={[shelter.x, y, shelter.z]}>
      <mesh position-y={0.04} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[2.6, 2.8, 40]} />
        <meshBasicMaterial color={shelterRing} transparent opacity={0.5} />
      </mesh>
      <Html position={[0, 3, 0]} center zIndexRange={[20, 0]} pointerEvents="none">
        <div className="label-3d" style={{ color: '#ffc08a' }}>
          Refugio · dosis ×{shelter.svf.toFixed(2)}
        </div>
      </Html>
    </group>
  );
}

export function Landmarks() {
  return (
    <>
      <Habitat />
      {SITES.map((s) => (
        <SiteFlag key={s.code} code={s.code} name={siteName(s.code, s.name)} x={s.x} z={s.z} />
      ))}
      <ShelterMarker />
    </>
  );
}
