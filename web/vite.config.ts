import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        configure: (proxy) => {
          let lastHint = 0
          proxy.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ECONNREFUSED' && Date.now() - lastHint > 5000) {
              lastHint = Date.now()
              console.error(
                '\n[deal-finder] backend is not running on 127.0.0.1:8787 — ' +
                  'start it with `npm run dev:server`, or use `npm run dev` to run both together.\n',
              )
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
