/**
 * 글자 레이어의 값 규칙과 배치.
 *
 * shape.ts / reveal.ts 와 같은 자리다. 렌더러 / 스토어 / 마이그레이션 / 프리셋 / UI 가
 * 모두 여기를 거친다. 규칙이 두 벌이 되면 저장했다 열었을 때 글자가 다른 자리에 선다.
 *
 * DOM 도 WebGL 도 참조하지 않는다. 글자 폭 측정만 밖에서 받는다(measure 콜백).
 * 측정은 브라우저가 하고 배치 규칙은 여기서 한다. 그래야 배치를 테스트할 수 있다.
 */

import type { TextAlign, TextSpec } from './types.ts'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const TEXT_LIMITS = {
  fontSize: { min: 4, max: 800 },
  weight: { min: 100, max: 900 },
  letterSpacing: { min: -200, max: 400 },
  lineHeight: { min: 0.5, max: 4 },
  strokeWidth: { min: 0, max: 64 },
  /** 한 레이어가 품는 글자 수 상한. 이보다 길면 잘라 낸다. */
  chars: 400,
} as const

export const TEXT_ALIGN_LABELS: Record<TextAlign, string> = {
  left: '왼쪽',
  center: '가운데',
  right: '오른쪽',
}

/**
 * 고를 수 있는 글꼴.
 *
 * 웹폰트를 넣지 않는다. 결과물이 이미지라 보는 사람 PC 에 그 글꼴이 없어도 상관없고,
 * 앱 용량과 첫 로딩이 글꼴 하나에 몇 MB 씩 늘어나기 때문이다. 대신 사용자가
 * .ttf/.otf 파일을 직접 올리면 그 글꼴로 그린다 (ui/text/fonts.ts).
 *
 * 목록은 "설치돼 있을 법한 것" 이고, 없으면 브라우저가 뒤의 대체 글꼴로 떨어진다.
 * 프리텐다드와 노토 산스도 같은 규칙을 받는다. 설치돼 있으면 그것으로 그리고,
 * 없으면 맑은 고딕으로 떨어진다.
 */
export interface FontChoice {
  id: string
  label: string
  /** CSS font-family 값. 대체 글꼴까지 적는다. */
  family: string
}

export const FONT_CHOICES: readonly FontChoice[] = [
  {
    id: 'sans',
    label: '고딕 (기본)',
    family:
      'Pretendard, "Pretendard Variable", "Noto Sans KR", "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif',
  },
  {
    id: 'pretendard',
    label: '프리텐다드',
    family: 'Pretendard, "Pretendard Variable", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  },
  {
    id: 'notosans',
    label: '노토 산스',
    family: '"Noto Sans KR", "Noto Sans", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  },
  {
    id: 'serif',
    label: '명조',
    family: '"Batang", "바탕", "Apple SD Gothic Neo", "Noto Serif KR", serif',
  },
  {
    id: 'round',
    label: '둥근 고딕',
    family: '"NanumSquareRound", "NanumGothic", "Malgun Gothic", sans-serif',
  },
  {
    id: 'mono',
    label: '고정폭',
    family: '"D2Coding", "Consolas", "Courier New", monospace',
  },
  {
    id: 'display',
    label: '굵은 제목',
    family: '"Black Han Sans", "Jalnan", "Malgun Gothic", sans-serif',
  },
]

export const FONT_BY_ID = new Map(FONT_CHOICES.map((f) => [f.id, f]))
export const DEFAULT_FONT_FAMILY = FONT_CHOICES[0]!.family

/** 기본 글자. 넣자마자 화면에 보이는 크기여야 한다. */
export function createTextSpec(overrides: Partial<TextSpec> = {}): TextSpec {
  return normalizeTextSpec({
    content: '글자',
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: 96,
    weight: 700,
    italic: false,
    color: '#ffffffff',
    letterSpacing: 0,
    lineHeight: 1.25,
    align: 'center',
    strokeWidth: 0,
    strokeColor: '#000000ff',
    ...overrides,
  })
}

const ALIGNS: readonly TextAlign[] = ['left', 'center', 'right']

/** 줄바꿈(코드 10)만 남기고 제어문자를 지운다. 정규식은 원본에 제어문자를 박아 두므로 쓰지 않는다. */
function stripControl(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code !== 10 && (code < 32 || code === 127)) continue
    out += ch
  }
  return out
}
const CRLF = /\r\n?/g
const TABS = /\t/g

/** 어떤 값이 들어와도 그릴 수 있는 글자로 만든다. 던지지 않는다. */
export function normalizeTextSpec(raw: Partial<TextSpec> & { align?: unknown }): TextSpec {
  const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.length > 0 ? v : fallback

  // 줄바꿈은 살리고 나머지 제어문자는 버린다. 탭은 공백 하나로 본다.
  const rawContent = typeof raw.content === 'string' ? raw.content : ''
  const content = stripControl(rawContent.replace(CRLF, '\n').replace(TABS, ' ')).slice(
    0,
    TEXT_LIMITS.chars,
  )

  return {
    content,
    fontFamily: str(raw.fontFamily, DEFAULT_FONT_FAMILY),
    fontSize: num(raw.fontSize, 96, TEXT_LIMITS.fontSize.min, TEXT_LIMITS.fontSize.max),
    // 100 단위로 스냅한다. 중간값은 글꼴이 어차피 반올림한다.
    weight:
      Math.round(num(raw.weight, 700, TEXT_LIMITS.weight.min, TEXT_LIMITS.weight.max) / 100) * 100,
    italic: raw.italic === true,
    color: str(raw.color, '#ffffffff'),
    letterSpacing: num(
      raw.letterSpacing,
      0,
      TEXT_LIMITS.letterSpacing.min,
      TEXT_LIMITS.letterSpacing.max,
    ),
    lineHeight: num(raw.lineHeight, 1.25, TEXT_LIMITS.lineHeight.min, TEXT_LIMITS.lineHeight.max),
    align: ALIGNS.includes(raw.align as TextAlign) ? (raw.align as TextAlign) : 'center',
    strokeWidth: num(raw.strokeWidth, 0, TEXT_LIMITS.strokeWidth.min, TEXT_LIMITS.strokeWidth.max),
    strokeColor: str(raw.strokeColor, '#000000ff'),
  }
}

// ---------------------------------------------------------------------------
// 배치
// ---------------------------------------------------------------------------

export interface TextGlyph {
  /** 글자 하나. 코드 포인트 단위라 한글 한 음절이 하나다. */
  char: string
  /** 글자 상자 안에서의 자리(px). 왼쪽 위가 원점이다. */
  x: number
  y: number
  /** 글자가 차지하는 칸. w 는 자간을 포함한 전진폭이다. */
  w: number
  h: number
  /** 몇 번째 줄인가. */
  line: number
  /**
   * 애니메이션 순번.
   *
   * 공백과 줄바꿈은 세지 않는다. 공백에 순번을 주면 "글자 다섯 개가 차례로
   * 들어온다" 는 리듬이 눈에 보이지 않는 칸에서 한 박자씩 끊긴다.
   * 공백 글리프는 -1 이고 렌더러가 그리지 않는다.
   */
  order: number
}

export interface TextLayout {
  glyphs: TextGlyph[]
  /** 글자 상자 크기(px). 레이어의 자연 크기 자리에 그대로 들어간다. */
  width: number
  height: number
  lines: number
  /** 애니메이션 대상 글자 수(공백 제외). */
  animCount: number
}

/** 내용이 비어도 레이어가 사라지면 안 된다. 상자가 0 이면 매트릭스가 무너진다. */
const MIN_BOX = 1

/**
 * 글자를 배치한다.
 *
 * measure 는 "이 글자의 전진폭(px)" 을 돌려준다. 브라우저에서는 canvas measureText 이고
 * 테스트에서는 고정폭 함수다. 자간과 행간은 여기서 더한다.
 */
export function layoutText(spec: TextSpec, measure: (char: string) => number): TextLayout {
  const lineH = spec.fontSize * spec.lineHeight
  const lines = spec.content.split('\n')

  const perLine: { chars: string[]; widths: number[]; total: number }[] = []
  let maxWidth = 0

  for (const line of lines) {
    const chars = Array.from(line)
    const widths = chars.map((c) => Math.max(0, measure(c)) + spec.letterSpacing)
    // 줄 끝의 자간은 상자 밖으로 나가는 여백이다. 폭에서 뺀다.
    const total = widths.reduce((a, b) => a + b, 0) - (chars.length > 0 ? spec.letterSpacing : 0)
    perLine.push({ chars, widths, total: Math.max(0, total) })
    if (total > maxWidth) maxWidth = total
  }

  const width = Math.max(MIN_BOX, maxWidth)
  const height = Math.max(MIN_BOX, lineH * perLine.length)

  const glyphs: TextGlyph[] = []
  let order = 0

  for (let li = 0; li < perLine.length; li += 1) {
    const { chars, widths, total } = perLine[li]!
    const slack = width - total
    const startX = spec.align === 'left' ? 0 : spec.align === 'right' ? slack : slack / 2

    let x = startX
    for (let ci = 0; ci < chars.length; ci += 1) {
      const char = chars[ci]!
      const w = widths[ci]!
      const blank = char.trim().length === 0
      glyphs.push({
        char,
        x,
        y: li * lineH,
        w,
        h: lineH,
        line: li,
        order: blank ? -1 : order,
      })
      if (!blank) order += 1
      x += w
    }
  }

  return { glyphs, width, height, lines: perLine.length, animCount: order }
}

// ---------------------------------------------------------------------------
// 상자 크기 기억
// ---------------------------------------------------------------------------

/**
 * 실제로 잰 글자 상자 크기.
 *
 * 오버스캔 솔버와 레이어 속성 표시는 "이 레이어의 자연 크기" 를 알아야 하는데,
 * 글자는 브라우저가 재기 전에는 알 수 없다. 그렇다고 core 가 캔버스를 부를 수는 없다.
 * 그래서 렌더러가 재고 나면 여기에 적어 두고, 그 전에는 어림값을 쓴다.
 * 키는 레이어 id 가 아니라 값이다. 같은 글자 같은 글꼴이면 크기도 같다.
 */
const measuredBoxes = new Map<string, { width: number; height: number }>()

/** 상자 크기를 좌우하는 값만 모은 키. 색이나 테두리는 크기를 바꾸지 않는다. */
export function textBoxKey(spec: TextSpec): string {
  return [
    spec.content,
    spec.fontFamily,
    spec.fontSize,
    spec.weight,
    spec.italic ? 'i' : 'n',
    spec.letterSpacing,
    spec.lineHeight,
    spec.align,
  ].join('|')
}

/** 잰 값을 기억한다. 렌더러가 배치를 만든 뒤에 부른다. */
export function rememberTextBox(spec: TextSpec, width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return
  // 무한정 쌓이지 않게 상한을 둔다. 글자를 타이핑하면 키가 글자마다 새로 생긴다.
  if (measuredBoxes.size > 256) measuredBoxes.clear()
  measuredBoxes.set(textBoxKey(spec), {
    width: Math.max(MIN_BOX, width),
    height: Math.max(MIN_BOX, height),
  })
}

/**
 * 잰 적이 없을 때의 어림 크기.
 *
 * 한글과 한자는 대체로 정사각(1em)이고 로마자는 그 절반쯤이다. 정확할 필요는 없다.
 * 첫 렌더 한 번이면 실측값으로 바뀐다.
 */
export function estimateTextBox(spec: TextSpec): { width: number; height: number } {
  const lines = spec.content.split('\n')
  let widest = 0
  for (const line of lines) {
    let w = 0
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0
      const em = code > 0x2e80 ? 1 : ch === ' ' ? 0.3 : 0.55
      w += spec.fontSize * em + spec.letterSpacing
    }
    if (w > widest) widest = w
  }
  return {
    width: Math.max(MIN_BOX, widest - spec.letterSpacing),
    height: Math.max(MIN_BOX, spec.fontSize * spec.lineHeight * lines.length),
  }
}

/** 이 글자가 차지하는 상자. 잰 값이 있으면 그것, 없으면 어림값이다. */
export function textBoxOf(spec: TextSpec): { width: number; height: number } {
  return measuredBoxes.get(textBoxKey(spec)) ?? estimateTextBox(spec)
}

/**
 * 캔버스 font 속성 문자열.
 * 렌더러와 폭 측정이 같은 문자열을 써야 배치와 그림이 어긋나지 않는다.
 */
export function cssFontOf(spec: TextSpec): string {
  const style = spec.italic ? 'italic ' : ''
  return `${style}${spec.weight} ${spec.fontSize}px ${spec.fontFamily}`
}

/** 이 레이어가 실제로 그릴 것이 있는가. */
export function textIsDrawable(spec: TextSpec | undefined): spec is TextSpec {
  return spec !== undefined && spec.content.trim().length > 0
}
