import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const target = `http://127.0.0.1:${process.env.PERPS_CORE_UI_PORT || 4318}`
const proxy = {
  target,
  changeOrigin: true,
  configure(server: any) {
    server.on('proxyReq', (outgoing: any, incoming: any) => {
      if (incoming.headers.origin === 'http://127.0.0.1:4319') outgoing.setHeader('origin', target)
    })
  },
}
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { host: '127.0.0.1', port: 4319, strictPort: true, proxy: { '/api': proxy, '/docs': proxy } },
})
