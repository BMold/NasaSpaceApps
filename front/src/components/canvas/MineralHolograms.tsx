// Holographic anchors over the real mineral sites (CRISM, terreno/sitios.json
// served by the backend). One per site, at its true position on the DEM:
//
//   • a floating prism whose shape and colour are the agreed mineral code
//     (CLAUDE.md §14): filosilicatos → round prism, sulfatos → rhombus
//     (octahedron), hematita → triangular prism, sílice → square prism (cube);
//   • a light beam down to the ground and a pulsing ring on the sampling spot,
//     plus a faint tall pillar so the site can be found from far away;
//   • a label drawn into a texture (a sprite), so it shows in BOTH eyes of the
//     Cardboard; HTML labels are hidden in stereo.
//
// Nothing here is computed: id, mineral, value, mass and window come from the
// site record; "planned / next / sampled" comes from the tour and the goal list.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimStore } from '../../store/useSimStore';
import { SITES, type ScienceSite } from '../../lib/sites';
import { MINERALES } from '../../lib/realTerrain';
import { heightAt } from '../../lib/terrain';
import { UNLIT } from '../../render/unlit';
import { currentGoal } from '../../vr/vrEngine';
import { formatHours } from '../../lib/marsTime';

const HOVER = 2.7; // metres above the ground (above a suited astronaut's helmet)

const holoVert = /* glsl */ `
varying vec3 vN; varying vec3 vView; varying float vY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  vY = wp.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const holoFrag = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uGain;
varying vec3 vN; varying vec3 vView; varying float vY;
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), vView)), 2.2);
  float scan = 0.55 + 0.45 * sin(vY * 34.0 - uTime * 6.0);
  float flick = 0.92 + 0.08 * sin(uTime * 23.0 + vY * 3.0);
  float a = (0.16 + 0.84 * fres) * (0.7 + 0.3 * scan) * flick * uGain;
  gl_FragColor = vec4(uColor * (0.6 + 1.6 * fres), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Vertical fade: bright at the bottom of the beam, gone at the top. */
const beamFrag = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uGain;
varying vec2 vUv;
void main() {
  float a = (1.0 - vUv.y) * (0.55 + 0.45 * sin(vUv.y * 40.0 - uTime * 5.0)) * uGain;
  gl_FragColor = vec4(uColor, a * 0.55);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const uvVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const ringFrag = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uGain;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float wave = fract(r * 1.0 - uTime * 0.45);
  float ring = smoothstep(0.86, 0.93, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float pulse = smoothstep(0.0, 0.08, wave) * (1.0 - smoothstep(0.08, 0.3, wave)) * (1.0 - r);
  float a = (ring * 0.9 + pulse * 0.6) * uGain;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function prismGeometry(forma: string, size: number): THREE.BufferGeometry {
  switch (forma) {
    case 'rombo':
      return new THREE.OctahedronGeometry(size * 0.85, 0).scale(0.8, 1.25, 0.8);
    case 'triangulo':
      return new THREE.CylinderGeometry(size * 0.8, size * 0.8, size * 1.5, 3, 1);
    case 'cuadrado':
      return new THREE.BoxGeometry(size * 1.05, size * 1.05, size * 1.05);
    default: // circulo
      return new THREE.CylinderGeometry(size * 0.65, size * 0.65, size * 1.3, 28, 1);
  }
}

type Status = 'next' | 'planned' | 'done' | 'out';

const STATUS_TXT: Record<Status, string> = {
  next: '▶ PRÓXIMO OBJETIVO',
  planned: 'en el plan',
  done: '✓ muestreado',
  out: 'fuera del plan',
};

/** Two-line label rendered into a texture (works in both stereo eyes). */
function labelTexture(site: ScienceSite, color: string, status: Status, order: number | null): THREE.CanvasTexture {
  const W = 512;
  const H = 168;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(8, 14, 24, 0.78)';
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(4, 4, W - 8, H - 8, 18);
  g.fill();
  g.stroke();
  const m = site.mineralKey ? MINERALES[site.mineralKey] : null;
  g.fillStyle = color;
  g.font = 'bold 44px ui-monospace, Consolas, monospace';
  g.fillText(`${site.code}  ${(m?.nombre ?? site.mineral).toUpperCase()}`, 24, 58);
  g.fillStyle = '#e6edf5';
  g.font = '30px ui-monospace, Consolas, monospace';
  // Spanish decimal comma (the DOM localiser does not reach canvas text).
  const kg = site.massKg.toFixed(1).replace('.', ',');
  g.fillText(`valor ${site.value}/10 · ${kg} kg · ${formatHours(site.window[0])}–${formatHours(site.window[1])}`, 24, 102);
  g.fillStyle = status === 'next' ? '#ffffff' : status === 'out' ? '#8b95a3' : '#c9d6e3';
  g.font = `${status === 'next' ? 'bold ' : ''}28px ui-monospace, Consolas, monospace`;
  const src = site.source === 'backend' ? 'backend' : 'terreno/';
  g.fillText(`${STATUS_TXT[status]}${order ? ` · parada ${order}` : ''} · ${src}`, 24, 142);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function Hologram({ site, status, order, version }: { site: ScienceSite; status: Status; order: number | null; version: number }) {
  const hex = site.mineralKey ? MINERALES[site.mineralKey].color : '#cfd8e3';
  const forma = site.mineralKey ? MINERALES[site.mineralKey].forma : 'circulo';
  // Hematite's agreed colour (#712B13) is too dark to glow: lift it for the light, keep the hue.
  const glow = useMemo(() => {
    const c = new THREE.Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    if (hsl.l < 0.45) c.setHSL(hsl.h, hsl.s, 0.45);
    return c.multiplyScalar(UNLIT * 1.4);
  }, [hex]);
  const ground = useMemo(() => heightAt(site.x, site.z), [site.x, site.z, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = 0.42 + 0.045 * site.value; // bigger = more science value

  const prism = useMemo(() => prismGeometry(forma, size), [forma, size]);
  const edges = useMemo(() => new THREE.EdgesGeometry(prism, 1), [prism]);
  const mats = useMemo(() => {
    const u = () => ({ uColor: { value: glow }, uTime: { value: 0 }, uGain: { value: 1 } });
    const common = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: true } as const;
    return {
      holo: new THREE.ShaderMaterial({ vertexShader: holoVert, fragmentShader: holoFrag, uniforms: u(), side: THREE.DoubleSide, ...common }),
      beam: new THREE.ShaderMaterial({ vertexShader: uvVert, fragmentShader: beamFrag, uniforms: u(), side: THREE.DoubleSide, ...common }),
      pillar: new THREE.ShaderMaterial({ vertexShader: uvVert, fragmentShader: beamFrag, uniforms: u(), side: THREE.DoubleSide, ...common }),
      ring: new THREE.ShaderMaterial({ vertexShader: uvVert, fragmentShader: ringFrag, uniforms: u(), side: THREE.DoubleSide, ...common }),
      edge: new THREE.LineBasicMaterial({ color: glow.clone().multiplyScalar(1.6), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
    };
  }, [glow]);
  const label = useMemo(() => labelTexture(site, hex, status, order), [site, hex, status, order]);
  const spriteMat = useMemo(() => new THREE.SpriteMaterial({ map: label, transparent: true, depthWrite: false, toneMapped: false, fog: false }), [label]);
  useEffect(() => () => label.dispose(), [label]);
  useEffect(() => () => spriteMat.dispose(), [spriteMat]);
  useEffect(
    () => () => {
      prism.dispose();
      edges.dispose();
      Object.values(mats).forEach((m) => m.dispose());
    },
    [prism, edges, mats],
  );

  const spin = useRef<THREE.Group>(null);
  const sprite = useRef<THREE.Sprite>(null);
  const tall = useRef<THREE.Mesh>(null);
  const phase = useMemo(() => site.id * 1.7, [site.id]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // The goal may change between React renders (it lives in the VR engine).
    const g = currentGoal();
    const isNext = g?.code === site.code;
    const gain = status === 'done' ? 0.35 : status === 'out' ? 0.45 : isNext ? 1.35 + 0.25 * Math.sin(t * 4) : 1;
    for (const m of [mats.holo, mats.beam, mats.ring, mats.pillar]) {
      m.uniforms.uTime.value = t + phase;
      m.uniforms.uGain.value = gain;
    }
    mats.pillar.uniforms.uGain.value = gain * (isNext ? 0.9 : 0.35);
    mats.edge.opacity = Math.min(1, 0.8 * gain);
    if (spin.current) {
      spin.current.rotation.y = t * 0.8 + phase;
      spin.current.rotation.x = Math.sin(t * 0.5 + phase) * 0.18;
      spin.current.position.y = HOVER + Math.sin(t * 1.6 + phase) * 0.18;
    }
    // Keep the label readable at any distance: constant angular size past ~25 m.
    const d = state.camera.position.distanceTo(_p.set(site.x, ground + HOVER, site.z));
    const k = Math.min(7, Math.max(1, d / 25));
    if (sprite.current) {
      sprite.current.scale.set(2.6 * k, 0.853 * k, 1);
      sprite.current.position.y = HOVER + 1.25 + 0.4 * k;
    }
    if (tall.current) tall.current.visible = d > 18; // no pillar in your face when you are on the spot
  });

  return (
    <group position={[site.x, ground, site.z]}>
      {/* sampling spot on the ground */}
      <mesh rotation-x={-Math.PI / 2} position-y={0.06} material={mats.ring} renderOrder={6}>
        <planeGeometry args={[4.2, 4.2]} />
      </mesh>
      {/* beam from the ground up to the prism */}
      <mesh position-y={HOVER / 2} material={mats.beam} renderOrder={6}>
        <cylinderGeometry args={[0.05, 0.42, HOVER, 20, 1, true]} />
      </mesh>
      {/* faint tall pillar: find the site from across the window */}
      <mesh ref={tall} position-y={HOVER + 20} material={mats.pillar} renderOrder={6}>
        <cylinderGeometry args={[0.12, 0.12, 40, 10, 1, true]} />
      </mesh>
      <group ref={spin} position-y={HOVER}>
        <mesh geometry={prism} material={mats.holo} renderOrder={7} />
        <lineSegments geometry={edges} material={mats.edge} renderOrder={8} />
      </group>
      <sprite ref={sprite} material={spriteMat} renderOrder={9} />
    </group>
  );
}

const _p = new THREE.Vector3();

export function MineralHolograms() {
  const version = useSimStore((s) => s.terrainVersion);
  const tour = useSimStore((s) => s.tour);
  useSimStore((s) => s.routeVersion); // a new goal comes with a new route
  const goal = currentGoal();
  return (
    <>
      {SITES.filter((s) => s.mineralKey).map((s) => {
        const idx = tour?.stops.findIndex((x) => x.code === s.code) ?? -1;
        const stop = idx >= 0 ? tour!.stops[idx] : null;
        const status: Status = stop?.done ? 'done' : goal?.code === s.code ? 'next' : stop ? 'planned' : 'out';
        return <Hologram key={`${s.code}-${version}`} site={s} status={status} order={stop ? idx + 1 : null} version={version} />;
      })}
    </>
  );
}
