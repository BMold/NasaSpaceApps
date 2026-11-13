// Socket.io client shared by the phone (vr-client) and the laptop (spectator-host).
// In development the page and the socket share one origin: Vite proxies
// /socket.io to the sync server on port 3000, so HTTPS works for both.
import { io, type Socket } from 'socket.io-client';

export type Role = 'vr-client' | 'spectator-host';

export interface DroneNet {
  x: number;
  y: number;
  z: number;
  heading: number;
  state: string;
  rotor: number;
  scan: number;
}

export interface SyncState {
  t: number;
  position: { x: number; y: number; z: number };
  rotation: [number, number, number, number] | [number, number, number, number, number];
  heading: number;
  lookYaw?: number;
  /** Local true solar time (hours) and dust-storm strength 0..1, chosen on the laptop. */
  ltst?: number | null;
  storm?: number;
  gaze?: { on: boolean; speed: number; thr: number; walking: boolean } | null;
  drone: DroneNet | null;
  vr: boolean;
  host: boolean;
}

export interface WorldNet {
  routeId: number;
  route: [number, number][]; // x, z pairs (1 m spacing)
  canyonScanned: boolean;
  goal: { code: string; x: number; z: number } | null;
  litres: number; // O₂ of the remaining route
}

let socket: Socket | null = null;

export function connect(role: Role): Socket {
  if (socket) return socket;
  // ?server=host:port lets the page reach a sync server on another machine.
  const override = new URLSearchParams(location.search).get('server');
  const url = override ? `${location.protocol === 'https:' ? 'https' : 'http'}://${override}` : undefined;
  socket = io(url ?? '', { transports: ['websocket'], reconnectionDelay: 300, reconnectionDelayMax: 1500 });
  socket.on('connect', () => socket?.emit('register', role));
  return socket;
}

export const getSocket = () => socket;

/** Round-trip time to the server, in ms. */
export function ping(): Promise<number> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve(NaN);
    const t0 = performance.now();
    socket.timeout(1000).emit('ping-ares', t0, (err: unknown) => resolve(err ? NaN : performance.now() - t0));
  });
}
