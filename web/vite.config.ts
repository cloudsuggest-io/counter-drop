import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

// Absolute site address for link-preview tags in index.html (%VITE_PUBLIC_URL%). Set VITE_PUBLIC_URL
// in the build environment if the site moves; no trailing slash.
process.env.VITE_PUBLIC_URL ||= 'https://counterdrop.cloudsuggest.in'

// In dev, the API runs on :8080 and Vite proxies /api to it, so phones on the LAN
// only need to reach the Vite server (npm run dev -- --host).
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:8080', changeOrigin: true, ws: true } },
  },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        id: '/',
        name: 'Counter Drop',
        short_name: 'Counter Drop',
        description: 'Send files to the print counter from your phone. No WhatsApp, no phone number. Counter Drop deletes your files after pickup.',
        start_url: '/?src=pwa',
        lang: 'en-IN',
        categories: ['productivity', 'utilities'],
        shortcuts: [
          { name: 'Scan shop QR', short_name: 'Scan', url: '/scan?src=shortcut', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
          { name: 'My tickets', short_name: 'Tickets', url: '/?src=shortcut', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }] },
        ],
        screenshots: [
          { src: 'screenshots/drop.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'Choose files and see the price before you send' },
          { src: 'screenshots/ticket.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow', label: 'Your token turns green when it is ready' },
          { src: 'screenshots/board.png', sizes: '1280x800', type: 'image/png', form_factor: 'wide', label: 'The shop works every job from one live board' },
        ],
        scope: '/',
        display: 'standalone',
        background_color: '#F8FAFC',
        theme_color: '#0F172A',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}', 'icon-*.png'],
        // Latin + Devanagari fonts only; other scripts still load on demand if ever needed.
        // The PDF engine (~1.3 MB) is fetched only when someone picks a PDF, then kept (runtime cache below).
        globIgnores: ['**/*cyrillic*', '**/*greek*', '**/*vietnamese*', '**/*latin-ext*', '**/pdf.worker*', '**/pdf-*.js', '**/jsQR*'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/assets/') && /pdf|jsQR/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'pdf-engine', expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 60 } },
          },
        ],
      },
    }),
  ],
})
