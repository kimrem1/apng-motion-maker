/**
 * 애니메이션 WebP 인코더.
 *
 * **wasm 인코더(wasm-webp 0.1.0, 482,273바이트)를 쓰지 않는다.**
 *
 * 이유: 브라우저가 이미 WebP 인코더를 들고 있다. `OffscreenCanvas.convertToBlob(
 * {type:'image/webp'})` 가 정지 WebP 를 만들어 준다. 애니메이션 WebP 는 그 정지 WebP
 * 들의 비트스트림을 RIFF 컨테이너 안에서 VP8X + ANIM + ANMF 로 다시 묶은 것뿐이다.
 * 먹싱은 순수 바이트 조작이고 WebP 는 CRC 도 없다. 471KB 짜리 wasm 의존성과
 * 그 로딩 실패 경로가 통째로 사라진다.
 *
 * 대가는 파일 크기다. libwebp AnimEncoder 는 프레임 간 차분과 전역 최적화를 하지만
 * 이 경로는 매 프레임을 독립 키 프레임으로 넣는다.
 * 프레임 차분은 APNG 쪽과 함께 다룬다.
 *
 * 파일 구조:
 *   RIFF....WEBP
 *     VP8X   flags(ANIMATION | ALPHA) + canvas 크기
 *     ANIM   배경색 BGRA + loop_count
 *     ANMF   프레임 헤더 + [ALPH] + VP8|VP8L      (프레임 수만큼)
 *
 * window / document 를 참조하지 않는다. OffscreenCanvas 는 워커에도 있으므로
 * 이 파일은 인코드 워커에서 그대로 돈다. 순수 먹싱 함수(muxAnimatedWebp 이하)는
 * 브라우저 API 를 전혀 건드리지 않아 Node 테스트에서 직접 부를 수 있다.
 */

import {
  ALPH_FOURCC,
  ANIM_FOURCC,
  ANMF_FOURCC,
  ANMF_FLAG_BLEND_NONE,
  ANMF_FLAG_DISPOSE_BACKGROUND,
  parseStaticWebp,
  VP8X_FLAG_ALPHA,
  VP8X_FLAG_ANIMATION,
  VP8X_FOURCC,
  VP8L_FOURCC,
  WEBP_MAX_DIMENSION,
  type StaticWebpImage,
} from './parse.ts'
import { buildRiff, concatBytes, writeChunk, writeUint16LE, writeUint24LE } from './riff.ts'
import { yieldToHost } from '../yield.ts'

// ---------------------------------------------------------------------------
// 공개 타입
// ---------------------------------------------------------------------------

export interface WebpFrame {
  /** straight alpha RGBA8. width*height*4 바이트. 프리멀티플라이가 아니다. */
  rgba: Uint8Array
  durationMs: number
}

export type WebpWarningCode = 'duration-clamped' | 'lossless-unavailable' | 'alpha-dropped'

/**
 * 파일은 정상적으로 나왔지만 요청과 다르게 처리된 부분.
 * 던지지 않고 알린다. UI 가 결과 패널에 배지로 띄우면 된다.
 */
export interface WebpWarning {
  code: WebpWarningCode
  message: string
  /** duration-clamped 일 때 클램프된 프레임 수 */
  count?: number
}

export interface WebpOptions {
  width: number
  height: number
  /** 0 = 무한 */
  loopCount: number
  /**
   * **0~1 이다. 0~100 이 아니다.**
   * 두 스케일이 섞이면 82 를 넣은 쪽은 최고 품질 파일을 받고 원인을 못 찾는다.
   * 그래서 1 을 넘는 값은 조용히 자르지 않고 던진다.
   */
  quality: number
  /**
   * 표준 convertToBlob 에는 무손실 스위치가 없다(ImageEncodeOptions 는 type 과
   * quality 뿐이다). true 면 quality 1 로 요청하고, 실제로 VP8L 이 나왔는지
   * 결과 비트스트림으로 확인해 아니면 onWarning 으로 알린다.
   */
  lossless: boolean
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
  /**
   * 선택. duration 클램프처럼 "실패는 아니지만 사용자가 알아야 하는" 사실을 받는다.
   * 반환 타입이 Uint8Array 로 고정돼 있어 경고를 반환값에 실을 수 없다.
   */
  onWarning?(warning: WebpWarning): void
}

// ---------------------------------------------------------------------------
// 타이밍
// ---------------------------------------------------------------------------

/**
 * 프레임 지연 하한 20ms.
 *
 * Blink 는 10ms 이하의 WebP 프레임 지연을 100ms 로 갈아치운다. 60fps(16.67ms)를
 * 그대로 넣으면 Chrome 에서만 10배 느린 파일이 된다. 20ms 로 올리면 50fps 가 되고
 * 이건 WebP 의 fps 상한과 정확히 같다.
 * 클램프가 일어나면 onWarning 으로 알린다. 조용히 바꾸면 사용자는 원인을 못 찾는다.
 */
export const MIN_FRAME_DURATION_MS = 20

/** ANMF duration 은 24비트다. */
export const MAX_FRAME_DURATION_MS = 0xffffff

/** ms 지연을 WebP 가 담을 수 있는 값으로 맞춘다. 순수 함수다. */
export function clampFrameDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs)) {
    throw new Error(`프레임 지연이 유한한 수가 아니다: ${durationMs}`)
  }
  const ms = Math.round(durationMs)
  if (ms < MIN_FRAME_DURATION_MS) return MIN_FRAME_DURATION_MS
  if (ms > MAX_FRAME_DURATION_MS) return MAX_FRAME_DURATION_MS
  return ms
}

export interface DurationPlan {
  durationsMs: number[]
  /** 하한/상한에 걸려 값이 바뀐 프레임 수 */
  clampedCount: number
}

/** 프레임 지연 목록을 미리 계산한다. 인코딩 전에 경고를 띄우려면 이 결과를 본다. */
export function planFrameDurations(durationsMs: readonly number[]): DurationPlan {
  const out: number[] = []
  let clampedCount = 0
  for (const raw of durationsMs) {
    const ms = clampFrameDurationMs(raw)
    if (ms !== Math.round(raw)) clampedCount += 1
    out.push(ms)
  }
  return { durationsMs: out, clampedCount }
}

/** 알파가 하나라도 255 미만인 픽셀이 있는가. 알파 유실 감지에 쓴다. */
export function hasTransparency(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i]! < 255) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 청크 조립 (순수)
// ---------------------------------------------------------------------------

/**
 * VP8X 페이로드 10바이트.
 *   flags(1) + reserved(3) + canvas_width-1(3, LE) + canvas_height-1(3, LE)
 * 크기가 **1 을 뺀 값**이라는 점이 함정이다. 그대로 넣으면 캔버스가 1px 커진다.
 */
export function buildVp8x(width: number, height: number, hasAlpha: boolean, animated: boolean): Uint8Array {
  assertCanvasSize(width, height)
  const data = new Uint8Array(10)
  data[0] = (animated ? VP8X_FLAG_ANIMATION : 0) | (hasAlpha ? VP8X_FLAG_ALPHA : 0)
  // data[1..3] reserved = 0
  writeUint24LE(data, 4, width - 1)
  writeUint24LE(data, 7, height - 1)
  return writeChunk(VP8X_FOURCC, data)
}

/**
 * ANIM 페이로드 6바이트.
 *   background_color BGRA(4) + loop_count(2, LE)
 * loop_count 0 이 무한이다. 배경색은 캔버스를 지울 때 쓰이며 투명 스티커에는 0 이다.
 */
export function buildAnim(
  loopCount: number,
  backgroundBgra: readonly [number, number, number, number] = [0, 0, 0, 0],
): Uint8Array {
  if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 0xffff) {
    throw new Error(`loopCount 는 0..65535 정수여야 한다: ${loopCount}`)
  }
  const data = new Uint8Array(6)
  data[0] = backgroundBgra[0] & 0xff
  data[1] = backgroundBgra[1] & 0xff
  data[2] = backgroundBgra[2] & 0xff
  data[3] = backgroundBgra[3] & 0xff
  writeUint16LE(data, 4, loopCount)
  return writeChunk(ANIM_FOURCC, data)
}

export interface AnmfArgs {
  /** 캔버스 좌상단 기준 좌표. **2픽셀 단위로 저장되므로 짝수만 허용한다.** */
  x: number
  y: number
  width: number
  height: number
  /** 이미 clampFrameDurationMs 를 통과한 값이어야 한다. */
  durationMs: number
  /** true 면 사각형을 덮어쓴다. 투명 프레임에서 이전 프레임이 비쳐 보이지 않게 한다. */
  blendNone: boolean
  disposeBackground: boolean
  /** ALPH / VP8 / VP8L 청크를 이미 writeChunk 로 만든 바이트열 */
  subChunks: readonly Uint8Array[]
}

/**
 * ANMF 청크. 페이로드는 고정 16바이트 헤더 + 서브청크다.
 *   frame_x(3) frame_y(3) frame_width-1(3) frame_height-1(3) duration(3) flags(1)
 * 전부 리틀엔디언 24비트다. 좌표만 2픽셀 단위이고 크기는 픽셀 단위 -1 이다.
 */
export function buildAnmf(args: AnmfArgs): Uint8Array {
  const { x, y, width, height, durationMs, blendNone, disposeBackground, subChunks } = args
  if (x % 2 !== 0 || y % 2 !== 0 || x < 0 || y < 0) {
    throw new Error(`ANMF 좌표는 0 이상 짝수여야 한다: (${x}, ${y})`)
  }
  assertCanvasSize(width, height)

  const body = concatBytes(subChunks)
  const data = new Uint8Array(16 + body.length)
  writeUint24LE(data, 0, x / 2)
  writeUint24LE(data, 3, y / 2)
  writeUint24LE(data, 6, width - 1)
  writeUint24LE(data, 9, height - 1)
  writeUint24LE(data, 12, durationMs)
  data[15] =
    (blendNone ? ANMF_FLAG_BLEND_NONE : 0) | (disposeBackground ? ANMF_FLAG_DISPOSE_BACKGROUND : 0)
  data.set(body, 16)
  return writeChunk(ANMF_FOURCC, data)
}

function assertCanvasSize(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > WEBP_MAX_DIMENSION ||
    height > WEBP_MAX_DIMENSION
  ) {
    throw new Error(
      `WebP 크기는 1..${WEBP_MAX_DIMENSION} 정수여야 한다: ${width}x${height}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 먹싱 (순수)
// ---------------------------------------------------------------------------

export interface StaticWebpSource {
  /** 완성된 정지 WebP 파일 바이트 (convertToBlob 결과) */
  bytes: Uint8Array
  durationMs: number
}

export interface MuxOptions {
  width: number
  height: number
  /** 0 = 무한 */
  loopCount: number
  /** ANIM 배경색 [B, G, R, A]. 기본은 완전 투명. */
  backgroundBgra?: readonly [number, number, number, number]
  onWarning?(warning: WebpWarning): void
}

/**
 * 정지 WebP 여러 장을 애니메이션 WebP 로 묶는다. **여기에 브라우저 API 가 없다.**
 * 이 함수가 순수하기 때문에 먹싱 로직 전체를 Node 테스트로 검증할 수 있다.
 * 이 분리가 이 설계의 핵심이다.
 */
export function muxAnimatedWebp(sources: readonly StaticWebpSource[], opts: MuxOptions): Uint8Array {
  const { width, height, loopCount, backgroundBgra, onWarning } = opts
  assertCanvasSize(width, height)
  if (sources.length === 0) {
    throw new Error('프레임이 하나도 없다')
  }

  const anmfChunks: Uint8Array[] = []
  let anyAlpha = false
  let clampedCount = 0

  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i]!
    const still: StaticWebpImage = parseStaticWebp(source.bytes)

    if (still.width !== width || still.height !== height) {
      throw new Error(
        `프레임 ${i} 의 크기가 캔버스와 다르다: ${still.width}x${still.height} != ${width}x${height}`,
      )
    }
    if (still.hasAlpha) anyAlpha = true

    const duration = clampFrameDurationMs(source.durationMs)
    if (duration !== Math.round(source.durationMs)) clampedCount += 1

    // ALPH 가 있으면 반드시 비트스트림보다 **앞에** 온다. 순서를 바꾸면 디코더가 거부한다.
    const subChunks: Uint8Array[] = []
    if (still.alph !== null) subChunks.push(writeChunk(ALPH_FOURCC, still.alph))
    subChunks.push(writeChunk(still.bitstreamFourCC, still.bitstream))

    anmfChunks.push(
      buildAnmf({
        x: 0,
        y: 0,
        width,
        height,
        durationMs: duration,
        // 전체 캔버스를 매 프레임 덮어쓴다. APNG 의 BLEND_OP_SOURCE 와 같은 의미다.
        // 블렌딩(B=0)으로 두면 투명 영역으로 이전 프레임이 비쳐 잔상이 남는다.
        blendNone: true,
        disposeBackground: false,
        subChunks,
      }),
    )
  }

  if (clampedCount > 0) {
    onWarning?.({
      code: 'duration-clamped',
      count: clampedCount,
      message:
        `프레임 ${clampedCount}개의 지연을 ${MIN_FRAME_DURATION_MS}ms 로 올렸습니다. ` +
        'Chrome 계열이 그보다 짧은 WebP 프레임을 100ms 로 취급해 훨씬 느리게 재생합니다. ' +
        `WebP 는 ${Math.round(1000 / MIN_FRAME_DURATION_MS)}fps 가 상한입니다.`,
    })
  }

  const parts: Uint8Array[] = [
    buildVp8x(width, height, anyAlpha, true),
    buildAnim(loopCount, backgroundBgra),
    ...anmfChunks,
  ]
  return buildRiff(parts)
}

// ---------------------------------------------------------------------------
// 브라우저 인코딩
// ---------------------------------------------------------------------------

/**
 * 이 환경에서 정지 WebP 를 만들 수 있는가.
 * 실제로 image/webp 가 나오는지는 인코딩해 봐야 알 수 있다(convertToBlob 은 지원하지
 * 않는 타입을 요청받으면 image/png 로 떨어진다). 여기서는 API 존재만 본다.
 */
export function isWebpSupported(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof ImageData !== 'undefined' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function'
  )
}

function abortError(): Error {
  const err = new Error('WebP 인코딩이 취소되었다')
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

/** UI 가 그대로 띄울 수 있는 문구다. 대체 포맷 제안과 짝을 이룬다. */
const UNSUPPORTED_MESSAGE =
  '이 브라우저에서는 WebP 를 만들 수 없습니다. GIF 나 APNG 로 대신 만들어 주세요.'

export async function encodeWebp(frames: WebpFrame[], opts: WebpOptions): Promise<Uint8Array> {
  const { loopCount, lossless, onProgress, signal, onWarning } = opts
  const width = opts.width
  const height = opts.height

  assertCanvasSize(width, height)
  if (frames.length === 0) {
    throw new Error('프레임이 하나도 없다')
  }
  if (!isWebpSupported()) {
    throw new Error(UNSUPPORTED_MESSAGE)
  }

  assertQuality01(opts.quality)
  // lossless 요청은 quality 1 로 옮기고, 실제로 무손실(VP8L)이 나왔는지는
  // 결과 비트스트림을 보고 판정한다. 추측하지 않고 확인한다.
  const quality = lossless ? 1 : opts.quality

  const expectedBytes = width * height * 4
  const total = frames.length

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: true })
  if (ctx === null) {
    throw new Error(UNSUPPORTED_MESSAGE)
  }

  // ImageData 는 넘긴 Uint8ClampedArray 를 그대로 참조한다. 버퍼 하나를 돌려 쓰면
  // 프레임마다 width*height*4 를 새로 할당하지 않는다.
  const scratch = new Uint8ClampedArray(expectedBytes)
  const image = new ImageData(scratch, width, height)

  const sources: StaticWebpSource[] = []
  let sourceHadAlpha = false
  let encodedHasAlpha = false
  let sawLossless = false

  for (let i = 0; i < total; i += 1) {
    throwIfAborted(signal)

    const frame = frames[i]!
    if (frame.rgba.length !== expectedBytes) {
      throw new Error(
        `프레임 ${i} 의 RGBA 길이가 맞지 않는다: ${frame.rgba.length} != ${expectedBytes}`,
      )
    }
    if (!sourceHadAlpha && hasTransparency(frame.rgba)) sourceHadAlpha = true

    scratch.set(frame.rgba)
    // putImageData 는 합성하지 않고 픽셀을 그대로 덮어쓴다. 직전 프레임을 지울 필요가
    // 없고, 알파 0 픽셀이 이전 프레임과 섞이지도 않는다.
    ctx.putImageData(image, 0, 0)

    const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
    throwIfAborted(signal)
    if (blob.type !== 'image/webp') {
      // 이 브라우저는 webp 를 못 만들어 png 로 떨어뜨렸다. 그 png 를 ANMF 에 넣으면
      // 완전히 깨진 파일이 나온다. 여기서 끊는 편이 낫다.
      throw new Error(`${UNSUPPORTED_MESSAGE} (돌려받은 형식: ${blob.type || '알 수 없음'})`)
    }

    const bytes = new Uint8Array(await blob.arrayBuffer())
    // 크기와 알파 유무는 여기서 한 번 확인해 둔다. muxAnimatedWebp 가 다시 파싱하지만
    // 경고를 내려면 어차피 프레임 단위로 봐야 한다.
    const still = parseStaticWebp(bytes)
    if (still.hasAlpha) encodedHasAlpha = true
    if (still.bitstreamFourCC === VP8L_FOURCC) sawLossless = true

    sources.push({ bytes, durationMs: frame.durationMs })

    onProgress?.(i + 1, total)
    // convertToBlob 은 대개 비동기지만 구현에 따라 즉시 해소될 수 있다. 프레임마다
    // 한 번 양보해 취소 버튼과 진행률이 도는 시간을 준다.
    await yieldToHost()
  }

  if (lossless && !sawLossless) {
    onWarning?.({
      code: 'lossless-unavailable',
      message:
        '이 브라우저의 WebP 인코더에 무손실 옵션이 없어 손실 압축(최고 품질)으로 저장했습니다.',
    })
  }
  if (sourceHadAlpha && !encodedHasAlpha) {
    onWarning?.({
      code: 'alpha-dropped',
      message:
        '이 브라우저의 WebP 인코더가 투명도를 버렸습니다. 투명 배경이 필요하면 APNG 로 만들어 주세요.',
    })
  }

  throwIfAborted(signal)
  return muxAnimatedWebp(sources, {
    width,
    height,
    loopCount,
    onWarning,
  })
}

/**
 * 품질 스케일 검증. 0~1 을 벗어나면 던진다.
 *
 * 조용히 클램프하면 quality 82 를 넣은 호출자가 "최고 품질"파일을 받고도 눈치채지
 * 못한다. 파일이 몇 배 커졌을 뿐 열리기는 하므로 릴리즈까지 살아남는다.
 * 스케일 착오는 통합 시점에 터뜨리는 편이 싸다.
 */
export function assertQuality01(quality: number): void {
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new Error(
      `WebP quality 는 0~1 이다: ${quality}. ` +
        '0~100 스케일을 쓰고 있다면 100 으로 나눠서 넘겨라.',
    )
  }
}
