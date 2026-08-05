/**
 * 편집이 쓰는 프레임.
 *
 * 재생 중 useUiStore.playheadFrame 은 100ms 마다만 갱신돼 한두 프레임 뒤처져 있다.
 * "재생을 멈추고 그 자리에 키를 찍는" 조작이 그 값을 읽으면, 화면이 보여 준 프레임이
 * 아니라 그 앞 프레임에 키가 남는다. 인스펙터 입력 칸은 블러 직후 보간값으로
 * 되돌아가고, 캔버스 드래그는 놓은 자리와 다른 곳에 자국을 남긴다.
 *
 * 그래서 렌더 루프가 자기 프레임을 모듈에 미러링하고, 편집은 재생 중일 때 그쪽을 읽는다.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  frameForEdit,
  livePlayheadFrame,
  setLivePlayheadFrame,
} from '@/ui/canvas/livePlayhead.ts'

beforeEach(() => {
  setLivePlayheadFrame(0)
})

describe('렌더 프레임 미러', () => {
  it('렌더러가 남긴 값을 그대로 돌려준다', () => {
    setLivePlayheadFrame(17)
    expect(livePlayheadFrame()).toBe(17)
  })

  it('정수 프레임만 남는다', () => {
    setLivePlayheadFrame(12.4)
    expect(livePlayheadFrame()).toBe(12)
    setLivePlayheadFrame(12.6)
    expect(livePlayheadFrame()).toBe(13)
  })

  it('수가 아닌 값은 무시한다. 마지막 값이 남는다', () => {
    setLivePlayheadFrame(9)
    setLivePlayheadFrame(Number.NaN)
    setLivePlayheadFrame(Number.POSITIVE_INFINITY)
    expect(livePlayheadFrame()).toBe(9)
  })
})

describe('편집이 쓰는 프레임', () => {
  it('재생 중이면 스토어가 아니라 렌더 프레임을 쓴다', () => {
    // 스토어는 뒤처져 있다. 화면에는 14 가 나가 있는데 스토어는 아직 12 다.
    setLivePlayheadFrame(14)
    expect(frameForEdit(true, 12)).toBe(14)
  })

  it('정지 상태면 스토어가 진실이다', () => {
    /*
     * 스크럽으로 옮긴 자리는 스토어에 있고, 렌더 루프가 그 값을 따라간다.
     * 여기서 미러를 읽으면 정지 중 스크럽 직후 한 프레임이 어긋날 수 있다.
     */
    setLivePlayheadFrame(14)
    expect(frameForEdit(false, 12)).toBe(12)
  })

  it('언제나 정수를 돌려준다', () => {
    expect(frameForEdit(false, 7.6)).toBe(8)
    expect(frameForEdit(false, Number.NaN)).toBe(0)
  })

  it('인스펙터와 캔버스가 같은 답을 받는다', () => {
    // 두 곳이 각자 판단하던 때 실제로 갈라져 있었다. 이제 같은 함수 하나다.
    setLivePlayheadFrame(21)
    for (const [playing, store] of [[true, 19], [false, 19], [true, 21]] as const) {
      expect(frameForEdit(playing, store)).toBe(frameForEdit(playing, store))
    }
  })
})
