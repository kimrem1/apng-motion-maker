/**
 * 내보내기 파이프라인.
 *
 * 이 파일의 존재 이유는 하나다. 프리뷰와 같은 renderer.renderFrame 을 부른다.
 * 내보내기 전용 렌더 경로를 만드는 순간 "프리뷰 = 결과물" 이라는 제품의 핵심 약속이
 * 깨진다. 여기서 하는 일은 프레임 인덱스를 정하고, 리드백한 픽셀을 포맷이 기대하는
 * 표현으로 바꾸고, 인코더에 넘기는 것뿐이다.
 *
 * DOM 을 참조하지 않는다. WebGL 컨텍스트는 Renderer 로 주입받는다.
 * 결정론을 위해 Math.random / Date.now / performance.now 를 쓰지 않는다.
 */

import type { GifencPalette } from 'gifenc'

import type { AssetTable, LoopSpec, MotionProject } from '@/core/types.ts'
import type { Renderer } from '@/core/renderer/index.ts'
import { parseHexColor } from '@/core/color.ts'
import { exportFrameIndices, frameToSec } from '@/core/time.ts'
import { ApngStreamEncoder, encodeApng } from '@/export/apng/encoder.ts'
import {
  GifStreamEncoder,
  buildPaletteFromFrames,
  encodeGif,
  pickSampleIndices,
  SAMPLE_FRAME_MAX,
} from '@/export/gif/encoder.ts'
import { WebpStreamEncoder, encodeWebp, type WebpWarning } from '@/export/webp/encoder.ts'
import { FrameFilterChain } from '@/export/compress.ts'
import { yieldToHost } from '@/export/yield.ts'

// ---------------------------------------------------------------------------
// 공개 타입
// ---------------------------------------------------------------------------

export type ExportFormat = 'apng' | 'gif' | 'webp' | 'png-sequence'

/**
 * 결과 파일 자체를 돌리는 각도. 시계 방향이고 90 의 배수만 있다.
 *
 * 임의 각도는 리샘플링이 필요하다. 그러면 가장자리가 뭉개지고 알파가 번져서, 이
 * 파이프라인이 지키는 "미리보기가 곧 결과물" 이 깨진다. 90 의 배수는 픽셀 순열이라
 * 한 픽셀도 섞이지 않는다. 그림을 비스듬히 돌리고 싶으면 레이어 회전을 쓰면 된다.
 */
export type ExportRotate = 0 | 90 | 180 | 270

/** 회전을 마친 뒤의 반전. 'x' 는 좌우, 'y' 는 상하다. */
export type ExportFlip = 'none' | 'x' | 'y'

export interface ExportOrientation {
  rotate: ExportRotate
  flip: ExportFlip
}

export const NO_ORIENTATION: ExportOrientation = { rotate: 0, flip: 'none' }

/**
 * 방향을 적용한 뒤의 픽셀 크기.
 *
 * 90 과 270 에서만 가로세로가 바뀐다. 반전은 크기를 바꾸지 않는다.
 * 인코더는 프레임 버퍼의 **길이**만 검증하므로(gif/encoder.ts, apng/encoder.ts),
 * 여기를 틀리게 넘겨도 예외가 나지 않고 찢어진 파일이 조용히 만들어진다.
 */
export function orientedSize(
  width: number,
  height: number,
  orient: ExportOrientation,
): { width: number; height: number } {
  return orient.rotate === 90 || orient.rotate === 270
    ? { width: height, height: width }
    : { width, height }
}

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
   * WebP 전용. 0~1 이다. 0~100 이 아니다.
   * 스케일을 섞으면 82 를 넣은 쪽이 최고 품질 파일을 받고도 눈치채지 못한다.
   * 인코더가 범위 밖이면 던지도록 되어 있다.
   */
  quality: number
  /** WebP 전용. 브라우저가 무손실을 못 만들면 경고를 내고 손실로 떨어진다. */
  lossless: boolean
  /**
   * 결과 파일 자체의 회전. 시계 방향이다.
   *
   * width / height 는 **회전 전** 렌더 크기다. 캔버스 비율을 그대로 따라야
   * fitSettingsToCanvas 와 용량 맞추기 사다리가 성립한다. 실제 파일 크기는
   * orientedSize(width, height, ...) 다. 여기에 회전 후 크기를 넣으면
   * fitSettingsToCanvas 가 캔버스 비율에 맞춰 되돌려 회전이 무효가 된다.
   */
  rotate: ExportRotate
  /** 회전 뒤의 반전. */
  flip: ExportFlip
  /**
   * 움직임 없는 픽셀을 얼려 두는 세기. 0 이면 끈다.
   *
   * 프레임마다 색이 아주 조금씩 흔들리는 픽셀(사진의 그레인, 그라데이션의 디더 잡티,
   * 압축 잔여물)이 용량의 대부분을 먹는다. 눈에는 안 보이는데 코덱은 그걸 전부
   * "바뀐 픽셀" 로 보기 때문이다. 이 값보다 가까운 색이면 화면에 이미 찍혀 있는 값을
   * 그대로 두고 갱신하지 않는다. APNG 는 차분 사각형이 좁아지고, GIF 는 같은
   * 팔레트 인덱스가 길게 이어져 LZW 가 짧아진다.
   *
   * 비교 대상이 "직전 입력 프레임" 이 아니라 "지금 화면에 찍혀 있는 값" 이라서
   * 오차가 누적되지 않는다. 아무리 오래 얼어 있어도 참값과의 거리가 이 값 안이다.
   * 자세한 규칙은 export/compress.ts 에 있다.
   */
  freeze: number
  /** 그레인(미세 노이즈)을 미리 걷어낸다. 얼리기가 훨씬 잘 먹는다. */
  degrain: boolean
}

export interface ExportProgress {
  phase: 'render' | 'encode' | 'done'
  /**
   * done / total 은 프레임 수가 아니라 가중 백분율이다. total 은 항상 100 이다.
   * 가중치는 경로마다 다르다. 통짜 경로는 렌더 40 + 인코딩 60, 스트리밍 경로는
   * 렌더+인코딩 인터리브 95 (phase 'render' 로 보고) + 마무리 5 다. phase 로
   * 백분율 구간을 역산하면 안 되고, 프레임 단위 숫자는 message 에 담는다.
   */
  done: number
  total: number
  message: string
}

/**
 * 통짜 인코딩 결과. 프레임 전체를 메모리에 들고 도는 경로가 낸다.
 * 용량 추정처럼 바이트를 직접 재는 쪽이 이 형태를 쓴다.
 */
export interface EncodedBuffer {
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

/**
 * 내보내기 최종 결과. Uint8Array 가 아니라 Blob 이다.
 *
 * 큰 파일에서 이 차이가 성공과 실패를 가른다. 완성 바이트를 이어붙이고(사본 1),
 * 호출자가 slice 로 뷰를 떼어내고(사본 2), Blob 을 만들며 또 복사하면(사본 3)
 * 1GB 파일이 JS 힙에서 3~4GB 를 요구해 탭이 그냥 죽는다.
 *
 * Blob 의 데이터는 JS 힙이 아니라 브라우저가 관리하는 저장소에 있고 필요하면
 * 디스크로 내려간다. 스트리밍 경로는 조각을 만들자마자 Blob 으로 흘려보내므로
 * 힙에는 마지막 몇 MB 만 남는다.
 */
export interface ExportOutput {
  blob: Blob
  byteLength: number
  mime: string
  /** 점 없는 확장자 */
  extension: string
  warnings?: WebpWarning[]
}

/** 렌더 구간이 전체 진행률에서 차지하는 비중. */
export const RENDER_WEIGHT = 40
export const ENCODE_WEIGHT = 60

/**
 * 통짜 경로의 상한. 렌더한 프레임을 전부 메모리에 들고 있다가 인코더에 넘기는
 * 방식은 2048px x 왕복 238프레임에서 약 4GB 를 한 번에 할당해 탭이 죽거나
 * 시스템이 스와핑에 빠진다. 4000px 에서는 프레임 11장이면 이 예산을 채운다.
 *
 * 이 값을 넘으면 막지 않고 스트리밍 경로로 간다 (runExport 참조). 프레임을 렌더하는 즉시
 * 인코딩하고 원시 RGBA 를 버리므로 상주 메모리가 프레임 두어 장 + 압축 결과로
 * 떨어진다. 통짜 경로를 남겨 두는 이유는 APNG 무손실 팔레트화(전 프레임을
 * 미리 훑어야 한다) 때문이다.
 */
export const MEMORY_BUDGET_BYTES = 700 * 1024 * 1024

export function estimateExportMemory(frameCount: number, width: number, height: number): number {
  return frameCount * width * height * 4
}

/** 이 설정이 통짜 버퍼 대신 스트리밍 인코딩을 타야 하는가. */
export function needsStreamingExport(
  frameCount: number,
  width: number,
  height: number,
): boolean {
  return estimateExportMemory(frameCount, width, height) > MEMORY_BUDGET_BYTES
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
 * 1. un-premultiply. 엔진 내부 합성은 premultiplied alpha 다(gl.ts 의
 *    setPremultipliedBlend). PNG 와 GIF 는 straight alpha 를 기대한다. 되돌리지 않으면
 *    반투명 픽셀이 검은색과 섞인 것처럼 보여 가장자리에 어두운 테두리가 생긴다.
 *    a > 0 이면 c = min(255, round(c * 255 / a)), a == 0 이면 rgb 는 의미가 없으므로 0.
 * 2. 세로 뒤집기. readPixels 의 원점은 좌하단이다. 그대로 쓰면 결과가 상하 반전된다.
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
  readbackToOriented(src, dst, width, height, matte, NO_ORIENTATION)
}

/**
 * 리드백 픽셀을 straight alpha 로 바꾸면서 결과 파일의 방향까지 맞춘다.
 *
 * 왜 한 패스인가
 *
 * 회전을 별도 패스로 두면 4000px 프레임 한 장(64MB)이 더 상주한다. 스트리밍 경로가
 * "힙에는 프레임 두어 장만 남는다" 를 근거로 상한을 잡고 있어서(MEMORY_BUDGET_BYTES,
 * STREAM_FLUSH_BYTES) 그 근거가 무너진다. 어차피 여기는 이미 세로 뒤집기를 하느라
 * 읽기 인덱스를 계산하고 있다. 읽는 자리만 바꾸면 회전과 반전이 공짜로 따라온다.
 *
 * 90 의 배수 회전과 반전은 픽셀 순열이라 리샘플링이 0 이다. 한 픽셀도 섞이지 않는다.
 *
 * srcWidth / srcHeight 는 **렌더 크기**이고, dst 는 orientedSize 크기로 채워진다.
 * 바이트 수는 같으므로 호출자의 할당은 그대로다.
 *
 * 인덱스 맵 (P = 4, R = srcWidth * 4). 출력 픽셀을 순서대로 쓰고 읽기 자리만 옮긴다.
 *
 *   회전   base                          stepX  stepY  출력 크기
 *   0      (srcH-1)*R                    +P     -R     srcW x srcH   (세로 뒤집기만)
 *   90     0                             +R     +P     srcH x srcW
 *   180    (srcW-1)*P                    -P     +R     srcW x srcH
 *   270    (srcH-1)*R + (srcW-1)*P       -R     -P     srcH x srcW
 *
 * 반전은 회전이 끝난 좌표계에서 base 와 step 을 접기만 한다.
 */
export function readbackToOriented(
  src: Uint8Array,
  dst: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  matte: Rgb255 | null,
  orient: ExportOrientation,
): void {
  const P = 4
  const R = srcWidth * P
  const out = orientedSize(srcWidth, srcHeight, orient)
  const dstW = out.width
  const dstH = out.height

  let base: number
  let stepX: number
  let stepY: number
  switch (orient.rotate) {
    case 90:
      base = 0
      stepX = R
      stepY = P
      break
    case 180:
      base = (srcWidth - 1) * P
      stepX = -P
      stepY = R
      break
    case 270:
      base = (srcHeight - 1) * R + (srcWidth - 1) * P
      stepX = -R
      stepY = -P
      break
    case 0:
    default:
      base = (srcHeight - 1) * R
      stepX = P
      stepY = -R
      break
  }

  if (orient.flip === 'x') {
    base += (dstW - 1) * stepX
    stepX = -stepX
  } else if (orient.flip === 'y') {
    base += (dstH - 1) * stepY
    stepY = -stepY
  }

  let d = 0
  for (let dy = 0; dy < dstH; dy += 1) {
    const rowStart = base + dy * stepY
    for (let dx = 0; dx < dstW; dx += 1, d += P) {
      const s = rowStart + dx * stepX
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
  /*
   * APNG 는 언제나 알파를 담는다. 화면의 토글도 APNG 에서만 잠겨 있다.
   *
   * WebP 는 여기서 빠진다. 알파를 **담을 수 있는 것**과 **담아야 하는 것**은 다르다.
   * 예전에는 형식만 보고 통과시켜 settings.transparent 를 아예 안 읽었고, 그래서
   * 내보내기 다이얼로그의 '투명 배경 유지' 토글이 WebP 에서 눌리기만 하고 아무
   * 효과도 없는 죽은 컨트롤이었다. 정책이 두 곳에 있으면서 조건이 서로 달랐다
   * (ui/export/ExportDialog.tsx 는 APNG 만 잠근다).
   */
  if (settings.format === 'apng' || settings.transparent) return null
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
   * encodeGif 의 loopCount 입력. 재생 횟수다.
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
 * 포맷마다 숫자의 의미가 다르다. 명세만으로는 갈리는 부분이라
 * Chrome ImageDecoder 로 실측해 확정했다 (같은 문서를 세 포맷으로 내보내 repetitionCount 비교).
 *
 *   APNG acTL num_plays = N   -> 총 N회 재생   (N=3 이면 repetitionCount 2)
 *   WebP ANIM loop_count = N  -> 총 N회 재생   (N=3 이면 repetitionCount 2)
 *   GIF  NETSCAPE2.0 = N      -> 추가 반복 N회 = 총 N+1회 재생 (N=3 이면 repetitionCount 3)
 *
 * 그래서 GIF 만 1 을 빼야 세 포맷의 재생 횟수가 같아진다. 안 그러면 "3회 반복" 으로
 * 내보낸 GIF 가 혼자 4번 재생된다. 그 뺄셈은 loopCountToRepeat 한 곳에서만 한다.
 * 여기서 미리 빼면 값 1 이 "1회 재생" 과 "2회 재생" 두 뜻을 갖게 되어 반복 2회가
 * GIF 에서만 조용히 1회로 깎인다.
 */
export function mapLoop(loop: LoopSpec): LoopMapping {
  // 1회 재생. encodeGif 는 1 을 받으면 NETSCAPE 확장을 아예 안 써서 1회로 끝난다.
  if (loop.mode === 'once') return { apngNumPlays: 1, gifLoopCount: 1, webpLoopCount: 1 }
  const count = Math.max(0, Math.round(loop.count))
  if (count <= 0) return { apngNumPlays: 0, gifLoopCount: 0, webpLoopCount: 0 }
  return {
    apngNumPlays: count,
    // 세 포맷 모두 "재생 횟수" 하나의 의미로 통일한다.
    gifLoopCount: count,
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
  /** **렌더** 크기. 회전이 걸려도 이 값은 캔버스 비율 그대로다. */
  width: number
  height: number
  /** 인코딩할 프레임 인덱스 목록. exportFrameIndices 결과이거나 그 부분집합이다. */
  frames: readonly number[]
  matte: Rgb255 | null
  /**
   * 결과 파일의 방향. 생략하면 지금까지와 같다(세로 뒤집기만).
   * 렌더 타깃은 이 값과 무관하게 언제나 width x height 다. 타깃을 뒤바꾸면
   * 회전이 아니라 찌그러진 그림이 나온다.
   */
  orient?: ExportOrientation
  /**
   * 용량 다이어트 필터. 생략하면 걸지 않는다.
   *
   * 상태를 들고 있으므로(얼리기 화면) 내보내기 한 번에 하나여야 한다. 호출자가
   * 만들어 넘긴다. 여기서 만들면 통짜 경로와 스트리밍 경로가 각자 다른 화면을 들게 된다.
   */
  filter?: FrameFilterChain
  onFrame?(done: number, total: number): void
  signal?: AbortSignal
}

export interface RenderSinkArgs extends RenderSequenceArgs {
  /**
   * 프레임 하나의 straight alpha RGBA 를 받는다. 버퍼는 프레임마다 새로 할당되며
   * 소유권이 sink 로 넘어간다 (APNG 차분이 직전 프레임을 참조하므로 재사용 버퍼면 안 된다).
   */
  sink(rgba: Uint8Array, index: number): Promise<void> | void
}

/**
 * 프레임을 하나씩 렌더해 sink 로 흘린다. 스트리밍 인코딩의 렌더 구간이다.
 *
 * 타깃은 루프 밖에서 한 번만 빌린다. 프레임마다 acquire 하면 FBO 를 매번 새로 만들게 되고
 * (풀은 반납 전에는 같은 걸 다시 주지 않는다) 120프레임에 FBO 120개가 생긴다.
 */
export async function renderFrameSink(args: RenderSinkArgs): Promise<void> {
  const { doc, renderer, assets, frames, matte, onFrame, signal, sink, filter } = args
  const width = Math.max(1, Math.round(args.width))
  const height = Math.max(1, Math.round(args.height))
  const orient = args.orient ?? NO_ORIENTATION
  const gl = renderer.gl
  const total = frames.length

  const pooled = renderer.targets.acquire(width, height, 'rgba8')
  const scratch = new Uint8Array(width * height * 4)
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
      // 방향은 리드백과 한 패스로 묶는다. 회전 후 크기라도 바이트 수는 같다.
      readbackToOriented(scratch, rgba, width, height, matte, orient)
      // 용량 필터는 회전이 끝난 좌표계에서 돈다. 얼리기 화면도 그 좌표계다.
      filter?.apply(rgba)
      await sink(rgba, i)

      onFrame?.(i + 1, total)
      await yieldToHost()
    }
  } finally {
    // 프리뷰가 다시 기본 프레임버퍼에 그리도록 되돌린다.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    renderer.targets.release(pooled)
  }
}

/**
 * 프레임 목록을 straight alpha RGBA 버퍼 배열로 만든다. 통짜 경로 전용이다.
 *
 * 메모리: 1080x1080 x 120프레임이면 약 560MB 다. 그래서 MEMORY_BUDGET_BYTES 를
 * 넘는 설정은 이 함수 대신 renderFrameSink 로 스트리밍한다 (runExport 참조).
 */
export async function renderFrameSequence(args: RenderSequenceArgs): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  await renderFrameSink({
    ...args,
    sink: (rgba) => {
      out.push(rgba)
    },
  })
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
  /**
   * APNG 무손실 팔레트화 스위치. 생략하면 켜짐(인코더 기본값).
   *
   * 용량 추정기가 쓴다. 실제 내보내기가 스트리밍으로 라우팅되는 설정은 팔레트
   * 없이 인코딩되므로, 추정도 팔레트를 꺼야 "추정 경로 = 실제 경로" 불변이 산다.
   * 안 맞추면 256색 이하 콘텐츠에서 추정이 실제 파일보다 몇 배 작게 나온다.
   */
  apngPalette?: boolean
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}

/**
 * 렌더된 RGBA 프레임을 최종 바이트로 만든다.
 * 용량 추정기도 같은 함수를 쓴다. 추정과 실제가 다른 경로를 타면 추정이 의미를 잃는다.
 */
export async function encodeRenderedFrames(args: EncodeArgs): Promise<EncodedBuffer> {
  const { doc, settings, frames, width, height, apngPalette, onProgress, signal } = args
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
        ...(apngPalette === undefined ? {} : { palette: apngPalette }),
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

/** 설정에서 방향만 뽑는다. 두 필드를 따로 읽는 곳이 늘어나면 반드시 한쪽을 빠뜨린다. */
export function orientationOf(settings: ExportSettings): ExportOrientation {
  return { rotate: settings.rotate, flip: settings.flip }
}

/** 이 설정으로 만들어질 파일의 픽셀 크기. 회전이 걸리면 렌더 크기와 다르다. */
export function outputSize(settings: ExportSettings): { width: number; height: number } {
  return orientedSize(
    Math.max(1, Math.round(settings.width)),
    Math.max(1, Math.round(settings.height)),
    orientationOf(settings),
  )
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
  /*
   * 렌더 크기와 파일 크기가 갈라지는 유일한 자리다.
   *
   *   width / height  렌더 타깃. 캔버스 비율 그대로다
   *   out.width / out.height  실제 파일. 90 / 270 이면 가로세로가 바뀐다
   *
   * 인코더는 버퍼 길이만 검증하므로 여기를 섞으면 예외 없이 찢어진 파일이 나온다.
   */
  const orient = orientationOf(settings)
  const out = orientedSize(width, height, orient)
  const filter = new FrameFilterChain({
    freeze: settings.freeze,
    degrain: settings.degrain,
    width: out.width,
    height: out.height,
  })

  /*
   * 통짜 버퍼가 예산을 넘으면 스트리밍으로 간다. 여기서 막고 "크기를 줄여 달라" 고
   * 하면 1080px 왕복 238프레임(약 1.1GB) 같은 정상 설정까지 걸린다.
   */
  if (needsStreamingExport(frames.length, width, height)) {
    return runExportStreaming({
      doc,
      renderer,
      assets,
      settings,
      width,
      height,
      frames,
      matte,
      orient,
      out,
      filter,
      onProgress,
      signal,
    })
  }

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
    orient,
    filter,
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
    // 인코더에는 회전 후 크기를 넘긴다. 프레임 버퍼가 이미 그 모양이다.
    width: out.width,
    height: out.height,
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
  return toExportOutput(output)
}

/** 통짜 결과를 최종 형태로 옮긴다. 여기서 바이트가 JS 힙을 떠난다. */
function toExportOutput(buffer: EncodedBuffer): ExportOutput {
  const blob = new Blob([toBlobPart(buffer.bytes)], { type: buffer.mime })
  return {
    blob,
    byteLength: buffer.bytes.length,
    mime: buffer.mime,
    extension: buffer.extension,
    ...(buffer.warnings ? { warnings: buffer.warnings } : {}),
  }
}

/**
 * Uint8Array 를 Blob 생성자가 받는 형태로 바꾼다.
 *
 * 뷰를 그대로 넘겨도 되지만, SharedArrayBuffer 백킹이면 BlobPart 타입에 맞지
 * 않는다. 그때만 복사한다. 일반 ArrayBuffer 뷰는 복사 없이 그대로 간다.
 */
function toBlobPart(bytes: Uint8Array): BlobPart {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as unknown as BlobPart) : bytes.slice()
}

// ---------------------------------------------------------------------------
// 스트리밍 경로
// ---------------------------------------------------------------------------

/**
 * 스트리밍 진행률에서 렌더+인코딩 인터리브 구간이 차지하는 비중.
 * 나머지 5는 finish(먹싱/연결) 몫이다.
 */
const STREAM_FRAME_WEIGHT = 95

/**
 * GIF 팔레트 표본이 쓸 수 있는 메모리.
 *
 * buildPaletteFromFrames 는 표본을 하나로 이어붙인 버퍼를 만든다. 장수를 고정
 * 16 으로 두면 4000x4000 에서 표본 배열 1GB + 이어붙인 버퍼 1GB 가 되어,
 * 정작 스트리밍으로 아낀 메모리를 팔레트 준비 단계에서 다 써 버린다.
 */
const PALETTE_SAMPLE_BUDGET_BYTES = 192 * 1024 * 1024

/**
 * 이 크기에서 팔레트 표본을 몇 장이나 쓸 수 있는가.
 *
 * 최소 2장이다. 1장이면 애니메이션 전체의 색을 첫 프레임 하나로 대표하게 되고,
 * 색이 크게 바뀌는 모션에서 팔레트가 통째로 틀어진다.
 */
export function paletteSampleCount(width: number, height: number): number {
  const perFrame = Math.max(1, width * height * 4)
  const affordable = Math.floor(PALETTE_SAMPLE_BUDGET_BYTES / perFrame)
  return Math.max(2, Math.min(SAMPLE_FRAME_MAX, affordable))
}

/**
 * 스트리밍 압축 출력 누적 상한.
 *
 * 원시 프레임은 안 쌓지만 압축 결과는 쌓인다. 글리치/자글자글처럼 매 프레임이
 * 노이즈인 콘텐츠는 deflate 가 거의 못 줄여서 4000px 왕복 238프레임이면 출력만
 * 수십 GB 가 될 수 있다. 어딘가에서는 끊어야 한다.
 *
 * 예전 값은 1GB 였고, 그마저도 실제로는 못 닿았다. 완성 바이트를 이어붙이고
 * (사본 1) 다시 잘라내고(사본 2) Blob 으로 옮기느라(사본 3) 힙이 먼저 터졌기
 * 때문이다. 지금은 조각을 만들자마자 Blob 으로 흘려보내므로(STREAM_FLUSH_BYTES)
 * 힙 사용량이 출력 크기와 무관해졌고, 그래서 상한을 2GB 로 올릴 수 있다.
 *
 * 2GB 위로 더 올리지 않는 이유는 브라우저의 Blob/파일 저장 경로와 대부분의
 * 뷰어가 그 근처에서 무너지기 때문이다. 여기서 끊고 이유를 설명하는 편이
 * 탭이 조용히 죽는 것보다 낫다.
 */
export const STREAM_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

/**
 * 이만큼 쌓이면 조각을 Blob 으로 옮기고 JS 힙에서 놓아 준다.
 *
 * 작게 잡으면 Blob 개수가 늘어 브라우저가 관리 비용을 더 쓰고, 크게 잡으면
 * 힙에 그만큼이 상주한다. 64MB 는 4000px 프레임 하나(64MB)와 같은 크기라
 * 프레임 한 장 이상은 절대 안 쌓인다는 뜻이 된다.
 */
const STREAM_FLUSH_BYTES = 64 * 1024 * 1024

/** 포맷별 프레임 push 세션을 하나의 얼굴로 감싼다. */
interface StreamSession {
  add(rgba: Uint8Array): Promise<void>
  /**
   * 지금까지 쌓인 조각을 가져가고 세션에서는 비운다.
   * 흘려보내기를 지원하지 않는 포맷은 빈 배열을 돌려준다.
   */
  drain(): Uint8Array[]
  /** 마무리하고 **남은** 조각을 돌려준다. 이어붙이지 않는다. */
  finishParts(): Uint8Array[]
  /** 지금까지 쌓인 압축 출력 바이트 */
  bytesWritten(): number
}

/**
 * 조각을 Blob 으로 흘려보내며 모으는 통.
 *
 * 완성 파일을 연속된 Uint8Array 로 한 번도 만들지 않는 것이 핵심이다.
 * Blob 생성자는 조각들을 브라우저 저장소로 복사하고, 그 뒤 JS 쪽 참조를 놓으면
 * 힙에서 사라진다. 마지막의 new Blob(blobs) 는 Blob 끼리의 연결이라 데이터를
 * 다시 JS 힙으로 끌어올리지 않는다.
 */
class BlobSink {
  private readonly blobs: Blob[] = []
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private total = 0

  push(parts: readonly Uint8Array[]): void {
    for (const part of parts) {
      if (part.length === 0) continue
      this.pending.push(part)
      this.pendingBytes += part.length
      this.total += part.length
    }
    if (this.pendingBytes >= STREAM_FLUSH_BYTES) this.flush()
  }

  private flush(): void {
    if (this.pending.length === 0) return
    this.blobs.push(new Blob(this.pending.map(toBlobPart)))
    this.pending = []
    this.pendingBytes = 0
  }

  get byteLength(): number {
    return this.total
  }

  toBlob(mime: string): Blob {
    this.flush()
    return new Blob(this.blobs, { type: mime })
  }
}

function createStreamSession(args: {
  doc: MotionProject
  settings: ExportSettings
  width: number
  height: number
  frameCount: number
  /** GIF 전용. 대표 프레임 선렌더로 만든 팔레트. */
  gifPalette: GifencPalette | null
  warnings: WebpWarning[]
  signal?: AbortSignal
}): { session: StreamSession; mime: string; extension: string } {
  const { doc, settings, width, height, frameCount, gifPalette, warnings, signal } = args
  const { fps, loop } = doc.timeline
  const mapping = mapLoop(loop)

  if (settings.format === 'apng') {
    const delay = fpsToApngDelay(fps)
    /*
     * 팔레트는 넘기지 않는다(null). 무손실 팔레트화는 전 프레임을 미리 훑어야
     * 하는데 그게 곧 통짜 버퍼다. 스트리밍까지 온 크기(700MB 초과)의 애니메이션이
     * 전 프레임 256색 이하일 가능성은 사실상 없어 실질 손해도 없다.
     */
    const encoder = new ApngStreamEncoder(
      { width, height, numPlays: mapping.apngNumPlays, frameCount, signal },
      null,
    )
    return {
      session: {
        add: (rgba) => encoder.addFrame({ rgba, delayNum: delay.num, delayDen: delay.den }),
        // APNG 만 흘려보내기가 된다. 청크를 붙이는 즉시 완결되기 때문이다.
        drain: () => encoder.drain(),
        finishParts: () => encoder.finishParts(),
        bytesWritten: () => encoder.bytesWritten,
      },
      // MIME 이 image/png 인 이유는 encodeRenderedFrames 의 주석 참조.
      mime: 'image/png',
      extension: 'png',
    }
  }

  if (settings.format === 'gif') {
    if (!gifPalette) throw new Error('GIF 스트리밍에는 선계산된 팔레트가 필요하다')
    const delayMs = fpsToGifDelayMs(fps)
    const encoder = new GifStreamEncoder(
      {
        width,
        height,
        loopCount: mapping.gifLoopCount,
        transparent: settings.transparent,
        dither: settings.dither,
        signal,
      },
      gifPalette,
    )
    return {
      session: {
        add: (rgba) => encoder.addFrame({ rgba, delayMs }),
        // gifenc 는 내부 버퍼 하나에 계속 쓴다. 중간에 떼어 낼 수 없다.
        drain: () => [],
        finishParts: () => encoder.finishParts(),
        bytesWritten: () => encoder.bytesWritten,
      },
      mime: 'image/gif',
      extension: 'gif',
    }
  }

  if (settings.format === 'webp') {
    const durationMs = fpsToGifDelayMs(fps) // 1000/fps. GIF 전용 이름이지만 계산은 같다.
    const encoder = new WebpStreamEncoder({
      width,
      height,
      loopCount: mapping.webpLoopCount,
      quality: settings.quality,
      lossless: settings.lossless,
      signal,
      onWarning: (w) => warnings.push(w),
    })
    return {
      session: {
        add: (rgba) => encoder.addFrame({ rgba, durationMs }),
        // RIFF 헤더에 전체 크기를 써야 해서 먹싱은 마지막에 한 번에 한다.
        drain: () => [],
        finishParts: () => encoder.finishParts(),
        bytesWritten: () => encoder.bytesWritten,
      },
      mime: 'image/webp',
      extension: 'webp',
    }
  }

  throw new Error('PNG 시퀀스 내보내기는 아직 준비되지 않았습니다. APNG 나 GIF 를 골라 주세요.')
}

interface StreamExportArgs {
  doc: MotionProject
  renderer: Renderer
  assets: AssetTable
  settings: ExportSettings
  /** 렌더 크기. 캔버스 비율 그대로다. */
  width: number
  height: number
  frames: readonly number[]
  matte: Rgb255 | null
  orient: ExportOrientation
  /** 회전을 마친 뒤의 파일 크기. 인코더와 팔레트가 쓰는 값이다. */
  out: { width: number; height: number }
  filter: FrameFilterChain
  onProgress?(p: ExportProgress): void
  signal?: AbortSignal
}

/**
 * 렌더와 인코딩을 프레임 하나 단위로 인터리브한다.
 *
 * 원시 RGBA 를 전 프레임 보관하지 않는다는 설계 불변 규칙(DESIGN_PLAN)의 실현이다.
 * 상주 메모리는 프레임 두어 장(리드백 스크래치 + 현재 프레임 + APNG 차분용 직전
 * 프레임)과 압축 결과뿐이라, 통짜 경로가 감당 못 하는 1080px 왕복 238프레임도
 * 수십 MB 로 끝난다.
 *
 * 통짜 경로와의 차이는 APNG 무손실 팔레트화가 꺼진다는 것 하나다. 나머지는
 * 같은 세션 인코더를 쓰므로 픽셀 결과가 같다.
 */
async function runExportStreaming(args: StreamExportArgs): Promise<ExportOutput> {
  const {
    doc,
    renderer,
    assets,
    settings,
    width,
    height,
    frames,
    matte,
    orient,
    out,
    filter,
    onProgress,
    signal,
  } = args
  const total = frames.length

  throwIfAborted(signal)

  // GIF 팔레트: 대표 프레임만 먼저 렌더한다. 전 프레임을 붙잡지 않기 위해
  // 지불하는 유일한 선행 비용이고, 최대 16프레임이라 예산 안이다.
  let gifPalette: GifencPalette | null = null
  if (settings.format === 'gif') {
    onProgress?.({ phase: 'render', done: 0, total: 100, message: '색상 팔레트 준비 중' })
    // 표본 장수는 크기에 따라 줄인다. 4000px 에서 16장이면 그것만 1GB 다.
    const sampleIndices = pickSampleIndices(total, paletteSampleCount(width, height))
    const sampleFrames: Uint8Array[] = []
    /*
     * 표본에는 본 필터를 쓰지 않는다.
     *
     * 얼리기는 화면 상태를 들고 있어서, 여기서 돌리면 본 렌더가 시작하기도 전에
     * 화면이 표본 프레임들로 채워진다. 그러면 첫 프레임부터 엉뚱한 값과 비교하게 된다.
     * 그레인 제거만 걸어 준다. 그쪽은 색을 실제로 바꾸므로 팔레트가 그 색을 봐야 한다.
     * 얼리기는 새 색을 만들지 않으므로 팔레트와 무관하다.
     */
    const paletteFilter = new FrameFilterChain({
      freeze: 0,
      degrain: settings.degrain,
      width: out.width,
      height: out.height,
    })
    await renderFrameSink({
      doc,
      renderer,
      assets,
      width,
      height,
      frames: sampleIndices.map((i) => frames[i]!),
      matte,
      orient,
      filter: paletteFilter,
      signal,
      sink: (rgba) => {
        sampleFrames.push(rgba)
      },
    })
    gifPalette = buildPaletteFromFrames(sampleFrames, {
      // 표본 프레임은 이미 회전돼 있다. 여기에 렌더 크기를 넘기면 던지지 않고
      // 디더 좌표만 어긋나 무늬가 비스듬해진다 (gif/encoder.ts prepareFrame).
      width: out.width,
      height: out.height,
      maxColors: settings.maxColors,
      transparent: settings.transparent,
      dither: settings.dither,
    })
  }

  const warnings: WebpWarning[] = []
  const { session, mime, extension } = createStreamSession({
    doc,
    settings,
    width: out.width,
    height: out.height,
    frameCount: total,
    gifPalette,
    warnings,
    signal,
  })

  onProgress?.({
    phase: 'render',
    done: 0,
    total: 100,
    message: `프레임 0 / ${total} 만드는 중`,
  })

  const sink = new BlobSink()

  await renderFrameSink({
    doc,
    renderer,
    assets,
    width,
    height,
    frames,
    matte,
    orient,
    filter,
    signal,
    sink: async (rgba) => {
      await session.add(rgba)
      // 완성된 조각을 즉시 Blob 으로 옮긴다. 이게 없으면 압축 결과가 통째로
      // JS 힙에 남아 GB 단위 파일에서 탭이 죽는다.
      sink.push(session.drain())
      if (session.bytesWritten() > STREAM_OUTPUT_LIMIT_BYTES) {
        /*
         * 처방을 EASY 사용자가 쓸 수 있는 말로 적는다. EASY 화면에서 길이를 줄이는
         * 유일한 손잡이는 속도 슬라이더다.
         */
        throw new Error(
          `만들어지는 파일이 ${formatLimit(STREAM_OUTPUT_LIMIT_BYTES)} 를 넘어 중단했습니다. ` +
            '크기를 한 단계 줄이거나 속도를 조금 올려 주세요(길이가 짧아집니다).',
        )
      }
    },
    onFrame: (done, t) => {
      onProgress?.({
        phase: 'render',
        done: (done / t) * STREAM_FRAME_WEIGHT,
        total: 100,
        message: `프레임 ${done} / ${t} 만드는 중`,
      })
    },
  })

  throwIfAborted(signal)
  onProgress?.({
    phase: 'encode',
    done: STREAM_FRAME_WEIGHT,
    total: 100,
    message: '마무리하는 중',
  })

  sink.push(session.finishParts())
  const blob = sink.toBlob(mime)
  onProgress?.({ phase: 'done', done: 100, total: 100, message: '완성' })

  const output: ExportOutput = { blob, byteLength: sink.byteLength, mime, extension }
  if (settings.format === 'webp') return { ...output, warnings }
  return output
}

/** 상한을 사람이 읽는 단위로. 상수를 고쳐도 메시지가 따라오게 만든다. */
function formatLimit(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`
  return `${Math.round(bytes / (1024 * 1024))}MB`
}
