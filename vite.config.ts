import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

/*
 * GitHub Pages 는 https://<사용자>.github.io/<저장소>/ 로 서비스한다.
 * base 가 '/' 이면 번들과 아이콘을 도메인 루트에서 찾아 빈 화면이 뜬다.
 *
 * 저장소 이름을 여기 적어 두지 않는 이유는, 저장소 이름을 바꾸거나 다른 곳에
 * 올릴 때마다 이 파일을 고쳐야 하기 때문이다. 배포 워크플로가 실제 저장소
 * 이름을 BASE_PATH 로 넣어 준다. 로컬 개발과 미리보기는 '/' 그대로다.
 */
const base = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'APNG Motion Maker',
        short_name: 'Motion Maker',
        description: '이미지를 움직이는 이미지(APNG / WebP / GIF)로 만드는 도구',
        theme_color: '#0e0f13',
        background_color: '#0e0f13',
        display: 'standalone',
        lang: 'ko',
        // 하위 경로에 올라가면 설치했을 때 시작 주소도 그 경로여야 한다.
        // 루트로 두면 설치된 앱이 404 를 연다.
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
  },
})
