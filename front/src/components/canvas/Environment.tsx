// Sky, sunlight, ambient light and haze of the Martian scene.
//
// Everything comes from one physical model (render/marsSky.ts): the dome you
// see, the colour and strength of the sun light, the light the sky sends back
// (as an environment map, so metal, glass and fabric reflect the real sky),
// the haze of the distance and the camera exposure.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { rt } from '../../store/simEngine';
import { Q } from '../../render/quality';
import { SKY_GLSL, skyLight, type SkyLight } from '../../render/marsSky';
import { marsFog, patchMarsFog } from '../../render/marsFog';

patchMarsFog();

/** Dust optical depth on a clear sol at Gale; a storm raises it. */
export const CLEAR_TAU = 0.6;
/** Mean reflectance of the ground (linear RGB), used for the light bounced back up. */
export const GROUND_ALBEDO = new THREE.Color(0.27, 0.165, 0.088);

/** Uniforms shared by every shader that needs the sky (dome, far terrain haze). */
export const skyUniforms = {
  uSunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3).normalize() },
  uTau: { value: CLEAR_TAU },
  uHazeDensity: { value: 5.5e-5 }, // extinction per metre at ground level (tau / dust scale height)
  uHazeScaleH: { value: 11000 },
};

/** Current state of the light, for components that are not shaders. */
export const skyState = {
  light: skyLight({ x: 0.5, y: 0.6, z: 0.3 }, CLEAR_TAU) as SkyLight,
  sunDir: new THREE.Vector3(0.5, 0.6, 0.3).normalize(),
  elevation: 37,
  tau: CLEAR_TAU,
  exposure: 4,
  version: 0, // bumps whenever the Sun or the dust changed enough to re-bake dependent maps
};

/** Centre of the real-time shadow box (world), for shaders that blend it with the baked light. */
export const shadowFocus = new THREE.Vector3();

const sunVec = new THREE.Vector3();
function readSun(out: THREE.Vector3) {
  const d = rt.sun.dir;
  return out.set(d.x, d.y, d.z).normalize();
}

const domeVert = /* glsl */ `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const domeFrag = (env: boolean) => /* glsl */ `
uniform vec3 uSunDir; uniform float uTau; uniform vec3 uGround;
varying vec3 vDir;
#include <common>
#include <dithering_pars_fragment>
${SKY_GLSL}
void main(){
  vec3 d = normalize(vDir);
  vec3 c = marsSky(d, uSunDir, uTau, 1.0, ${env ? '1.0' : '0.0'});
  ${
    env
      ? // Environment map: below the horizon is the sunlit ground, so objects pick up its warm bounce.
        `c = mix(c, uGround, smoothstep(0.02, -0.06, d.y));`
      : `// Looking below the horizon (only where the land does not reach): dust haze over distant ground.
  c *= mix(1.0, 0.72, smoothstep(0.0, -0.25, d.y));
  // Solar disc: 0.35 deg wide from Mars, dimmed by the dust in front of it.
  float s = dot(d, uSunDir);
  float disc = smoothstep(0.999990, 0.999996, s) * step(-0.01, uSunDir.y);
  float beam = exp(-uTau * skyAirmass(uSunDir.y));
  c += vec3(1.0, 0.97, 0.93) * disc * (2.0 + 60.0 * beam);`
  }
  gl_FragColor = vec4(c, 1.0);
  ${env ? '' : '#include <tonemapping_fragment>\n  #include <colorspace_fragment>\n  #include <dithering_fragment>'}
}`;

export function Atmosphere() {
  const { scene, gl, camera } = useThree();
  const dome = useRef<THREE.Mesh>(null);
  const sunLight = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);

  const skyMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        dithering: true, // smooth gradients: no banding in the sky
        uniforms: { uSunDir: skyUniforms.uSunDir, uTau: skyUniforms.uTau, uGround: { value: new THREE.Color() } },
        vertexShader: domeVert,
        fragmentShader: domeFrag(false),
      }),
    [],
  );

  // Environment map: the same sky rendered into a cube and pre-filtered for PBR.
  const env = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
      uniforms: { uSunDir: skyUniforms.uSunDir, uTau: skyUniforms.uTau, uGround: { value: new THREE.Color() } },
      vertexShader: domeVert,
      fragmentShader: domeFrag(true),
    });
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat));
    return { scene: s, mat, pmrem: new THREE.PMREMGenerator(gl), target: null as THREE.WebGLRenderTarget | null, dirty: false, dirtyAt: 0 };
  }, [gl]);

  useEffect(() => {
    scene.fog = new THREE.FogExp2('#000000', skyUniforms.uHazeDensity.value);
    return () => {
      scene.fog = null;
      scene.environment = null;
      env.target?.dispose();
      env.pmrem.dispose();
    };
  }, [scene, env]);

  const last = useRef({ sun: new THREE.Vector3(), tau: -1 });
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(), []);
  const focus = shadowFocus;

  useFrame((state, dt) => {
    readSun(sunVec);
    const tau = CLEAR_TAU + rt.stormIntensity * 3.4;
    const now = state.clock.elapsedTime;

    // --- Light model: recomputed only when the Sun or the dust moved -------
    if (last.current.sun.angleTo(sunVec) > 0.004 || Math.abs(last.current.tau - tau) > 0.01) {
      last.current.sun.copy(sunVec);
      last.current.tau = tau;
      skyUniforms.uSunDir.value.copy(sunVec);
      skyUniforms.uTau.value = tau;
      skyUniforms.uHazeDensity.value = tau / skyUniforms.uHazeScaleH.value;
      const L = skyLight(sunVec, tau);
      skyState.light = L;
      skyState.sunDir.copy(sunVec);
      skyState.elevation = (Math.asin(sunVec.y) * 180) / Math.PI;
      skyState.tau = tau;
      skyState.version++;
      env.dirty = true; // re-bake the reflections once the change settles
      env.dirtyAt = now + (env.target ? 0.25 : 0);

      // Light the ground sends back up (for the lower half of the environment).
      const mu = Math.max(0, sunVec.y);
      const g = env.mat.uniforms.uGround.value as THREE.Color;
      g.setRGB(
        (GROUND_ALBEDO.r * (L.beam[0] * mu + L.skyIrradiance[0])) / Math.PI,
        (GROUND_ALBEDO.g * (L.beam[1] * mu + L.skyIrradiance[1])) / Math.PI,
        (GROUND_ALBEDO.b * (L.beam[2] * mu + L.skyIrradiance[2])) / Math.PI,
      );

      // Camera exposure: meter the ground and the sky together, as a real camera does.
      const lum = (c: number[] | THREE.Color) => ('r' in c ? c.r * 0.3 + c.g * 0.6 + c.b * 0.1 : c[0] * 0.3 + c[1] * 0.6 + c[2] * 0.1);
      const ySky = 0.5 * (lum(L.horizon) + lum(L.zenith));
      skyState.exposure = Math.min(40, 0.18 / Math.max(1e-5, 0.62 * lum(g) + 0.19 * ySky)) * 1.12;

      // Haze of ordinary objects: same density as the sky model (clear sol: tens of kilometres of view).
      marsFog.value.setRGB(L.horizon[0], L.horizon[1], L.horizon[2]);
      if (scene.fog instanceof THREE.FogExp2) scene.fog.density = skyUniforms.uHazeDensity.value;
    }

    if (env.dirty && now >= env.dirtyAt) {
      env.dirty = false;
      const old = env.target;
      env.target = env.pmrem.fromScene(env.scene, 0, 0.1, 100);
      scene.environment = env.target.texture;
      old?.dispose();
    }

    gl.toneMappingExposure += (skyState.exposure - gl.toneMappingExposure) * (1 - Math.exp(-dt * 3));
    dome.current?.position.copy(camera.position);

    // --- Sun light with a shadow map that follows the crew ------------------
    const s = sunLight.current;
    if (s) {
      const L = skyState.light;
      const peak = Math.max(L.beam[0], 1e-4);
      s.color.setRGB(1, L.beam[1] / peak, L.beam[2] / peak);
      s.intensity = L.beam[0];
      s.castShadow = sunVec.y > 0.02;

      // Aim the shadow box a little ahead of the astronaut, where the view looks.
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() > 1e-6) fwd.normalize();
      const half = Q.shadowHalf;
      focus.set(rt.astro.x + fwd.x * half * 0.35, rt.astro.y, rt.astro.z + fwd.z * half * 0.35);
      // Snap the box to whole shadow texels in light space: shadow edges stay still while walking.
      right.crossVectors(THREE.Object3D.DEFAULT_UP, sunVec);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      up.crossVectors(sunVec, right).normalize();
      const texel = (2 * half) / Q.shadowMap;
      const fx = focus.dot(right);
      const fy = focus.dot(up);
      focus.addScaledVector(right, Math.round(fx / texel) * texel - fx).addScaledVector(up, Math.round(fy / texel) * texel - fy);
      target.position.copy(focus);
      target.updateMatrixWorld();
      s.position.copy(focus).addScaledVector(sunVec, 160);
    }
  });

  return (
    <>
      <mesh ref={dome} material={skyMat} scale={900} renderOrder={-1000} frustumCulled={false}>
        <sphereGeometry args={[1, 48, 24]} />
      </mesh>
      <primitive object={target} />
      <directionalLight
        ref={sunLight}
        target={target}
        castShadow
        shadow-mapSize={[Q.shadowMap, Q.shadowMap]}
        shadow-camera-left={-Q.shadowHalf}
        shadow-camera-right={Q.shadowHalf}
        shadow-camera-top={Q.shadowHalf}
        shadow-camera-bottom={-Q.shadowHalf}
        shadow-camera-near={20}
        shadow-camera-far={320}
        shadow-bias={-0.00025}
        shadow-normalBias={0.03}
      />
    </>
  );
}

/** Kept for callers that still mount it: the lighting now lives in <Atmosphere />. */
export function Lights() {
  return null;
}
