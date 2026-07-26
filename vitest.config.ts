import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// PWA 플러그인은 테스트에 필요 없고 빌드 훅만 늘리므로 vite.config.ts 를 재사용하지 않는다.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
