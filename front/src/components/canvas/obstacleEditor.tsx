// Drag-and-drop obstacles on the terrain (drone view). Placing or dragging an
// obstacle re-runs the costmap, the return field R(p) and the CTOPTW tour live,
// so the rover's reaction to each position can be watched as it happens.
//
// Picking uses a coarse invisible copy of the terrain (64 × 64) that only exists
// while a tool is active, so ordinary camera dragging never pays for a
// raycast against the full 241 × 241 mesh.
import { useMemo } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useSimStore } from '../../store/useSimStore';
import { addUserHazard, hazardAt, liveReplan, moveUserHazard, removeHazard } from '../../store/simEngine';
import { WORLD_SIZE, baseHeights, HF_RES, HALF, HF_STEP } from '../../lib/terrain';

let dragId: string | null = null;
let offset = { x: 0, z: 0 };

function endDrag() {
  window.removeEventListener('pointerup', endDrag);
  if (!dragId) return;
  dragId = null;
  liveReplan(true);
}

export function editorDown(e: ThreeEvent<PointerEvent>) {
  const tool = useSimStore.getState().obstacleTool;
  if (!tool || e.button !== 0) return;
  e.stopPropagation();
  const { x, z } = e.point;
  if (tool === 'erase') {
    const h = hazardAt(x, z);
    if (h) {
      removeHazard(h.id);
      liveReplan(true, 'Obstáculo borrado: ruta y tour recalculados.');
    }
    return;
  }
  if (tool === 'move') {
    const h = hazardAt(x, z);
    if (!h) return;
    dragId = h.id;
    offset = { x: h.x - x, z: h.z - z };
  } else {
    dragId = addUserHazard(tool, x, z);
    offset = { x: 0, z: 0 };
    liveReplan(false);
  }
  window.addEventListener('pointerup', endDrag);
}

export function editorMove(e: ThreeEvent<PointerEvent>) {
  if (!dragId) return;
  e.stopPropagation();
  moveUserHazard(dragId, e.point.x + offset.x, e.point.z + offset.z);
  liveReplan(false);
}

const SEG = 64;
const pickMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });

/** Invisible low-resolution terrain used only for placing / dragging obstacles. */
export function ObstaclePicker({ version }: { version: number }) {
  const tool = useSimStore((s) => s.obstacleTool);
  const geo = useMemo(() => {
    const g = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, SEG, SEG);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      // Base terrain (without user hills) keeps the picking plane stable while a hill is dragged.
      const fx = Math.round((p.getX(i) + HALF) / HF_STEP);
      const fz = Math.round((p.getZ(i) + HALF) / HF_STEP);
      p.setY(i, baseHeights[Math.min(HF_RES - 1, fz) * HF_RES + Math.min(HF_RES - 1, fx)]);
    }
    g.computeBoundingSphere();
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  if (!tool) return null;
  return <mesh geometry={geo} material={pickMat} onPointerDown={editorDown} onPointerMove={editorMove} />;
}
