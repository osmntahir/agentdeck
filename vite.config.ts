import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 4710,
    proxy: {
      // Regex: yalnızca /api/... eşleşsin. Düz '/api' öneki, modül yolu
      // /api.ts'i de yakalayıp Vite'ın transform'unu atlatıyordu.
      '^/api/': 'http://127.0.0.1:4711',
      '^/ws\\b': { target: 'ws://127.0.0.1:4711', ws: true },
    },
  },
})
