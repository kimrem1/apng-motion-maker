/**
 * 인스펙터 숫자 칸 한 번의 편집이 쓰는 프레임.
 *
 * 왜 세션이 필요한가
 *
 * NumberField 는 글자 하나마다 onChange 를 쏜다(ui/widgets/Field.tsx). "50" 을 치면
 * 5 와 50 이 차례로 들어온다. 재생 중이라면 그 사이 재생 헤드가 흘러서 서로 다른
 * 프레임에 키가 두 개 생긴다. 등장 진행률에서 이러면 곡선 한가운데 5% 짜리 계단이
 * 남고, 시작 / 걸리는 시간 표시까지 함께 틀어진다.
 *
 * 그래서 편집이 시작되면 재생을 멈추고 그 순간의 프레임을 못 박는다. 스크럽이
 * 재생을 멈추는 것과 같은 관습이다(Timeline.onPointerDown).
 *
 * 이 훅이 따로 있는 이유는 같은 장치가 세 곳에 필요하기 때문이다. 레이어 섹션에만
 * 있고 가리기 진행률과 등장 진행률에는 빠져 있었다. 세 벌로 두면 또 갈라진다.
 */

import { useCallback, useMemo, useRef } from 'react'

import { useUiStore } from '@/state/ui.ts'
import { frameForEdit } from '@/ui/canvas/livePlayhead.ts'

export interface EditFrameSession {
  /** 세션을 열고 이 편집이 쓸 프레임을 돌려준다. 이미 열려 있으면 그 값을 그대로 준다. */
  beginEdit(): number
  /** 세션을 닫는다. 다음 편집은 새 프레임을 잡는다. */
  endEdit(): void
}

export function useEditFrame(): EditFrameSession {
  const frameRef = useRef<number | null>(null)

  const beginEdit = useCallback((): number => {
    const ui = useUiStore.getState()
    /*
     * 재생 중이면 스토어의 playheadFrame 을 읽으면 안 된다. 100ms 마다만 갱신돼
     * 뒤처져 있고, 정확한 값은 정지 이펙트가 나중에 확정한다 (livePlayhead.ts).
     */
    const at = frameForEdit(ui.playing, ui.playheadFrame)
    if (ui.playing) {
      ui.setPlaying(false)
      // 정지 이펙트가 곧 같은 값을 넣지만, 그 사이 읽기 경로가 다른 프레임을 보면
      // 방금 쓴 값이 입력 칸에 안 돌아온다. 여기서 먼저 맞춰 둔다.
      ui.setPlayheadFrame(at)
    }
    if (frameRef.current === null) frameRef.current = at
    return frameRef.current
  }, [])

  const endEdit = useCallback((): void => {
    frameRef.current = null
  }, [])

  return useMemo(() => ({ beginEdit, endEdit }), [beginEdit, endEdit])
}
