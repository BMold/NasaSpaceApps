import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { networkInterfaces } from 'node:os';
// @ts-expect-error plain ESM module shared with server.js
import { attachSync } from './sync-core.js';

// HTTPS on the LAN: phone browsers only expose the gyroscope to secure pages.
// Set VITE_HTTP=1 to serve plain HTTP (e.g. for automated tests).
const https = process.env.VITE_HTTP !== '1';

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
  plugins: https ? [react(), basicSsl(), aresSync()] : [react(), aresSync()],
  server: {
    host: true, // listen on the LAN, not only localhost
    port: 5173,
    open: false,
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
