// ARES-TWIN · standalone sync server (port 3000) for the production build.
// During development you don't need it: `npm run dev` runs the same sync logic
// inside the Vite server (see vite.config.ts and sync-core.js).
//
// Run: npm run build && node server.js   (PORT=xxxx to change the port)
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachSync, TICK_HZ } from './sync-core.js';

const PORT = Number(process.env.PORT ?? 3000);
const app = express();
const http = createServer(app);
attachSync(http);

const dist = fileURLToPath(new URL('./dist/', import.meta.url));
if (existsSync(dist)) app.use(express.static(dist));
// The shared terrain package, served as is from the repo root (../terreno).
const terreno = fileURLToPath(new URL('../terreno/', import.meta.url));
if (existsSync(terreno)) app.use('/terreno', express.static(terreno, { index: false, dotfiles: 'deny' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

http.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`ARES-TWIN sync server on :${PORT} (${TICK_HZ} Hz)`);
  for (const ip of ips) console.log(`  LAN: http://${ip}:${PORT}  (sin HTTPS el celular no entrega el giroscopio)`);
});
