import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // /_AMapService is the AMap security proxy: the runtime forwards it to
  // restapi.amap.com with the server-only jscode appended (server-runtime.ts).
  server: { proxy: { '/v1': 'http://127.0.0.1:8787', '/_AMapService': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/v1': 'http://127.0.0.1:8787', '/_AMapService': 'http://127.0.0.1:8787' } },
})
