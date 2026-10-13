import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://krin2.github.io/hmi-plc-simulator/ -> the base must match the repository name
export default defineConfig({
  base: '/hmi-plc-simulator/',
  plugins: [react(), tailwindcss()],
  test: {
    // PLC logic and the process model are plain TypeScript: they run in node.
    // Component tests opt in to jsdom with a file comment.
    environment: 'node',
    globals: true,
  },
})
