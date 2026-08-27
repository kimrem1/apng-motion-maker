/**
 * 용량 추정.
 *
 * 균등 간격 8프레임만 실제로 렌더/인코딩해 외삽한다. 전량 인코딩은 추정이 아니라
 * 그냥 내보내기다. 추정 경로가 실제 경로와 다르면 추정이 의미를 잃으므로
 * pipeline.ts 의 renderFrameSequence / encodeRenderedFrames 를 그대로 쓴다.
 *
 * 숫자 하나가 아니라 범위로 돌려준다. 이유는 편향이 양방향으로 존재하기 때문이다.
 *
 * - 표본 프레임끼리는 시간축에서 멀리 떨어져 있어 프레임 간 차이가 최대치다.
 *   실제 연속 프레임은 이보다 훨씬 잘 압축되므로 정지 구간이 많은 모션은 과대추정된다.
 * - 반대로 글리치/자글자글처럼 매 프레임 노이즈가 달라지는 모션은 표본 사이의 상관마저
 *   0 에 가까워 델타 압축이 무너지고, 전체 프레임에서도 그대로 무너진다.
 *   여기에 표본 8개로는 잡히지 않는 국소 팔레트 추가까지 붙으면 과소추정된다.
 *
 * 그래서 하한은 낙관 계수, 상한은 비관 계수를 곱해 폭을 남긴다.
 * 이 계수는 실측이 아니라 보수적인 어림값이다. 결과물 통계가 쌓이면 교체한다.
 */

import type { AssetTable, MotionProject } from '@/core/types.ts'
import type { Renderer } from '@/core/renderer/index.ts'
import { FrameFilterChain } from './compress.ts'
import {
  encodeRenderedFrames,
  exportFrames,
  needsStreamingExport,
  orientationOf,
  orientedSize,
  renderFrameSequence,
  resolveMatte,
  type ExportSettings,
} from './pipeline.ts'

/** 실제로 인코딩해 볼 표본 수. 늘리면 정확해지지만 다이얼로그가 느려진다. */
export const ESTIMATE_SAMPLE_COUNT = 8

/**
 * 표본 프레임이 쓸 수 있는 메모리.
 *
 * 추정은 통짜 경로라 표본을 전부 메모리에 들고 있는다. 4000x4000 은 한 장이
 * 64MB 라 8장이면 512MB 다. 다이얼로그를 열었을 뿐인데 그만큼을 잡으면 정작
 * 내보내기가 메모리를 못 얻는다. 그래서 장수를 크기에 맞춰 줄인다.
 */
const ESTIMATE_BUDGET_BYTES = 128 * 1024 * 1024

/**
 * 이 크기에서 몇 장을 표본으로 쓸 수 있는가.
 * 최소 2장이다. 1장이면 프레임 간 차분 압축이 표본에 전혀 안 나타나서
 * 외삽의 근거가 사라진다.
 */
export function estimateSampleCount(width: number, height: number): number {
  const perFrame = Math.max(1, width * height * 4)
  const affordable = Math.floor(ESTIMATE_BUDGET_BYTES / perFrame)
  return Math.max(2, Math.min(ESTIMATE_SAMPLE_COUNT, affordable))
}

/** 표본 외삽의 낙관/비관 계수. 위 주석의 두 편향을 폭으로 흡수한다. */
const OPTIMISTIC = 0.55
const PESSIMISTIC = 1.2

export interface SizeEstimate {
  minBytes: number
  maxBytes: number
  /** 실제로 인코딩한 표본 수 */
  sampledFrames: number
  totalFrames: number
  /** 전체를 다 인코딩했으면 true. 이때 min === max 이고 추정이 아니라 실측이다. */
  exact: boolean
}

export interface EstimateArgs {
  doc: MotionProject
  renderer: Renderer
  assets: AssetTable
  settings: ExportSettings
  signal?: AbortSignal
}

/**
 * 파일에서 프레임 수와 무관한 고정 오버헤드.
 * 외삽할 때 이 부분까지 프레임 수에 비례해 늘리면 짧은 애니메이션이 크게 과대추정된다.
 *
 * GIF 팔레트는 maxColors 가 아니라 실제로 쓰인 팔레트 길이로 계산해야 한다.
 * quantize 는 색이 적으면 그만큼만 돌려주므로, 거의 단색인 소스에서 maxColors 256 을
 * 가정하면 762바이트를 과다 차감한다. 그 오차가 표본 수로 나뉜 뒤 전체 프레임 수로
 * 증폭되어 추정 범위가 실제 파일보다 작아진다(실측: 60프레임에서 상한 32% 초과).
 * 표본보다 오버헤드가 크면 perFrame 이 0 으로 붕괴하는 경로도 있었다.
 */
function fixedOverheadBytes(settings: ExportSettings, sampleBytes: Uint8Array): number {
  if (settings.format === 'gif') {
    const paletteEntries = readGifPaletteLength(sampleBytes) ?? Math.max(2, settings.maxColors)
    // 컬러 테이블 크기는 2의 거듭제곱으로 올림된다.
    const tableSize = 1 << Math.max(1, Math.ceil(Math.log2(Math.max(2, paletteEntries))))
    // 헤더 13 + NETSCAPE2.0 확장 19 + 트레일러 1 + 글로벌 팔레트 3 * 엔트리
    const overhead = 33 + 3 * tableSize
    // 표본보다 큰 오버헤드는 있을 수 없다. 방어적으로 잘라 perFrame 붕괴를 막는다.
    return Math.min(overhead, Math.floor(sampleBytes.length * 0.2))
  }
  if (settings.format === 'webp') {
    // RIFF 헤더 12 + VP8X 18 + ANIM 14. ANMF 당 24바이트는 프레임 비례라 외삽이 처리한다.
    return 44
  }
  // PNG 서명 8 + IHDR 25 + acTL 20 + IEND 12
  return 65
}

/**
 * GIF 논리 화면 서술자에서 글로벌 컬러 테이블 크기를 읽는다.
 * 바이트 10 의 하위 3비트가 size 이고 실제 엔트리는 2^(size+1) 이다.
 */
function readGifPaletteLength(bytes: Uint8Array): number | undefined {
  if (bytes.length < 13) return undefined
  const packed = bytes[10]
  if (packed === undefined) return undefined
  if ((packed & 0x80) === 0) return undefined // 글로벌 테이블 없음
  return 1 << ((packed & 0x07) + 1)
}

/** 균등 간격 표본 인덱스. 결정론을 위해 무작위 추출을 하지 않는다. */
export function sampleIndices(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, i) => i)
  const picked = new Set<number>()
  for (let i = 0; i < count; i += 1) {
    picked.add(Math.round((i * (total - 1)) / (count - 1)))
  }
  return [...picked].sort((a, b) => a - b)
}

export async function estimateExportSize(args: EstimateArgs): Promise<SizeEstimate> {
  const { doc, renderer, assets, settings, signal } = args

  const width = Math.max(1, Math.round(settings.width))
  const height = Math.max(1, Math.round(settings.height))
  const all = exportFrames(doc)
  const totalFrames = all.length

  const picks = sampleIndices(totalFrames, estimateSampleCount(width, height))
  const sampleFrames = picks.map((i) => all[i]!)

  /*
   * 방향과 용량 필터도 실제 경로와 똑같이 건다. "추정 경로 = 실제 경로" 불변이
   * 이 파일의 존재 이유다. 회전을 빼면 90도에서 인코더에 넘기는 크기가 어긋나고,
   * 얼리기를 빼면 실제보다 몇 배 크게 잡혀 용량 맞추기가 과하게 줄인다.
   *
   * 얼리기의 효과는 실제보다 **작게** 잡힌다. 표본이 시간축에서 멀리 떨어져 있어
   * 프레임 사이가 많이 다르기 때문이다. 그 편향은 이 파일이 이미 낙관/비관 계수로
   * 흡수하고 있는 것과 같은 종류다.
   */
  const orient = orientationOf(settings)
  const out = orientedSize(width, height, orient)
  const filter = new FrameFilterChain({
    freeze: settings.freeze,
    degrain: settings.degrain,
    width: out.width,
    height: out.height,
  })

  const rendered = await renderFrameSequence({
    doc,
    renderer,
    assets,
    width,
    height,
    frames: sampleFrames,
    matte: resolveMatte(doc, settings),
    orient,
    filter,
    signal,
  })

  const { bytes } = await encodeRenderedFrames({
    doc,
    settings,
    frames: rendered,
    width: out.width,
    height: out.height,
    /*
     * 실제 내보내기가 스트리밍으로 라우팅되는 설정(700MB 초과)은 APNG 팔레트
     * 최적화 없이 인코딩된다. 추정도 같은 조건으로 돌려야 "추정 경로 = 실제 경로"
     * 불변이 산다. 표본 8프레임은 예산과 무관하게 작으므로 판정은 전체 프레임
     * 수로 한다.
     */
    apngPalette: needsStreamingExport(totalFrames, width, height) ? false : undefined,
    signal,
  })

  // 표본이 곧 전체면 외삽할 것이 없다. 실측값을 그대로 준다.
  if (sampleFrames.length >= totalFrames) {
    return {
      minBytes: bytes.length,
      maxBytes: bytes.length,
      sampledFrames: sampleFrames.length,
      totalFrames,
      exact: true,
    }
  }

  const overhead = fixedOverheadBytes(settings, bytes)
  const perFrame = Math.max(0, bytes.length - overhead) / sampleFrames.length
  const projected = perFrame * totalFrames

  return {
    minBytes: Math.round(overhead + projected * OPTIMISTIC),
    maxBytes: Math.round(overhead + projected * PESSIMISTIC),
    sampledFrames: sampleFrames.length,
    totalFrames,
    exact: false,
  }
}

/** "약 1.5 ~ 2.4MB" 처럼 사람이 읽는 문자열. UI 여러 곳에서 같은 표기를 쓴다. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function formatEstimate(estimate: SizeEstimate): string {
  if (estimate.exact) return formatBytes(estimate.maxBytes)
  return `약 ${formatBytes(estimate.minBytes)} ~ ${formatBytes(estimate.maxBytes)}`
}
