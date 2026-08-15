import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'

const resolvePort = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback
}

// Renderer build configuration: alias '@' -> src and env-based dev proxy.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devPort = resolvePort(
    process.env.VITE_APP_DEV_PORT
      || process.env.VITE_DEV_PORT
      || env.VITE_APP_DEV_PORT
      || env.VITE_DEV_PORT,
    52731
  )
  const configuredBackendPort = process.env.DSH_SERVER_PORT || process.env.SERVER_PORT
  const devBackendPort = resolvePort(configuredBackendPort, 52838)
  const proxyTarget = process.env.VITE_PROXY_URL
    || (configuredBackendPort ? `http://127.0.0.1:${devBackendPort}` : env.VITE_PROXY_URL)
    || `http://127.0.0.1:${devBackendPort}`
  const pathSrc = path.resolve(__dirname, 'src')

  return {
    base: mode === 'desktop' ? './' : (env.VITE_BASE_PATH || '/'),
    clearScreen: false,
    server: {
      port: devPort,
      strictPort: true,
      open: false,
      host: true,
      hmr: {
        host: '127.0.0.1',
        clientPort: devPort,
        protocol: 'ws'
      },
      // Dev proxy: forward VITE_PROXY_BASE_URL (for example /api) to the running backend VITE_PROXY_URL.
      // Backend routes are already under /api/*, so keep the prefix and avoid rewriting to /projects.
      proxy: env.VITE_PROXY_BASE_URL
        ? {
            [env.VITE_PROXY_BASE_URL]: {
              target: proxyTarget,
              changeOrigin: true,
              // If a backend does not include /api prefix, set VITE_PROXY_STRIP=1 to remove it.
              ...(env.VITE_PROXY_STRIP === '1'
                ? { rewrite: (p: string) => p.replace(new RegExp(`^${env.VITE_PROXY_BASE_URL}`), '') }
                : {})
            }
          }
        : undefined
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': pathSrc,
        // html2pdf.js package uses a .js suffix that can fail parsing, so point explicitly to the bundle file.
        'html2pdf.js': 'html2pdf.js/dist/html2pdf.bundle.min.js'
      }
    },
    build: {
      chunkSizeWarningLimit: 10000,
      assetsDir: 'static/assets',
      rollupOptions: {
        output: {
          chunkFileNames: 'static/js/[name]-[hash].js',
          entryFileNames: 'static/js/[name]-[hash].js',
          assetFileNames: 'static/[ext]/[name]-[hash].[ext]'
        }
      }
    },
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
          silenceDeprecations: ['legacy-js-api'],
          // Match original project: inject responsive.scss mixins (mobile/tablet etc.) into every SCSS entry point.
          additionalData: `@use "${pathSrc.replace(/\\/g, '/')}/styles/responsive.scss" as *;\n`
        }
      }
    }
  }
})
