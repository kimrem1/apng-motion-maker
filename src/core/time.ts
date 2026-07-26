/**
 * 시간 변환.
 *
 * 정본은 정수 frameIndex 다. 평가 API 는 연속 시간을 받는다.
 * 시드용 정수 인덱스는 항상 floor(t * fps) 로 유도한다.
 */

export function frameToSec(frame: number, fps: number): number {
  return frame / fps
}

export function secToFrame(sec: number, fps: number): number {
  return Math.floor(sec * fps)
}

/** 지속시간(ms)을 프레임 격자에 스냅한다. */
export function snapDurationMs(durationMs: number, fps: number): number {
  return (Math.round((durationMs * fps) / 1000) * 1000) / fps
}

export function durationSec(durationFrames: number, fps: number): number {
  return durationFrames / fps
}

/**
 * GIF 는 1/100초 격자다. 100/N 으로 떨어지지 않는 fps 는 정확히 표현되지 않는다.
 */
export function isGifExactFps(fps: number): boolean {
  const centis = 100 / fps
  return Math.abs(centis - Math.round(centis)) < 1e-9
}

export function fpsToGifCentis(fps: number): number {
  return Math.round(100 / fps)
}

/**
 * 재생 헤드. 절대 시간 기준이며 누적 가산을 하지 않는다.
 * 매 프레임 dt 를 더하면 부동소수 드리프트가 쌓인다.
 */
export function playheadFrame(
  nowMs: number,
  startMs: number,
  fps: number,
  durationFrames: number,
  loopMode: 'once' | 'loop' | 'pingPong' | 'loopWithHold',
): number {
  if (durationFrames <= 0) return 0
  const elapsed = Math.max(0, nowMs - startMs)
  const raw = Math.floor((elapsed / 1000) * fps)

  switch (loopMode) {
    case 'once':
      return Math.min(raw, durationFrames - 1)
    case 'pingPong': {
      // 양끝 중복을 제거하면 주기는 2N-2 다.
      const period = Math.max(1, durationFrames * 2 - 2)
      const p = raw % period
      return p < durationFrames ? p : period - p
    }
    case 'loop':
    case 'loopWithHold':
    default:
      return raw % durationFrames
  }
}

/** 내보낼 프레임 인덱스 목록. loop / pingPong 의 이음새 중복을 제거한다. */
export function exportFrameIndices(
  durationFrames: number,
  loopMode: 'once' | 'loop' | 'pingPong' | 'loopWithHold',
  dedupeBoundaryFrame: boolean,
): number[] {
  const n = Math.max(1, durationFrames)
  if (loopMode === 'pingPong') {
    const forward = Array.from({ length: n }, (_, i) => i)
    if (!dedupeBoundaryFrame) return [...forward, ...forward.slice().reverse()]
    // 정방향 0..N-1, 역방향 N-2..1  => 총 2N-2
    const backward: number[] = []
    for (let i = n - 2; i >= 1; i--) backward.push(i)
    return [...forward, ...backward]
  }
  return Array.from({ length: n }, (_, i) => i)
}
