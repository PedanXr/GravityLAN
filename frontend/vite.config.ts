import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/api/scanner/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
      '/api/agent/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
      '/api/ssh/terminal': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
});
