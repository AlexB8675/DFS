import { fileURLToPath } from 'node:url'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { msw } from 'msw/vite'
import { defineConfig, loadEnv } from 'vite'
import { pdfjsAssets } from './pdfjs-assets.ts'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, import.meta.dirname)
  // In dev, the API is mocked in the browser unless VITE_API_MOCKS=off (§13.1).
  const useMocks = command === 'serve' && mode !== 'test' && env.VITE_API_MOCKS !== 'off'

  return {
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      pdfjsAssets(),
      useMocks && msw({ mode: 'worker-only' }),
    ],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: useMocks ? undefined : { '/api': 'http://localhost:3000' },
    },
  }
})
