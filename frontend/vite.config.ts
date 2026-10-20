import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { BRAND } from './src/brand'

/** Fill brand placeholders in index.html from src/brand.ts (single source of truth). */
function brandHtml(): Plugin {
  return {
    name: 'brand-html',
    transformIndexHtml: (html) => html
      .replace(/%BRAND_NAME%/g, BRAND.name)
      .replace(/%BRAND_DESCRIPTOR%/g, BRAND.descriptor),
  }
}

export default defineConfig({
  plugins: [react(), brandHtml()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
})
