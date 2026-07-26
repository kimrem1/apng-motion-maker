/**
 * 인코딩 워커 프로토콜.
 *
 * 메인 스레드와 워커가 **같은 이 파일**을 읽는다. 여기에 요청 타입과 실제 인코딩
 * 함수를 함께 둔 이유는 하나다. 워커 생성이 실패해 메인 스레드로 폴백할 때
 * 다른 코드 경로를 타면 "워커에서는 되는데 폴백에서는 색이 다르다" 같은 버그가
 * 생긴다. runEncodeJob 하나만 존재한다.
 *
 * window / document / React 를 참조하지 않는다.
 *
 * ## 소유권 계약 (중요)
 *
 * EncodeJobRequest.frames 의 ArrayBuffer 는 **transfer 로 넘어간다.**
 * postMessage 가 끝나는 순간 보낸 쪽의 버퍼는 detached 되어 byteLength 가 0 이 된다.
 * 넘긴 뒤에 읽으면 예외가 아니라 **빈 데이터**를 보게 되므로 조용히 깨진다.
 * 그래서 규칙은 하나다. **encode 를 부른 뒤에는 frames 를 절대 읽지 마라.**
 * 미리보기 등으로 프레임이 더 필요하면 넘기기 전에 복사해 두어야 한다.
 *
 * 반환되는 결과 바이트도 같은 방식으로 워커 -> 메인으로 transfer 된다.
 *
 * ## 취소
 *
 * AbortSignal 은 구조적 복제가 안 된다. 그래서 두 단계로 나눴다.
 *
 * 1. `cancel(jobId)` 메시지: 워커가 내부 AbortController 를 abort 한다.
 *    encodeApng / encodeGif 는 이미 signal 을 받아 프레임 경계마다 확인하므로
 *    보통 수십 ms 안에 AbortError 로 끝난다. 부분 결과가 남지 않는다.
 * 2. 그래도 안 끝나면 호출자(pipelineWorker.ts)가 worker.terminate() 로 죽인다.
 *    "취소는 워커 terminate 로 즉시 반응" 이 이쪽이다.
 *
 * 1번을 먼저 쓰는 이유는 워커 재사용 때문이다. terminate 하면 다음 내보내기에서
 * 모듈 로드를 다시 해야 한다.
 */

import type { MotionProject } from '@/core/types.ts'
import {
  fpsToApngDelay,
  fpsToGifDelayMs,
  mapLoop,
  type ExportFormat,
  type ExportSettings,
} from '@/export/pipeline.ts'
import { encodeApng } from '@/export/apng/encoder.ts'
import { encodeGif } from '@/export/gif/encoder.ts'
import { encodeWebp, isWebpSupported } from '@/export/webp/encoder.ts'

/** 프로토콜이 바뀌면 올린다. 워커와 메인의 버전이 다르면 폴백한다. */
export const ENCODE_PROTOCOL_VERSION = 1

/** 워커가 다루는 포맷. png-sequence 는 zip 패키징이라 이 경로로 오지 않는다. */
export type WorkerFormat = 'apng' | 'gif' | 'webp'

export interface EncodeJobRequest {
  /** 취소 대상을 지목하는 데 쓴다. 메인 스레드가 증가시킨다. */
  jobId: number
  protocolVersion: number
  format: WorkerFormat
  width: number
  height: number
  /**
   * straight alpha RGBA8 프레임. 길이는 각각 width * height * 4.
   * 각 원소의 buffer 는 transfer 대상이다. 위 소유권 계약을 읽어라.
   */
  frames: Uint8Array[]
  apng: {
    /** delay_num. num=1, den=fps 면 무손실이다. */
    delayNum: number
    delayDen: number
    /** acTL num_plays. 0 = 무한 */
    numPlays: number
  }
  gif: {
    delayMs: number
    /** 재생 횟수. 0 = 무한, 1 = 1회 */
    loopCount: number
    maxColors: number
    transparent: boolean
    dither: number
  }
  webp: {
    /** 프레임 지연 ms. 인코더가 20ms 하한으로 클램프한다. */
    durationMs: number
    /** ANIM loop_count. 0 = 무한. 0..65535 */
    loopCount: number
    /** **0~1 이다. 0~100 이 아니다.** encodeWebp 가 1 초과를 던진다. */
    quality: number
    lossless: boolean
  }
}

export interface EncodeJobResult {
  bytes: Uint8Array
  mime: string
  /** 점 없는 확장자 */
  extension: string
}

export interface EncodeProgress {
  done: number
  total: number
}

/**
 * 진행률 콜백. 메인 스레드에서 Comlink.proxy 로 감싸서 넘겨야 한다.
 * 날것의 함수를 넘기면 postMessage 가 DataCloneError 를 던진다.
 * 워커에서 부르면 실제로는 Promise 를 돌려주지만 반환값은 쓰지 않는다.
 */
export type EncodeProgressCallback = (progress: EncodeProgress) => void

export interface WorkerCapabilities {
  protocolVersion: number
  /** OffscreenCanvas 생성자가 있는가. */
  offscreenCanvas: boolean
  /** convertToBlob({ type: 'image/webp' }) 이 실제로 webp 를 돌려주는가. (정지 1장) */
  webpStill: boolean
  /**
   * 애니메이션 WebP 를 만들 수 있는가.
   * OffscreenCanvas 는 정지 1장만 만든다. ANIM/ANMF 먹싱이 별도로 있어야 true 가 된다.
   */
  webpAnimated: boolean
  /** 사람이 읽는 부연. UI 에 그대로 띄워도 된다. */
  note: string
}

export interface EncodeWorkerApi {
  capabilities(): Promise<WorkerCapabilities>
  encode(request: EncodeJobRequest, onProgress?: EncodeProgressCallback): Promise<EncodeJobResult>
  /** 진행 중인 job 을 중단시킨다. 이미 끝났으면 아무 일도 하지 않는다. */
  cancel(jobId: number): Promise<void>
}

/** 아직 워커가 만들 수 없는 포맷을 요청했을 때. */
export class UnsupportedFormatError extends Error {
  override readonly name = 'UnsupportedFormatError'
  readonly format: string
  constructor(format: string, detail: string) {
    super(`${format} 내보내기는 아직 준비되지 않았습니다. ${detail}`)
    this.format = format
  }
}

// ---------------------------------------------------------------------------
// 요청 만들기
// ---------------------------------------------------------------------------

export interface BuildRequestArgs {
  jobId: number
  doc: MotionProject
  settings: ExportSettings
  frames: Uint8Array[]
  width: number
  height: number
  /**
   * WebP 품질 덮어쓰기. 생략하면 settings 에 quality / lossless 가 있으면 그걸 쓰고
   * 없으면 기본값을 쓴다. ExportSettings 에 WebP 필드가 정식으로 들어오면
   * 이 인자는 필요 없어진다.
   */
  webp?: { quality?: number; lossless?: boolean }
}

/** WebP 기본 품질. 0~1 스케일이다. */
export const DEFAULT_WEBP_QUALITY = 0.82

/** ANIM loop_count 는 uint16 이다. 넘으면 인코더가 던진다. */
const MAX_WEBP_LOOP_COUNT = 0xffff

/**
 * ExportSettings 에 아직 없는 필드를 안전하게 읽는다.
 * WebP 설정이 정식 필드가 되면 이 헬퍼를 지우고 직접 읽으면 된다.
 */
function readOptional(settings: ExportSettings, key: string): unknown {
  return (settings as unknown as Record<string, unknown>)[key]
}

/**
 * 문서와 설정을 워커가 이해하는 평평한 요청으로 바꾼다.
 *
 * MotionProject 를 통째로 보내지 않는 이유: 문서에는 워커가 쓰지 않는 레이어/트랙/
 * 에셋이 전부 들어 있고, 구조적 복제 비용이 프레임 데이터에 맞먹을 수 있다.
 * 인코더가 실제로 쓰는 값은 지연, 루프, 팔레트 설정뿐이다.
 */
export function buildEncodeRequest(args: BuildRequestArgs): EncodeJobRequest {
  const { jobId, doc, settings, frames, width, height } = args

  // ExportSettings 가 'webp' 를 아직 모를 수 있어 한 단계 넓혀서 본다.
  // 'webp' 가 정식 ExportFormat 이 되면 이 캐스트만 지우면 된다.
  const format = settings.format as ExportFormat | 'webp'
  if (format === 'png-sequence') {
    throw new UnsupportedFormatError('PNG 시퀀스', 'APNG 나 GIF 를 골라 주세요.')
  }

  const { fps, loop } = doc.timeline
  const mapping = mapLoop(loop)
  const delay = fpsToApngDelay(fps)
  const delayMs = fpsToGifDelayMs(fps)

  const rawQuality = args.webp?.quality ?? readOptional(settings, 'quality')
  const rawLossless = args.webp?.lossless ?? readOptional(settings, 'lossless')

  return {
    jobId,
    protocolVersion: ENCODE_PROTOCOL_VERSION,
    format,
    width,
    height,
    frames,
    apng: {
      delayNum: delay.num,
      delayDen: delay.den,
      numPlays: mapping.apngNumPlays,
    },
    gif: {
      delayMs,
      loopCount: mapping.gifLoopCount,
      maxColors: settings.maxColors,
      transparent: settings.transparent,
      dither: settings.dither,
    },
    webp: {
      durationMs: delayMs,
      // ANIM loop_count 는 uint16 이다. 무한(0)이 아닌 큰 값은 잘라야 인코더가 안 던진다.
      loopCount: Math.min(MAX_WEBP_LOOP_COUNT, Math.max(0, mapping.gifLoopCount)),
      quality: typeof rawQuality === 'number' ? rawQuality : DEFAULT_WEBP_QUALITY,
      lossless: rawLossless === true,
    },
  }
}

/**
 * transfer 목록을 만든다.
 *
 * 두 가지를 처리한다.
 * 1. 같은 ArrayBuffer 를 두 번 넣으면 postMessage 가 DataCloneError 를 던진다.
 *    (한 버퍼를 여러 프레임이 subarray 로 나눠 쓰는 경우가 실제로 생긴다)
 * 2. SharedArrayBuffer 는 transfer 대상이 아니다. 목록에서 뺀다. 복사로 넘어간다.
 */
export function collectTransferables(frames: readonly Uint8Array[]): ArrayBuffer[] {
  const seen = new Set<ArrayBufferLike>()
  const out: ArrayBuffer[] = []
  for (const frame of frames) {
    const buffer = frame.buffer
    if (seen.has(buffer)) continue
    seen.add(buffer)
    if (isTransferableBuffer(buffer)) out.push(buffer)
  }
  return out
}

function isTransferableBuffer(buffer: ArrayBufferLike): buffer is ArrayBuffer {
  return typeof SharedArrayBuffer === 'undefined' || !(buffer instanceof SharedArrayBuffer)
}

/**
 * 버퍼 전체를 정확히 차지하는 Uint8Array 로 정규화한다.
 *
 * transfer 는 뷰가 아니라 **버퍼 단위**다. 프레임이 큰 버퍼의 일부를 가리키고 있으면
 * 그 버퍼 전체가 넘어가고, 같은 버퍼를 보던 다른 프레임까지 함께 detach 된다.
 * 그런 경우에만 잘라 낸 복사본을 만든다. 이미 딱 맞으면 그대로 돌려주므로
 * 정상 경로에서는 복사가 0 이다.
 */
export function toOwnedFrames(frames: readonly Uint8Array[]): Uint8Array[] {
  const owners = new Map<ArrayBufferLike, number>()
  for (const frame of frames) {
    owners.set(frame.buffer, (owners.get(frame.buffer) ?? 0) + 1)
  }
  return frames.map((frame) => {
    const exclusive =
      owners.get(frame.buffer) === 1 &&
      frame.byteOffset === 0 &&
      frame.byteLength === frame.buffer.byteLength
    return exclusive ? frame : frame.slice()
  })
}

/** 결과 바이트도 transfer 하려면 버퍼를 통째로 차지해야 한다. */
export function toOwnedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes
  return bytes.slice()
}

// ---------------------------------------------------------------------------
// 실제 인코딩 (워커와 메인 폴백이 공유한다)
// ---------------------------------------------------------------------------

export async function runEncodeJob(
  request: EncodeJobRequest,
  onProgress?: EncodeProgressCallback,
  signal?: AbortSignal,
): Promise<EncodeJobResult> {
  const { format, width, height, frames } = request
  if (frames.length === 0) throw new Error('인코딩할 프레임이 없습니다.')

  const report = onProgress
    ? (done: number, total: number) => {
        onProgress({ done, total })
      }
    : undefined

  if (format === 'apng') {
    const { delayNum, delayDen, numPlays } = request.apng
    const bytes = await encodeApng(
      frames.map((rgba) => ({ rgba, delayNum, delayDen })),
      { width, height, numPlays, onProgress: report, signal },
    )
    // MIME 을 image/apng 로 주면 이 타입을 모르는 뷰어가 거부한다. pipeline.ts 와 같은 선택.
    return { bytes: toOwnedBytes(bytes), mime: 'image/png', extension: 'png' }
  }

  if (format === 'gif') {
    const { delayMs, loopCount, maxColors, transparent, dither } = request.gif
    const bytes = await encodeGif(
      frames.map((rgba) => ({ rgba, delayMs })),
      { width, height, loopCount, maxColors, transparent, dither, onProgress: report, signal },
    )
    return { bytes: toOwnedBytes(bytes), mime: 'image/gif', extension: 'gif' }
  }

  // WebP 는 OffscreenCanvas.convertToBlob 으로 정지 프레임을 만들고 ANIM/ANMF 로 먹싱한다.
  // OffscreenCanvas 는 워커 전역에도 있으므로 이 경로가 워커에서 그대로 돈다.
  // (메인 스레드 폴백에서도 같은 함수를 부르므로 결과 바이트는 동일하다)
  const { durationMs, loopCount, quality, lossless } = request.webp
  if (!isWebpSupported()) {
    throw new UnsupportedFormatError(
      'WebP',
      '이 브라우저에 OffscreenCanvas WebP 인코더가 없습니다. GIF 나 APNG 를 골라 주세요.',
    )
  }
  const bytes = await encodeWebp(
    frames.map((rgba) => ({ rgba, durationMs })),
    { width, height, loopCount, quality, lossless, onProgress: report, signal },
  )
  return { bytes: toOwnedBytes(bytes), mime: 'image/webp', extension: 'webp' }
}

// ---------------------------------------------------------------------------
// 능력 확인
// ---------------------------------------------------------------------------

/**
 * 워커 안에서 WebP 를 만들 수 있는지 **실제로 인코딩해서** 확인한다.
 *
 * API 존재 확인만으로는 부족하다. convertToBlob 은 지원하지 않는 타입을 요청받으면
 * 던지지 않고 조용히 image/png 를 돌려준다. 그래서 1x1 을 실제로 만들어 보고
 * blob.type 을 확인한다. 이것만이 확실하다.
 */
export async function probeCapabilities(): Promise<WorkerCapabilities> {
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined'
  let webpStill = false

  if (offscreenCanvas && isWebpSupported()) {
    try {
      const canvas = new OffscreenCanvas(1, 1)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const blob = await canvas.convertToBlob({ type: 'image/webp' })
        webpStill = blob.type === 'image/webp'
      }
    } catch {
      webpStill = false
    }
  }

  return {
    protocolVersion: ENCODE_PROTOCOL_VERSION,
    offscreenCanvas,
    webpStill,
    // 애니메이션 WebP 는 정지 프레임 + 자체 ANIM/ANMF 먹싱이라 정지가 되면 함께 된다.
    webpAnimated: webpStill,
    note: webpStill
      ? 'WebP 를 워커에서 만들 수 있습니다.'
      : '이 브라우저에서는 WebP 를 만들 수 없습니다. GIF 나 APNG 로 대신 만들어 주세요.',
  }
}
