/**
 * 목표 용량 맞추기.
 *
 * "2MB 이하로 맞춰줘" 가 1급 컨트롤이다. 사용자는 해상도/프레임/색상/압축 네 노브가
 * 서로 어떻게 얽히는지 모른다. 도구가 대신 조정하되 무엇을 얼마나 희생했는지
 * 반드시 문자열로 남긴다. 조용히 줄이면 사용자는 결과가 왜 뭉개졌는지 알 수 없고,
 * 그 순간 도구를 믿지 않게 된다.
 *
 * ## 조정 순서
 *
 * **해상도(크기)는 절대 줄이지 않는다.** 그림이 작아지는 것이 가장 눈에 띄는
 * 희생이고, 스티커는 받은 쪽 화면에서 원래 크기로 보여야 한다. 크기를 지킨 채
 * 앞칸일수록 눈에 덜 띄는 순서로 줄인다.
 *   0) 얼리기      - 움직임 없는 픽셀을 갱신하지 않는다. 화질 손상이 가장 적다
 *   1) 그레인 제거 - 프레임마다 흔들리는 미세 노이즈만 걷어낸다. 선과 글자는 그대로다
 *   2) 프레임 수   - fps 를 내려 같은 길이를 더 적은 프레임으로 담는다. 그림 자체는
 *                    한 픽셀도 안 상한다. 대신 움직임이 덜 부드러워진다
 *   3) 화질        - WebP 전용. 손실 압축 강도를 올린다
 *   4) 색상 수     - GIF 전용. 인덱스 비트폭이 줄어 LZW 가 짧아진다
 *   5) 압축 파라미터 - 디더를 끄면 인접 픽셀이 같아져 LZW 런이 길어진다
 *
 * 위 순서대로 사다리(ladder)를 만들고 그 위에서 이분 탐색한다. 사다리를 쓰는 이유는
 * 네 노브를 동시에 흔들면 결과를 설명할 수 없기 때문이다. 사다리는 단조 감소이므로
 * "목표를 만족하는 가장 앞쪽 칸" 이 곧 최소 희생이다.
 *
 * ## 인코딩 횟수
 *
 * 실제 측정은 비싸다(표본 8프레임을 렌더 + 인코딩). 기본 6회로 제한한다.
 * 1회는 현재 설정 확인에 쓰고, 남은 5회로 15칸 사다리를 이분 탐색한다
 * (ceil(log2(16)) = 4). 예산이 떨어지면 그때까지 찾은 최선을 돌려준다.
 *
 * 예전에는 해상도 5칸이 들어간 18칸 사다리였다. 해상도 축을 빼면서 얼리기를
 * 세 칸으로 늘리고 그레인 제거 칸을 새로 두었다. 둘 다 크기와 색을 그대로 두는
 * 축이라, "크기를 지키면서 줄인다" 는 새 계약에 맞는 자리다.
 *
 * DOM 을 참조하지 않는다. 측정은 measure 콜백으로 주입받으므로 워커에서도 돈다.
 */

import { GIF_COLOR_CHOICES, type AssetTable, type MotionProject } from '@/core/types.ts'
import type { Renderer } from '@/core/renderer/index.ts'
import { estimateExportSize, formatBytes } from './estimate.ts'
import type { ExportSettings } from './pipeline.ts'

export interface SizeTarget {
  maxBytes: number
}

/** 한 칸의 설정. ExportSettings 에 fps/프레임 수가 없어 따로 들고 다닌다. */
export interface SizeCandidate {
  settings: ExportSettings
  durationFrames: number
  fps: number
}

export interface SizePlan extends SizeCandidate {
  /**
   * 사용자에게 보여줄 변경 요약. "30fps -> 20fps", "크기 512px -> 400px" 같은 항목이다.
   * 아무것도 바꾸지 않았으면 빈 배열이다.
   * 목표를 못 맞췄으면 절대 비어 있지 않다. 왜 못 맞췄는지 마지막 항목에 적는다.
   */
  changes: string[]
  estimatedBytes: number
  achieved: boolean
  /** 실제로 measure 를 부른 횟수. */
  attempts: number
}

/** 후보 하나의 예상 바이트를 돌려준다. 보통 estimate.ts 의 표본 인코딩을 감싼다. */
export type SizeMeasure = (candidate: SizeCandidate) => Promise<number>

export interface SizePlanLimits {
  /** 이보다 낮추지 않는다. 기본 10fps. */
  minFps?: number
  /** GIF 팔레트 하한. 기본 32색. */
  minColors?: number
  /** 실제 인코딩 횟수 상한. 기본 5. */
  maxAttempts?: number
}

export interface PlanForTargetSizeArgs {
  settings: ExportSettings

  /** 목표 용량. target 과 targetBytes 중 하나는 반드시 줘야 한다. */
  target?: SizeTarget
  /** target 의 축약형. UI 호출부가 쓰기 편하다. */
  targetBytes?: number

  /** 생략하면 doc.timeline 에서 가져온다. */
  durationFrames?: number
  fps?: number

  /**
   * 후보 하나의 예상 바이트를 재는 함수.
   * 생략하면 doc / renderer / assets 로 estimate.ts 의 표본 인코딩 측정기를 만든다.
   * 테스트나 워커에서는 이 콜백을 직접 주입해 GPU 없이 탐색 로직만 검사할 수 있다.
   */
  measure?: SizeMeasure
  doc?: MotionProject
  renderer?: Renderer
  assets?: AssetTable

  limits?: SizePlanLimits
  /** 매 측정마다 부른다. 다이얼로그의 "맞추는 중 2/5" 표시에 쓴다. */
  onAttempt?(info: { attempt: number; maxAttempts: number; bytes: number }): void
  signal?: AbortSignal
}

/**
 * 문서의 timeline 만 후보 값으로 갈아 끼운다.
 * 얕은 복사로 충분하다. 레이어/트랙은 건드리지 않으므로 공유해도 안전하다.
 */
function candidateDoc(doc: MotionProject, candidate: SizeCandidate): MotionProject {
  return {
    ...doc,
    timeline: {
      ...doc.timeline,
      fps: candidate.fps,
      durationFrames: candidate.durationFrames,
    },
  }
}

/**
 * 실제 표본 인코딩으로 재는 측정기.
 *
 * 범위의 상한(maxBytes)을 쓴다. "2MB 이하로 맞췄습니다" 라고 해 놓고 2.4MB 를
 * 주면 목표 맞추기 기능 자체가 무의미해진다. 조금 과하게 줄이는 쪽이 낫다.
 */
export function createEstimateMeasure(
  doc: MotionProject,
  renderer: Renderer,
  assets: AssetTable,
  signal?: AbortSignal,
): SizeMeasure {
  return async (candidate: SizeCandidate) => {
    const estimate = await estimateExportSize({
      doc: candidateDoc(doc, candidate),
      renderer,
      assets,
      settings: candidate.settings,
      signal,
    })
    return estimate.maxBytes
  }
}

export const DEFAULT_MAX_ATTEMPTS = 6
const DEFAULT_MIN_FPS = 10
const DEFAULT_MIN_COLORS = GIF_COLOR_CHOICES[0]

/**
 * 사다리 길이 상한. 이분 탐색이 ceil(log2(15+1)) = 4회에 끝나야
 * 첫 측정 1회를 합쳐 6회 예산에 넉넉히 들어간다.
 *
 * 15 는 가장 긴 사다리(GIF)의 실제 길이다.
 * 얼리기 3 + 그레인 1 + 프레임 6 + 색상 3 + 디더 2 = 15.
 */
export const MAX_LADDER_RUNGS = 15

/**
 * 얼리기 사다리.
 *
 * 10 이면 그레인과 디더 잡티가 대부분 얼고, 16 은 무손실 원본에서 안 보이는
 * 권장 상한이다(compress.ts FREEZE_GENTLE). 24 는 이미 압축된 GIF 를 다시 넣은
 * 경우를 위한 칸으로, 평평한 면에 옅은 얼룩이 생길 수 있는 대신 해상도와 색은
 * 끝까지 지킨다. 해상도 축을 빼면서 이 축이 마지막 칸 하나를 더 받았다.
 *
 * 사용자가 이미 더 센 값을 골라 뒀으면 그 칸은 만들지 않는다. 사다리는 단조
 * 감소여야 이분 탐색이 성립한다.
 */
const FREEZE_STEPS = [10, 16, 24] as const

/**
 * fps 사다리. 전부 FPS_CHOICES 안의 값이다.
 * 24 와 12 는 25/12.5 와 거의 같은 자리라 칸만 늘어나므로 뺐다.
 */
const FPS_STEPS = [50, 30, 25, 20, 15, 12.5, 10] as const

/** GIF 팔레트 사다리. 화면 선택지와 같은 값이어야 한다(core/types.ts GIF_COLOR_CHOICES). */
const COLOR_STEPS = [...GIF_COLOR_CHOICES].reverse()

/**
 * WebP 화질 사다리. 0~1 이다.
 *
 * 이 축이 없으면 WebP 는 해상도와 프레임 수 두 노브밖에 없다. 색상/디더는 GIF
 * 전용이라 통째로 건너뛰기 때문이다. 그래서 목표에 조금 못 미치는 WebP 가 굳이
 * 해상도까지 깎여 나왔다. 0.4 아래로는 또렷한 가장자리에 링잉이 눈에 띈다.
 */
const QUALITY_STEPS = [0.7, 0.55, 0.4] as const

/** 압축 파라미터. 디더는 마지막에 건드린다(가장 눈에 덜 띄지만 효과도 작다). */
const DITHER_STEPS = [0.5, 0] as const

// ---------------------------------------------------------------------------
// 사다리
// ---------------------------------------------------------------------------

function withFps(prev: SizeCandidate, base: SizeCandidate, fps: number): SizeCandidate {
  // 벽시계 길이를 유지한다. fps 만 내리고 프레임 수를 그대로 두면 영상이 느려진다.
  const durationFrames = Math.max(2, Math.round((base.durationFrames * fps) / base.fps))
  return { ...prev, fps, durationFrames }
}

/**
 * 조정 사다리를 만든다. 앞칸일수록 희생이 적다.
 * 순서는 얼리기 -> 그레인 -> 프레임 -> 화질/색상 -> 압축 파라미터로 고정이다.
 * **해상도 칸은 없다.** 크기를 바꾸지 않는 것이 이 사다리의 계약이다.
 */
export function buildSizeLadder(base: SizeCandidate, limits: SizePlanLimits = {}): SizeCandidate[] {
  const minFps = Math.max(1, limits.minFps ?? DEFAULT_MIN_FPS)
  const minColors = Math.max(2, Math.floor(limits.minColors ?? DEFAULT_MIN_COLORS))

  const rungs: SizeCandidate[] = []
  let cur = base

  // 0) 얼리기. 그림의 크기도 색도 그대로라 가장 앞이다.
  for (const freeze of FREEZE_STEPS) {
    if (rungs.length >= MAX_LADDER_RUNGS) return rungs
    if (freeze <= cur.settings.freeze) continue
    cur = { ...cur, settings: { ...cur.settings, freeze } }
    rungs.push(cur)
  }

  // 1) 그레인 제거. 얼리기와 함께 써야 효과가 크다 (compress.ts 상단 주석).
  //    사용자가 이미 켜 뒀으면 칸을 만들지 않는다.
  if (!base.settings.degrain) {
    if (rungs.length >= MAX_LADDER_RUNGS) return rungs
    cur = { ...cur, settings: { ...cur.settings, degrain: true } }
    rungs.push(cur)
  }

  // 2) 프레임 수 (fps 를 내린다)
  for (const fps of FPS_STEPS) {
    if (rungs.length >= MAX_LADDER_RUNGS) return rungs
    if (fps >= cur.fps || fps < minFps) continue
    cur = withFps(cur, base, fps)
    rungs.push(cur)
  }

  // 3) 화질. WebP 전용이다. 무손실을 켜 뒀으면 이 값은 안 읽히므로 칸을 만들지 않는다.
  if (base.settings.format === 'webp' && !base.settings.lossless) {
    for (const quality of QUALITY_STEPS) {
      if (rungs.length >= MAX_LADDER_RUNGS) return rungs
      if (quality >= cur.settings.quality) continue
      cur = { ...cur, settings: { ...cur.settings, quality } }
      rungs.push(cur)
    }
  }

  // 4) 색상 수. APNG 는 트루컬러라 팔레트 노브가 없다. 칸을 만들면 측정만 낭비한다.
  if (base.settings.format === 'gif') {
    for (const colors of COLOR_STEPS) {
      if (rungs.length >= MAX_LADDER_RUNGS) return rungs
      if (colors >= cur.settings.maxColors || colors < minColors) continue
      cur = { ...cur, settings: { ...cur.settings, maxColors: colors } }
      rungs.push(cur)
    }
  }

  // 5) 압축 파라미터. 디더도 GIF 전용이다.
  if (base.settings.format === 'gif') {
    for (const dither of DITHER_STEPS) {
      if (rungs.length >= MAX_LADDER_RUNGS) return rungs
      if (dither >= cur.settings.dither) continue
      cur = { ...cur, settings: { ...cur.settings, dither } }
      rungs.push(cur)
    }
  }

  return rungs
}

// ---------------------------------------------------------------------------
// 변경 요약
// ---------------------------------------------------------------------------

function formatDither(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '')
}

/**
 * 무엇을 얼마나 희생했는지 사람 말로 적는다.
 * 이 함수가 비어 있는 배열을 돌려주는 경우는 정말 아무것도 안 바뀐 때뿐이다.
 */
export function describeChanges(base: SizeCandidate, chosen: SizeCandidate): string[] {
  const out: string[] = []

  if (chosen.settings.freeze !== base.settings.freeze) {
    out.push(
      `움직임 없는 픽셀 얼리기 ${base.settings.freeze === 0 ? '끔' : base.settings.freeze}` +
        ` -> ${chosen.settings.freeze} (해상도와 색은 그대로입니다)`,
    )
  }
  if (chosen.settings.degrain !== base.settings.degrain) {
    out.push('그레인(미세 노이즈) 제거 켬 (선과 글자는 그대로입니다)')
  }
  if (chosen.fps !== base.fps) {
    out.push(
      `${base.fps}fps -> ${chosen.fps}fps` +
        ` (${base.durationFrames}프레임 -> ${chosen.durationFrames}프레임)`,
    )
  } else if (chosen.durationFrames !== base.durationFrames) {
    out.push(`${base.durationFrames}프레임 -> ${chosen.durationFrames}프레임`)
  }
  if (chosen.settings.quality !== base.settings.quality) {
    out.push(
      `화질 ${Math.round(base.settings.quality * 100)}% -> ${Math.round(chosen.settings.quality * 100)}%`,
    )
  }
  if (chosen.settings.maxColors !== base.settings.maxColors) {
    out.push(`색상 ${base.settings.maxColors}색 -> ${chosen.settings.maxColors}색`)
  }
  if (chosen.settings.dither !== base.settings.dither) {
    out.push(
      `디더 ${formatDither(base.settings.dither)} -> ${formatDither(chosen.settings.dither)}`,
    )
  }

  return out
}

// ---------------------------------------------------------------------------
// 탐색
// ---------------------------------------------------------------------------

class TargetSizeAbortError extends Error {
  override readonly name = 'AbortError'
  constructor() {
    super('목표 용량 맞추기를 취소했습니다.')
  }
}

export async function planForTargetSize(args: PlanForTargetSizeArgs): Promise<SizePlan> {
  const { settings, doc, renderer, assets, onAttempt, signal } = args
  const limits = args.limits ?? {}
  const maxAttempts = Math.max(1, Math.floor(limits.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))

  const maxBytes = args.target?.maxBytes ?? args.targetBytes
  if (maxBytes === undefined || !(maxBytes > 0)) {
    throw new Error('planForTargetSize: target.maxBytes 나 targetBytes 가 필요합니다.')
  }
  const target: SizeTarget = { maxBytes }

  const durationFrames = args.durationFrames ?? doc?.timeline.durationFrames
  const fps = args.fps ?? doc?.timeline.fps
  if (durationFrames === undefined || fps === undefined) {
    throw new Error('planForTargetSize: durationFrames / fps 또는 doc 이 필요합니다.')
  }

  const measure =
    args.measure ??
    (doc && renderer && assets ? createEstimateMeasure(doc, renderer, assets, signal) : undefined)
  if (!measure) {
    throw new Error('planForTargetSize: measure 또는 doc / renderer / assets 가 필요합니다.')
  }

  const base: SizeCandidate = { settings, durationFrames, fps }
  let attempts = 0

  const measureOnce = async (candidate: SizeCandidate): Promise<number> => {
    if (signal?.aborted === true) throw new TargetSizeAbortError()
    attempts += 1
    const bytes = await measure(candidate)
    onAttempt?.({ attempt: attempts, maxAttempts, bytes })
    return bytes
  }

  // 1) 지금 설정이 이미 목표 안이면 손대지 않는다.
  //    "일단 줄이고 본다" 는 사용자가 고른 품질을 이유 없이 깎는 것이다.
  const baseBytes = await measureOnce(base)
  if (baseBytes <= target.maxBytes) {
    return { ...base, changes: [], estimatedBytes: baseBytes, achieved: true, attempts }
  }

  const ladder = buildSizeLadder(base, limits)
  if (ladder.length === 0) {
    return failedPlan(base, baseBytes, target, attempts, '더 줄일 수 있는 설정이 없습니다')
  }

  // 2) 사다리 이분 탐색. 목표를 만족하는 **가장 앞칸**(= 희생이 가장 적은 칸)을 찾는다.
  let lo = 0
  let hi = ladder.length - 1
  let best: { candidate: SizeCandidate; bytes: number } | null = null
  let worst: { candidate: SizeCandidate; bytes: number } = { candidate: base, bytes: baseBytes }

  while (lo <= hi && attempts < maxAttempts) {
    const mid = (lo + hi) >> 1
    const candidate = ladder[mid]
    if (!candidate) break
    const bytes = await measureOnce(candidate)
    if (bytes <= target.maxBytes) {
      best = { candidate, bytes }
      hi = mid - 1
    } else {
      // 실패한 칸 중 가장 많이 줄인 칸을 기억한다. 끝내 못 맞추면 이걸 돌려준다.
      worst = { candidate, bytes }
      lo = mid + 1
    }
  }

  if (best) {
    const changes = describeChanges(base, best.candidate)
    return {
      ...best.candidate,
      changes,
      estimatedBytes: best.bytes,
      achieved: true,
      attempts,
    }
  }

  // 3) 못 맞췄다. 여기까지 줄였다는 사실과 그래도 넘친다는 사실을 둘 다 알린다.
  //    사다리 끝칸을 측정도 없이 돌려주면 estimatedBytes 가 거짓말이 된다.
  return failedPlan(worst.candidate, worst.bytes, target, attempts, null, base)
}

function failedPlan(
  candidate: SizeCandidate,
  bytes: number,
  target: SizeTarget,
  attempts: number,
  reason: string | null,
  base?: SizeCandidate,
): SizePlan {
  const changes = base ? describeChanges(base, candidate) : []
  const head = reason ? `${reason}. ` : ''
  changes.push(
    `${head}목표 ${formatBytes(target.maxBytes)} 에 맞추지 못했습니다` +
      ` (여기까지 줄여 약 ${formatBytes(bytes)}). 크기는 건드리지 않았습니다.` +
      ` 길이를 줄이거나, 크기를 직접 낮추거나, 더 단순한 모션을 골라 주세요.`,
  )
  return { ...candidate, changes, estimatedBytes: bytes, achieved: false, attempts }
}
