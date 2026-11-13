// Materials of the EVA suit. Everything is physically based and lit by the
// same sky as the terrain, so the white fabric picks up the butterscotch
// ambient light and the visor mirrors the real horizon.
import * as THREE from 'three';
import { addMarsFog } from '../../render/marsFog';

/** World height of the ground under the boots: dust clings to the suit from there up. */
export const suitUniforms = { uSuitGround: { value: 0 }, uSuitDust: { value: 1 } };

interface FabricOptions {
  color: string;
  roughness?: number;
  metalness?: number;
  /** How readily Martian dust sticks (fabric 1, smooth shell ~0.4). */
  dust?: number;
  /** Fine weave relief in the lighting. */
  weave?: number;
}

/**
 * Suit surface with wear: dust kicked up by the boots stains everything below
 * the knee and thins out towards the waist; a fine weave breaks the highlights
 * so the cloth does not look like plastic.
 */
export function fabric({ color, roughness = 0.78, metalness = 0, dust = 1, weave = 1 }: FabricOptions) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  mat.onBeforeCompile = (shader) => {
    addMarsFog(shader);
    Object.assign(shader.uniforms, suitUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSuitPos; varying vec3 vSuitLocal;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSuitPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSuitLocal = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vSuitPos; varying vec3 vSuitLocal;
uniform float uSuitGround; uniform float uSuitDust;
float sHash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sNoise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(sHash(i), sHash(i+vec3(1,0,0)), f.x), mix(sHash(i+vec3(0,1,0)), sHash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(sHash(i+vec3(0,0,1)), sHash(i+vec3(1,0,1)), f.x), mix(sHash(i+vec3(0,1,1)), sHash(i+vec3(1,1,1)), f.x), f.y), f.z); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float h = vSuitPos.y - uSuitGround;
  float blot = sNoise(vSuitLocal * 34.0) * 0.6 + sNoise(vSuitLocal * 9.0) * 0.4;
  // Heavy below the knee, a film up to the waist, traces above.
  float amount = (1.0 - smoothstep(0.02, 0.55, h)) * 0.8 + (1.0 - smoothstep(0.35, 1.05, h)) * 0.1 + 0.015;
  amount *= ${dust.toFixed(2)} * uSuitDust * (0.55 + 0.9 * blot);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.335, 0.205, 0.108) * (0.8 + 0.4 * blot), clamp(amount, 0.0, 0.92));
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (sNoise(vSuitLocal * 60.0) - 0.5) * 0.12, 0.04, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  // Woven outer layer: two crossed thread directions, far too fine to model.
  vec3 q = vSuitLocal * 2400.0;
  vec3 w = vec3(sin(q.x) * cos(q.y * 0.5), sin(q.y) * cos(q.z * 0.5), sin(q.z) * cos(q.x * 0.5));
  float fade = 1.0 - smoothstep(0.5, 2.2, length(vViewPosition));
  normal = normalize(normal + w * ${(0.045 * weave).toFixed(3)} * fade);
}`,
      );
  };
  mat.customProgramCacheKey = () => `suit-fabric-${dust}-${weave}`;
  return mat;
}

export function makeSuitMaterials() {
  return {
    white: fabric({ color: '#f1f1ee', roughness: 0.72 }),
    whiteShell: fabric({ color: '#f4f4f1', roughness: 0.3, dust: 0.45, weave: 0 }), // helmet and hard parts
    grey: fabric({ color: '#4b4e55', roughness: 0.7 }),
    dark: fabric({ color: '#1e2024', roughness: 0.62, dust: 0.9 }),
    rubber: fabric({ color: '#141518', roughness: 0.86, dust: 1.2, weave: 0 }),
    metal: fabric({ color: '#8d9299', roughness: 0.32, metalness: 0.9, dust: 0.5, weave: 0 }),
    darkMetal: fabric({ color: '#2b2e33', roughness: 0.38, metalness: 0.85, dust: 0.5, weave: 0 }),
    // Sun visor: thin metallic coating (copper-gold), mirror smooth under a clear coat.
    visor: new THREE.MeshPhysicalMaterial({ color: '#d79a55', metalness: 1, roughness: 0.045, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.35 }),
    screen: new THREE.MeshStandardMaterial({ color: '#06121a', roughness: 0.25, emissive: '#3fd0ff', emissiveIntensity: 0.05 }),
    ledGreen: new THREE.MeshStandardMaterial({ color: '#0c2a12', emissive: '#48ff7a', emissiveIntensity: 0.09 }),
    ledAmber: new THREE.MeshStandardMaterial({ color: '#2a1a08', emissive: '#ffb347', emissiveIntensity: 0.07 }),
    lamp: new THREE.MeshStandardMaterial({ color: '#dfe6ee', roughness: 0.2, emissive: '#ffffff', emissiveIntensity: 0.04 }),
  };
}
export type SuitMaterials = ReturnType<typeof makeSuitMaterials>;
