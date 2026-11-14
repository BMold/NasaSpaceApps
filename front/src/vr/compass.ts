// Phone orientation, compass style.
//
// Uses the absolute (Earth-referenced) orientation when the browser gives it:
//   • Android Chrome: 'deviceorientationabsolute' (alpha measured from north)
//   • iOS Safari:     event.webkitCompassHeading
// so turning your body to face real north makes you look north on Mars
// (the scene's −Z). Falls back to the relative 'deviceorientation' if the
// device has no magnetometer. Double tap adds a yaw offset (recenter).
import * as THREE from 'three';

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };

export const compass = {
  alpha: 0, // degrees, counter-clockwise from north (W3C convention)
  beta: 90,
  gamma: 0,
  absolute: false, // alpha is referenced to magnetic north
  samples: 0,
  source: '' as '' | 'absolute' | 'ios-compass' | 'relative' | 'generic-absolute' | 'generic-relative' | 'gravity',
  yawOffset: 0, // radians added by "recenter"
  /** Generic Sensor API quaternion (device frame → East-North-Up), when that path is used. */
  sensorQ: [0, 0, 0, 1] as number[],
  sensorError: '',
};

const deg = Math.PI / 180;

function onAbsolute(e: DeviceOrientationEvent) {
  if (e.alpha === null || e.beta === null || e.gamma === null) return;
  compass.alpha = e.alpha;
  compass.beta = e.beta;
  compass.gamma = e.gamma;
  compass.absolute = true;
  compass.source = 'absolute';
  compass.samples++;
}

function onRelative(e: CompassEvent) {
  if (e.beta === null || e.gamma === null) return;
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    // iOS: heading is clockwise from north; alpha is counter-clockwise.
    compass.alpha = 360 - e.webkitCompassHeading;
    compass.absolute = true;
    compass.source = 'ios-compass';
  } else {
    if (compass.source === 'absolute' && compass.samples > 0) {
      // Android also fires the relative event: keep the absolute one.
      compass.beta = e.beta;
      compass.gamma = e.gamma;
      return;
    }
    if (e.alpha === null) return;
    compass.alpha = e.alpha;
    compass.source = 'relative';
  }
  compass.beta = e.beta;
  compass.gamma = e.gamma;
  compass.samples++;
}

let listening = false;
export function startCompass() {
  if (listening) return;
  listening = true;
  window.addEventListener('deviceorientationabsolute' as 'deviceorientation', onAbsolute as EventListener, true);
  window.addEventListener('deviceorientation', onRelative as EventListener, true);
}

/** iOS 13+ requires a permission prompt opened from a tap. */
export async function requestCompassPermission(): Promise<boolean> {
  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  if (!DOE) return false;
  if (typeof DOE.requestPermission === 'function') {
    try {
      return (await DOE.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fallback: Generic Sensor API (Chrome). Gives the orientation directly as a
// quaternion and, unlike the DOM events, reports WHY it fails (permission
// denied, no hardware, insecure page…).
// ---------------------------------------------------------------------------
type OrientationSensorLike = EventTarget & { quaternion: number[] | null; start(): void; stop(): void };
type SensorCtor = new (opts: { frequency: number; referenceFrame: 'screen' | 'device' }) => OrientationSensorLike;

let genericSensor: OrientationSensorLike | null = null;

export const hasGenericSensor = () =>
  typeof (window as unknown as { AbsoluteOrientationSensor?: unknown }).AbsoluteOrientationSensor === 'function' ||
  typeof (window as unknown as { RelativeOrientationSensor?: unknown }).RelativeOrientationSensor === 'function';

async function queryPermission(name: string) {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state;
  } catch {
    return 'n/a';
  }
}

/** Start AbsoluteOrientationSensor (compass) or, without magnetometer, RelativeOrientationSensor. */
export async function startGenericSensor(): Promise<boolean> {
  const w = window as unknown as { AbsoluteOrientationSensor?: SensorCtor; RelativeOrientationSensor?: SensorCtor };
  const tries: [SensorCtor | undefined, 'generic-absolute' | 'generic-relative', string[]][] = [
    [w.AbsoluteOrientationSensor, 'generic-absolute', ['accelerometer', 'gyroscope', 'magnetometer']],
    [w.RelativeOrientationSensor, 'generic-relative', ['accelerometer', 'gyroscope']],
  ];
  const errors: string[] = [];
  for (const [Ctor, source, perms] of tries) {
    if (!Ctor) continue;
    const states = await Promise.all(perms.map(queryPermission));
    if (states.includes('denied')) {
      errors.push(`${source}: permiso denegado (${perms.filter((_, i) => states[i] === 'denied').join(', ')})`);
      continue;
    }
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const sensor = new Ctor({ frequency: 60, referenceFrame: 'screen' });
        const done = (v: boolean) => {
          clearTimeout(timer);
          resolve(v);
        };
        const timer = setTimeout(() => {
          errors.push(`${source}: sin lecturas`);
          sensor.stop();
          done(false);
        }, 1500);
        sensor.addEventListener('reading', () => {
          if (!sensor.quaternion) return;
          compass.sensorQ = sensor.quaternion.slice();
          compass.source = source;
          compass.absolute = source === 'generic-absolute';
          compass.samples++;
          if (genericSensor !== sensor) {
            genericSensor = sensor;
            done(true);
          }
        });
        sensor.addEventListener('error', (ev) => {
          const err = (ev as unknown as { error?: { name?: string; message?: string } }).error;
          errors.push(`${source}: ${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim());
          sensor.stop();
          done(false);
        });
        sensor.start();
      } catch (e) {
        errors.push(`${source}: ${(e as Error).name} ${(e as Error).message}`);
        resolve(false);
      }
    });
    if (ok) {
      compass.sensorError = '';
      return true;
    }
  }
  compass.sensorError = errors.join(' · ') || (hasGenericSensor() ? 'sin lecturas' : 'API no disponible en este navegador');
  return false;
}

// ---------------------------------------------------------------------------
// Last resort: phones without a gyroscope (or whose gyroscope Chrome won't
// expose) still have an accelerometer. Gravity gives up/down and tilt, but not
// the compass direction: in this mode the yaw comes from the laptop (Q/E/mouse).
// ---------------------------------------------------------------------------
export const gravity = { x: 0, y: 9.8, z: 0, samples: 0, has: false };
let gravityOn = false;
function onMotion(e: DeviceMotionEvent) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null || a.y === null || a.z === null) return;
  if (Math.hypot(a.x, a.y, a.z) < 3) return;
  const k = gravity.samples ? 0.25 : 1; // low-pass: hide hand shake and steps
  gravity.x += (a.x - gravity.x) * k;
  gravity.y += (a.y - gravity.y) * k;
  gravity.z += (a.z - gravity.z) * k;
  gravity.samples++;
  gravity.has = true;
}
export function startGravity() {
  if (gravityOn) return;
  gravityOn = true;
  window.addEventListener('devicemotion', onMotion, true);
}
export function waitForGravity(ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (gravity.samples > 0) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}
const gScreen = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
/** Tilt-only camera quaternion (yaw 0 = north) from gravity, in the screen frame. */
export function gravityQuaternion(out: THREE.Quaternion) {
  const t = screenAngle() * deg;
  const c = Math.cos(t), s = Math.sin(t);
  // Device axes → screen axes (the page rotates with the screen).
  gScreen.set(gravity.x * c - gravity.y * s, gravity.x * s + gravity.y * c, gravity.z).normalize();
  return out.setFromUnitVectors(gScreen, worldUp);
}

// Yaw without gyroscope ------------------------------------------------------
// 1) Magnetometer (Generic Sensor `Magnetometer`; in Chrome Android it needs
//    chrome://flags/#enable-generic-sensor-extra-classes): tilt-compensated
//    compass from gravity + magnetic field, like Android's getRotationMatrix.
// 2) Otherwise, tilt the head sideways to turn (see tiltRoll).
export const mag = { x: 0, y: 0, z: 0, samples: 0, error: '' };
let magSensor: (EventTarget & { x: number | null; y: number | null; z: number | null; start(): void; stop(): void }) | null = null;

export async function startMagnetometer(): Promise<boolean> {
  if (magSensor) return mag.samples > 0;
  const Ctor = (window as unknown as { Magnetometer?: new (o: { frequency: number }) => NonNullable<typeof magSensor> }).Magnetometer;
  if (!Ctor) {
    mag.error = 'Magnetometer no disponible (activá chrome://flags/#enable-generic-sensor-extra-classes)';
    return false;
  }
  if ((await queryPermission('magnetometer')) === 'denied') {
    mag.error = 'permiso del magnetómetro denegado';
    return false;
  }
  return new Promise((resolve) => {
    try {
      const sensor = new Ctor({ frequency: 30 });
      const timer = setTimeout(() => {
        mag.error = 'magnetómetro sin lecturas';
        sensor.stop();
        resolve(false);
      }, 1500);
      sensor.addEventListener('reading', () => {
        if (sensor.x === null || sensor.y === null || sensor.z === null) return;
        // No per-reading filter: 'reading' only fires on change. The heading is smoothed per frame.
        mag.x = sensor.x;
        mag.y = sensor.y;
        mag.z = sensor.z;
        if (mag.samples++ === 0) {
          magSensor = sensor;
          mag.error = '';
          clearTimeout(timer);
          resolve(true);
        }
      });
      sensor.addEventListener('error', (ev) => {
        const err = (ev as unknown as { error?: { name?: string; message?: string } }).error;
        mag.error = `magnetómetro: ${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim();
        clearTimeout(timer);
        sensor.stop();
        resolve(false);
      });
      sensor.start();
    } catch (e) {
      mag.error = `magnetómetro: ${(e as Error).name} ${(e as Error).message}`;
      resolve(false);
    }
  });
}

const vA = new THREE.Vector3();
const vE = new THREE.Vector3();
const vH = new THREE.Vector3();
const vM = new THREE.Vector3();
/** Compass heading (radians, clockwise from north) of the camera, from gravity + magnetometer. */
export function magHeading(): number | null {
  if (!mag.samples || !gravity.samples) return null;
  vA.set(gravity.x, gravity.y, gravity.z).normalize(); // up, device frame
  vE.set(mag.x, mag.y, mag.z);
  vH.crossVectors(vE, vA); // east
  if (vH.lengthSq() < 1e-6) return null;
  vH.normalize();
  vM.crossVectors(vA, vH); // north
  // Camera forward is the device's −z (out of the back), whatever the screen rotation.
  return Math.atan2(-vH.z, -vM.z);
}

/** Head roll from gravity (radians, + = head tilted to the right). */
export function tiltRoll() {
  const t = screenAngle() * deg;
  const c = Math.cos(t), s = Math.sin(t);
  const gx = gravity.x * c - gravity.y * s;
  const gy = gravity.x * s + gravity.y * c;
  return Math.atan2(-gx, gy);
}

/** Wait until the sensor actually reports angles. */
export function waitForCompass(ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      if (compass.samples > 0) return resolve(true);
      if (performance.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // −90° around X: camera looks out of the back of the phone
const qYaw = new THREE.Quaternion();
const yAxis = new THREE.Vector3(0, 1, 0);

const screenAngle = () => {
  const so = screen.orientation?.angle;
  if (typeof so === 'number') return so;
  return (window as unknown as { orientation?: number }).orientation ?? 0;
};

// East-North-Up (Generic Sensor) → scene frame (+x east, +y up, −z north): −90° around X.
const qEnuToScene = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

/** Camera quaternion from the latest sensor angles (three.js convention, −Z forward = north at alpha 0). */
export function compassQuaternion(out: THREE.Quaternion) {
  if (compass.source === 'generic-absolute' || compass.source === 'generic-relative') {
    // With referenceFrame 'screen' the device frame already matches the camera
    // frame (x right, y up, looking out of the back along −z).
    const q = compass.sensorQ;
    out.set(q[0], q[1], q[2], q[3]).premultiply(qEnuToScene);
    if (compass.yawOffset) out.premultiply(qYaw.setFromAxisAngle(yAxis, compass.yawOffset));
    return out;
  }
  euler.set(compass.beta * deg, compass.alpha * deg, -compass.gamma * deg, 'YXZ');
  out.setFromEuler(euler);
  out.multiply(q1);
  out.multiply(q0.setFromAxisAngle(zee, -screenAngle() * deg));
  if (compass.yawOffset) out.premultiply(qYaw.setFromAxisAngle(yAxis, compass.yawOffset));
  return out;
}

/** Compass heading of a camera quaternion, degrees clockwise from north. */
const fwd = new THREE.Vector3();
export function headingDeg(q: THREE.Quaternion) {
  fwd.set(0, 0, -1).applyQuaternion(q);
  return ((Math.atan2(fwd.x, -fwd.z) / deg) % 360 + 360) % 360;
}
