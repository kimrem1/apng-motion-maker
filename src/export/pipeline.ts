/**
 * 내보내기 파이프라인.
 *
 * 이 파일의 존재 이유는 하나다. **프리뷰와 같은 renderer.renderFrame 을 부른다.**
 * 내보내기 전용 렌더 경로를 만드는 순간 "프리뷰 = 결과물" 이라는 제품의 핵심 약속이
 * 깨진다. 여기서 하는 일은 프레임 인덱스를 정하고, 리드백한 픽셀을 포맷이 기대하는
 * 표현으로 바꾸고, 인코더에 넘기는 것뿐이다.
 *
 * DOM 을 참조하지 않는다. WebGL 컨텍스트는 Renderer 로 주입받는다.
 * 결정론을 위해 Math.random / Date.now / performance.now 를 쓰지 않는다.
 */

import type { AssetTable, LoopSpec, MotionProject } from '@/core/types.ts'
import type { Renderer } from '@/core/renderer/index.ts'
import { parseHexColor } from '@/core/color.ts'
import { exportFrameIndices, frameToSec } from '@/core/time.ts'
import { encodeApng } from '@/export/apng/encoder.ts'
import { encodeGif } from '@/export/gif/encoder.ts'
import { encodeWebp, type WebpWarning } from '@/export/webp/encoder.ts'
import { yieldToHost } from '@/export/yield.ts'

// ---------------------------------------------------------------------------
// 공개 타입
// ---------------------------------------------------------------------------

export type ExportFormat = 'apng' | 'gif' | 'webp' | 'png-sequence'

export interface ExportSettings {
  format: ExportFormat
  /** 출력 해상도. 캔버스와 달라도 된다. 뷰포트가 다르면 합성 전체가 그 크기로 스케일된다. */
  width: number
  height: number
  /** GIF 전용. APNG 는 무시한다. */
  maxColors: number
  transparent: boolean
  /** 0 = 디더 없음, 1 = 최대. Bayer 8x8 오디널 디더 강도. */
  dither: number
  /**
   * WebP 전용. **0~1 이다.** 0~100 이 아니다.
   * 스케일을 섞으면 82 를 넣은 쪽이 최고 품질 파일을 받고도 눈치채지 못한다.
   * 인코더가 범위 밖이면 던지도록 되어 있다.
   */
  quality: number
  /** WebP 전용. 브라우저가 무손실을 못 만들면 경고를 내고 손실로 떨어진다. */
  lossless: boolean
}

export interface ExportProgress {
  phase: 'render' | 'encode' | 'done'
  /**
   * done / total 은 프레임 수가 아니라 **가중 백분율**이다.
   * 렌더 40 + 인코딩 60 으로 합산하므로 total 은 항상 100 이다.
   * 프레임 단위 숫자는 message 에 담는다. 그래야 버튼 하나에 그대로 물릴 수 있다.
   */
  done: number
  total: number
  message: string
}

export interface ExportOutput {
  bytes: Uint8Array
  mime: string
  /** 점 없는 확장자 */
  extension: string
  /**
   * 인코딩 중 사용자에게 알려야 할 것. 지금은 WebP 만 낸다.
   * duration 이 클램프되면 사용자가 고른 fps 와 결과가 달라지는 유일한 경우다.
   */
  warnings?: WebpWarning[]
}

/** 렌더 구간이 전체 진행률에서 차지하는 비중. */
export const RENDER_WEIGHT = 40
export const ENCODE_WEIGHT = 60

/**
 * 렌더한 프레임을 전부 메모리에 들고 있다가 인코더에 통짜로 넘긴다.
 * 상한 없이 두면 2048px x 왕복 238프레임에서 약 4GB 를 한 번에 할당해
 * 탭이 죽거나 시스템이 스와핑에 빠진다. 미리 막고 처방을 알려 준다.
 * 스트리밍 인코딩으로 옮기면 이 상한은 사라진다.
 */
export const MEMORY_BUDGET_BYTES = 700 * 1024 * 1024

export function estimateExportMemory(frameCount: number, width: number, height: number): number {
  return frameCount * width * height * 4
}

export class ExportTooLargeError extends Error {
  override readonly name = 'ExportTooLargeError'
  readonly requiredBytes: number
  constructor(requiredBytes: number) {
    const gb = (requiredBytes / (1024 * 1024 * 1024)).toFixed(1)
    /*
     * 처방을 EASY 사용자가 쓸 수 있는 말로 적는다. "길이를 줄여 주세요" 만 있으면
     * EASY 화면에 길이 컨트롤이 없어서 아무것도 할 수 없다. 거기서 길이를 줄이는
     * 유일한 손잡이는 속도 슬라이더다.
     */
    super(
      `이 설정은 한 번에 약 ${gb}GB 가 필요해 만들 수 없습니다. ` +
        `속도를 조금 올리거나(길이가 짧아집니다) 크기를 한 단계 줄여 주세요.`,
    )
    this.requiredBytes = requiredBytes
  }
}

/**
 * 취소 신호로 중단됐을 때 던진다.
 * name 을 'AbortError' 로 맞춰 두면 호출자가 DOMException 과 같은 방식으로 걸러낼 수 있다.
 */
export class ExportAbortError extends Error {
  override readonly name = 'AbortError'
  constructor() {
    super('내보내기를 취소했습니다.')
  }
}

// ---------------------------------------------------------------------------
// 픽셀 변환
// ---------------------------------------------------------------------------

export type Rgb255 = readonly [number, number, number]

/**
 * readPixels 결과를 파일 포맷이 기대하는 표현으로 바꾼다. 두 가지를 한 번에 한다.
 *
 * 1. **un-premultiply.** 엔진 내부 합성은 premultiplied alpha 다(gl.ts 의
 *    setPremultipliedBlend). PNG 와 GIF 는 straight alpha 를 기대한다. 되돌리지 않으면
 *    반투명 픽셀이 검은색과 섞인 것처럼 보여 가장자리에 어두운 테두리가 생긴다.
 *    a > 0 이면 c = min(255, round(c * 255 / a)), a == 0 이면 rgb 는 의미가 없으므로 0.
 * 2. **세로 뒤집기.** readPixels 의 원점은 좌하단이다. 그대로 쓰면 결과가 상하 반전된다.
 *
 * matte 가 있으면 (불투명 포맷) un-premultiply 대신 그 색 위에 합성한다.
 * premultiplied 상태에서는 out = src + matte * (1 - a) 라 나눗셈이 아예 필요 없다.
 * 이 경로를 빼먹으면 알파 0 인 픽셀이 검게 남아 배경이 새까맣게 나온다.
 *
 * 두 작업을 한 패스로 묶은 것은 프레임당 픽셀을 두 번 훑지 않기 위해서다.
 */
export function readbackToStraight(
  src: Uint8Array,
  dst: Uint8Array,
  width: number,
  height: number,
  matte: Rgb255 | null,
): void {
  const rowBytes = width * 4

  for (let y = 0; y < height; y += 1) {
    let s = (height - 1 - y) * rowBytes
    let d = y * rowBytes
    for (let x = 0; x < width; x += 1, s += 4, d += 4) {
      const a = src[s + 3]!

      if (matte) {
        const inv = 1 - a / 255
        dst[d] = Math.min(255, Math.round(src[s]! + matte[0] * inv))
        dst[d + 1] = Math.min(255, Math.round(src[s + 1]! + matte[1] * inv))
        dst[d + 2] = Math.min(255, Math.round(src[s + 2]! + matte[2] * inv))
        dst[d + 3] = 255
        continue
      }

      if (a === 0) {
        dst[d] = 0
        dst[d + 1] = 0
        dst[d + 2] = 0
        dst[d + 3] = 0
        continue
      }
      if (a === 255) {
        dst[d] = src[s]!
        dst[d + 1] = src[s + 1]!
        dst[d + 2] = src[s + 2]!
        dst[d + 3] = 255
        continue
      }

      const scale = 255 / a
      dst[d] = Math.min(255, Math.round(src[s]! * scale))
      dst[d + 1] = Math.min(255, Math.round(src[s + 1]! * scale))
      dst[d + 2] = Math.min(255, Math.round(src[s + 2]! * scale))
      dst[d + 3] = a
    }
  }
}

/**
 * 알파를 못 담는 출력에서 쓸 배경색.
 * 알파를 유지하는 경우 null 을 돌려주고, 그때만 un-premultiply 경로를 탄다.
 */
export function resolveMatte(doc: MotionProject, settings: ExportSettings): Rgb255 | null {
  // WebP 도 APNG 와 같은 8비트 알파다. 매트를 깔면 투명이 사라진다.
  const keepsAlpha =
    settings.format === 'apng' || settings.format === 'webp' || settings.transparent
  if (keepsAlpha) return null
  const [r, g, b] = parseHexColor(doc.canvas.background.matteColor)
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

// ---------------------------------------------------------------------------
// 타이밍과 루프
// ---------------------------------------------------------------------------

export interface ApngDelay {
  num: number
  den: number
}

/**
 * APNG 의 프레임 지연은 유리수(delay_num / delay_den)라 무손실로 담을 수 있다.
 * 정수 fps 는 1/fps 그대로다. 12.5fps 같은 값만 분모를 정수로 만들려고 2/25 로 확장한다.
 * ms 로 환산하면 30fps 가 33ms(=30.30fps)로 드리프트해 10초에 100ms 이상 어긋난다.
 */
export function fpsToApngDelay(fps: number): ApngDelay {
  for (let num = 1; num <= 100; num += 1) {
    const den = fps * num
    if (Math.abs(den - Math.round(den)) < 1e-9) return { num, den: Math.round(den) }
  }
  // 여기 오는 fps 는 FPS_CHOICES 에 없다. 1000 분모로 근사한다.
  return { num: Math.round(1000 / fps), den: 1000 }
}

/** GIF 는 1/100초 격자다. 인코더가 센티초로 반올림한다. */
export function fpsToGifDelayMs(fps: number): number {
  return 1000 / fps
}

export interface LoopMapping {
  /** APNG acTL num_plays. 0 = 무한, n = n회 재생 */
  apngNumPlays: number
  /**
   * encodeGif 의 loopCount 입력. **재생 횟수**다.
   * 0 = 무한, 1 = 1회(NETSCAPE 확장 생략), n = n회.
   * -1 을 넣으면 안 된다. encodeGif 는 음수를 무한으로 해석한다.
   */
  gifLoopCount: number
  /** WebP ANIM 청크의 loop_count. uint16 이라 65535 로 클램프한다. 의미는 APNG 와 같다. */
  webpLoopCount: number
}

/**
 * 루프 설정을 포맷별 값으로 옮긴다.
 *
 * pingPong 도 count 를 그대로 쓴다. exportFrameIndices 가 이미 2N-2 프레임으로
 * 왕복 한 번을 만들어 두었으므로 파일 1회 재생 = 왕복 1회이고, count 가 곧 왕복 횟수다.
 *
 * **포맷마다 숫자의 의미가 다르다.** 명세만으로는 갈리는 부분이라
 * Chrome ImageDecoder 로 실측해 확정했다 (같은 문서를 세 포맷으로 내보내 repetitionCount 비교).
 *
 *   APNG acTL num_plays = N   -> 총 N회 재생   (N=3 이면 repetitionCount 2)
 *   WebP ANIM loop_count = N  -> 총 N회 재생   (N=3 이면 repetitionCount 2)
 *   GIF  NETSCAPE2.0 = N      -> **추가 반복 N회** = 총 N+1회 재생 (N=3 이면 repetitionCount 3)
 *
 * 그래서 GIF 만 1 을 빼야 세 포맷의 재생 횟수가 같아진다. 안 그러면 "3회 반복" 으로
 * 내보낸 GIF 가 혼자 4번 재생된다.
 */
export function mapLoop(loop: LoopSpec): LoopMapping {
  // 1회 재생. encodeGif 는 1 을 받으면 NETSCAPE 확장을 아예 안 써서 1회로 끝난다.
  if (loop.mode === 'once') return { apngNumPlays: 1, gifLoopCount: 1, webpLoopCount: 1 }
  const count = Math.max(0, Math.round(loop.count))
  if (count <= 0) return { apngNumPlays: 0, gifLoopCount: 0, webpLoopCount: 0 }
  return {
    apngNumPlays: count,
    // count 회 재생 = 추가 반복 count-1 회. count 가 1 이면 확장을 생략하는 1 을 그대로 쓴다.
    gifLoopCount: count === 1 ? 1 : count - 1,
    webpLoopCount: Math.min(0xffff, count),
  }
}

// ---------------------------------------------------------------------------
// 렌더 구간
// ---------------------------------------------------------------------------

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExportAbortError()
}

/**
 * 렌더 루프를 프레임마다 끊는다.
 * 메인 스레드에서 120프레임을 통짜로 돌면 취소 버튼이 눌리지 않고 진행률도 그려지지 않는다.
 * 양보 방식은 export/yield.ts 참조. setTimeout 을 쓰면 백그라운드 탭에서 멈춘다.
 */

export interface RenderSequenceArgs {
  doc: MotionProject
  renderer: Renderer
  assets: AssetTable
  width: number
  height: number
  /** 인코딩할 프레임 인덱스 목록. exportFrameIndices 결과이거나 그 부분집합이다. */
  frames: readonly number[]
  matte: Rgb255 | null
  onFrame?(done: number, total: number): void
  signal?: AbortSignal
}

/**
 * 프레임 목록을 straight alpha RGBA 버퍼 배열로 만든다.
 *
 * 타깃은 루프 밖에서 한 번만 빌린다. 프레임마다 acquire 하면 FBO 를 매번 새로 만들게 되고
 * (풀은 반납 전에는 같은 걸 다시 주지 않는다) 120프레임에 FBO 120개가 생긴다.
 *
 * 메모리: 1080x1080 x 120프레임이면 약 560MB 다. 14.A3 상한 안에서도 큰 값이라
 * 워커 + 스트리밍 인코딩으로 옮길 자리다. 지금은 인코더 API 가 프레임 배열을
 * 통짜로 받으므로 이 구조가 불가피하다.
 */
export async function renderFrameSequence(args: RenderSequenceArgs): Promise<Uint8Array[]> {
  const { doc, renderer, assets, frames, matte, onFrame, signal } = args
  const width = Math.max(1, Math.round(args.width))
  const height = Math.max(1, Math.round(args.height))
  const gl = renderer.gl
  const total = frames.length

  const pooled = renderer.targets.acquire(width, height, 'rgba8')
  const scratch = new Uint8Array(width * height * 4)
  const out: Uint8Array[] = []
  // 렌더 타깃 서술자도 루프 밖에서 한 번만 만든다.
  const target = { gl, width, height, fbo: pooled.fbo }

  try {
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)

    for (let i = 0; i < total; i += 1) {
      throwIfAborted(signal)
      const frame = frames[i]!

      // renderFrame 내부는 floor(t * fps) 로 정수 프레임을 되찾는다. frame/fps 를 그대로
      // 넘기면 부동소수 오차로 frame-1 이 될 수 있으므로 프레임 한가운데 시각을 넘긴다.
      renderer.renderFrame(doc, frameToSec(frame + 0.5, doc.timeline.fps), target, assets)

      gl.bindFramebuffer(gl.FRAMEBUFFER, pooled.fbo)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, scratch)

      const rgba = new Uint8Array(width * height * 4)
      readbackToStraight(scratch, rgba, width, height, matte)
      out.push(rgba)

      onFrame?.(i + 1, total)
      await yieldToHost()
    }
  } finally {
    // 프리뷰가 다시 기본 프레임버퍼에 그리도록 되돌린다.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    renderer.targets.release(pooled)
  }

  return out
}

// ---------------------------------------------------------------------------
// 인코딩 구간
// ---------------------------------------------------------------------------

export interface EncodeArgs {
  doc: MotionProject
  settings: ExportSettings
  frames: readonly Uint8Array[]
  width: number
  height: number
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}

/**
 * 렌더된 RGBA 프레임을 최종 바이트로 만든다.
 * 용량 추정기도 같은 함수를 쓴다. 추정과 실제가 다른 경로를 타면 추정이 의미를 잃는다.
 */
export async function encodeRenderedFrames(args: EncodeArgs): Promise<ExportOutput> {
  const { doc, settings, frames, width, height, onProgress, signal } = args
  const { fps, loop } = doc.timeline
  const mapping = mapLoop(loop)

  if (settings.format === 'apng') {
    const delay = fpsToApngDelay(fps)
    const bytes = await encodeApng(
      frames.map((rgba) => ({ rgba, delayNum: delay.num, delayDen: delay.den })),
      {
        width,
        height,
        numPlays: mapping.apngNumPlays,
        onProgress,
        signal,
      },
    )
    // MIME 을 image/apng 로 주면 이 타입을 모르는 뷰어가 파일을 거부할 수 있다.
    // APNG 는 유효한 PNG 이고, APNG 를 재생하는 브라우저는 acTL 청크로 판단하지
    // MIME 으로 판단하지 않는다. 호환성이 넓은 image/png 를 쓴다.
    return { bytes, mime: 'image/png', extension: 'png' }
  }

  if (settings.format === 'gif') {
    const delayMs = fpsToGifDelayMs(fps)
    const bytes = await encodeGif(
      frames.map((rgba) => ({ rgba, delayMs })),
      {
        width,
        height,
        loopCount: mapping.gifLoopCount,
        maxColors: settings.maxColors,
        transparent: settings.transparent,
        dither: settings.dither,
        onProgress,
        signal,
      },
    )
    return { bytes, mime: 'image/gif', extension: 'gif' }
  }

  if (settings.format === 'webp') {
    const durationMs = fpsToGifDelayMs(fps) // 1000/fps. GIF 전용 이름이지만 계산은 같다.
    const warnings: WebpWarning[] = []
    const bytes = await encodeWebp(
      frames.map((rgba) => ({ rgba, durationMs })),
      {
        width,
        height,
        loopCount: mapping.webpLoopCount,
        quality: settings.quality,
        lossless: settings.lossless,
        onProgress,
        signal,
        onWarning: (w) => warnings.push(w),
      },
    )
    return { bytes, mime: 'image/webp', extension: 'webp', warnings }
  }

  // png-sequence 는 zip 패키징(fflate)이 필요해 아직 없다.
  // 조용히 첫 프레임만 내보내면 사용자가 잘린 결과를 눈치채지 못한다. 명확히 막는다.
  throw new Error('PNG 시퀀스 내보내기는 아직 준비되지 않았습니다. APNG 나 GIF 를 골라 주세요.')
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export interface RunExportArgs {
  doc: MotionProject
  renderer: Renderer
  assets: AssetTable
  settings: ExportSettings
  onProgress?(p: ExportProgress): void
  signal?: AbortSignal
}

/** 이 설정으로 실제 인코딩될 프레임 인덱스. UI 의 프레임 수 표시도 이걸 쓴다. */
export function exportFrames(doc: MotionProject): number[] {
  const { durationFrames, loop } = doc.timeline
  return exportFrameIndices(durationFrames, loop.mode, loop.dedupeBoundaryFrame)
}

export async function runExport(args: RunExportArgs): Promise<ExportOutput> {
  const { doc, renderer, assets, settings, onProgress, signal } = args

  if (settings.format === 'png-sequence') {
    throw new Error('PNG 시퀀스 내보내기는 아직 준비되지 않았습니다. APNG 나 GIF 를 골라 주세요.')
  }

  const width = Math.max(1, Math.round(settings.width))
  const height = Math.max(1, Math.round(settings.height))
  const frames = exportFrames(doc)
  const matte = resolveMatte(doc, settings)

  // 한 프레임도 그리기 전에 막는다. 4GB 를 할당하다 죽으면 사용자는 이유를 모른다.
  const required = estimateExportMemory(frames.length, width, height)
  if (required > MEMORY_BUDGET_BYTES) throw new ExportTooLargeError(required)

  throwIfAborted(signal)
  onProgress?.({
    phase: 'render',
    done: 0,
    total: 100,
    message: `프레임 0 / ${frames.length} 그리는 중`,
  })

  const rendered = await renderFrameSequence({
    doc,
    renderer,
    assets,
    width,
    height,
    frames,
    matte,
    signal,
    onFrame: (done, total) => {
      onProgress?.({
        phase: 'render',
        done: (done / total) * RENDER_WEIGHT,
        total: 100,
        message: `프레임 ${done} / ${total} 그리는 중`,
      })
    },
  })

  throwIfAborted(signal)
  onProgress?.({
    phase: 'encode',
    done: RENDER_WEIGHT,
    total: 100,
    message: '압축하는 중',
  })

  const output = await encodeRenderedFrames({
    doc,
    settings,
    frames: rendered,
    width,
    height,
    signal,
    onProgress: (done, total) => {
      // 인코더가 진행률을 못 주면 이 콜백이 아예 안 불린다. 그래도 위에서 40% 를
      // 이미 보고했으므로 막대가 멈춘 것처럼 보이지 진행률이 뒤로 가지는 않는다.
      const ratio = total > 0 ? done / total : 0
      onProgress?.({
        phase: 'encode',
        done: RENDER_WEIGHT + ratio * ENCODE_WEIGHT,
        total: 100,
        message: '압축하는 중',
      })
    },
  })

  onProgress?.({ phase: 'done', done: 100, total: 100, message: '완성' })
  return output
}
