/**
 * 결정론적 난수.
 *
 * 렌더 경로에서 Math.random 은 금지다. 난수는 프레임마다 재시드한다.
 *   rng = mulberry32(hashSeed(projectSeed, nodeId, frameIndex))
 *
 * 프레임 간 누산을 하지 않기 때문에 임의 순서로 seek 해도 같은 픽셀이 나온다.
 * 이것이 프리뷰와 내보내기가 일치한다는 약속의 전제다.
 */

/** FNV-1a 32비트. 문자열 노드 id 를 정수로 접는다. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 정수 3개를 하나의 시드로 섞는다. fract(sin(x)) 류는 쓰지 않는다. */
export function hashSeed(projectSeed: number, nodeId: string | number, frameIndex: number): number {
  const node = typeof nodeId === 'string' ? hashString(nodeId) : nodeId >>> 0
  let h = (projectSeed ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ node, 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (frameIndex + 0x165667b1), 0xc2b2ae35) >>> 0
  h ^= h >>> 15
  return h >>> 0
}

/** mulberry32. 상태 32비트, 주기 2^32. 셰이더 밖 CPU 경로용. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** [-1, 1] 범위 */
export function signedRandom(rng: () => number): number {
  return rng() * 2 - 1
}

/**
 * 홀드 클럭. boil / 자글자글이 2컷, 3컷으로 잡히게 만든다.
 * 시드에는 항상 원본 frame 이 아니라 effFrame 을 넣는다.
 */
export function effectiveFrame(frame: number, holdFrames: number): number {
  const hold = Math.max(1, Math.floor(holdFrames))
  return Math.floor(frame / hold) * hold
}
