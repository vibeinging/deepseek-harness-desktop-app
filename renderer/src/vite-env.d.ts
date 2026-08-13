/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_ENV: string
  readonly VITE_APP_BASE_URL: string
  readonly VITE_APP_IMAGE_URL: string
  readonly VITE_APP_CALLBACK_BASE_URL: string
  readonly VITE_APP_DEV_PORT: string
  readonly VITE_PROXY_BASE_URL: string
  readonly VITE_PROXY_URL: string
  readonly VITE_BASE_PATH: string
  readonly VITE_APP_ENABLE_CUSTOM_THEMES?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// html2pdf.js has no type declarations.
declare module 'html2pdf.js'
declare module 'html2pdf.js/dist/html2pdf.bundle.min.js'

// js-error-collection has no type declarations.
declare module 'js-error-collection'
