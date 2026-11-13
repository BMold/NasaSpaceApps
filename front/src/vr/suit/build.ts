// Geometry of the EVA suit: a slim, white, single-piece pressure suit in the
// style of SpaceX's flight / EVA suits (dark side panels and boots, close
// fitting helmet with a wide coated visor), plus the life-support backpack
// that carries the scout drone. No logos or markings of any real organisation.
//
// The body is a small skeleton of rigid, overlapping segments with bellows at
// the joints, as a pressurised suit really is: that is what lets the legs be
// posed by inverse kinematics without any skinning.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three-stdlib';
import { Q } from '../../render/quality';
import { makeSuitMaterials, type SuitMaterials } from './materials';

/** Body dimensions, metres (a 1.80 m person in the suit: helmet top at 1.89 m, eyes at 1.70 m). */
export const DIM = {
  HIP_H: 0.95,
  HIP_W: 0.1,
  THIGH: 0.43,
  SHIN: 0.43,
  ANKLE_H: 0.09,
  TOE: 0.2, // ankle → ball of the foot
  HEEL: 0.07, // ankle → back of the heel
  LUMBAR: 0.13, // hip centre → lower spine joint
  NECK: 0.48, // lower spine joint → head pivot
  SHOULDER_X: 0.222,
  SHOULDER_Y: 0.385,
  UPPER_ARM: 0.295,
  FOREARM: 0.265,
  EYE_UP: 0.14, // head pivot → eyes
  EYE_FWD: 0.14,
};

const SEG = Math.max(16, Q.suitSegs);

type P = [number, number]; // radius, height

/** Surface of revolution through smoothed profile points (radius, y), y increasing. */
function lathe(points: P[], phiStart = 0, phiLength = Math.PI * 2, grow = 1, smooth = 28) {
  const curve = new THREE.SplineCurve(points.map(([r, y]) => new THREE.Vector2(r * grow, y)));
  return new THREE.LatheGeometry(curve.getPoints(smooth), phiLength >= Math.PI * 2 ? SEG : Math.max(4, Math.round((SEG * phiLength) / (Math.PI * 2))), phiStart, phiLength);
}

/** A limb segment hanging from its joint: from y = 0 down to y = −len, rounded at both ends. */
function limb(rTop: number, rBot: number, len: number, bulge = 0) {
  const pts: THREE.Vector2[] = [];
  const cap = 5;
  const body = 10;
  for (let i = 0; i <= cap; i++) {
    const a = ((i / cap) * Math.PI) / 2;
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.sin(a) * rBot), -len - Math.cos(a) * rBot * 0.55));
  }
  for (let i = 1; i < body; i++) {
    const t = i / body;
    pts.push(new THREE.Vector2(rBot + (rTop - rBot) * t + bulge * Math.sin(Math.PI * t), -len + len * t));
  }
  for (let i = cap; i >= 0; i--) {
    const a = ((i / cap) * Math.PI) / 2;
    pts.push(new THREE.Vector2(Math.max(1e-4, Math.sin(a) * rTop), Math.cos(a) * rTop * 0.55));
  }
  return new THREE.LatheGeometry(pts, SEG);
}

/** Ring lying in the horizontal plane (axis = Y). */
function ring(radius: number, tube: number, tubeSeg = 8) {
  const g = new THREE.TorusGeometry(radius, tube, tubeSeg, SEG);
  g.rotateX(Math.PI / 2);
  return g;
}

function add<T extends THREE.Object3D>(parent: THREE.Object3D, child: T, x = 0, y = 0, z = 0): T {
  child.position.set(x, y, z);
  parent.add(child);
  return child;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Convoluted joint: a stack of rings, the way pressure-suit elbows and knees are built. */
function bellows(parent: THREE.Object3D, mat: THREE.Material, radius: number, y0: number, count: number, pitch: number, tube: number) {
  const geo = ring(radius, tube, 6);
  for (let i = 0; i < count; i++) add(parent, mesh(geo, mat), 0, y0 - i * pitch, 0);
}

function buildBoot(M: SuitMaterials) {
  const outline = (k: number) => {
    const s = new THREE.Shape();
    s.moveTo(-0.04 * k, -0.085 * k);
    s.bezierCurveTo(-0.047 * k, -0.02 * k, -0.057 * k, 0.06 * k, -0.055 * k, 0.13 * k);
    s.bezierCurveTo(-0.053 * k, 0.19 * k, -0.03 * k, 0.215 * k, 0, 0.215 * k);
    s.bezierCurveTo(0.03 * k, 0.215 * k, 0.053 * k, 0.19 * k, 0.055 * k, 0.13 * k);
    s.bezierCurveTo(0.057 * k, 0.06 * k, 0.047 * k, -0.02 * k, 0.04 * k, -0.085 * k);
    s.bezierCurveTo(0.03 * k, -0.103 * k, -0.03 * k, -0.103 * k, -0.04 * k, -0.085 * k);
    return s;
  };
  const orient = (g: THREE.BufferGeometry) => {
    g.rotateX(-Math.PI / 2); // extrusion depth → up
    g.rotateY(Math.PI); // toe → +Z
    return g;
  };
  const foot = new THREE.Group();
  const sole = orient(new THREE.ExtrudeGeometry(outline(1), { depth: 0.022, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 10 }));
  add(foot, mesh(sole, M.rubber), 0, -DIM.ANKLE_H + 0.004, 0);
  const upper = orient(new THREE.ExtrudeGeometry(outline(0.9), { depth: 0.05, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.03, bevelSegments: 5, curveSegments: 10 }));
  add(foot, mesh(upper, M.dark), 0, -DIM.ANKLE_H + 0.03, 0);
  // Ankle: where the boot meets the leg.
  const ankle = mesh(new THREE.SphereGeometry(0.066, SEG, 10), M.dark);
  ankle.scale.set(1, 0.95, 1.12);
  add(foot, ankle, 0, -0.012, -0.004);
  // Toe cap and heel counter in a lighter grey, like moulded reinforcements.
  const toe = mesh(new THREE.SphereGeometry(0.05, SEG, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.grey);
  toe.scale.set(1.02, 0.62, 1.25);
  add(foot, toe, 0, -DIM.ANKLE_H + 0.05, 0.142);
  return foot;
}

function buildHand(M: SuitMaterials, side: 1 | -1) {
  const hand = new THREE.Group();
  // Wrist disconnect ring, then the glove. Palm faces the body (−side X).
  add(hand, mesh(ring(0.047, 0.011), M.darkMetal), 0, 0.004, 0);
  const cuff = mesh(limb(0.046, 0.04, 0.04), M.grey);
  add(hand, cuff, 0, -0.004, 0);
  const palm = mesh(new RoundedBoxGeometry(0.036, 0.092, 0.086, 3, 0.014), M.white);
  add(hand, palm, 0, -0.088, 0.004);
  const pad = mesh(new RoundedBoxGeometry(0.012, 0.07, 0.07, 2, 0.005), M.dark);
  add(hand, pad, -side * 0.017, -0.09, 0.004);
  const fingerGeo = new THREE.CapsuleGeometry(0.0108, 0.05, 4, 8);
  for (let i = 0; i < 4; i++) {
    const knuckle = new THREE.Group();
    add(hand, knuckle, 0, -0.134, -0.029 + i * 0.0215);
    knuckle.rotation.z = -side * (0.3 + 0.07 * i); // relaxed curl towards the palm
    add(knuckle, mesh(fingerGeo, M.white), 0, -0.03, 0);
    const tip = new THREE.Group();
    add(knuckle, tip, 0, -0.058, 0);
    tip.rotation.z = -side * 0.45;
    add(tip, mesh(new THREE.CapsuleGeometry(0.0102, 0.022, 4, 8), M.dark), 0, -0.016, 0);
  }
  const thumb = new THREE.Group();
  add(hand, thumb, -side * 0.006, -0.07, 0.05);
  thumb.rotation.set(0.55, 0, -side * 0.5);
  add(thumb, mesh(new THREE.CapsuleGeometry(0.0125, 0.045, 4, 8), M.white), 0, -0.03, 0);
  return hand;
}

function buildHelmet(M: SuitMaterials, headMeshes: THREE.Mesh[]) {
  const head = new THREE.Group();
  const push = <T extends THREE.Mesh>(m: T) => {
    headMeshes.push(m);
    return m;
  };
  const RX = 0.152, RY = 0.168, RZ = 0.176;
  const CY = 0.135, CZ = 0.012;
  // Shell: single smooth piece, slightly longer front to back.
  const shell = push(mesh(new THREE.SphereGeometry(1, Math.max(24, SEG * 2), Math.max(16, SEG)), M.whiteShell));
  shell.scale.set(RX, RY, RZ);
  add(head, shell, 0, CY, CZ);
  // Visor: a wide wrap-around window. Sphere patch a hair proud of the shell (phi = π/2 is +Z, the front).
  const phiHalf = 1.32;
  const th0 = 0.27 * Math.PI;
  const th1 = 0.67 * Math.PI;
  const visor = push(mesh(new THREE.SphereGeometry(1.012, Math.max(24, SEG * 2), Math.max(12, SEG), Math.PI / 2 - phiHalf, phiHalf * 2, th0, th1 - th0), M.visor));
  visor.scale.set(RX, RY, RZ);
  visor.receiveShadow = false;
  add(head, visor, 0, CY, CZ);
  // Gasket around the visor opening.
  const onShell = (phi: number, th: number, grow = 1.02) => new THREE.Vector3(-Math.cos(phi) * Math.sin(th) * RX * grow, Math.cos(th) * RY * grow + CY, Math.sin(phi) * Math.sin(th) * RZ * grow + CZ);
  const pts: THREE.Vector3[] = [];
  const N = 14;
  const p0 = Math.PI / 2 - phiHalf;
  const p1 = Math.PI / 2 + phiHalf;
  for (let i = 0; i < N; i++) pts.push(onShell(p0 + ((p1 - p0) * i) / N, th0));
  for (let i = 0; i < N / 2; i++) pts.push(onShell(p1, th0 + ((th1 - th0) * i) / (N / 2)));
  for (let i = 0; i < N; i++) pts.push(onShell(p1 - ((p1 - p0) * i) / N, th1));
  for (let i = 0; i < N / 2; i++) pts.push(onShell(p0, th1 - ((th1 - th0) * i) / (N / 2)));
  const gasket = push(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.3), 96, 0.0075, 6, true), M.dark));
  head.add(gasket);
  // Dark accent running over the crown, front to back.
  const crown: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const th = th0 - 0.02 - ((th0 - 0.02 + 0.55 * Math.PI) * i) / 16; // from above the visor, over the top, down the back
    const t = Math.abs(th);
    crown.push(new THREE.Vector3(0, Math.cos(t) * RY * 1.012 + CY, (th >= 0 ? 1 : -1) * Math.sin(t) * RZ * 1.012 + CZ));
  }
  head.add(push(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(crown), 40, 0.011, 6, false), M.grey)));
  // Lamp / camera pods at the temples.
  for (const s of [1, -1]) {
    const pod = push(mesh(new RoundedBoxGeometry(0.028, 0.046, 0.085, 2, 0.008), M.grey));
    add(head, pod, s * (RX + 0.004), CY + 0.1, CZ - 0.02);
    add(head, push(mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.006, 12).rotateX(Math.PI / 2), M.lamp)), s * (RX + 0.006), CY + 0.109, CZ + 0.024);
    add(head, push(mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.006, 10).rotateX(Math.PI / 2), M.screen)), s * (RX + 0.006), CY + 0.089, CZ + 0.024);
  }
  // Neck: soft collar between the helmet and the locking ring.
  const collar = push(mesh(lathe([[0.118, -0.03], [0.124, 0.0], [0.128, 0.03], [0.122, 0.055]]), M.grey));
  add(head, collar, 0, -0.02, 0.004);
  return head;
}

export interface SuitParts {
  root: THREE.Group;
  pelvis: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  arms: { shoulder: THREE.Group; elbow: THREE.Group; wrist: THREE.Group }[]; // [left (+X), right (−X)]
  legs: { thigh: THREE.Group; shin: THREE.Group; foot: THREE.Group }[];
  headMeshes: THREE.Mesh[];
  /** Where the scout drone sits on the backpack. */
  dock: THREE.Object3D;
  materials: SuitMaterials;
}

export function buildSuit(): SuitParts {
  const M = makeSuitMaterials();
  const root = new THREE.Group();
  const headMeshes: THREE.Mesh[] = [];

  // --- Pelvis -------------------------------------------------------------
  const pelvis = add(root, new THREE.Group(), 0, DIM.HIP_H, 0);
  const hips = mesh(lathe([[0.03, -0.145], [0.115, -0.125], [0.16, -0.06], [0.17, 0.02], [0.162, 0.1], [0.152, 0.15]]), M.white);
  hips.scale.z = 0.8;
  pelvis.add(hips);
  // Waist: bearing ring and harness belt.
  const belt = mesh(ring(0.158, 0.017), M.grey);
  belt.scale.z = 0.8;
  add(pelvis, belt, 0, 0.115, 0);
  for (const s of [1, -1]) {
    const pocket = mesh(new RoundedBoxGeometry(0.03, 0.1, 0.085, 2, 0.01), M.white);
    add(pelvis, pocket, s * 0.168, 0.0, 0.012);
  }

  // --- Chest --------------------------------------------------------------
  const chest = add(pelvis, new THREE.Group(), 0, DIM.LUMBAR, 0);
  const torsoPts: P[] = [[0.15, -0.03], [0.158, 0.02], [0.176, 0.12], [0.195, 0.24], [0.2, 0.32], [0.183, 0.4], [0.142, 0.445], [0.114, 0.47], [0.06, 0.478], [0.002, 0.48]];
  const torso = mesh(lathe(torsoPts), M.white);
  torso.scale.z = 0.76;
  chest.add(torso);
  // Dark side panels from the armpit to the hip (Lathe phi: 0 = front, π/2 = +X).
  const panelPts: P[] = [[0.152, -0.02], [0.158, 0.02], [0.176, 0.12], [0.195, 0.24], [0.199, 0.3]];
  for (const c of [Math.PI / 2, (3 * Math.PI) / 2]) {
    const panel = mesh(lathe(panelPts, c - 0.5, 1.0, 1.012), M.grey);
    panel.scale.z = 0.76;
    chest.add(panel);
  }
  // Dark yoke over the shoulders, up to the neck ring.
  const yoke = mesh(lathe([[0.2, 0.33], [0.186, 0.395], [0.146, 0.445], [0.118, 0.472]], 0, Math.PI * 2, 1.012, 14), M.grey);
  yoke.scale.z = 0.76;
  chest.add(yoke);
  headMeshes.push(yoke); // right under the chin: hidden with the helmet in first person
  // Neck locking ring.
  headMeshes.push(add(chest, mesh(ring(0.118, 0.017), M.darkMetal), 0, 0.468, 0.004)); // hidden with the helmet in first person
  // Chest unit: display and controls.
  const unit = mesh(new RoundedBoxGeometry(0.17, 0.115, 0.05, 3, 0.012), M.grey);
  add(chest, unit, 0, 0.255, 0.148);
  unit.rotation.x = -0.12;
  const screen = mesh(new THREE.PlaneGeometry(0.085, 0.05), M.screen);
  add(unit, screen, -0.028, 0.012, 0.0256);
  add(unit, mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.014, 12).rotateX(Math.PI / 2), M.darkMetal), 0.05, 0.022, 0.03);
  add(unit, mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 10).rotateX(Math.PI / 2), M.darkMetal), 0.05, -0.014, 0.03);
  add(unit, mesh(new THREE.SphereGeometry(0.0045, 8, 6), M.ledGreen), 0.022, -0.036, 0.026);
  add(unit, mesh(new THREE.SphereGeometry(0.0045, 8, 6), M.ledAmber), 0.006, -0.036, 0.026);
  // Harness straps over the shoulders.
  for (const s of [1, -1]) {
    const strap: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = -0.15 + (Math.PI + 0.3) * (i / 12); // from the chest, over the shoulder, to the pack
      strap.push(new THREE.Vector3(s * 0.105, 0.33 + Math.sin(a) * 0.125, Math.cos(a) * 0.155 - 0.01));
    }
    const strapMesh = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(strap), 24, 0.014, 6, false), M.grey);
    chest.add(strapMesh);
    headMeshes.push(strapMesh);
  }

  // --- Life-support backpack ------------------------------------------------
  const pack = add(chest, new THREE.Group(), 0, 0.2, -0.2);
  pack.add(mesh(new RoundedBoxGeometry(0.38, 0.57, 0.165, 4, 0.045), M.whiteShell));
  add(pack, mesh(new RoundedBoxGeometry(0.3, 0.16, 0.03, 2, 0.01), M.grey), 0, -0.16, -0.078); // radiator panel
  for (let i = 0; i < 6; i++) add(pack, mesh(new THREE.BoxGeometry(0.26, 0.006, 0.008), M.dark), 0, -0.215 + i * 0.022, -0.0945);
  for (const s of [1, -1]) {
    // Oxygen bottles half sunk in the sides.
    const tank = mesh(new THREE.CapsuleGeometry(0.048, 0.33, 6, SEG), M.metal);
    add(pack, tank, s * 0.168, -0.02, -0.01);
    // Umbilicals from the pack to the chest unit.
    const hose: THREE.Vector3[] = [new THREE.Vector3(s * 0.15, -0.2, 0.04), new THREE.Vector3(s * 0.215, -0.17, 0.16), new THREE.Vector3(s * 0.2, -0.05, 0.3), new THREE.Vector3(s * 0.1, 0.03, 0.36), new THREE.Vector3(s * 0.085, 0.05, 0.345)];
    pack.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hose), 32, 0.0125, 8, false), M.grey));
  }
  add(pack, mesh(new THREE.SphereGeometry(0.006, 8, 6), M.ledGreen), 0.12, 0.2, -0.084);
  add(pack, mesh(new THREE.SphereGeometry(0.006, 8, 6), M.ledAmber), 0.1, 0.2, -0.084);
  const whip = mesh(new THREE.CylinderGeometry(0.0025, 0.004, 0.34, 6), M.darkMetal);
  add(pack, whip, -0.15, 0.44, -0.03);
  add(pack, mesh(new THREE.SphereGeometry(0.008, 8, 6), M.dark), -0.15, 0.61, -0.03);
  // Drone cradle on top of the pack.
  const cradle = add(pack, new THREE.Group(), 0, 0.295, -0.005);
  cradle.add(mesh(new RoundedBoxGeometry(0.22, 0.022, 0.15, 2, 0.008), M.darkMetal));
  for (const [x, z] of [[0.09, 0.055], [-0.09, 0.055], [0.09, -0.055], [-0.09, -0.055]]) add(cradle, mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.03, 8), M.metal), x, 0.024, z);
  const dock = add(cradle, new THREE.Object3D(), 0, 0.016, 0);

  // --- Head -----------------------------------------------------------------
  const head = add(chest, buildHelmet(M, headMeshes), 0, DIM.NECK, 0);

  // --- Arms -----------------------------------------------------------------
  const arms = ([1, -1] as const).map((s) => {
    const shoulder = add(chest, new THREE.Group(), s * DIM.SHOULDER_X, DIM.SHOULDER_Y, 0);
    const cap = mesh(new THREE.SphereGeometry(0.08, SEG, 12), M.white);
    cap.scale.set(1, 0.96, 1);
    shoulder.add(cap);
    const scye = mesh(ring(0.071, 0.011), M.grey); // bearing where the arm joins the torso
    scye.rotation.z = Math.PI / 2;
    add(shoulder, scye, -s * 0.045, 0, 0);
    shoulder.add(mesh(limb(0.066, 0.057, DIM.UPPER_ARM, 0.003), M.white));
    const elbow = add(shoulder, new THREE.Group(), 0, -DIM.UPPER_ARM, 0);
    elbow.add(mesh(new THREE.SphereGeometry(0.06, SEG, 10), M.grey));
    bellows(elbow, M.white, 0.0565, 0.03, 4, 0.02, 0.0085);
    elbow.add(mesh(limb(0.056, 0.047, DIM.FOREARM), M.white));
    // Sleeve display on the left forearm.
    if (s === 1) add(elbow, mesh(new RoundedBoxGeometry(0.012, 0.085, 0.05, 2, 0.004), M.screen), 0.052, -0.15, 0);
    const wrist = add(elbow, new THREE.Group(), 0, -DIM.FOREARM, 0);
    wrist.add(buildHand(M, s));
    return { shoulder, elbow, wrist };
  });

  // --- Legs (posed by IK in root space) ---------------------------------------
  const legs = ([1, -1] as const).map((s) => {
    const thigh = add(root, new THREE.Group(), s * DIM.HIP_W, DIM.HIP_H, 0);
    thigh.add(mesh(new THREE.SphereGeometry(0.1, SEG, 12), M.white));
    thigh.add(mesh(limb(0.1, 0.075, DIM.THIGH, 0.004), M.white));
    // Dark stripe down the outside of the leg (phi π/2 = +X).
    const stripe = mesh(lathe([[0.097, -0.03], [0.094, -0.14], [0.086, -0.28], [0.077, -0.41]].reverse() as P[], (s === 1 ? Math.PI / 2 : (3 * Math.PI) / 2) - 0.32, 0.64, 1.02, 12), M.grey);
    thigh.add(stripe);
    const shin = add(root, new THREE.Group(), s * DIM.HIP_W, DIM.HIP_H - DIM.THIGH, 0);
    shin.add(mesh(new THREE.SphereGeometry(0.078, SEG, 10), M.grey));
    bellows(shin, M.white, 0.074, 0.035, 3, 0.022, 0.009);
    const pad = mesh(new THREE.SphereGeometry(1, SEG, 10), M.dark);
    pad.scale.set(0.064, 0.082, 0.042);
    add(shin, pad, 0, -0.005, 0.052);
    shin.add(mesh(limb(0.071, 0.06, DIM.SHIN), M.white));
    // Boot shaft up to mid-shin, with its cuff.
    add(shin, mesh(limb(0.078, 0.069, 0.25, 0.002), M.dark), 0, -0.19, 0);
    add(shin, mesh(ring(0.078, 0.01), M.grey), 0, -0.185, 0);
    const foot = add(root, buildBoot(M), s * DIM.HIP_W, DIM.ANKLE_H, 0);
    return { thigh, shin, foot };
  });

  return { root, pelvis, chest, head, arms, legs, headMeshes, dock, materials: M };
}
