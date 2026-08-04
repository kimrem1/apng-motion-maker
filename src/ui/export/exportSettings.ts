/**
 * 용도 프리셋 테이블.
 *
 * 포맷 선택을 "APNG 냐 GIF 냐" 가 아니라 "어디에 올릴 건가" 로 묻는다.
 * APNG 는 비개발자에게 미지의 단어이고, 더 심각하게는 상당수 메신저가 APNG 를
 * 정지 이미지로 취급한다. 용도를 고르면 포맷 + 크기 + fps + 용량 상한이 함께 정해지고,
 * GIF 의 1비트 투명 같은 제약이 "설명" 이 아니라 "선택지 배제" 로 처리된다.
 *
 * 규격은 코드가 아니라 **데이터**다. 플랫폼 지원 사양은 자주 바뀐다.
 * 확인되지 않은 항목을 추측으로 채우지 않는다. 아래 수치는 목표값이며
 * 각 플랫폼의 실제 APNG/WebP 지원 여부는 미검증이다.
 */

import { CANVAS_MAX } from '@/core/types.ts'
import type { ExportFormat, ExportSettings } from '@/export/pipeline.ts'

export type ExportPurposeId = 'sticker' | 'web' | 'messenger' | 'sns' | 'custom'

/**
 * 용량 등급.
 * 선택 시점에 기대를 조정하기 위한 **정성 등급**이다. 예상 바이트가 아니다.
 * 실제 숫자는 estimateExportSize 가 8프레임을 실제로 인코딩해 따로 낸다.
 */
export type ExportWeight = 'light' | 'normal' | 'heavy'

export const WEIGHT_LABELS: Record<ExportWeight, string> = {
  light: '가벼움',
  normal: '보통',
  heavy: '무거움',
}

export interface ExportPurpose {
  id: ExportPurposeId
  label: string
  /** 라디오 아래 한 줄 설명 */
  description: string
  /** 실제 포맷명. 부제로 작게 표시한다. */
  formatLabel: string
  format: ExportFormat
  /** 긴 변 기준 상한 픽셀 */
  maxWidth: number
  /** 이 용도에 권장하는 fps. 문서 fps 가 더 높으면 안내만 한다. */
  fps: number
  /** 권장 용량 상한. 0 = 상한 없음 */
  maxBytes: number
  transparent: boolean
  maxColors: number
  dither: number
  /**
   * 카드에 미리 보여 주는 용량 등급.
   * custom 은 설정에 따라 달라지므로 비운다.
   */
  weight?: ExportWeight
  /** false 면 라디오는 보이되 고를 수 없다. */
  available: boolean
  unavailableReason?: string
  /** true 면 세부 옵션을 직접 조작한다. 아래 수치는 초기값으로만 쓴다. */
  custom?: boolean
}

const MB = 1024 * 1024

/**
 * 이 표를 마지막으로 검토한 날. UI 에 그대로 노출한다.
 * 날짜가 오래됐다는 사실 자체가 사용자에게 유용한 정보다.
 */
export const SPEC_CHECKED_AT = '2026-07-25'

export const SPEC_NOTE =
  '플랫폼별 실제 지원 여부는 아직 실측하지 않았습니다. 저장 전에 결과 화면에서 꼭 확인해 주세요.'

export const EXPORT_PURPOSES: readonly ExportPurpose[] = [
  {
    id: 'sticker',
    label: '투명 배경 스티커로 쓰기',
    description: '반투명 가장자리까지 그대로 남습니다. 가장 깨끗한 결과입니다.',
    formatLabel: 'APNG',
    format: 'apng',
    maxWidth: 512,
    fps: 25,
    maxBytes: 0,
    transparent: true,
    maxColors: 256,
    dither: 0,
    // APNG 는 무손실이라 같은 그림에서 가장 크다. 고르기 전에 알려 준다.
    weight: 'heavy',
    available: true,
  },
  {
    id: 'web',
    label: '웹사이트 / 블로그에 넣기',
    description: 'WebP 로 내보냅니다. 같은 화질에서 파일이 가장 작습니다.',
    formatLabel: 'WebP',
    format: 'webp',
    maxWidth: 800,
    fps: 25,
    maxBytes: 0,
    transparent: true,
    maxColors: 256,
    dither: 0,
    weight: 'light',
    available: true,
  },
  {
    id: 'messenger',
    label: '메신저로 보내기',
    description: '어디서나 움직입니다. 대신 색이 줄고 반투명이 사라집니다.',
    formatLabel: 'GIF',
    format: 'gif',
    maxWidth: 512,
    fps: 20,
    maxBytes: 2 * MB,
    transparent: true,
    maxColors: 128,
    dither: 0.5,
    weight: 'normal',
    available: true,
  },
  {
    id: 'sns',
    label: 'SNS에 올리기',
    description: '크게 올릴 수 있습니다. 파일이 커지니 길이를 짧게 잡으세요.',
    formatLabel: 'GIF',
    format: 'gif',
    maxWidth: 1080,
    fps: 25,
    maxBytes: 8 * MB,
    transparent: false,
    maxColors: 256,
    dither: 0.5,
    weight: 'heavy',
    available: true,
  },
  {
    id: 'custom',
    label: '직접 고르기',
    description: '포맷과 색상 수를 직접 정합니다.',
    formatLabel: '',
    format: 'apng',
    // 캔버스 상한과 같이 간다. 여기만 낮으면 4000px 캔버스가 조용히 줄어든다.
    maxWidth: CANVAS_MAX,
    fps: 25,
    maxBytes: 0,
    transparent: true,
    maxColors: 256,
    dither: 0,
    available: true,
    custom: true,
  },
]

/** 14.A1 확정: 기본 선택은 투명 배경 스티커다. */
export const DEFAULT_PURPOSE_ID: ExportPurposeId = 'sticker'

export const PURPOSE_BY_ID: ReadonlyMap<ExportPurposeId, ExportPurpose> = new Map(
  EXPORT_PURPOSES.map((p) => [p.id, p]),
)

/** GIF 팔레트 크기 선택지 */
export const MAX_COLOR_CHOICES = [64, 128, 256] as const

/**
 * WebP 손실 압축 품질 기본값.
 *
 * **0~1 스케일이다. 0~100 이 아니다.** encodeWebp 가 0~1 을 받고 1 을 넘으면 던진다.
 * 여기서 0~100 으로 들고 있다가 넘길 때 나누는 구조를 만들면, 나누는 곳을 한 군데라도
 * 빠뜨렸을 때 조용히 최고 품질 파일이 나오고 원인을 찾기 어렵다. 저장하는 값 자체를
 * 인코더와 같은 스케일로 맞춘다. 화면에 보여줄 때만 100 을 곱한다.
 *
 * 0.82 는 libwebp 권장 구간(0.75~0.85)의 위쪽이다. 스티커처럼 가장자리가 뚜렷한
 * 그림은 더 낮추면 테두리에 링잉이 보인다.
 */
export const WEBP_QUALITY_DEFAULT = 0.82

/** 화질 슬라이더 하한. 이 아래는 스티커 가장자리가 눈에 띄게 뭉개진다. */
export const WEBP_QUALITY_MIN = 0.3

// ---------------------------------------------------------------------------
// 파생 계산
// ---------------------------------------------------------------------------

/** 긴 변을 maxWidth 이하로 줄인다. 비율은 유지하고 확대는 하지 않는다. */
export function fitWithin(
  w: number,
  h: number,
  maxWidth: number,
): { width: number; height: number } {
  const longest = Math.max(w, h)
  const scale = longest > maxWidth ? maxWidth / longest : 1
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

/**
 * 내보내기 크기를 **지금 캔버스 비율**에 다시 맞춘다. 긴 변 길이는 그대로 둔다.
 *
 * ---------------------------------------------------------------------------
 * 왜 필요한가
 * ---------------------------------------------------------------------------
 * 렌더러는 정점을 `doc.canvas` 픽셀 좌표로 만들고(canvasToClip), 그 결과를
 * `settings.width x settings.height` 뷰포트에 늘려 담는다. 두 비율이 어긋나면
 * 어긋난 만큼 **그림이 정확히 늘어난다.**
 *
 * 내보내기 대화상자는 닫혀 있어도 마운트된 채라, `사용자 지정` 설정은 앱을 켠
 * 순간의 캔버스 크기로 초기화된 뒤 그대로 남는다. 그 상태에서 이미지를 넣거나
 * 자르기로 캔버스 비율이 바뀌면, 사양 라디오를 다른 것으로 갔다 오기 전까지
 * 옛 비율이 그대로 쓰인다. 그래서 크기 계산을 상태가 아니라 이 함수에 맡긴다.
 */
export function fitSettingsToCanvas(
  settings: ExportSettings,
  canvasW: number,
  canvasH: number,
): ExportSettings {
  const longest = Math.max(settings.width, settings.height)
  if (!Number.isFinite(longest) || longest <= 0) return settings
  const fitted = fitWithin(canvasW, canvasH, longest)
  if (fitted.width === settings.width && fitted.height === settings.height) return settings
  return { ...settings, ...fitted }
}

export function settingsForPurpose(
  purpose: ExportPurpose,
  canvasW: number,
  canvasH: number,
): ExportSettings {
  const { width, height } = fitWithin(canvasW, canvasH, purpose.maxWidth)
  return {
    format: purpose.format,
    width,
    height,
    maxColors: purpose.maxColors,
    transparent: purpose.transparent,
    dither: purpose.dither,
    // WebP 전용 필드. 다른 포맷의 인코더는 읽지 않는다.
    quality: WEBP_QUALITY_DEFAULT,
    lossless: false,
  }
}

/**
 * 예상 소요 시간(초).
 *
 * **측정값이 아니라 어림값이다.** 실제 속도는 GPU, 브라우저, 배경 탭 여부에 따라
 * 몇 배씩 달라진다. 그럼에도 숫자를 내는 이유는 필요한 것이 "정확한 진행률" 이
 * 아니라 "체감 관리" 이고, 5초를 넘길 작업은 누르기 전에 알려야 하기 때문이다.
 * 실제 측정치가 모이면 교체한다.
 */
export function estimateDurationSec(
  frameCount: number,
  width: number,
  height: number,
  format: ExportFormat,
): number {
  const mpx = (width * height) / 1_000_000
  // 프레임당 고정비: 드로우콜 + 취소 반응성을 위한 양보(setTimeout 클램프)
  const fixedMs = 6
  const renderMsPerMpx = 25
  // WebP 는 wasm 안에서 도므로 JS deflate 인 APNG 보다는 싸고, 팔레트 한 번으로
  // 끝나는 GIF 보다는 비싸다. 셋 다 실측이 아니라 어림값이다.
  const encodeMsPerMpx = format === 'apng' ? 260 : format === 'webp' ? 190 : 130
  const ms = frameCount * (fixedMs + mpx * (renderMsPerMpx + encodeMsPerMpx))
  return ms / 1000
}

/** 이 시간을 넘으면 누르기 전에 미리 알린다. */
export const SLOW_EXPORT_SEC = 5

export function formatDuration(sec: number): string {
  if (sec < 1) return '1초 이내'
  if (sec < 60) return `약 ${Math.round(sec)}초`
  return `약 ${Math.round(sec / 60)}분`
}

/**
 * 파일명 정규화는 exportFileName.ts 로 옮겼다.
 * 구현이 둘이면 다이얼로그와 결과 패널이 서로 다른 이름을 만든다. 여기서는 재수출만 한다.
 */
export { buildExportFileName, sanitizeFileName } from './exportFileName.ts'
