import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { networkInterfaces } from 'node:os';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain ESM module shared with server.js
import { attachSync } from './sync-core.js';

// HTTPS on the LAN: phone browsers only expose the gyroscope to secure pages.
// Set VITE_HTTP=1 to serve plain HTTP (e.g. for automated tests).
const https = process.env.VITE_HTTP !== '1';

// Albert's backend (FastAPI, docker-compose publishes it on :8000). /api is proxied
// so the phone, which only sees this HTTPS origin, reaches it too.
const BACKEND = process.env.ARES_BACKEND ?? 'http://127.0.0.1:8000';

// The shared terrain package lives at the repo root (../terreno) and is served
// as is: one copy for the optimizer, the backend and the 3D views.
const TERRENO = fileURLToPath(new URL('../terreno/', import.meta.url));
const TYPES: Record<string, string> = { json: 'application/json', bin: 'application/octet-stream', jpg: 'image/jpeg' };

function terrenoPackage(): Plugin {
  return {
    name: 'ares-terreno',
    configureServer(server) {
      server.middlewares.use('/terreno', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        // Flat package: plain file names only (no sub-folders, no "..").
        const ext = /^[\w.-]+\.(json|bin|jpg)$/.exec(name)?.[1];
        const file = ext && !name.includes('..') ? TERRENO + name : '';
        if (!file || !existsSync(file)) return next();
        res.setHeader('Content-Type', TYPES[ext!]);
        res.setHeader('Content-Length', statSync(file).size);
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

/** Runs the Socket.io sync server inside Vite: same HTTPS origin, one process. */
function aresSync(): Plugin {
  return {
    name: 'ares-sync',
    configureServer(server) {
      if (!server.httpServer) return;
      attachSync(server.httpServer, { log: (m: string) => server.config.logger.info(m) });
      server.httpServer.once('listening', () => {
        const port = server.config.server.port;
        const ips = Object.values(networkInterfaces())
          .flat()
          .filter((i) => i && i.family === 'IPv4' && !i.internal)
          .map((i) => i!.address);
        const proto = https ? 'https' : 'http';
        setTimeout(() => {
          server.config.logger.info(`\n  ARES-TWIN · sincronización activa en este mismo servidor`);
          server.config.logger.info(`  Laptop  → ${proto}://localhost:${port}/?role=spectator`);
          for (const ip of ips) server.config.logger.info(`  Celular → ${proto}://${ip}:${port}/?role=vr`);
        }, 300);
      });
    },
  };
}

export default defineConfig({
  plugins: https ? [react(), basicSsl(), aresSync(), terrenoPackage()] : [react(), aresSync(), terrenoPackage()],
  server: {
    host: true, // listen on the LAN, not only localhost
    port: 5173,
    open: false,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true, timeout: 2000, proxyTimeout: 2000 },
    },
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { main: 'index.html', explicacion: 'explicacion.html' },
      output: {
        manualChunks: {
          three: ['three'],
          r3f: ['@react-three/fiber', '@react-three/drei', '@react-three/postprocessing', 'postprocessing'],
        },
      },
    },
  },
});
