// Scout helicopter carried on the backpack: a small coaxial rotorcraft in the
// style of NASA's Ingenuity (gold-foil body, two counter-rotating carbon
// rotors, solar panel on top, four thin legs), at true scale.
//
// Docked, the blades are folded down along the pack and the legs are tucked
// in. On DEPLOY the legs open, the blades swing out and spin up (they blur
// into two discs), it lifts off, flies to the area, scans it with a thin
// lidar fan and comes back to the cradle.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three-stdlib';
import { rt } from '../../store/simEngine';
import { heightAt } from '../../lib/terrain';
import { addMarsFog } from '../../render/marsFog';
import { UNLIT } from '../../render/unlit';
import { suitState } from '../../vr/suit/state';

const LIDAR_N = 28;
const ROTOR_R = 0.55;
const HINGE = 0.085; // blade fold hinge, clear of the body

function buildDrone() {
  const std = (o: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial(o);
    m.onBeforeCompile = addMarsFog;
    return m;
  };
  // Multi-layer insulation: crinkled gold foil.
  const foil = new THREE.MeshStandardMaterial({ color: '#c9973f', metalness: 1, roughness: 0.32, envMapIntensity: 1.25 });
  foil.onBeforeCompile = (shader) => {
    addMarsFog(shader);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFoilP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvFoilP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFoilP;\nfloat fH(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{ vec3 c = floor(vFoilP * 55.0); vec3 w = vec3(fH(c), fH(c + 7.3), fH(c + 13.1)) - 0.5; normal = normalize(normal + w * 0.55); }`,
      );
  };
  const carbon = std({ color: '#17181b', roughness: 0.45, metalness: 0.2 });
  const alu = std({ color: '#a9adb3', roughness: 0.35, metalness: 0.9 });
  const cell = std({ color: '#0b1630', roughness: 0.22, metalness: 0.55 });
  const glass = std({ color: '#05070a', roughness: 0.08, metalness: 0.9 });
  const strobe = new THREE.MeshStandardMaterial({ color: '#111', emissive: '#ffffff', emissiveIntensity: 0 });
  const navGreen = new THREE.MeshStandardMaterial({ color: '#031', emissive: '#3dff7a', emissiveIntensity: 0.06 });
  const navRed = new THREE.MeshStandardMaterial({ color: '#300', emissive: '#ff3b3b', emissiveIntensity: 0.06 });

  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(g, m);
    o.position.set(x, y, z);
    o.castShadow = true;
    return o;
  };

  // Origin = underside of the body (what rests on the cradle).
  const root = new THREE.Group();
  const body = mesh(new RoundedBoxGeometry(0.15, 0.17, 0.15, 3, 0.02), foil, 0, 0.085, 0);
  root.add(body);
  root.add(mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 16).rotateX(Math.PI / 2), glass, 0, 0.07, 0.077)); // navigation camera
  root.add(mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 16), glass, 0.03, -0.002, 0.02)); // downward camera
  root.add(mesh(new THREE.BoxGeometry(0.04, 0.012, 0.03), carbon, -0.03, -0.003, -0.02)); // lidar head
  root.add(mesh(new THREE.SphereGeometry(0.006, 8, 6), navGreen, -0.078, 0.12, 0));
  root.add(mesh(new THREE.SphereGeometry(0.006, 8, 6), navRed, 0.078, 0.12, 0));
  root.add(mesh(new THREE.SphereGeometry(0.007, 8, 6), strobe, 0, 0.004, -0.06));
  // Mast with the two rotor hubs, the solar panel and the antenna.
  root.add(mesh(new THREE.CylinderGeometry(0.011, 0.014, 0.33, 10), alu, 0, 0.335, 0));
  const panel = mesh(new THREE.BoxGeometry(0.17, 0.006, 0.42), cell, 0, 0.5, 0);
  root.add(panel);
  root.add(mesh(new THREE.BoxGeometry(0.176, 0.004, 0.426), alu, 0, 0.496, 0));
  root.add(mesh(new THREE.CylinderGeometry(0.0018, 0.0018, 0.11, 5), alu, 0, 0.555, 0));

  // Blade: a thin, twisted, tapered plate from the hub outwards (+X).
  const bladeGeo = (() => {
    const g = new THREE.BoxGeometry(ROTOR_R - HINGE, 0.006, 0.075, 10, 1, 2);
    g.translate((ROTOR_R - HINGE) / 2 + HINGE, 0, 0);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const t = p.getX(i) / ROTOR_R;
      const chord = 1 - 0.55 * t * t; // narrower towards the tip
      const z = p.getZ(i) * chord;
      const tw = 0.32 * (1 - t); // more pitch at the root
      p.setY(i, p.getY(i) + z * Math.sin(tw));
      p.setZ(i, z * Math.cos(tw));
    }
    g.computeVertexNormals();
    return g;
  })();
  const discGeo = new THREE.CircleGeometry(ROTOR_R, 48).rotateX(-Math.PI / 2);
  const rotors = [0.27, 0.36].map((y, k) => {
    const hub = new THREE.Group();
    hub.position.y = y;
    hub.add(mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.03, 12), alu));
    hub.add(mesh(new THREE.BoxGeometry(HINGE * 2, 0.012, 0.03), alu)); // blade grips
    const blades = [0, 1].map((n) => {
      const arm = new THREE.Group(); // points the blade outwards
      const hinge = new THREE.Group(); // folds the blade down
      hinge.position.x = HINGE;
      const b = mesh(bladeGeo, carbon, -HINGE, 0, 0);
      hinge.add(b);
      arm.add(hinge);
      hub.add(arm);
      // Flying: opposite each other. Parked: both swept to the rear (model −Z), fanned a little.
      return { arm, hinge, mesh: b, open: n * Math.PI, parked: Math.PI / 2 + (n === 0 ? -1 : 1) * (0.2 + 0.22 * k) };
    });
    // The spinning rotor seen as a blur.
    const discMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uAlpha: { value: 0 }, uPhase: { value: 0 } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `uniform float uAlpha; uniform float uPhase; varying vec2 vP;
        void main(){
          float r = length(vP) / ${ROTOR_R.toFixed(3)};
          float a = atan(vP.y, vP.x);
          float streak = 0.5 + 0.5 * cos(a * 2.0 + uPhase); // two blades smeared over the turn
          float alpha = uAlpha * (0.10 + 0.20 * streak * streak) * smoothstep(0.06, 0.2, r) * (1.0 - smoothstep(0.93, 1.0, r));
          gl_FragColor = vec4(vec3(0.045, 0.047, 0.05) * ${UNLIT.toFixed(3)} * 4.0, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.renderOrder = 6;
    hub.add(disc);
    root.add(hub);
    return { hub, blades, discMat, dir: k === 0 ? 1 : -1 };
  });

  // Legs: carbon tubes hinged under the body.
  const legs = [0, 1, 2, 3].map((i) => {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * 0.06, 0.02, Math.sin(a) * 0.06);
    pivot.rotation.y = -a;
    const swing = new THREE.Group(); // rotates about the horizontal tangent to open / fold
    const tube = mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.36, 6), carbon, 0, -0.18, 0);
    swing.add(tube);
    swing.add(mesh(new THREE.SphereGeometry(0.012, 8, 6), carbon, 0, -0.36, 0));
    pivot.add(swing);
    root.add(pivot);
    return swing;
  });
  return { root, rotors, legs, strobe };
}

export function ScoutDrone() {
  const drone = useMemo(buildDrone, []);
  const anim = useRef({ deploy: 0, spin: 0, phase: 0, px: 0, py: 0, pz: 0, vx: 0, vz: 0, pitch: 0, roll: 0, yaw: 0, init: false });
  const lidar = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIDAR_N * 2 * 3), 3));
    const m = new THREE.LineBasicMaterial({ color: new THREE.Color('#58ff9a').multiplyScalar(UNLIT * 1.6), transparent: true, opacity: 0.16, depthWrite: false });
    const l = new THREE.LineSegments(g, m);
    l.frustumCulled = false;
    return l;
  }, []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const e = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);

  // After the suit (−1): the docked drone uses the cradle's pose of this very frame.
  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const d = rt.drone;
    const A = anim.current;
    const t = state.clock.elapsedTime;
    const docked = d.state === 'docked';
    const g = drone.root;

    // Unfold on launch, fold again once back on the cradle.
    A.deploy += ((docked ? 0 : 1) - A.deploy) * (1 - Math.exp(-dt * (docked ? 3 : 7)));
    A.spin += ((docked ? 0 : 1) * Math.min(1, d.rotor + 0.2) - A.spin) * (1 - Math.exp(-dt * 2.5));
    A.phase += dt * A.spin * 260; // ~2500 rpm at full speed
    const fold = 1 - A.deploy;
    drone.rotors.forEach((r) => {
      // Parked: both blades swept behind the pack and hanging down, like a closed umbrella.
      r.hub.rotation.y = fold > 0.02 ? 0 : (A.phase * r.dir) % (Math.PI * 2);
      for (const b of r.blades) {
        b.arm.rotation.y = b.open + (b.parked - b.open) * fold;
        b.hinge.rotation.z = -1.44 * fold;
        b.mesh.visible = A.spin < 0.6;
      }
      r.discMat.uniforms.uAlpha.value = THREE.MathUtils.smoothstep(A.spin, 0.25, 0.8);
      r.discMat.uniforms.uPhase.value = A.phase * 0.07 * r.dir;
    });
    // Legs: splayed 41° when flying, folded up against the body when docked.
    for (const leg of drone.legs) leg.rotation.z = THREE.MathUtils.lerp(3.0, 0.72, A.deploy);
    drone.strobe.emissiveIntensity = !docked && (t * 1.1) % 1 < 0.06 ? 3 : 0;

    if (docked && suitState.dockValid) {
      g.position.copy(suitState.dockPos);
      g.quaternion.copy(suitState.dockQuat);
      A.init = false;
    } else {
      // In flight: lean into the motion, bank on turns, hover with a small wander.
      if (!A.init) {
        A.px = d.x; A.py = d.y; A.pz = d.z; A.vx = 0; A.vz = 0; A.yaw = d.heading;
        A.init = true;
      }
      const k = 1 - Math.exp(-dt * 6);
      A.vx += ((d.x - A.px) / dt - A.vx) * k;
      A.vz += ((d.z - A.pz) / dt - A.vz) * k;
      A.px = d.x; A.py = d.y; A.pz = d.z;
      const fwdX = Math.sin(d.heading);
      const fwdZ = -Math.cos(d.heading);
      const vF = A.vx * fwdX + A.vz * fwdZ;
      const vR = A.vx * Math.cos(d.heading) + A.vz * Math.sin(d.heading);
      A.pitch += (THREE.MathUtils.clamp(vF * 0.02, -0.3, 0.3) - A.pitch) * (1 - Math.exp(-dt * 4));
      A.roll += (THREE.MathUtils.clamp(-vR * 0.02, -0.25, 0.25) - A.roll) * (1 - Math.exp(-dt * 4));
      A.yaw += Math.atan2(Math.sin(d.heading - A.yaw), Math.cos(d.heading - A.yaw)) * (1 - Math.exp(-dt * 5));
      const hover = d.state === 'launch' ? 0 : 1;
      g.position.set(d.x + Math.sin(t * 0.9) * 0.03 * hover, d.y + Math.sin(t * 1.7) * 0.035 * hover, d.z + Math.cos(t * 0.7) * 0.03 * hover);
      // Model faces +Z; heading 0 = north (−Z).
      e.set(-A.pitch + Math.sin(t * 2.3) * 0.012, Math.PI - A.yaw, A.roll + Math.cos(t * 1.9) * 0.012);
      g.quaternion.copy(q.setFromEuler(e));
    }

    // Lidar fan while scanning: thin lines from the sensor to the ground, sweeping round.
    const pos = lidar.geometry.attributes.position as THREE.BufferAttribute;
    lidar.visible = d.state === 'scan';
    if (lidar.visible) {
      const sweep = t * 1.8;
      for (let i = 0; i < LIDAR_N; i++) {
        const ang = sweep + (i / LIDAR_N) * 0.5;
        const rr = 3 + (i / LIDAR_N) * 22;
        const gx = d.x + Math.cos(ang) * rr;
        const gz = d.z + Math.sin(ang) * rr;
        pos.setXYZ(i * 2, g.position.x, g.position.y, g.position.z);
        pos.setXYZ(i * 2 + 1, gx, heightAt(gx, gz) + 0.03, gz);
      }
      pos.needsUpdate = true;
    }
  });

  return (
    <>
      <primitive object={drone.root} />
      <primitive object={lidar} />
    </>
  );
}
