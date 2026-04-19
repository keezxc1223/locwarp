import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { port: 5173 },
  build: {
    // Bundle splitting — keeps the app chunk small & long-term cacheable.
    // - react/react-dom rarely change → cache survives across deploys
    // - leaflet is the largest single dep (~150 KB) → isolate it so map-less
    //   loads (if we ever lazy-load MapView) don't pay for it
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'leaflet-vendor': ['leaflet'],
        },
      },
    },
    // Surface oversized chunks early — pre-split was a single 433 KB bundle,
    // post-split target is ~250 KB app + vendors. Warn at 300 KB so we notice
    // if a stray dep balloons the app chunk again.
    chunkSizeWarningLimit: 300,
  },
})
