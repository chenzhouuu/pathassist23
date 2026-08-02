import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {
  const girderProxyTarget = process.env.VITE_GIRDER_PROXY_TARGET || 'https://lymphoma.dev.pathassist.health'
  const copilotProxyTarget = process.env.VITE_COPILOT_PROXY_TARGET || 'http://localhost:8010'

  return {
    plugins: [react()],
    // `@/` mirrors the alias the vendored OHIF components are written against, so their imports
    // survive the copy unedited. tsconfig carries the same mapping for the type-checker.
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.js',
      clearMocks: true,
    },
    server: {
      port: 3000,
      // The Python services are a sibling tree, not frontend source: nothing under `services/` is
      // ever imported by the app, and each service's `.venv` is thousands of files. Watching them
      // exhausts the inotify budget and the dev server dies on `ENOSPC: System limit for number of
      // file watchers reached` — the venvs are ~11k files where the whole frontend is a few hundred.
      // Vite merges this with its own defaults (node_modules, .git), so it only adds.
      watch: {
        ignored: [
          fileURLToPath(new URL('./services/**', import.meta.url)),
          '**/.venv/**',
        ],
      },
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
