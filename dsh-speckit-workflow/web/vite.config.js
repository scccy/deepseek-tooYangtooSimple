import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dsh-speckit-workflow-web — standalone preview of the plugin workbench.
// Later the same components get wrapped into the plugin's client.js module.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1'
  }
})
