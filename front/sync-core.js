// ARES-TWIN · sync logic shared by server.js (standalone, port 3000) and the
// Vite dev server plugin (same HTTPS origin as the page, no extra process).
//
//   vr-client       the phone in the Cardboard headset: owns the ROTATION
//   spectator-host  the laptop: owns the POSITION (keyboard) and the world
//
// Low-latency relays (sent the moment they arrive, volatile = dropped, never queued):
//   'rotation'  phone → laptop   head quaternion
//   'pose'      laptop → phone   body x, z, heading and velocity (the phone extrapolates)
// Every client also receives one unified state at 60 Hz (late joiners, drone, sky):
//   { t, position: {x,y,z}, rotation: [x,y,z,w], heading, drone, vr, host }
// World changes that are not per-frame (route polyline, scanned canyon, goal)
// travel as 'world' events and are cached for clients that join later.
import { Server } from 'socket.io';

export const TICK_HZ = 60;

export function attachSync(httpServer, { log = console.log } = {}) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: true },
    transports: ['websocket'], // no long-polling: lowest latency on a LAN
    perMessageDeflate: false,
    // Leave other websocket upgrades (e.g. Vite's hot reload) alone.
    destroyUpgrade: false,
  });

  const state = {
    t: 0,
    position: { x: -88, y: 0, z: -84 },
    rotation: [0, 0, 0, 1],
    heading: 0,
    lookYaw: 0, // laptop's view yaw (radians), used by phones without gyroscope
    gaze: null, // look-down-to-walk settings, owned by the laptop
    ltst: null, // local solar time and dust chosen on the laptop
    storm: 0,
    drone: null,
    vr: false,
    host: false,
  };
  let world = null;
  const roles = new Map();

  const countRole = (r) => [...roles.values()].filter((x) => x === r).length;
  const refreshPresence = () => {
    state.vr = countRole('vr-client') > 0;
    state.host = countRole('spectator-host') > 0;
    io.emit('presence', { vr: countRole('vr-client'), host: countRole('spectator-host') });
  };

  io.on('connection', (socket) => {
    socket.on('register', (role) => {
      if (role !== 'vr-client' && role !== 'spectator-host') return;
      roles.set(socket.id, role);
      refreshPresence();
      socket.emit('state', state);
      if (world) socket.emit('world', world);
      log(`[sync] + ${role} (${socket.id})`);
    });

    // The phone owns the head rotation: relay it immediately (lowest latency)
    // and keep it in the unified state.
    socket.on('rotation', (q) => {
      // [x, y, z, w] or [x, y, z, w, 1] = tilt only (phone without gyroscope: the laptop owns the yaw).
      if (roles.get(socket.id) !== 'vr-client' || !Array.isArray(q) || q.length < 4 || q.length > 5) return;
      state.rotation = q;
      socket.broadcast.volatile.emit('rotation', q);
    });

    // The laptop owns the body position (and the drone, which is part of the suit).
    socket.on('position', (p) => {
      if (roles.get(socket.id) !== 'spectator-host' || !p) return;
      state.position = { x: +p.x || 0, y: +p.y || 0, z: +p.z || 0 };
      if (typeof p.heading === 'number') state.heading = p.heading;
      if (typeof p.lookYaw === 'number') state.lookYaw = p.lookYaw;
      if (typeof p.ltst === 'number') state.ltst = p.ltst;
      if (typeof p.storm === 'number') state.storm = p.storm;
      if (p.gaze && typeof p.gaze === 'object') state.gaze = { on: !!p.gaze.on, speed: +p.gaze.speed || 0, thr: +p.gaze.thr || 0, walking: !!p.gaze.walking };
      if (p.drone) state.drone = p.drone;
      // Relay the body pose the instant it arrives (like the rotation): the phone
      // no longer waits up to one 60 Hz tick. Volatile: a late pose is dropped, never queued.
      socket.broadcast.volatile.emit('pose', {
        x: state.position.x,
        z: state.position.z,
        h: state.heading,
        vx: +p.vx || 0,
        vz: +p.vz || 0,
      });
    });

    socket.on('world', (w) => {
      if (roles.get(socket.id) !== 'spectator-host') return;
      world = w;
      socket.broadcast.emit('world', w);
    });

    socket.on('ping-ares', (t, ack) => typeof ack === 'function' && ack(t));

    socket.on('disconnect', () => {
      const role = roles.get(socket.id);
      roles.delete(socket.id);
      refreshPresence();
      if (role) log(`[sync] - ${role} (${socket.id})`);
    });
  });

  const timer = setInterval(() => {
    state.t = Date.now();
    io.volatile.emit('state', state);
  }, 1000 / TICK_HZ);
  httpServer.on('close', () => clearInterval(timer));
  return io;
}
