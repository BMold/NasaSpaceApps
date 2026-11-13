// The ground: the walkable 240 m site, the land around it out to the rim of
// Gale crater, the boulders, the loose stones and the baked light of the site.
import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimStore } from '../../store/useSimStore';
import { BASE_A, HF_RES, ROCKS, WORLD_SIZE, albedoGrid, heights, sandGrid, siteTerrain } from '../../lib/terrain';
import { makeGroundMaterial, shadeUniforms, siteAlbedo } from '../../render/groundMaterial';
import { bakeShade, type Caster } from '../../render/shadeBake';
import { Q } from '../../render/quality';
import { ObstaclePicker } from './obstacleEditor';
import { FarTerrain } from './FarTerrain';
import { Clutter, Rocks, rockCasters } from './Rocks';
import { shadowFocus, skyState } from './Environment';

/** Real orbital image of the site (grey, 0.47 m per texel) as the large-scale tone of the ground. */
function refreshSiteAlbedo() {
  const g = albedoGrid();
  if (!g || !siteTerrain.hiRes) {
    siteAlbedo.uSiteAlbOn.value = 0;
    return;
  }
  const n = g.n;
  const data = new Uint8Array(n * n * 4);
  for (let k = 0; k < n * n; k++) {
    const v = Math.round(g.data[k * 3] * 255);
    data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = v;
    data[k * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Q.aniso;
  t.needsUpdate = true;
  siteAlbedo.uSiteAlb.value.dispose();
  siteAlbedo.uSiteAlb.value = t;
  siteAlbedo.uSiteAlbOn.value = 1;
}

/** Wall hanging from the border of the tile, so its edge never shows a gap. */
function buildSkirt() {
  const n = HF_RES;
  const half = WORLD_SIZE / 2;
  const step = WORLD_SIZE / (n - 1);
  const pos: number[] = [];
  const nor: number[] = [];
  const sand: number[] = [];
  const idx: number[] = [];
  const edge = (at: (i: number) => [number, number, number], nx: number, nz: number, flip: boolean) => {
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = at(i);
      pos.push(x, y, z, x, y - 8, z);
      nor.push(nx, 0.3, nz, nx, 0.3, nz);
      sand.push(0, 0);
      if (i < n - 1) {
        const a = base + i * 2;
        if (flip) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  };
  edge((i) => [-half + i * step, heights[i], -half], 0, -1, true);
  edge((i) => [-half + i * step, heights[(n - 1) * n + i], half], 0, 1, false);
  edge((i) => [-half, heights[i * n], -half + i * step], -1, 0, false);
  edge((i) => [half, heights[i * n + n - 1], -half + i * step], 1, 0, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aSand', new THREE.Float32BufferAttribute(sand, 1));
  g.setIndex(idx);
  return g;
}

/** Keeps the baked sunlight of the site up to date with the Sun, the relief and the obstacles. */
function ShadeBaker({ version }: { version: number }) {
  const hazards = useSimStore((s) => s.hazards);
  const done = useRef({ sky: -1, key: '' });
  useFrame(() => {
    shadeUniforms.uShadowFocus.value.set(shadowFocus.x, shadowFocus.z, Q.shadowHalf);
    const key = `${version}|${hazards.map((h) => `${h.id}:${h.x.toFixed(1)},${h.z.toFixed(1)}`).join(';')}`;
    if (done.current.sky === skyState.version && done.current.key === key) return;
    done.current = { sky: skyState.version, key };
    const casters: Caster[] = rockCasters(ROCKS);
    for (const h of hazards) if (h.rocks) casters.push(...rockCasters(h.rocks));
    // Habitat dome and its three modules.
    casters.push({ x: BASE_A.x - 7, z: BASE_A.z - 7, r: 3.5, h: 3.4 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      casters.push({ x: BASE_A.x - 7 + Math.cos(a) * 5.3, z: BASE_A.z - 7 + Math.sin(a) * 5.3, r: 1.9, h: 2.5 });
    }
    void bakeShade(skyState.sunDir, casters, version);
  });
  return null;
}

export function Terrain() {
  const terrainVersion = useSimStore((s) => s.terrainVersion);

  const geometry = useMemo(() => {
    const g = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, HF_RES - 1, HF_RES - 1);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heights[i]);
    g.deleteAttribute('uv');
    g.setAttribute('aSand', new THREE.BufferAttribute(sandGrid.slice(), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    refreshSiteAlbedo();
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrainVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const skirt = useMemo(buildSkirt, [terrainVersion]);
  const material = useMemo(() => makeGroundMaterial({ kind: 'site' }), []);

  return (
    <group>
      <mesh geometry={geometry} material={material} receiveShadow castShadow={Q.shadowMap > 1024} raycast={() => null} />
      <mesh geometry={skirt} material={material} raycast={() => null} />
      <ObstaclePicker version={terrainVersion} />
      <FarTerrain version={terrainVersion} />
      <Rocks version={terrainVersion} />
      <Clutter version={terrainVersion} />
      <ShadeBaker version={terrainVersion} />
    </group>
  );
}
