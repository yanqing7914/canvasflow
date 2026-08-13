import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const localVoiceHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

export default defineConfig({
  plugins: [react()],
  // ORT resolves its sibling WASM files at runtime. Vite prebundling rewrites
  // that location to an HTML fallback in development, so keep the package's
  // own module/asset layout intact.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // /_AMapService is the AMap security proxy: the runtime forwards it to
  // restapi.amap.com with the server-only jscode appended (server-runtime.ts).
  // Local KWS uses pthread WASM, so both development and Vite preview must be
  // cross-origin isolated. The production Node server applies the same pair.
  server: {
    headers: localVoiceHeaders,
    proxy: { '/v1': 'http://127.0.0.1:8787', '/_AMapService': 'http://127.0.0.1:8787' },
  },
  preview: {
    headers: localVoiceHeaders,
    proxy: { '/v1': 'http://127.0.0.1:8787', '/_AMapService': 'http://127.0.0.1:8787' },
  },
})
