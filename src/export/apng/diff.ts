/**
 * APNG 프레임 차분.
 *
 * 전체 프레임을 매번 쓰면 24프레임 512x512 가 수 MB 다. 바뀐 사각형만 fdAT 로 쓰면
 * 정지 구간과 국소 움직임에서 파일이 크게 줄어든다.
 *
 * 알파가 이 파일의 함정이다.
 *
 * APNG 의 blend_op 는 두 가지다.
 *   SOURCE(0) : 사각형 영역을 통째로 덮어쓴다. 알파까지 그대로 대체된다. 항상 안전하다.
 *   OVER(1)   : 사각형을 출력 버퍼 위에 알파 합성한다.
 *
 * 투명 스티커는 프레임마다 알파가 늘었다 줄었다 한다. OVER 는 알파를 "더하는"
 * 연산이라 줄어드는 알파를 표현하지 못한다. 반투명 가장자리에 잔상이 쌓인다.
 *
 * 그래서 OVER 는 결과가 원본과 바이트 단위로 같아지는 경우에만 쓴다. APNG 사양의 합성
 * 식(정수 연산)을 픽셀별로 풀면 다음 셋 중 하나여야 한다.
 *
 *   1) cur.a === 255                       -> 전경이 불투명이라 그대로 대체된다
 *   2) prev.a === 0 && cur.a > 0            -> 배경이 없어 전경이 그대로 남는다
 *   3) prev 와 cur 이 모두 (0,0,0,0)        -> 어느 구현이든 (0,0,0,0) 이 나온다
 *
 * 3번을 따로 두는 이유가 있다. 알파 0 픽셀의 RGB 를 디코더마다 다르게 다룬다.
 * "fg.a 가 0 이면 bg 를 그대로 둔다" 는 구현과 사양의 정수식(분모가 0 이면 결과를
 * (0,0,0,0) 으로 둔다)을 그대로 따르는 구현이 갈린다. 두 해석이 같은 답을 내는
 * 경우만 허용해야 어떤 뷰어에서도 같은 그림이 나온다.
 *
 * 참고로 readbackToStraight 는 알파 0 픽셀을 (0,0,0,0) 으로 눌러 준다. 그래서
 * 실제 파이프라인에서는 3번 조건이 자연스럽게 성립한다.
 *
 * window / document 를 import 하지 않으므로 워커에서 그대로 돈다.
 */

/** 프레임 안의 사각형. APNG fcTL 의 x_offset/y_offset/width/height 에 그대로 들어간다. */
export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
}

/** RGBA8 픽셀당 바이트 수. */
const BPP = 4

function assertSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`width/height 가 잘못됐다: ${width}x${height}`)
  }
}

function assertFrames(prev: Uint8Array, cur: Uint8Array, width: number, height: number): void {
  assertSize(width, height)
  const needed = width * height * BPP
  if (prev.length !== needed || cur.length !== needed) {
    throw new Error(
      `프레임 버퍼 길이가 맞지 않는다: prev=${prev.length}, cur=${cur.length}, 필요=${needed}`,
    )
  }
}

/** 사각형이 width x (버퍼에서 유도한 height) 안에 들어가는지 확인한다. */
function assertRect(rect: FrameRect, width: number, bufferLength: number): number {
  assertSize(width, 1)
  const rowBytes = width * BPP
  if (bufferLength % rowBytes !== 0) {
    throw new Error(`버퍼 길이가 행 크기의 배수가 아니다: ${bufferLength} % ${rowBytes}`)
  }
  const height = bufferLength / rowBytes
  const ok =
    Number.isInteger(rect.x) &&
    Number.isInteger(rect.y) &&
    Number.isInteger(rect.w) &&
    Number.isInteger(rect.h) &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.w > 0 &&
    rect.h > 0 &&
    rect.x + rect.w <= width &&
    rect.y + rect.h <= height
  if (!ok) {
    throw new Error(
      `사각형이 프레임을 벗어난다: ${rect.x},${rect.y} ${rect.w}x${rect.h} (프레임 ${width}x${height})`,
    )
  }
  return height
}

/**
 * 두 프레임이 다른 최소 사각형. 완전히 같으면 null.
 *
 * 행/열 한 번 훑는 O(w*h) 스캔이다. 픽셀 4바이트를 비교하고 최소/최대 x, y 를 모은다.
 */
export function changedRect(
  prev: Uint8Array,
  cur: Uint8Array,
  width: number,
  height: number,
): FrameRect | null {
  assertFrames(prev, cur, width, height)

  let minX = width
  let maxX = -1
  let minY = -1
  let maxY = -1

  const rowBytes = width * BPP
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes
    let rowChanged = false
    let at = rowStart
    for (let x = 0; x < width; x++, at += BPP) {
      if (
        prev[at] === cur[at] &&
        prev[at + 1] === cur[at + 1] &&
        prev[at + 2] === cur[at + 2] &&
        prev[at + 3] === cur[at + 3]
      ) {
        continue
      }
      rowChanged = true
      if (x < minX) minX = x
      if (x > maxX) maxX = x
    }
    if (rowChanged) {
      if (minY < 0) minY = y
      maxY = y
    }
  }

  if (maxY < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 사각형만 잘라낸 RGBA. 길이는 rect.w * rect.h * 4 다. */
export function cropFrame(rgba: Uint8Array, width: number, rect: FrameRect): Uint8Array {
  assertRect(rect, width, rgba.length)

  const srcRowBytes = width * BPP
  const dstRowBytes = rect.w * BPP
  const out = new Uint8Array(dstRowBytes * rect.h)
  for (let y = 0; y < rect.h; y++) {
    const s = (rect.y + y) * srcRowBytes + rect.x * BPP
    out.set(rgba.subarray(s, s + dstRowBytes), y * dstRowBytes)
  }
  return out
}

/**
 * blend_op / dispose 선택.
 *
 * OVER(1) 로 알파를 겹치면 반투명 픽셀이 누적된다. 알파가 줄어드는 픽셀이 하나라도
 * 있으면 SOURCE(0) 로 떨어뜨려야 한다. 이 함수가 그 판정을 한다.
 *
 * 위 파일 주석의 세 조건을 사각형 안의 모든 픽셀이 만족할 때만 OVER 를 고른다.
 * 알파가 늘어나는 경우(prev.a=100 -> cur.a=200)도 합성 결과가 200 이 아니라 더 커지므로
 * 마찬가지로 SOURCE 다. "줄어드는 경우"만 보면 그 함정에 빠진다.
 *
 * dispose_op 는 언제나 NONE 이다. 차분은 이전 프레임이 버퍼에 남아 있어야 성립한다.
 */
export function pickBlendOp(
  prev: Uint8Array,
  cur: Uint8Array,
  rect: FrameRect,
  width: number,
): 0 | 1 {
  assertRect(rect, width, cur.length)
  if (prev.length !== cur.length) {
    throw new Error(`프레임 버퍼 길이가 다르다: ${prev.length} != ${cur.length}`)
  }

  const rowBytes = width * BPP
  for (let y = 0; y < rect.h; y++) {
    let at = (rect.y + y) * rowBytes + rect.x * BPP
    for (let x = 0; x < rect.w; x++, at += BPP) {
      const ca = cur[at + 3]!
      // 1) 전경이 불투명이면 무조건 그대로 대체된다.
      if (ca === 255) continue

      const pa = prev[at + 3]!
      if (pa === 0) {
        // 2) 배경이 완전 투명이고 전경 알파가 있으면 전경이 그대로 남는다.
        if (ca > 0) continue
        // 3) 양쪽 다 완전 투명 검정이면 어떤 구현이든 (0,0,0,0) 이다.
        if (
          cur[at]! === 0 &&
          cur[at + 1]! === 0 &&
          cur[at + 2]! === 0 &&
          prev[at]! === 0 &&
          prev[at + 1]! === 0 &&
          prev[at + 2]! === 0
        ) {
          continue
        }
      }
      return 0
    }
  }
  return 1
}

/**
 * blend_op=OVER 전용 크롭.
 *
 * 사각형 안에서 prev 와 값이 같은 픽셀을 완전 투명(0,0,0,0)으로 눌러 둔다.
 * OVER 는 알파 0 을 배경 그대로 통과시키므로 결과가 바뀌지 않는다. 대신 넓은 사각형이
 * 0 으로 가득 차서 deflate 가 훨씬 잘 먹는다. 이게 OVER 를 고르는 유일한 이득이다.
 * (누르지 않으면 OVER 는 SOURCE 대비 아무것도 절약하지 못한다.)
 *
 * 무손실 근거: pickBlendOp 이 OVER 를 골랐다면 변화 없는 픽셀은
 *   - prev.a > 0  -> 알파 0 을 얹어도 배경(=cur) 이 그대로 남는다
 *   - prev.a === 0 -> 조건 3에 의해 prev 와 cur 이 모두 (0,0,0,0) 이다
 * 둘 중 하나다. 어느 쪽이든 원본과 같다.
 *
 * **반드시 pickBlendOp 이 1 을 돌려준 사각형에만 써라.**
 */
export function cropFrameOverDelta(
  prev: Uint8Array,
  cur: Uint8Array,
  width: number,
  rect: FrameRect,
): Uint8Array {
  assertRect(rect, width, cur.length)
  if (prev.length !== cur.length) {
    throw new Error(`프레임 버퍼 길이가 다르다: ${prev.length} != ${cur.length}`)
  }

  const rowBytes = width * BPP
  const out = new Uint8Array(rect.w * rect.h * BPP)
  let d = 0
  for (let y = 0; y < rect.h; y++) {
    let s = (rect.y + y) * rowBytes + rect.x * BPP
    for (let x = 0; x < rect.w; x++, s += BPP, d += BPP) {
      const r = cur[s]!
      const g = cur[s + 1]!
      const b = cur[s + 2]!
      const a = cur[s + 3]!
      if (r === prev[s] && g === prev[s + 1] && b === prev[s + 2] && a === prev[s + 3]) {
        // out 은 이미 0 이다. 그대로 둔다.
        continue
      }
      out[d] = r
      out[d + 1] = g
      out[d + 2] = b
      out[d + 3] = a
    }
  }
  return out
}
