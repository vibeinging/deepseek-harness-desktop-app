import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'

const rendererRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.dirname(rendererRoot)
const packageId = '@deepseek-ai/dsh-work-shell'
const cssPlaceholder = '__DSH_WORK_CLIENT_CSS__'
const platformModules = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form'
])

function inlinePluginCss(): Plugin {
  return {
    name: 'dsh-work-client-css-inline',
    writeBundle(options) {
      if (!options.dir) throw new Error('dsh-work Client bundle 缺少输出目录')
      const clientPath = path.join(options.dir, 'client.js')
      const cssPath = path.join(options.dir, 'style.css')
      const client = fs.readFileSync(clientPath, 'utf8')
      const css = fs.readFileSync(cssPath, 'utf8')
      const placeholder = JSON.stringify(cssPlaceholder)
      if (!client.includes(placeholder)) throw new Error('dsh-work Client bundle 缺少样式占位符')
      fs.writeFileSync(clientPath, client.replace(placeholder, JSON.stringify(css)))
      fs.unlinkSync(cssPath)
    }
  }
}

export default defineConfig({
  root: rendererRoot,
  publicDir: false,
  plugins: [react(), inlinePluginCss()],
  resolve: {
    alias: {
      '@': path.resolve(rendererRoot, 'src'),
      'html2pdf.js': 'html2pdf.js/dist/html2pdf.bundle.min.js'
    }
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production')
  },
  build: {
    outDir: path.resolve(appRoot, 'packages/dsh-work-shell/lib'),
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 20_000,
    lib: {
      entry: path.resolve(appRoot, 'packages/dsh-work-shell/src/client/index.tsx'),
      formats: ['cjs'],
      fileName: () => 'client.js'
    },
    rollupOptions: {
      external: (id) => platformModules.has(id),
      output: {
        inlineDynamicImports: true,
        banner: [
          `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => {`,
          `const css = ${JSON.stringify(cssPlaceholder)};`,
          `if (css && document.querySelector('style[data-plugin=${JSON.stringify(packageId)}]') === null) {`,
          `  const tag = document.createElement('style');`,
          `  tag.dataset.plugin = ${JSON.stringify(packageId)};`,
          `  tag.textContent = css;`,
          `  document.head.appendChild(tag);`,
          `}`
        ].join('\n'),
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });'
      }
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        silenceDeprecations: ['legacy-js-api'],
        additionalData: `@use "${path.resolve(rendererRoot, 'src/styles/responsive.scss').replace(/\\/g, '/')}" as *;\n`
      }
    }
  }
})
