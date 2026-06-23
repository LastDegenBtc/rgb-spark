import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // Multi-page app: dev-lab at /, the standalone familier test at
      // /familier.html. Only matters for `vite build` — the dev server
      // serves any .html file it finds without this.
      input: {
        main: resolve(__dirname, 'index.html'),
        familier: resolve(__dirname, 'familier.html'),
      },
    },
  },
  server: {
    host: true,
    // lab.pprgb.app is our dev/preview HTTPS slot reverse-proxied by nginx;
    // Vite's host check would 403 it otherwise.
    allowedHosts: ['lab.pprgb.app'],
    // HMR runs over the same nginx 443 termination — tell the in-browser
    // client to connect via wss://<host>:443/ so it doesn't try :5173 direct.
    hmr: { clientPort: 443 },
  },
})
