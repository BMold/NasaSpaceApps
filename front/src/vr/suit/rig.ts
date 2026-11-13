// Procedural animation of the suit. No canned walk cycle: each boot is planted
// at a real point of the terrain and stays there while the body passes over
// it (no sliding), then swings to where the body will be half a stance later.
// Leg joints are solved by inverse kinematics, so the knees bend more going
// uphill, the boots follow the slope and the hips drop when the stride is long.
//
// Gait follows Mars gravity (0.38 g): strides are longer and slower than on
// Earth and, above ~1.4 m/s, the walk turns into a floating lope with both
// feet off the ground. Standing still, the feet shuffle to follow the body
// when it turns on the spot.
//
// What keeps it clean:
//  • the boots rest on the ground as it is DRAWN (triangles), sampled under the
//    heel, the toe and both edges of the sole, so they never sink into it;
//  • a foot that drifts out of the leg's reach steps at once instead of pulling
//    the hips down, and the hips never drop below a slight crouch;
//  • legs are never fully straight (soft limit), which is what makes IK knees
//    snap and wobble; hips ride on a spring, landing targets are smoothed.
import * as THREE from 'three';
import { meshHeightAt } from '../../lib/terrain';
import { buildSuit, DIM, type SuitParts } from './build';
import { suitUniforms } from './materials';

export interface SuitInput {
  x: number;
  z: number;
  /** Body yaw, radians clockwise from north. */
  bodyYaw: number;
  /** Where the head looks (world yaw) and its pitch (+ up). */
  headYaw: number;
  headPitch: number;
  firstPerson: boolean;
}

export interface StepEvent {
  x: number;
  y: number;
  z: number;
  yaw: number;
  side: 1 | -1; // +1 left, −1 right
  speed: number;
}

const LEG_MAX = (DIM.THIGH + DIM.SHIN) * 0.992;
const LEG_SOFT = 0.075; // the last centimetres of extension are approached asymptotically
const SPREAD = 0.112; // half distance between the feet
const SOLE_HALF = 0.05; // half width of the sole
const HIP_NOMINAL = DIM.HIP_H - 0.05; // suited walkers keep their knees a little bent
const HIP_MIN = DIM.HIP_H - 0.17; // the lowest the hips go (long stride, steep ground)
/** Furthest a planted foot may be from its hip, horizontally, before it has to step. */
const REACH = Math.sqrt((LEG_MAX * 0.97) ** 2 - (HIP_MIN - DIM.ANKLE_H) ** 2) - 0.03;
const MARS_G = 3.71;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

class Foot {
  pos = new THREE.Vector3(); // point of the sole under the ankle
  yaw = 0;
  from = new THREE.Vector3();
  to = new THREE.Vector3();
  fromYaw = 0;
  toYaw = 0;
  t = 1; // swing progress, ≥ 1 = planted
  dur = 0.4;
  lift = 0.08;
  pitch = 0; // heel-to-toe roll, + toe up
  pitchOff = 0; // pitch when the swing started
  stanceU = 0.5;
  ankle = new THREE.Vector3();
  /** Ankle offset from `pos` when the swing started (the heel is up at toe-off). */
  offFrom = new THREE.Vector3(0, DIM.ANKLE_H, 0);
  /** Tilt of the ground under the sole: toe up (+) and left edge up (+), radians. */
  slopePitch = 0;
  slopeRoll = 0;

  constructor(readonly side: 1 | -1) {}
}

const _v = new THREE.Vector3();
const _h = new THREE.Vector3();
const _a = new THREE.Vector3();
const _k = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _off = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _rootQ = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Quaternion of a limb segment whose local −Y runs along `along` and whose front (+Z) faces `front`. */
function aim(out: THREE.Quaternion, along: THREE.Vector3, front: THREE.Vector3) {
  _y.copy(along).multiplyScalar(-1).normalize();
  _z.copy(front).addScaledVector(_y, -front.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
  _z.normalize();
  _x.crossVectors(_y, _z);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

/**
 * Where the ankle is relative to the sole point for a heel-to-toe roll `p`: the boot pivots on
 * the ball of the foot when the heel is up (p < 0) and on the heel when the toe is up (p > 0).
 */
function pivot(out: THREE.Vector3, p: number, fx: number, fz: number) {
  const h = DIM.ANKLE_H;
  if (p < 0) {
    const c = Math.cos(-p), s = Math.sin(-p);
    const along = DIM.TOE - DIM.TOE * c + h * s;
    return out.set(fx * along, DIM.TOE * s + h * c, fz * along);
  }
  const c = Math.cos(p), s = Math.sin(p);
  const along = -DIM.HEEL + DIM.HEEL * c - h * s;
  return out.set(fx * along, DIM.HEEL * s + h * c, fz * along);
}

export class SuitRig {
  readonly parts: SuitParts = buildSuit();
  readonly root = this.parts.root;
  /** Called when a boot lands (footprints, dust). */
  onStep: ((e: StepEvent) => void) | null = null;
  /** World pose of the drone cradle on the backpack. */
  readonly dockPos = new THREE.Vector3();
  readonly dockQuat = new THREE.Quaternion();
  /** World position of the neck joint (the eyes are just above and ahead of it). */
  readonly neck = new THREE.Vector3();
  speed = 0;
  /** Running checks of the animation (development): lowest sole clearance, lowest hip, knee shake. */
  readonly debug = { clearMin: Infinity, pelvisMin: Infinity, kneeJerk: 0, frames: 0, pelvis: 0, phase: 0, stretch: 0 };
  private kneeHist = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private dtPrev = 1 / 60;

  private feet = [new Foot(1), new Foot(-1)];
  private phase = 0;
  private started = false;
  private moving = false;
  private last = new THREE.Vector2();
  private vel = new THREE.Vector2();
  private velSlow = new THREE.Vector2(); // steadier estimate, used to choose where a foot lands
  private pelvisY = HIP_NOMINAL;
  private pelvisVel = 0;
  private sway = 0;
  private lean = 0;
  private gait = 0; // 0 standing … 1 full stride, eased
  private time = 0;
  private idleWait = 0;
  private headShadow: THREE.Mesh;

  constructor() {
    this.parts.head.rotation.order = 'YXZ'; // turn, then nod
    this.parts.chest.rotation.order = 'YXZ';
    // In first person the helmet is not drawn, but it must still cast its shadow.
    const shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.headShadow = new THREE.Mesh(new THREE.SphereGeometry(0.165, 16, 12), shadowOnly);
    this.headShadow.position.set(0, 0.135, 0.012);
    this.headShadow.castShadow = true;
    this.headShadow.visible = false;
    this.parts.head.add(this.headShadow);
  }

  /**
   * Rest the sole on the drawn ground at (x, z): returns the height of the point under the ankle
   * such that neither the heel nor the toe is below the surface, and stores the tilt of the ground.
   */
  private rest(f: Foot, x: number, z: number): number {
    const fx = Math.sin(f.yaw), fz = -Math.cos(f.yaw);
    const lx = -Math.cos(f.yaw), lz = -Math.sin(f.yaw);
    const toe = meshHeightAt(x + fx * DIM.TOE, z + fz * DIM.TOE);
    const heel = meshHeightAt(x - fx * DIM.HEEL, z - fz * DIM.HEEL);
    const left = meshHeightAt(x + lx * SOLE_HALF, z + lz * SOLE_HALF);
    const right = meshHeightAt(x - lx * SOLE_HALF, z - lz * SOLE_HALF);
    f.slopePitch = Math.atan2(toe - heel, DIM.TOE + DIM.HEEL);
    f.slopeRoll = Math.atan2(left - right, 2 * SOLE_HALF);
    const line = heel + ((toe - heel) * DIM.HEEL) / (DIM.TOE + DIM.HEEL);
    // On a crest the middle of the sole is the contact; in a hollow, the heel and the toe.
    return Math.max(line, meshHeightAt(x, z), (left + right) / 2) + 0.004;
  }

  private place(i: number, x: number, z: number, yaw: number) {
    const f = this.feet[i];
    const lx = -Math.cos(yaw) * SPREAD * f.side;
    const lz = -Math.sin(yaw) * SPREAD * f.side;
    f.yaw = yaw - f.side * 0.1;
    f.pos.set(x + lx, 0, z + lz);
    f.pos.y = this.rest(f, f.pos.x, f.pos.z);
    f.t = 1;
    f.pitch = 0;
    f.ankle.copy(f.pos).y += DIM.ANKLE_H;
  }

  private startSwing(f: Foot, dur: number, lift: number) {
    f.from.copy(f.pos);
    f.offFrom.subVectors(f.ankle, f.pos);
    if (f.offFrom.lengthSq() < 1e-6 || f.offFrom.length() > 0.4) f.offFrom.set(0, DIM.ANKLE_H, 0);
    f.fromYaw = f.yaw;
    f.to.copy(f.pos);
    f.toYaw = f.yaw;
    f.t = 0;
    f.dur = Math.max(0.2, dur);
    f.lift = lift;
    f.pitchOff = f.pitch;
  }

  update(dtRaw: number, input: SuitInput) {
    const dt = clamp(dtRaw, 1e-4, 0.05);
    const { x, z, bodyYaw } = input;
    const P = this.parts;
    this.time += dt;

    // --- Velocity from the actual displacement (works on the laptop and on the phone) ---
    if (!this.started || Math.hypot(x - this.last.x, z - this.last.y) > 1.5) {
      this.started = true;
      this.last.set(x, z);
      this.vel.set(0, 0);
      this.velSlow.set(0, 0);
      this.place(0, x, z, bodyYaw);
      this.place(1, x, z, bodyYaw);
      this.pelvisY = HIP_NOMINAL;
      this.pelvisVel = 0;
    }
    const k = 1 - Math.exp(-dt * 9);
    this.vel.x += ((x - this.last.x) / dt - this.vel.x) * k;
    this.vel.y += ((z - this.last.y) / dt - this.vel.y) * k;
    this.velSlow.lerp(this.vel, 1 - Math.exp(-dt * 5));
    this.last.set(x, z);
    const v = this.vel.length();
    this.speed = v;
    const wasMoving = this.moving;
    this.moving = v > (wasMoving ? 0.1 : 0.2);

    const gy = meshHeightAt(x, z);
    this.root.position.set(x, gy, z);
    this.root.rotation.set(0, Math.PI - bodyYaw, 0);
    suitUniforms.uSuitGround.value = gy;

    const leftX = -Math.cos(bodyYaw);
    const leftZ = -Math.sin(bodyYaw);
    const hipDist = (f: Foot) => Math.hypot(f.pos.x - (x + leftX * DIM.HIP_W * f.side), f.pos.z - (z + leftZ * DIM.HIP_W * f.side));
    const home = (f: Foot, out: THREE.Vector3) => out.set(x + leftX * SPREAD * f.side, 0, z + leftZ * SPREAD * f.side);

    // --- Gait -------------------------------------------------------------
    // Walk up to ~1.4 m/s (short steps, one foot always down), then a lope: long floating steps,
    // brief contacts. The stance never covers more than ~0.8 m of ground: that is what a leg can do.
    const stepLen = v < 1.4 ? 0.4 + 0.3 * v : Math.min(2.4, 0.82 + 0.75 * (v - 1.4));
    const T = (2 * stepLen) / Math.max(v, 0.2);
    const beta = Math.min(v < 1.4 ? 0.64 - 0.1 * v : Math.max(0.2, 0.5 - 0.25 * (v - 1.4)), 0.8 / (2 * stepLen));
    this.gait = damp(this.gait, this.moving ? clamp(v / 1.2, 0, 1) : 0, 6, dt);
    const gaitK = this.gait;
    const liftFor = Math.min(0.3, 0.045 + 0.07 * v);

    if (this.moving) {
      if (!wasMoving) {
        // Lead with the foot that is furthest behind.
        const back = (f: Foot) => (f.pos.x - x) * this.vel.x + (f.pos.z - z) * this.vel.y;
        const lead = back(this.feet[0]) <= back(this.feet[1]) ? 0 : 1;
        if (this.feet[lead].t >= 1) {
          this.phase = (beta - (lead === 0 ? 0 : 0.5) + 1) % 1;
          this.startSwing(this.feet[lead], (1 - beta) * T, liftFor);
          home(this.feet[lead], this.feet[lead].to);
        }
      }
      const prev = this.phase;
      this.phase = (this.phase + dt / T) % 1;
      this.feet.forEach((f, i) => {
        const off = i === 0 ? 0 : 0.5;
        const lp = (this.phase + off) % 1;
        const lpPrev = (prev + off) % 1;
        const other = this.feet[1 - i];
        // Out of the leg's reach (speed or direction changed): step now, whatever the clock says.
        const late = f.t >= 1 && (other.t >= 1 || other.t > 0.55) && hipDist(f) > REACH;
        const onTime = lpPrev < beta && lp >= beta;
        if (f.t >= 1 && (onTime || late)) {
          if (late && !onTime) this.phase = (beta - off + 1) % 1;
          this.startSwing(f, (1 - beta) * T * (late && !onTime ? 0.8 : 1), liftFor);
        }
        if (f.t < 1) {
          // Aim at where the body will be at the middle of the coming stance; ease towards it so
          // small changes of speed do not make the foot swerve.
          const lead = (1 - f.t) * f.dur + 0.5 * beta * T;
          _v.set(x + this.velSlow.x * lead + leftX * SPREAD * f.side, 0, z + this.velSlow.y * lead + leftZ * SPREAD * f.side);
          if (f.t === 0) f.to.copy(_v);
          else f.to.lerp(_v, 1 - Math.exp(-dt * 14));
          f.toYaw = bodyYaw - f.side * 0.09;
        }
        f.stanceU = lp < beta ? lp / beta : 1;
      });
      this.idleWait = 0.1;
    } else {
      // Standing: bring the feet back under the hips, one at a time (also turns on the spot).
      this.idleWait -= dt;
      const err = (f: Foot) => {
        home(f, _v);
        return Math.hypot(f.pos.x - _v.x, f.pos.z - _v.z) + Math.abs(wrap(f.yaw - (bodyYaw - f.side * 0.1))) * 0.22;
      };
      const [a, b] = this.feet;
      if (a.t >= 1 && b.t >= 1) {
        const worst = err(a) >= err(b) ? a : b;
        const urgent = hipDist(worst) > REACH * 0.8;
        if (err(worst) > 0.07 && (this.idleWait <= 0 || urgent)) {
          const far = err(worst) > 0.3;
          this.startSwing(worst, far ? 0.34 : 0.28, far ? 0.07 : 0.04);
          this.idleWait = 0.06;
        }
      }
      for (const f of this.feet) {
        f.stanceU = 0.4;
        if (f.t < 1) {
          home(f, f.to);
          f.toYaw = bodyYaw - f.side * 0.1;
        }
      }
    }

    // --- Feet: swing arcs, landing, heel-to-toe roll -----------------------------
    for (const f of this.feet) {
      if (f.t < 1) {
        f.t = Math.min(1, f.t + dt / f.dur);
        const e = smoother(f.t);
        const gx = f.from.x + (f.to.x - f.from.x) * e;
        const gz = f.from.z + (f.to.z - f.from.z) * e;
        f.yaw = f.fromYaw + wrap(f.toYaw - f.fromYaw) * e;
        const ground = this.rest(f, gx, gz);
        const landing = meshHeightAt(f.to.x, f.to.z);
        // Quick lift behind the body, long reach forward: the arc peaks a third of the way through.
        const u = 1 - Math.pow(1 - f.t, 1.5);
        const arc = Math.sin(Math.PI * u) ** 2;
        f.pos.set(gx, Math.max(ground, f.from.y + (landing - f.from.y) * e) + f.lift * arc, gz);
        // Toe down while leaving the ground, toe up just before the heel strikes.
        f.pitch = f.pitchOff * (1 - smoother(clamp(f.t / 0.45, 0, 1))) + 0.17 * gaitK * smoother(clamp((f.t - 0.6) / 0.4, 0, 1));
        // The ankle leaves from where the toe-off left it and settles over the sole.
        const settle = smoother(clamp(f.t / 0.35, 0, 1));
        pivot(_off, f.pitch, Math.sin(f.yaw), -Math.cos(f.yaw));
        f.ankle.set(f.pos.x + f.offFrom.x + (_off.x - f.offFrom.x) * settle, f.pos.y + f.offFrom.y + (_off.y - f.offFrom.y) * settle, f.pos.z + f.offFrom.z + (_off.z - f.offFrom.z) * settle);
        if (f.t >= 1) {
          f.pos.y = this.rest(f, f.pos.x, f.pos.z);
          pivot(_off, f.pitch, Math.sin(f.yaw), -Math.cos(f.yaw));
          f.ankle.copy(f.pos).add(_off);
          this.onStep?.({ x: f.pos.x, y: f.pos.y, z: f.pos.z, yaw: f.yaw, side: f.side, speed: v });
        }
      } else {
        // Stance: roll from heel to toe; the heel lifts over the last third.
        const heelStrike = 0.17 * gaitK * (1 - smoother(clamp(f.stanceU / 0.18, 0, 1)));
        const heelOff = 0.5 * (0.3 + 0.7 * gaitK) * smoother(clamp((f.stanceU - 0.6) / 0.4, 0, 1));
        f.pitch = damp(f.pitch, this.moving ? heelStrike - heelOff : 0, 18, dt);
        pivot(_off, f.pitch, Math.sin(f.yaw), -Math.cos(f.yaw));
        f.ankle.copy(f.pos).add(_off);
      }
    }

    // --- Pelvis: on a spring, as high as the planted legs allow, never below a crouch ---
    const flight = clamp(0.5 - beta, 0, 0.3) * T; // time with both feet in the air
    const bobAmp = Math.min(0.06, ((MARS_G * flight * flight) / 8) * 2.2) * gaitK;
    const bob = bobAmp * Math.sin(4 * Math.PI * (this.phase - (beta + 0.5) / 2) + Math.PI / 2) + 0.01 * gaitK * Math.sin(4 * Math.PI * this.phase - 1.2) + 0.004 * (1 - gaitK) * Math.sin(this.time * 1.6);
    let targetY = gy + HIP_NOMINAL - 0.025 * gaitK + bob;
    const legLimit = (LEG_MAX * 0.97) ** 2;
    for (const f of this.feet) {
      if (f.t < 1 && f.t < 0.9) continue; // a swinging leg does not hold the hips
      const horiz = Math.hypot(f.ankle.x - (x + leftX * DIM.HIP_W * f.side), f.ankle.z - (z + leftZ * DIM.HIP_W * f.side));
      targetY = Math.min(targetY, f.ankle.y + Math.sqrt(Math.max(0.01, legLimit - horiz * horiz)));
    }
    targetY = Math.max(targetY, gy + HIP_MIN);
    const W = 15; // spring frequency (rad/s), critically damped
    this.pelvisVel += (W * W * (targetY - gy - this.pelvisY) - 2 * W * this.pelvisVel) * dt;
    this.pelvisY = clamp(this.pelvisY + this.pelvisVel * dt, HIP_MIN - 0.02, DIM.HIP_H + 0.06);
    const stanceSide = Math.cos(2 * Math.PI * this.phase) * gaitK; // + over the left foot
    this.sway = damp(this.sway, 0.02 * stanceSide * (1 - 0.5 * gaitK), 10, dt);
    this.lean = damp(this.lean, this.moving ? 0.045 + 0.05 * Math.min(v, 3.2) : 0.012, 5, dt);
    const stride = Math.sin(2 * Math.PI * this.phase + 0.5) * gaitK;

    P.pelvis.position.set(this.sway, this.pelvisY, 0);
    P.pelvis.rotation.set(this.lean * 0.35, 0.075 * stride, -0.03 * stanceSide);

    // --- Chest and head --------------------------------------------------------
    const breathe = Math.sin(this.time * 1.45);
    const lookYaw = clamp(wrap(input.headYaw - bodyYaw), -1.35, 1.35);
    const lookPitch = clamp(input.headPitch, -0.85, 0.7);
    P.chest.rotation.set(this.lean * 0.65 + 0.006 * breathe - lookPitch * 0.08, -0.1 * stride - lookYaw * 0.2, 0.026 * stanceSide);
    P.head.rotation.set(-lookPitch * 0.86, -lookYaw * 0.8, 0);

    // --- Arms: swing against the legs, held a little away from the body by the suit's pressure ---
    const swing = (0.17 + 0.12 * Math.min(v, 3)) * gaitK;
    const armPhase = Math.cos(2 * Math.PI * this.phase);
    P.arms.forEach((arm, i) => {
      const s = i === 0 ? 1 : -1;
      const sw = -s * swing * armPhase; // left arm is back when the left foot is forward
      const idle = 0.012 * Math.sin(this.time * 0.9 + i * 2.1);
      arm.shoulder.rotation.set(-0.03 - sw * 1.15 + idle - this.lean * 0.5, 0, s * (0.19 + 0.03 * breathe));
      // Elbows a little bent by the suit's pressure; they fold more as the arm comes forward.
      arm.elbow.rotation.set(-(0.26 + 0.14 * gaitK + Math.max(0, sw) * 1.1), 0, -s * 0.06);
      arm.wrist.rotation.set(0, s * 0.35, s * 0.08);
    });

    // --- Legs: two-bone IK from each hip to its ankle, in the body frame ---------
    this.root.updateMatrixWorld(true);
    this.root.getWorldQuaternion(_rootQ);
    P.legs.forEach((leg, i) => {
      const f = this.feet[i];
      // Boot: flat on the ground it stands on (its tilt comes from the heights under the sole);
      // in the air it mostly levels out. `pitch` is the heel-to-toe roll on top of that.
      const grounded = f.t >= 1 ? 1 : 1 - 0.6 * Math.sin(Math.PI * f.t);
      _q.setFromEuler(_e.set(-(f.pitch + f.slopePitch * grounded), Math.PI - f.yaw, f.slopeRoll * grounded, 'YXZ'));
      // Last word on penetration: where the heel and the toe really end up, they must be above
      // the drawn ground (slopes, creases between triangles). Lift the ankle by any shortfall.
      let lift = 0;
      for (const zz of [-DIM.HEEL - 0.01, DIM.TOE + 0.01]) {
        _v.set(0, -DIM.ANKLE_H, zz).applyQuaternion(_q).add(f.ankle);
        lift = Math.max(lift, meshHeightAt(_v.x, _v.z) + 0.008 - _v.y);
      }
      f.ankle.y += lift;
      _h.set(f.side * DIM.HIP_W, 0, 0);
      P.pelvis.localToWorld(_h);
      this.root.worldToLocal(_h);
      _a.copy(f.ankle);
      this.root.worldToLocal(_a);
      _dir.subVectors(_a, _h);
      let d = Math.max(_dir.length(), 1e-4);
      _dir.multiplyScalar(1 / d);
      // Soft limit: the leg approaches full extension without ever locking straight (no knee snap).
      const knee = LEG_MAX - LEG_SOFT;
      if (d > knee) {
        d = knee + LEG_SOFT * (1 - Math.exp(-(d - knee) / LEG_SOFT));
        _a.copy(_h).addScaledVector(_dir, d);
      }
      if (i === 0) this.debug.stretch = d / LEG_MAX;
      d = Math.max(d, 0.32);
      const cosHip = clamp((DIM.THIGH * DIM.THIGH + d * d - DIM.SHIN * DIM.SHIN) / (2 * DIM.THIGH * d), -1, 1);
      const sinHip = Math.sqrt(1 - cosHip * cosHip);
      // The knee bends towards where the foot points.
      const rel = wrap(f.yaw - bodyYaw);
      _bend.set(-Math.sin(rel) * 0.6 + f.side * 0.08, 0.12, Math.cos(rel));
      _bend.addScaledVector(_dir, -_bend.dot(_dir)).normalize();
      _k.copy(_h).addScaledVector(_dir, DIM.THIGH * cosHip).addScaledVector(_bend, DIM.THIGH * sinHip);
      leg.thigh.position.copy(_h);
      aim(leg.thigh.quaternion, _v.subVectors(_k, _h), _bend);
      leg.shin.position.copy(_k);
      aim(leg.shin.quaternion, _v.subVectors(_a, _k), _bend);
      leg.foot.position.copy(_a);
      leg.foot.quaternion.copy(_rootQ).invert().multiply(_q);
    });

    // --- Self-checks ------------------------------------------------------------------
    const D = this.debug;
    D.frames++;
    D.pelvisMin = Math.min(D.pelvisMin, this.pelvisY);
    D.pelvis = this.pelvisY;
    D.phase = this.phase;
    P.legs.forEach((leg, i) => {
      leg.foot.updateMatrixWorld(true);
      for (const zz of [-DIM.HEEL, DIM.TOE]) {
        _v.set(0, -DIM.ANKLE_H, zz).applyMatrix4(leg.foot.matrixWorld);
        D.clearMin = Math.min(D.clearMin, _v.y - meshHeightAt(_v.x, _v.z));
      }
      // Knee acceleration in the body frame: large values are what reads as "wobbly" legs.
      const pos = this.kneeHist[i * 2];
      const vel = this.kneeHist[i * 2 + 1];
      _k.copy(leg.shin.position).sub(pos).multiplyScalar(1 / dt); // velocity over this frame
      if (D.frames > 3) D.kneeJerk = Math.max(D.kneeJerk, _v.copy(_k).sub(vel).length() / ((dt + this.dtPrev) / 2));
      vel.copy(_k);
      pos.copy(leg.shin.position);
    });
    this.dtPrev = dt;

    // --- First person: hide the helmet (keep its shadow) ----------------------------
    for (const m of P.headMeshes) m.visible = !input.firstPerson;
    this.headShadow.visible = input.firstPerson;

    this.root.updateMatrixWorld(true);
    P.dock.getWorldPosition(this.dockPos);
    P.dock.getWorldQuaternion(this.dockQuat);
    P.head.getWorldPosition(this.neck);
  }
}
