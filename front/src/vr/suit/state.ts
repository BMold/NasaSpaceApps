// Small shared state between the suit, the cameras and the drone.
import * as THREE from 'three';

export const suitState = {
  /** Where the head looks (world yaw, clockwise from north) and its pitch (+ up). Set by the view each frame. */
  lookYaw: 0,
  lookPitch: 0,
  /** World pose of the drone cradle on the backpack (valid once the suit has been animated). */
  dockPos: new THREE.Vector3(),
  dockQuat: new THREE.Quaternion(),
  dockValid: false,
  /** World position of the neck joint: the eyes sit just above and ahead of it. */
  neck: new THREE.Vector3(),
  /** Walking speed measured by the rig (m/s). */
  speed: 0,
  /** The rig's running self-checks (see SuitRig.debug). */
  debug: null as { clearMin: number; pelvisMin: number; kneeJerk: number; frames: number; pelvis: number; phase: number; stretch: number } | null,
};
