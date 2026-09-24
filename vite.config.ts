import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Content-Security-Policy, differing per mode.
 *
 * This matters more than it looks. Vite injects an INLINE `<script>` for
 * `@react-refresh`, and `script-src 'self'` blocks inline scripts outright — so
 * under a strict policy React never mounts and `#root` stays empty, which reads
 * as "the window is blank" rather than as a CSP error.
 *
 * Dev therefore needs 'unsafe-inline' (for the injected script) and ws: (for the
 * HMR socket). Production injects nothing and talks over IPC, so it can drop
 * both — and the packaged app should not ship 'unsafe-eval'.
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*",
].join('; ')

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ')

/** Replaces the placeholder in src/renderer/index.html with the mode's policy. */
function cspPlugin() {
  return {
    name: 'ollama-harness-csp',
    transformIndexHtml: {
      order: 'pre' as const,
      handler(html: string, ctx: { server?: unknown }) {
        const policy = ctx.server ? DEV_CSP : PROD_CSP
        return html.replace('__CSP__', policy)
      },
    },
  }
}

export default defineConfig({
  root: r('./src/renderer'),
  base: './',
  plugins: [cspPlugin(), react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@renderer': r('./src/renderer'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: r('./dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
})
