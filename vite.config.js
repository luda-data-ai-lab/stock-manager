import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/stock-manager/',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.png'],
      manifest: {
        name: 'StockManager - 재고 관리',
        short_name: 'StockMgr',
        description: '음성 인식 기반 재고 출고/반품 관리 시스템',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/stock-manager/',
        scope: '/stock-manager/',
        icons: [
          {
            src: 'icons/icon.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}'],
        navigateFallback: 'index.html'
      }
    })
  ]
})
