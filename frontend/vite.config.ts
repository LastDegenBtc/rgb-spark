import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
