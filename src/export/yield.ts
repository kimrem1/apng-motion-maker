/**
 * 매크로태스크 양보.
 *
 * 왜 setTimeout 이 아닌가.
 *
 * Chrome 은 백그라운드 탭의 타이머에 CPU 예산을 매긴다. 예산을 쓰고 나면
 * setTimeout(0) 이 초 단위로 지연된다. 내보내기는 프레임마다 한 번씩 양보하므로
 * 탭이 가려지는 순간 24프레임짜리 작업이 수십 초로 늘어난다. 실측으로 확인했다:
 * 숨은 탭에서 4프레임은 6ms, 8프레임은 6초를 넘겼다.
 *
 * MessageChannel 은 그 예산 대상이 아니다. 같은 매크로태스크 양보를 주면서
 * 백그라운드에서도 일정한 속도를 낸다.
 *
 * "백그라운드 탭에서 느려질 수 있음" 을 미리 안내하는 방법도 있지만,
 * 안내보다 느려지지 않게 만드는 쪽이 낫다.
 *
 * window 를 참조하지 않는다. 워커에서도 그대로 동작해야 한다.
 */

type Resolver = () => void

let channel: MessageChannel | null = null
const queue: Resolver[] = []

function ensureChannel(): MessageChannel | null {
  if (channel) return channel
  if (typeof MessageChannel === 'undefined') return null
  channel = new MessageChannel()
  channel.port1.onmessage = () => {
    const next = queue.shift()
    if (next) next()
  }
  channel.port1.start()
  return channel
}

/** 이벤트 루프에 한 틱 양보한다. 취소 버튼과 진행률 UI 가 이 틈에 돈다. */
export function yieldToHost(): Promise<void> {
  const ch = ensureChannel()
  if (!ch) {
    // MessageChannel 이 없는 환경(구형 워커 등)은 타이머로 떨어진다.
    return new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }
  return new Promise<void>((resolve) => {
    queue.push(resolve)
    ch.port2.postMessage(0)
  })
}

/**
 * N 항목마다 한 번만 양보한다.
 * 프레임마다 양보하면 틱 비용이 인코딩 비용을 넘어서는 구간이 생긴다.
 */
export function shouldYield(index: number, every = 1): boolean {
  return every <= 1 || index % every === 0
}
