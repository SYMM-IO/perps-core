import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['perps-core-ui/ui/test/**/*.test.{ts,tsx}'], setupFiles: ['perps-core-ui/ui/test/setup.ts'] },
})
