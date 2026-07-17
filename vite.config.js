import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {
  const girderProxyTarget = process.env.VITE_GIRDER_PROXY_TARGET || 'https://lymphoma.dev.pathassist.health'
  const copilotProxyTarget = process.env.VITE_COPILOT_PROXY_TARGET || 'http://localhost:8010'

  return {
    plugins: [react()],
    server: {
      port: 3000,
      proxy: {
        // Must precede '/api' so copilot requests reach the agent gateway, not Girder.
        '/api/copilot': {
          target: copilotProxyTarget,
          changeOrigin: true,
          secure: false,
        },
        '/api': {
          target: girderProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      }
    },
  }
})
