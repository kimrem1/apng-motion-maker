/**
 * 앱 진입점.
 *
 * StrictMode 는 개발 중 이펙트를 두 번 실행한다. WebGL 컨텍스트 누수를 초기에
 * 잡아주므로 절대 끄지 않는다 (ui/canvas/useRenderer.ts 가 이 전제로 짜여 있다).
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'

import App from '@/ui/App.tsx'
import '@/ui/tokens.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 를 찾지 못했습니다.')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// registerType 이 'prompt' 이므로 새 버전이 자동으로 적용되지 않는다.
// 지금은 콘솔 안내만 한다. updateSW(true) 를 부르는 업데이트 배너는 아직 없다.
registerSW({
  onNeedRefresh() {
    console.info('[pwa] 새 버전이 준비되었습니다. 새로고침하면 적용됩니다.')
  },
  onOfflineReady() {
    console.info('[pwa] 오프라인에서도 쓸 수 있습니다.')
  },
  onRegisterError(error) {
    console.warn('[pwa] 서비스 워커 등록에 실패했습니다.', error)
  },
})
