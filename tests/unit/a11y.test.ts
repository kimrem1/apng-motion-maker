/**
 * 접근성 알림.
 *
 * announce 는 DOM 을 건드리지 않는다. 그래서 node 환경에서 그대로 돌아간다
 * (vitest.config.ts 의 environment: 'node'). LiveRegion.tsx 는 이 모듈의
 * 매핑과 구독만 쓰므로, 여기서 검증하면 컴포넌트를 렌더하지 않고도
 * priority 배선이 맞는지 확인할 수 있다.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ANNOUNCE_BUFFER_MAX,
  ANNOUNCE_DEDUPE_MS,
  announce,
  getBufferedAnnouncements,
  liveRegionAttrs,
  resetAnnouncer,
  setAnnounceClock,
  subscribeAnnouncements,
  type Announcement,
} from '@/ui/a11y/announce.ts'

/** 테스트가 시간을 직접 민다. 실제 시계에 기대면 dedupe 창 검증이 불안정해진다. */
let now = 0

function collect(): { seen: Announcement[]; stop: () => void } {
  const seen: Announcement[] = []
  const stop = subscribeAnnouncements((a) => seen.push(a))
  return { seen, stop }
}

beforeEach(() => {
  resetAnnouncer()
  now = 1_000_000
  setAnnounceClock(() => now)
})

afterEach(() => {
  setAnnounceClock(null)
  resetAnnouncer()
})

// ---------------------------------------------------------------------------
// 중복 억제
// ---------------------------------------------------------------------------

describe('announce 중복 억제', () => {
  it('같은 문장을 연속으로 보내면 한 번만 나간다', () => {
    const { seen } = collect()

    announce('흔들기 모션을 적용했습니다.')
    announce('흔들기 모션을 적용했습니다.')
    announce('흔들기 모션을 적용했습니다.')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toBe('흔들기 모션을 적용했습니다.')
  })

  it('다른 문장이 사이에 끼면 각각 나간다', () => {
    const { seen } = collect()

    announce('가')
    announce('나')
    announce('가')

    expect(seen.map((a) => a.message)).toEqual(['가', '나', '가'])
  })

  it('억제 창을 지나면 같은 문장도 다시 나간다', () => {
    const { seen } = collect()

    announce('내보내기를 마쳤습니다.')
    now += ANNOUNCE_DEDUPE_MS - 1
    announce('내보내기를 마쳤습니다.')
    expect(seen).toHaveLength(1)

    now += 1
    announce('내보내기를 마쳤습니다.')
    expect(seen).toHaveLength(2)
  })

  it('같은 문장이라도 등급이 polite 에서 assertive 로 오르면 통과시킨다', () => {
    const { seen } = collect()

    announce('저장하지 못했습니다.')
    announce('저장하지 못했습니다.', 'assertive')

    expect(seen).toHaveLength(2)
    expect(seen[1]?.priority).toBe('assertive')
  })

  it('assertive 가 연속되면 다시 억제한다', () => {
    const { seen } = collect()

    announce('저장하지 못했습니다.', 'assertive')
    announce('저장하지 못했습니다.', 'assertive')

    expect(seen).toHaveLength(1)
  })

  it('빈 문자열과 공백만 있는 문장은 버린다', () => {
    const { seen } = collect()

    announce('')
    announce('   ')
    announce('\n\t')

    expect(seen).toHaveLength(0)
  })

  it('앞뒤 공백만 다른 문장은 같은 문장으로 본다', () => {
    const { seen } = collect()

    announce('적용했습니다.')
    announce('  적용했습니다.  ')

    expect(seen).toHaveLength(1)
  })

  it('seq 는 실제로 나간 알림에 대해서만 증가한다', () => {
    const { seen } = collect()

    announce('가')
    announce('가')
    announce('나')

    expect(seen.map((a) => a.seq)).toEqual([1, 2])
  })
})

// ---------------------------------------------------------------------------
// 구독
// ---------------------------------------------------------------------------

describe('announce 구독', () => {
  it('구독자가 없을 때 온 알림은 첫 구독자에게 순서대로 전달된다', () => {
    announce('첫째')
    announce('둘째')
    expect(getBufferedAnnouncements()).toHaveLength(2)

    const { seen } = collect()

    expect(seen.map((a) => a.message)).toEqual(['첫째', '둘째'])
    // 한 번 넘기면 버퍼는 비운다. 두 번째 구독자에게 다시 읽히면 안 된다.
    expect(getBufferedAnnouncements()).toHaveLength(0)
  })

  it('밀린 알림은 상한을 넘지 않는다', () => {
    for (let i = 0; i < ANNOUNCE_BUFFER_MAX + 3; i += 1) {
      announce(`알림 ${i}`)
    }

    const buffered = getBufferedAnnouncements()
    expect(buffered).toHaveLength(ANNOUNCE_BUFFER_MAX)
    // 오래된 것부터 버린다. 마지막 알림이 가장 최근 상태다.
    expect(buffered[buffered.length - 1]?.message).toBe(`알림 ${ANNOUNCE_BUFFER_MAX + 2}`)
  })

  it('해제한 구독자에게는 더 이상 가지 않는다', () => {
    const { seen, stop } = collect()

    announce('가')
    stop()
    announce('나')

    expect(seen.map((a) => a.message)).toEqual(['가'])
  })
})

// ---------------------------------------------------------------------------
// LiveRegion priority 매핑
// ---------------------------------------------------------------------------

describe('LiveRegion priority 매핑', () => {
  it('polite 는 role=status / aria-live=polite 다', () => {
    expect(liveRegionAttrs('polite')).toEqual({
      role: 'status',
      ariaLive: 'polite',
      ariaAtomic: 'true',
    })
  })

  it('assertive 는 role=alert / aria-live=assertive 다', () => {
    expect(liveRegionAttrs('assertive')).toEqual({
      role: 'alert',
      ariaLive: 'assertive',
      ariaAtomic: 'true',
    })
  })

  it('두 등급은 서로 다른 영역으로 간다', () => {
    // 같은 노드의 aria-live 를 도중에 바꾸면 대부분의 낭독기가 무시한다.
    // 그래서 LiveRegion 은 영역을 두 개 만든다. 그 전제가 매핑에 드러나야 한다.
    expect(liveRegionAttrs('polite').role).not.toBe(liveRegionAttrs('assertive').role)
    expect(liveRegionAttrs('polite').ariaLive).not.toBe(liveRegionAttrs('assertive').ariaLive)
  })

  it('두 등급 모두 aria-atomic 이다', () => {
    // "적용했습니다" 와 "적용하지 못했습니다" 는 뒷부분만 다르다.
    // 일부만 읽히면 뜻이 정반대가 된다.
    expect(liveRegionAttrs('polite').ariaAtomic).toBe('true')
    expect(liveRegionAttrs('assertive').ariaAtomic).toBe('true')
  })

  it('기본 등급은 polite 다', () => {
    const { seen } = collect()
    announce('아무 말')
    expect(seen[0]?.priority).toBe('polite')
  })
})
