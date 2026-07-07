import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const lightweightChartsProductionEntry = fileURLToPath(
  new URL('./node_modules/lightweight-charts/dist/lightweight-charts.production.mjs', import.meta.url),
);

export default defineConfig({
  envDir: '..',
  resolve: {
    alias: {
      'lightweight-charts': lightweightChartsProductionEntry,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.ngrok-free.app',
      '.ngrok-free.dev',
      '.ngrok.app',
      '.trycloudflare.com',
    ],
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
