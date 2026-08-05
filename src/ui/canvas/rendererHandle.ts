/**
 * 활성 렌더러 레지스트리.
 *
 * 왜 이런 게 필요한가. WebGL2 컨텍스트는 앱에 하나뿐이어야 한다. 두 개가 생기면
 * 텍스처가 공유되지 않아 에셋이 두 배로 올라가고, 브라우저의 컨텍스트 상한에도 걸린다.
 * 그런데 컨텍스트를 만드는 useRenderer 는 PreviewCanvas 안에서만 호출된다.
 * 내보내기는 프리뷰와 같은 renderer.renderFrame 을 불러야 하므로
 * 그 인스턴스에 닿을 방법이 필요하다.
 *
 * React Context 를 쓰지 않는 이유는 두 가지다. 첫째, 렌더러는 렌더링 결과가 아니라
 * 부수효과의 산물이라 Provider 로 감싸면 초기화 순서가 트리 구조에 묶인다.
 * 둘째, 값이 바뀔 때마다 하위 트리 전체가 리렌더된다. 프리뷰 캔버스는 리렌더를 최대한
 * 피해야 하는 컴포넌트다.
 *
 * 그래서 모듈 스코프에 아주 작은 레지스트리만 둔다. 규칙은 하나다.
 * 등록/해제는 컨텍스트 소유자(useRenderer)만 한다. 나머지는 읽기만 한다.
 */

import type { Renderer } from '@/core/renderer/index.ts'
import type { AssetTable } from '@/core/types.ts'

export interface RendererHandle {
  renderer: Renderer
  /**
   * 호출 시점의 최신 에셋 테이블.
   * 테이블을 값으로 들고 있으면 이미지가 추가된 뒤에도 옛 테이블을 쓰게 된다.
   * GPU 캐시 sync 의 소유자는 useRenderer 이므로 여기서는 게터로만 받는다.
   */
  getAssets(): AssetTable
}

let active: RendererHandle | null = null
let revision = 0
const listeners = new Set<() => void>()

/**
 * 컨텍스트 소유자 전용. useRenderer 의 컨텍스트 생성 직후 등록하고 정리에서 null 로 지운다.
 * 다른 곳에서 부르면 내보내기가 이미 해제된 컨텍스트를 잡게 된다.
 */
export function setActiveRenderer(handle: RendererHandle | null): void {
  if (active === handle) return
  active = handle
  revision += 1
  for (const listener of listeners) listener()
}

export function getActiveRenderer(): RendererHandle | null {
  return active
}

/** useSyncExternalStore 용. 스냅샷이 객체면 매번 새 참조가 되어 무한 루프가 난다. */
export function getRendererRevision(): number {
  return revision
}

export function subscribeActiveRenderer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
