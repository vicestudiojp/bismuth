import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 配布物（npm パッケージ）にはビルド済みの画面を dist/web として同梱する。サーバは dist/server から ../web を配信する
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    proxy: {
      '/api': 'http://localhost:8383',
    },
  },
})
