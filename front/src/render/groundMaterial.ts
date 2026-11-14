// The Martian ground: one physically based material for the 240 m site and
// for the land beyond it (same shading, so the two join without a seam).
//
// Close up it blends three baked surfaces (dusty regolith with pebbles, wind
// rippled sand, fractured bedrock) with real relief in the lighting (normal
// maps), at two scales so the pattern never repeats visibly. From far away it
// shows the real orbital imagery (HiRISE / CTX) and, for the distance, the
// dust haze computed with the same model as the sky.
import * as THREE from 'three';
import { Q, tier } from './quality';
import { SKY_GLSL } from './marsSky';
import { skyUniforms } from '../components/canvas/Environment';
import { terrainUniforms } from '../lib/gpuMaps';
import { HALF, WORLD_SIZE } from '../lib/terrain';
import { layerUniforms } from '../lib/layers';
import { marsFog } from './marsFog';

const loader = new THREE.TextureLoader();
const BASE = import.meta.env.BASE_URL;

function dataTexture(url: string) {
  const t = loader.load(BASE + url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.flipY = false; // row 0 = north / v = 0, as the bake scripts write them
  t.anisotropy = Q.aniso;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

let detail: Record<'soilN' | 'soilA' | 'sandN' | 'sandA' | 'rockN' | 'rockA' | 'stoneN' | 'stoneA', THREE.Texture> | null = null;
/** Close-range surface textures (see scripts/bake-textures.py). */
export function detailTextures() {
  detail ??= {
    soilN: dataTexture('textures/soil_n.jpg'),
    soilA: dataTexture('textures/soil_a.jpg'),
    sandN: dataTexture('textures/sand_n.jpg'),
    sandA: dataTexture('textures/sand_a.jpg'),
    rockN: dataTexture('textures/rock_n.jpg'),
    rockA: dataTexture('textures/rock_a.jpg'),
    stoneN: dataTexture('textures/stone_n.jpg'),
    stoneA: dataTexture('textures/stone_a.jpg'),
  };
  return detail;
}

const grey1x1 = () => {
  const t = new THREE.DataTexture(new Uint8Array([92, 92, 92, 255]), 1, 1);
  t.needsUpdate = true;
  return t as THREE.Texture;
};

/** Grey orbital image of the 240 m site (R channel), set by the terrain when the data arrives. */
export const siteAlbedo = { uSiteAlb: { value: grey1x1() }, uSiteAlbOn: { value: 0 } };

/** Baked sunlight / sky occlusion of the site (render/shadeBake.ts) and where the live shadow map is. */
export const shadeUniforms = {
  uShade: { value: null as THREE.Texture | null },
  uShadowFocus: { value: new THREE.Vector3(0, 0, 30) }, // x, z, half size of the real-time shadow box
};

/** Real imagery around the site (far terrain). */
export const regionUniforms = {
  uMidAlb: { value: grey1x1() },
  uRegAlb: { value: grey1x1() },
  uFarAlb: { value: grey1x1() },
  uRegionOn: { value: 0 },
};

export const GROUND_COLORS = /* glsl */ `
// Reflectance of Martian materials, linear RGB (bright dust is ~0.30 in red, ~0.08 in blue).
const vec3 C_DUST = vec3(0.335, 0.205, 0.108);
const vec3 C_PEBBLE = vec3(0.215, 0.160, 0.118);
const vec3 C_SAND = vec3(0.215, 0.148, 0.098);
const vec3 C_CREST = vec3(0.105, 0.080, 0.066);
const vec3 C_ROCK = vec3(0.345, 0.250, 0.165);
const vec3 C_VEIN = vec3(0.50, 0.44, 0.36);
`;

/** Height range of the soil texture in texels of a 1024 px tile (printed by the bake script). */
const SOIL_RANGE_PX = 12.5;

const GROUND_GLSL = /* glsl */ `
uniform sampler2D uSoilN; uniform sampler2D uSoilA; uniform sampler2D uSandN; uniform sampler2D uSandA; uniform sampler2D uRockN; uniform sampler2D uRockA;
${GROUND_COLORS}
float gHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float gNoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(gHash(i), gHash(i+vec2(1,0)), f.x), mix(gHash(i+vec2(0,1)), gHash(i+vec2(1,1)), f.x), f.y); }

struct Ground { vec3 albedo; vec2 nxy; float ao; float micro; };

// One surface at up to two scales: the close one (2.4 m tile, GROUND_NEAR) and a wide one (17 m, GROUND_WIDE)
// that carries the mid-distance. nh = normal.xy (-1..1) and height; av = albedo variation, cavity, second-colour mask.
void gLayer(sampler2D tn, sampler2D ta, vec2 uv1, vec2 uv2, float w1, float w2, out vec3 nh, out vec3 av, out float hNear) {
#ifdef GROUND_NEAR
  vec3 n1 = texture2D(tn, uv1).rgb;
  vec3 a1 = texture2D(ta, uv1).rgb;
#else
  vec3 n1 = vec3(0.5, 0.5, 0.35);
  vec3 a1 = vec3(0.6, 1.0, 0.0);
#endif
  hNear = n1.z;
#ifdef GROUND_WIDE
  vec3 n2 = texture2D(tn, uv2).rgb;
  // The wide scale only carries relief and a soft mottling: no pebble "discs" the size of boulders.
  vec3 a2 = vec3(0.6 + (n2.z - 0.35) * 0.24, 1.0, 0.0);
  nh = vec3((n1.xy - 0.5) * 2.0 * w1 + (n2.xy - 0.5) * 2.0 * w2 * 0.6, mix(n2.z, n1.z, w1 / max(1e-3, w1 + w2)));
  av = mix(mix(vec3(0.6, 1.0, 0.0), a2, w2), a1, w1);
#else
  nh = vec3((n1.xy - 0.5) * 2.0 * w1, n1.z);
  av = mix(vec3(0.6, 1.0, 0.0), a1, w1);
#endif
}

/**
 * wpos: world position · geoN: geometric normal (world) · sandMask: 0..1 loose sand ·
 * macroL: orbital grey level (0.33 = site average) · camD: distance to the camera · sunDir: world.
 */
Ground marsGround(vec3 wpos, vec3 geoN, float sandMask, float macroL, float camD, vec3 sunDir) {
  vec2 uv1 = wpos.xz / 2.4;
  vec2 uv2 = wpos.xz / 17.3 + vec2(0.37, 0.61);
#ifdef GROUND_NEAR
  float w1 = 1.0 - smoothstep(9.0, 40.0, camD);
#else
  float w1 = 0.0;
#endif
  float w2 = smoothstep(4.0, 26.0, camD) * (1.0 - smoothstep(240.0, 650.0, camD));

  vec3 soilN; vec3 soilA; vec3 sandN; vec3 sandA; vec3 rockN; vec3 rockA; float hSoil; float hUnused;
  gLayer(uSoilN, uSoilA, uv1, uv2, w1, w2, soilN, soilA, hSoil);
  gLayer(uSandN, uSandA, uv1, uv2, w1, w2, sandN, sandA, hUnused);
  gLayer(uRockN, uRockA, uv1, uv2, w1, w2, rockN, rockA, hUnused);

  // Where each surface lives: bedrock on slopes and on the bright outcrops of the orbital image,
  // sand where the site has it and in the darkest patches, regolith everywhere else.
  float blotch = gNoise(wpos.xz * 0.11) * 0.6 + gNoise(wpos.xz * 0.37 + 9.1) * 0.4;
  float slope = 1.0 - geoN.y;
  float pRock = max(smoothstep(0.028, 0.14, slope), smoothstep(0.50, 0.68, macroL + (blotch - 0.5) * 0.30));
  float pSand = max(sandMask, smoothstep(0.27, 0.17, macroL + (blotch - 0.5) * 0.16) * 0.8);
  // Height blending: sand settles in the hollows first, slabs stand proud of the soil.
  float wRock = smoothstep(0.38, 0.62, pRock + (rockN.z - 0.5) * 0.45 - (soilN.z - 0.22) * 0.3);
  float wSand = smoothstep(0.40, 0.68, pSand + (0.30 - soilN.z) * 0.9) * (1.0 - 0.55 * smoothstep(0.10, 0.22, slope));

  vec3 cSoil = mix(C_DUST, C_PEBBLE, soilA.b) * (0.50 + 0.95 * soilA.r);
  vec3 cRock = mix(C_ROCK, C_VEIN, rockA.b) * (0.48 + 0.95 * rockA.r);
  vec3 cSand = mix(C_SAND, C_CREST, sandA.b) * (0.46 + 0.95 * sandA.r);

  Ground g;
  g.albedo = mix(mix(cSoil, cRock, wRock), cSand, wSand);
  g.nxy = mix(mix(soilN.xy, rockN.xy, wRock), sandN.xy, wSand);
  g.ao = mix(mix(soilA.g, rockA.g, wRock), sandA.g, wSand);
  // The orbital image carries the large light and dark patterns of the real place.
#ifdef GROUND_REGION
  g.albedo *= mix(1.0, min(1.3, 0.66 + 0.85 * macroL), 0.8);
#else
  g.albedo *= mix(1.0, min(1.5, 0.62 + 0.95 * macroL), 0.85);
#endif
  g.micro = 1.0;
#ifdef GROUND_MICRO
  // Pebbles cast short shadows: is the texture higher a little way towards the Sun?
  vec2 sdir = normalize(sunDir.xz + vec2(1e-5));
  float tanEl = sunDir.y / max(0.05, length(sunDir.xz));
  float hA = texture2D(uSoilN, uv1 + sdir * (5.0 / 1024.0)).z;
  float hB = texture2D(uSoilN, uv1 + sdir * (14.0 / 1024.0)).z;
  float occ = max(smoothstep(0.0, 1.6, (hA - hSoil) * ${SOIL_RANGE_PX.toFixed(1)} - 5.0 * tanEl), smoothstep(0.0, 2.4, (hB - hSoil) * ${SOIL_RANGE_PX.toFixed(1)} - 14.0 * tanEl));
  g.micro = 1.0 - occ * w1 * (1.0 - wSand) * (1.0 - wRock) * 0.9;
#endif
  return g;
}
`;

const HAZE_GLSL = /* glsl */ `
uniform float uHazeDensity; uniform float uHazeScaleH; uniform vec3 uSunDir; uniform float uTau; uniform vec3 uMarsFog;
${SKY_GLSL}
/** Dust between the camera and a distant point: dims it and adds the light the dust scatters towards you. */
vec3 marsHaze(vec3 color, vec3 camPos, vec3 wpos) {
  vec3 ray = wpos - camPos;
  float d = length(ray);
  vec3 v = ray / max(d, 1e-3);
  // Dust thins out with height (scale height ~11 km): average density along the ray.
  float h0 = camPos.y / uHazeScaleH; float h1 = wpos.y / uHazeScaleH;
  float dh = h1 - h0;
  float mean = abs(dh) < 1e-3 ? exp(-h0) : (exp(-h0) - exp(-h1)) / dh;
  float T = exp(-uHazeDensity * d * mean);
#ifdef GROUND_SIMPLE_HAZE
  vec3 air = uMarsFog;
#else
  vec3 air = marsSky(normalize(vec3(v.x, max(v.y, 0.012), v.z)), uSunDir, uTau, 1.0, 0.0);
#endif
  return color * T + air * (1.0 - T);
}
`;

export interface GroundOptions {
  /** 'site' = the walkable 240 m tile; 'region' = the land beyond it. */
  kind: 'site' | 'region';
}

export function makeGroundMaterial({ kind }: GroundOptions) {
  const site = kind === 'site';
  const tex = detailTextures();
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.96, metalness: 0, fog: false });
  const wide = site ? Q.groundTwoScales : Q.farDetail;
  const micro = site && tier !== 'low';
  mat.defines = {
    ...(site ? { GROUND_NEAR: '', GROUND_SITE: '' } : { GROUND_REGION: '' }),
    ...(wide ? { GROUND_WIDE: '' } : {}),
    ...(micro ? { GROUND_MICRO: '' } : {}),
    ...(!site && Q.farDetail ? { GROUND_STRATA: '' } : {}),
    ...(tier === 'low' ? { GROUND_SIMPLE_HAZE: '' } : {}),
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uSoilN: { value: tex.soilN },
      uSoilA: { value: tex.soilA },
      uSandN: { value: tex.sandN },
      uSandA: { value: tex.sandA },
      uRockN: { value: tex.rockN },
      uRockA: { value: tex.rockA },
      uSunDir: skyUniforms.uSunDir,
      uTau: skyUniforms.uTau,
      uHazeDensity: skyUniforms.uHazeDensity,
      uHazeScaleH: skyUniforms.uHazeScaleH,
      uMarsFog: marsFog,
    });
    if (site) Object.assign(shader.uniforms, terrainUniforms, siteAlbedo, shadeUniforms, layerUniforms);
    else Object.assign(shader.uniforms, regionUniforms, siteAlbedo);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos; varying vec3 vWNormal;\n${site ? 'attribute float aSand; varying float vSand;' : ''}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal = normalize(mat3(modelMatrix) * normal);\n${site ? 'vSand = aSand;' : ''}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWPos; varying vec3 vWNormal;
${GROUND_GLSL}
${HAZE_GLSL}
uniform sampler2D uSiteAlb; uniform float uSiteAlbOn;
${
  site
    ? `varying float vSand;
uniform sampler2D uShade; uniform vec3 uShadowFocus;
uniform sampler2D uFow; uniform float uFowStrength;
uniform sampler2D uCost; uniform float uCostOn;
uniform sampler2D uLayer; uniform float uLayerOn;
uniform vec2 uRoverPos; uniform vec2 uRoverDir; uniform float uTime;
uniform vec3 uScanPos; uniform float uScanOn;
const float T_HALF = ${HALF.toFixed(1)}; const float T_SIZE = ${WORLD_SIZE.toFixed(1)}; const float T_CELL = 2.5;`
    : `uniform sampler2D uMidAlb; uniform sampler2D uRegAlb; uniform sampler2D uFarAlb; uniform float uRegionOn;
float boxFade(vec2 p, float half_, float band) { vec2 a = abs(p) / half_; return 1.0 - smoothstep(1.0 - band, 1.0, max(a.x, a.y)); }`
}
vec3 gExtraEmit = vec3(0.0); float gSun = 1.0; float gAo = 1.0; vec2 gNxy = vec2(0.0);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 geoN = normalize(vWNormal);
  float camD = distance(cameraPosition, vWPos);
  vec3 viewW = normalize(cameraPosition - vWPos);
${
  site
    ? `  vec2 wuv = (vWPos.xz + T_HALF) / T_SIZE;
  float macroL = uSiteAlbOn > 0.5 ? texture2D(uSiteAlb, wuv).r : 0.34 + 0.22 * (gNoise(vWPos.xz * 0.045) - 0.5) + 0.16 * (gNoise(vWPos.xz * 0.013 + 4.0) - 0.5);
  Ground g = marsGround(vWPos, geoN, vSand, macroL, camD, uSunDir);
  vec3 shade = texture2D(uShade, wuv).rgb;
  // Baked boulder shadows only where the live shadow map does not reach.
  float live = 1.0 - smoothstep(uShadowFocus.z * 0.72, uShadowFocus.z * 0.95, max(abs(vWPos.x - uShadowFocus.x), abs(vWPos.z - uShadowFocus.y)));
  gSun = shade.r * mix(shade.g, 1.0, live) * g.micro;
  gAo = shade.b;`
    : `  // Orbital imagery, from the widest to the sharpest that covers the point.
  float macroL = 0.38;
  if (uRegionOn > 0.5) {
    macroL = texture2D(uFarAlb, vWPos.xz / 220000.0 + 0.5).r;
    macroL = mix(macroL, texture2D(uRegAlb, vWPos.xz / 11000.0 + 0.5).r, boxFade(vWPos.xz, 5500.0, 0.12));
    macroL = mix(macroL, texture2D(uMidAlb, vWPos.xz / 2560.0 + 0.5).r, boxFade(vWPos.xz, 1280.0, 0.10));
    if (uSiteAlbOn > 0.5) macroL = mix(macroL, texture2D(uSiteAlb, vWPos.xz / ${WORLD_SIZE.toFixed(1)} + 0.5).r, boxFade(vWPos.xz, ${HALF.toFixed(1)}, 0.02));
  }
  Ground g = marsGround(vWPos, geoN, 0.0, macroL, camD, uSunDir);
#ifdef GROUND_STRATA
  // Layered rock shows on the slopes of Mount Sharp: thin bands that follow the elevation.
  float slopeF = smoothstep(0.05, 0.30, 1.0 - geoN.y);
  float band = vWPos.y / 9.0 + gNoise(vWPos.xz * 0.004) * 2.2;
  float bw = fwidth(band);
  float strata = (smoothstep(0.35, 0.65, abs(fract(band) - 0.5) * 2.0) - 0.5) * (1.0 - smoothstep(0.25, 0.9, bw));
  float coarse = (gNoise(vec2(vWPos.y / 60.0, 3.0) + gNoise(vWPos.xz * 0.0011) * 0.8) - 0.5);
  g.albedo *= 1.0 + slopeF * (0.22 * strata + 0.30 * coarse);
#endif`
}
  // Opposition surge: dusty ground brightens when you look straight down-Sun.
  g.albedo *= 1.0 + 0.20 * pow(max(dot(viewW, uSunDir), 0.0), 12.0);
  diffuseColor.rgb = g.albedo;
  gNxy = g.nxy;
  gAo *= mix(1.0, g.ao, 0.85);
${
  site
    ? `  float fow = texture2D(uFow, wuv).r;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.28 + 0.72 * fow), uFowStrength);
  if (uCostOn > 0.5) {
    vec2 rel = vWPos.xz - uRoverPos;
    float fwd = dot(rel, uRoverDir);
    float lat = dot(rel, vec2(-uRoverDir.y, uRoverDir.x));
    float inFan = step(-1.5, fwd) * step(fwd, 40.0) * step(abs(lat), 5.0 + fwd * 0.5);
    float m = inFan * (1.0 - smoothstep(26.0, 40.0, fwd));
    vec3 cc = texture2D(uCost, wuv).rgb;
    vec2 gc = fract((vWPos.xz + T_HALF) / T_CELL);
    float line = 1.0 - smoothstep(0.0, 0.05, min(min(gc.x, 1.0 - gc.x), min(gc.y, 1.0 - gc.y)));
    diffuseColor.rgb = mix(diffuseColor.rgb, cc, (0.22 + line * 0.25) * m);
  }
  if (uLayerOn > 0.5) {
    // Data layer of the package (lib/layers.ts): the mineral / slope colour over the ground, a little self-lit
    // so it still reads in the shade.
    vec4 lc = texture2D(uLayer, wuv);
    vec3 lin = pow(lc.rgb, vec3(2.2));
    diffuseColor.rgb = mix(diffuseColor.rgb, lin, lc.a * 0.85);
    gExtraEmit += lin * lc.a * 0.06;
  }
  if (uScanOn > 0.0) {
    float d = distance(vWPos.xz, uScanPos.xz);
    float ring = 1.0 - smoothstep(0.0, 0.25, abs(d - mod(uTime * 12.0, 30.0)));
    gExtraEmit += vec3(0.02, 0.07, 0.035) * ring * uScanOn * (1.0 - smoothstep(22.0, 30.0, d));
  }`
    : ''
}
}`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  // Detail relief: tangent frame of a height field (u = east, v = south).
  vec3 nW = normalize(vWNormal);
  vec3 tW = normalize(vec3(nW.y, -nW.x, 0.0));
  vec3 bW = cross(tW, nW);
  vec3 pW = normalize(nW * sqrt(max(0.05, 1.0 - dot(gNxy, gNxy))) + tW * gNxy.x + bW * gNxy.y);
  normal = normalize((viewMatrix * vec4(pW, 0.0)).xyz);
}`,
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
reflectedLight.directDiffuse *= gSun; reflectedLight.directSpecular *= gSun;
reflectedLight.indirectDiffuse *= gAo; reflectedLight.indirectSpecular *= gAo;`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gExtraEmit;')
      // Distance haze from the sky model (not a flat fog colour): the land fades into the sky it sits under.
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb = marsHaze(gl_FragColor.rgb, cameraPosition, vWPos);');
  };
  mat.customProgramCacheKey = () => `mars-ground-${kind}-${wide}-${micro}-${Q.farDetail}`;
  return mat;
}
