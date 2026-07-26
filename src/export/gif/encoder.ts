// GIF 인코더 어댑터. gifenc 1.0.3 위에 양자화 / 디더 / 먹싱을 얹는다.
// window / document / React 를 참조하지 않는다. 워커에서 그대로 돌아야 한다.

import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import type { GifencFormat, GifencPalette, GifencWriteFrameOptions } from 'gifenc'

import { applyBayerDither } from './dither.ts'
import { yieldToHost } from '../yield.ts'

export interface GifFrame {
  /** RGBA8 픽셀. 길이는 width * height * 4. */
  rgba: Uint8Array
  /** 밀리초. GIF 는 1/100초 격자라 인코더가 Math.round(delayMs / 10) 으로 변환한다. */
  delayMs: number
}

export interface GifOptions {
  width: number
  height: number
  /** 0 = 무한 */
  loopCount: number
  maxColors: number // 64 | 128 | 256
  transparent: boolean // 투명 배경 유지 여부
  dither: number // 0 = 끔, 1 = 최대
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** 글로벌 팔레트를 만들 때 쓰는 대표 샘플 프레임 수 상한. */
export const SAMPLE_FRAME_MAX = 16

/** 1비트 알파 임계값. 이 값 이하면 완전 투명으로 스냅한다. */
export const ALPHA_THRESHOLD = 127

/** 투명 예약 인덱스. 팔레트 0번을 항상 투명으로 쓴다. */
export const TRANSPARENT_INDEX = 0

/** GIF 컬러 테이블 상한. */
const MAX_PALETTE_COLORS = 256
const MIN_PALETTE_COLORS = 2

/**
 * 프레임 배열을 GIF89a 바이트로 인코딩한다.
 *
 * 파이프라인
 *   1) 균등 간격으로 최대 16 프레임을 골라 이어붙인 대표 샘플을 만든다
 *   2) quantize 를 **한 번만** 호출해 글로벌 팔레트를 만든다
 *   3) 투명이면 팔레트 0번을 투명으로 예약한다
 *   4) 각 프레임은 Bayer 디더 -> applyPalette 만 수행한다 (재양자화 없음)
 */
export async function encodeGif(
  frames: GifFrame[],
  opts: GifOptions,
): Promise<Uint8Array> {
  const { width, height, loopCount, maxColors, transparent, dither } = opts
  const { onProgress, signal } = opts

  if (frames.length === 0) {
    throw new Error('encodeGif: 프레임이 하나도 없다')
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodeGif: 잘못된 크기 ${width}x${height}`)
  }

  const bytesPerFrame = width * height * 4
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]
    if (!frame) throw new Error(`encodeGif: 프레임 ${i} 이 비어 있다`)
    if (frame.rgba.length !== bytesPerFrame) {
      throw new Error(
        `encodeGif: 프레임 ${i} 픽셀 길이 불일치 (기대 ${bytesPerFrame}, 실제 ${frame.rgba.length})`,
      )
    }
  }

  throwIfAborted(signal)

  const total = frames.length
  onProgress?.(0, total)

  // 1) 대표 샘플. 프레임 전처리(디더 + 알파 스냅)를 거친 픽셀로 만들어야
  //    팔레트가 실제로 인덱싱될 색 분포와 어긋나지 않는다.
  const sampleIndices = pickSampleIndices(total, SAMPLE_FRAME_MAX)
  const sample = new Uint8Array(sampleIndices.length * bytesPerFrame)
  for (let i = 0; i < sampleIndices.length; i += 1) {
    const frame = frames[sampleIndices[i] ?? 0]
    if (!frame) continue
    sample.set(prepareFrame(frame.rgba, width, height, dither, transparent), i * bytesPerFrame)
  }

  throwIfAborted(signal)

  // 2) + 3) 글로벌 팔레트
  const palette = buildGlobalPalette(sample, maxColors, transparent)
  const format: GifencFormat = transparent ? 'rgba4444' : 'rgb565'

  const encoder = GIFEncoder()
  const repeat = loopCountToRepeat(loopCount)

  // 4) 프레임별 디더 + applyPalette
  for (let i = 0; i < total; i += 1) {
    throwIfAborted(signal)

    const frame = frames[i]
    if (!frame) continue

    const prepared = prepareFrame(frame.rgba, width, height, dither, transparent)
    const indexed = applyPalette(prepared, palette, format)

    const frameOpts: GifencWriteFrameOptions = {
      // delayMs 는 fps 에서 계산된 값을 그대로 넘긴다. 센티초 변환은 gifenc 몫이다.
      delay: frame.delayMs,
      repeat,
      transparent,
      transparentIndex: transparent ? TRANSPARENT_INDEX : 0,
      // 투명이면 2 (배경색으로 복원) 여야 이전 프레임이 비쳐 보이지 않는다.
      // 불투명이면 1 (그대로 두기) 이 프레임 간 LZW 반복에 유리하다.
      dispose: transparent ? 2 : 1,
    }
    // 팔레트는 **첫 프레임에서만** 넘긴다. 이후 프레임에 넘기면 gifenc 가
    // 로컬 컬러 테이블을 프레임마다 다시 써서 파일이 크게 부푼다.
    if (i === 0) frameOpts.palette = palette

    encoder.writeFrame(indexed, width, height, frameOpts)

    onProgress?.(i + 1, total)
    // 워커/메인 어느 쪽에서 돌든 취소 신호와 진행률이 반영될 틈을 준다.
    await yieldToHost()
  }

  throwIfAborted(signal)

  encoder.finish()
  return encoder.bytes()
}

/**
 * loopCount -> gifenc repeat 매핑.
 *   0  -> 0  (무한)
 *   1  -> -1 (NETSCAPE 확장을 아예 쓰지 않는다 = 1회 재생)
 *   n  -> n
 *
 * **불확실성 주의**: NETSCAPE2.0 확장의 16비트 값이 "추가 반복 횟수"인지
 * "총 재생 횟수"인지는 명세가 모호하고 리더마다 해석이 갈린다.
 * (원 명세에는 iteration count 로만 적혀 있고, 0 = 무한이라는 관례만 확고하다.)
 * 여기서는 값을 그대로 기록하고, 실제 브라우저별 재생 횟수는 검증 화면에서
 * 실측하기로 한다. 이 함수는 "기록되는 숫자"만 결정한다.
 */
export function loopCountToRepeat(loopCount: number): number {
  if (!Number.isFinite(loopCount)) return 0
  const n = Math.trunc(loopCount)
  if (n <= 0) return 0 // 무한
  if (n === 1) return -1 // 1회: 확장 자체를 생략
  return n
}

/**
 * 균등 간격으로 최대 max 개의 프레임 인덱스를 고른다.
 * 항상 첫 프레임과 마지막 프레임을 포함한다.
 */
export function pickSampleIndices(total: number, max: number): number[] {
  if (total <= 0) return []
  if (total <= max || max <= 1) {
    const all: number[] = []
    for (let i = 0; i < total; i += 1) all.push(i)
    return all
  }
  const out: number[] = []
  let last = -1
  for (let i = 0; i < max; i += 1) {
    const idx = Math.round((i * (total - 1)) / (max - 1))
    if (idx !== last) {
      out.push(idx)
      last = idx
    }
  }
  return out
}

/**
 * 대표 샘플로 글로벌 팔레트를 만든다.
 * 투명 모드에서는 인덱스 0 을 [0,0,0,0] 로 예약하고 나머지를 불투명 색으로 채운다.
 */
export function buildGlobalPalette(
  sample: Uint8Array,
  maxColors: number,
  transparent: boolean,
): GifencPalette {
  const colors = clampColorCount(maxColors)

  if (!transparent) {
    const palette = quantize(sample, colors, { format: 'rgb565' })
    // quantize 는 색이 극단적으로 적으면 1개만 돌려줄 수 있다.
    // GIF 컬러 테이블은 최소 2개가 필요하다.
    if (palette.length === 0) return [[0, 0, 0], [255, 255, 255]]
    if (palette.length === 1) return [palette[0] as number[], [255, 255, 255]]
    return palette
  }

  const raw = quantize(sample, colors, {
    format: 'rgba4444',
    oneBitAlpha: ALPHA_THRESHOLD,
    clearAlpha: true,
    clearAlphaColor: 0,
    clearAlphaThreshold: 0,
  })

  // quantize 가 만든 투명 항목은 버린다. 투명은 우리가 0번에 하나만 둔다.
  const opaque = raw
    .filter((c) => (c[3] ?? 255) !== 0)
    .slice(0, colors - 1)
    .map((c) => [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, 255])

  if (opaque.length === 0) opaque.push([0, 0, 0, 255])

  return [[0, 0, 0, 0], ...opaque]
}

/**
 * 프레임 전처리. 항상 새 버퍼를 돌려준다.
 *
 * gifenc 의 quantize / applyPalette 는 내부에서 `new Uint32Array(rgba.buffer)` 를
 * 쓰기 때문에 byteOffset 이 0 이고 버퍼 전체가 픽셀인 배열이어야 한다.
 * applyBayerDither 가 항상 새로 할당하므로 그 조건이 자동으로 만족된다.
 */
function prepareFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  dither: number,
  transparent: boolean,
): Uint8Array {
  const out = applyBayerDither(rgba, width, height, dither)
  if (transparent) snapAlpha(out)
  return out
}

/**
 * 알파를 1비트로 스냅한다. 투명 픽셀은 RGB 까지 0 으로 지운다.
 *
 * RGB 를 지우는 것이 핵심이다. applyPalette('rgba4444') 는 RGBA 유클리드 거리로
 * 최근접 색을 고르는데, 예를 들어 알파 0 인 흰 픽셀 (255,255,255,0) 은
 * 투명 항목 [0,0,0,0] 까지의 거리가 3*255^2 인 반면 불투명 흰색 [255,255,255,255]
 * 까지는 255^2 밖에 안 된다. 그러면 투명해야 할 픽셀이 불투명 흰색으로 매핑된다.
 * RGB 를 0 으로 지우면 투명 항목까지의 거리가 0 이 되어 반드시 인덱스 0 으로 간다.
 */
function snapAlpha(rgba: Uint8Array): void {
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) <= ALPHA_THRESHOLD) {
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = 0
    } else {
      rgba[i + 3] = 255
    }
  }
}

function clampColorCount(maxColors: number): number {
  if (!Number.isFinite(maxColors)) return MAX_PALETTE_COLORS
  const n = Math.trunc(maxColors)
  if (n < MIN_PALETTE_COLORS) return MIN_PALETTE_COLORS
  if (n > MAX_PALETTE_COLORS) return MAX_PALETTE_COLORS
  return n
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  // DOMException 이 없는 런타임도 있으므로 name 만 맞춘 Error 를 던진다.
  const err = new Error('GIF 인코딩이 취소되었다')
  err.name = 'AbortError'
  throw err
}

