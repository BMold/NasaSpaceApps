// What the boots leave behind: prints pressed into the regolith and the dust
// each step throws up. In Mars' thin air (0.6 % of Earth's) dust does not
// billow: grains fly in low arcs and fall back within a second.
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { normalAt, sandAt } from '../../lib/terrain';
import { addMarsFog } from '../../render/marsFog';
import { Q } from '../../render/quality';
import { skyState } from '../../components/canvas/Environment';
import type { StepEvent } from './rig';

export interface SuitFxHandle {
  step(e: StepEvent): void;
}

/** Tread of the boot sole, as an opacity mask. */
function makePrintTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 160);
  g.filter = 'blur(1.6px)';
  g.fillStyle = '#fff';
  // Sole outline: toe at the top of the image.
  g.beginPath();
  g.moveTo(14, 148);
  g.bezierCurveTo(8, 110, 4, 70, 6, 44);
  g.bezierCurveTo(8, 16, 22, 6, 32, 6);
  g.bezierCurveTo(42, 6, 56, 16, 58, 44);
  g.bezierCurveTo(60, 70, 56, 110, 50, 148);
  g.bezierCurveTo(44, 158, 20, 158, 14, 148);
  g.fill();
  // Tread bars pressed deeper than the rest: cut lighter gaps between them.
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,0.5)';
  for (let y = 16; y < 150; y += 11) g.fillRect(0, y, 64, 4);
  g.fillRect(0, 96, 64, 9); // arch
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

const GRAV = 3.71;

export const SuitFx = forwardRef<SuitFxHandle>(function SuitFx(_, ref) {
  // --- Footprints ---------------------------------------------------------------
  const prints = useRef<THREE.InstancedMesh>(null);
  const printGeo = useMemo(() => {
    const g = new THREE.PlaneGeometry(0.125, 0.31);
    g.rotateX(-Math.PI / 2); // flat, toe towards −Z
    return g;
  }, []);
  const printMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.16, 0.098, 0.052), // compacted regolith is darker than the loose dust around it
      roughness: 1,
      transparent: true,
      alphaMap: makePrintTexture(),
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide, // the right boot's print is a mirrored instance
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    m.onBeforeCompile = addMarsFog;
    return m;
  }, []);
  const printIdx = useRef(0);

  // --- Dust -----------------------------------------------------------------------
  const MAXP = Q.dust * 8;
  const dust = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3));
    g.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(MAXP), 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAXP), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color() }, uScale: { value: 600 } },
      vertexShader: /* glsl */ `attribute float aLife; attribute float aSize; uniform float uScale; varying float vLife;
        void main(){ vLife = aLife; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = aLife > 0.0 ? aSize * (0.6 + 1.4 * (1.0 - aLife)) * uScale / max(0.2, -mv.z) : 0.0; }`,
      fragmentShader: /* glsl */ `uniform vec3 uColor; varying float vLife;
        void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p) * 2.0; if (r > 1.0) discard;
          float a = (1.0 - r * r) * smoothstep(0.0, 0.25, vLife) * (0.16 + 0.26 * vLife);
          gl_FragColor = vec4(uColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    return { pts, g, mat, vel: new Float32Array(MAXP * 3), next: 0 };
  }, [MAXP]);

  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), n: { x: 0, y: 1, z: 0 }, up: new THREE.Vector3(0, 1, 0), nv: new THREE.Vector3() }), []);

  useImperativeHandle(
    ref,
    () => ({
      step(e) {
        const sand = sandAt(e.x, e.z);
        normalAt(e.x, e.z, tmp.n, 0.35);
        const soft = Math.max(0.25, Math.min(1, 0.45 + sand)) * (tmp.n.y > 0.93 ? 1 : 0.5); // faint on bare slopes
        // Footprint: under the ankle the sole reaches 7 cm back and 20 cm forward.
        const im = prints.current;
        if (im) {
          const fx = Math.sin(e.yaw);
          const fz = -Math.cos(e.yaw);
          tmp.nv.set(tmp.n.x, tmp.n.y, tmp.n.z);
          tmp.q.setFromUnitVectors(tmp.up, tmp.nv);
          tmp.q2.setFromAxisAngle(tmp.up, -e.yaw); // toe (−Z) towards the heading
          tmp.p.set(e.x + fx * 0.065, e.y + 0.012, e.z + fz * 0.065);
          tmp.s.set(e.side, 1, 1 + 0.15 * Math.min(1, e.speed / 3)); // mirrored for the other boot, smeared when running
          const i = printIdx.current++ % Q.footprints;
          im.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q.multiply(tmp.q2), tmp.s));
          im.setColorAt(i, new THREE.Color(1, 1, 1).multiplyScalar(1.6 - 0.75 * soft));
          im.count = Math.min(Q.footprints, printIdx.current);
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
        // Dust: more of it on loose sand and at speed.
        const n = Math.round((2 + 5 * soft) * (0.5 + Math.min(1.5, e.speed / 2)));
        const pos = dust.g.attributes.position as THREE.BufferAttribute;
        const life = dust.g.attributes.aLife as THREE.BufferAttribute;
        const size = dust.g.attributes.aSize as THREE.BufferAttribute;
        for (let k = 0; k < n; k++) {
          const i = dust.next++ % MAXP;
          const a = Math.random() * Math.PI * 2;
          const out = 0.15 + Math.random() * 0.55 + 0.25 * Math.min(1, e.speed / 3);
          pos.setXYZ(i, e.x + Math.cos(a) * 0.07, e.y + 0.02, e.z + Math.sin(a) * 0.07);
          // Thrown out sideways and back along the stride.
          dust.vel[i * 3] = Math.cos(a) * out - Math.sin(e.yaw) * 0.35 * e.speed * 0.3;
          dust.vel[i * 3 + 1] = 0.35 + Math.random() * 0.75;
          dust.vel[i * 3 + 2] = Math.sin(a) * out + Math.cos(e.yaw) * 0.35 * e.speed * 0.3;
          life.setX(i, 1);
          size.setX(i, 0.05 + Math.random() * 0.09);
        }
      },
    }),
    [dust, tmp, MAXP],
  );

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const pos = dust.g.attributes.position as THREE.BufferAttribute;
    const life = dust.g.attributes.aLife as THREE.BufferAttribute;
    let any = false;
    for (let i = 0; i < MAXP; i++) {
      const l = life.getX(i);
      if (l <= 0) continue;
      any = true;
      dust.vel[i * 3 + 1] -= GRAV * dt;
      const drag = Math.exp(-dt * 0.9);
      dust.vel[i * 3] *= drag;
      dust.vel[i * 3 + 2] *= drag;
      pos.setXYZ(i, pos.getX(i) + dust.vel[i * 3] * dt, pos.getY(i) + dust.vel[i * 3 + 1] * dt, pos.getZ(i) + dust.vel[i * 3 + 2] * dt);
      life.setX(i, l - dt / 0.85);
    }
    if (any) {
      pos.needsUpdate = true;
      life.needsUpdate = true;
      (dust.g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    }
    dust.pts.visible = any;
    // Lit like the ground it came from: sunlight plus skylight on airborne dust.
    const L = skyState.light;
    const mu = Math.max(0, skyState.sunDir.y);
    (dust.mat.uniforms.uColor.value as THREE.Color).setRGB(
      (0.335 * (L.beam[0] * (0.35 + 0.65 * mu) + L.skyIrradiance[0])) / Math.PI,
      (0.205 * (L.beam[1] * (0.35 + 0.65 * mu) + L.skyIrradiance[1])) / Math.PI,
      (0.108 * (L.beam[2] * (0.35 + 0.65 * mu) + L.skyIrradiance[2])) / Math.PI,
    );
    dust.mat.uniforms.uScale.value = state.size.height * state.viewport.dpr * 0.9;
  });

  return (
    <>
      <instancedMesh ref={prints} args={[printGeo, printMat, Q.footprints]} count={0} receiveShadow frustumCulled={false} renderOrder={3} />
      <primitive object={dust.pts} />
    </>
  );
});
