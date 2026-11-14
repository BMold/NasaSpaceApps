// The land beyond the 240 m site, out to 108 km: Mount Sharp's slopes, the
// floor of Gale crater and its rim, at true scale and with the real relief
// (MGS MOLA + MRO HiRISE, see render/galeData.ts). One mesh on a polar grid:
// rings a few metres apart next to the site and kilometres apart at the rim,
// dropping below the horizon with the curvature of Mars.
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { HALF, tiltAt } from '../../lib/terrain';
import { loadGale, regionalHeight } from '../../render/galeData';
import { makeGroundMaterial } from '../../render/groundMaterial';
import { Q } from '../../render/quality';

const R_INNER = HALF * 0.8; // under the site tile (its corners reach 1.41 × HALF)
const R_OUTER = 108000;
const MARS_RADIUS = 3389500;

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Ground height around the site: the tile's own border plane first, then the real relief. */
function farHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  // The tile ends on the plane tiltAt − 2; under the tile this mesh stays a little lower.
  const inside = Math.max(Math.abs(x), Math.abs(z));
  const plane = tiltAt(Math.max(-700, Math.min(700, x)), Math.max(-700, Math.min(700, z))) - 2 - 0.8 * (1 - sstep(HALF - 3, HALF + 1.5, inside));
  const h = plane + (regionalHeight(x, z) - 2 - plane) * sstep(HALF + 8, HALF + 500, r);
  return h - (r * r) / (2 * MARS_RADIUS);
}

function buildGeometry() {
  const rings = Q.farRings;
  const segs = Q.farSegs;
  const pos = new Float32Array(rings * segs * 3);
  const ratio = Math.pow(R_OUTER / R_INNER, 1 / (rings - 1));
  for (let k = 0; k < rings; k++) {
    const r = R_INNER * Math.pow(ratio, k);
    // Offset every other ring by half a step: no long straight seams in the triangles.
    const phase = (k % 2) * 0.5;
    for (let s = 0; s < segs; s++) {
      const a = ((s + phase) / segs) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      pos.set([x, farHeight(x, z), z], (k * segs + s) * 3);
    }
  }
  const idx = new Uint32Array((rings - 1) * segs * 6);
  let n = 0;
  for (let k = 0; k < rings - 1; k++)
    for (let s = 0; s < segs; s++) {
      const a = k * segs + s;
      const b = k * segs + ((s + 1) % segs);
      const c = (k + 1) * segs + s;
      const d = (k + 1) * segs + ((s + 1) % segs);
      if (k % 2 === 0) {
        idx.set([a, b, c, b, d, c], n);
      } else {
        idx.set([a, b, d, a, d, c], n);
      }
      n += 6;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function FarTerrain({ version }: { version: number }) {
  const [data, setData] = useState(0);
  useEffect(() => {
    let alive = true;
    loadGale().then(() => alive && setData((v) => v + 1));
    return () => {
      alive = false;
    };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geometry = useMemo(buildGeometry, [version, data]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const material = useMemo(() => makeGroundMaterial({ kind: 'region' }), []);
  return <mesh geometry={geometry} material={material} frustumCulled={false} raycast={() => null} />;
}
