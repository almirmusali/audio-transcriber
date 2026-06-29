import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Cross-Origin Isolation headers нужны, чтобы transformers.js мог использовать
// многопоточный WASM (SharedArrayBuffer) как фолбэк, когда WebGPU недоступен.
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
  configurePreviewServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
      next()
    })
  },
}

export default defineConfig({
  // Относительные пути нужны, чтобы интерфейс открывался из .app через file://
  base: './',
  plugins: [react(), crossOriginIsolation],
  server: { port: 5180, strictPort: true },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
})
