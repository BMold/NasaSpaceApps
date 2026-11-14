// Dust haze for every ordinary material (suit, drone, habitat, flags…).
//
// three.js mixes its fog in after tone mapping and in display colours, which
// cannot represent light scattered by dust in a scene lit with physical
// values. This replaces it once, for all built-in materials: the haze is
// mixed in before tone mapping, as light (radiance), with a true exponential
// fall-off whose density is the same one the sky and the far terrain use.
import * as THREE from 'three';

/** Radiance of the dust near the horizon (set by <Atmosphere />). */
export const marsFog = { value: new THREE.Color(0.03, 0.025, 0.02) };

/** For materials with their own onBeforeCompile: give them the haze colour too. */
export function addMarsFog(shader: { uniforms: Record<string, THREE.IUniform> }) {
  shader.uniforms.uMarsFog = marsFog;
}

let patched = false;
export function patchMarsFog() {
  if (patched) return;
  patched = true;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	uniform vec3 uMarsFog;
	varying float vFogDepth;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif`;
  THREE.ShaderChunk.opaque_fragment += /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		gl_FragColor.rgb = mix( gl_FragColor.rgb, uMarsFog, 1.0 - exp( - fogDensity * vFogDepth ) );
	#endif
#endif`;
  THREE.ShaderChunk.fog_fragment = '';
  THREE.Material.prototype.onBeforeCompile = function (shader) {
    addMarsFog(shader);
  };
}
