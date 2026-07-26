/**
 * 내보내기 파일명 생성.
 *
 * 규칙은 `원본명_프리셋명_크기.확장자` 다. 예: `cat_톡튀기_512.png`.
 *
 * **한글을 지우지 않는다.** 요즘 파일시스템은 전부 유니코드를 받는다.
 * 한글을 로마자로 바꾸거나 통째로 버리면 사용자가 자기 파일을 못 찾는다.
 * 실제로 문제를 일으키는 것은 두 가지뿐이다.
 *
 *   1. 경로 구분자와 윈도우 예약 문자: \ / : * ? " < > |
 *   2. 제어문자 (U+0000~U+001F, U+007F). 저장 대화상자와 zip 도구가 깨진다.
 *
 * 이 둘만 '_' 로 **치환**한다. 삭제가 아니라 치환인 이유는, 삭제하면 서로 다른
 * 두 이름이 같은 파일명으로 뭉개져 덮어쓰기가 나기 때문이다
 * ("a/b" 와 "ab" 가 둘 다 "ab" 가 된다).
 *
 * DOM 을 참조하지 않는다. 순수 함수만 둔다. 테스트가 이 파일만 임포트한다.
 */

/** 한 조각(원본명 / 프리셋명)의 길이 상한. 코드포인트 기준이다. */
export const FILENAME_PART_MAX = 60

/**
 * 확장자를 뺀 전체 이름의 길이 상한.
 *
 * 대부분의 파일시스템 상한은 255바이트다. 한글은 UTF-8 로 글자당 3바이트라
 * 코드포인트 100 이면 최악 300바이트가 되어 상한을 넘는다. 그래서 바이트로도 잰다.
 */
export const FILENAME_STEM_MAX = 80
export const FILENAME_STEM_MAX_BYTES = 200

/** 대체 이름. 정규화 결과가 비면 이걸 쓴다. */
export const FILENAME_FALLBACK = 'motion'

/** 경로 구분자와 윈도우 예약 문자. */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g

/** 제어문자. 정규식 리터럴에 직접 쓰면 린터가 경고하므로 코드 단위로 검사한다. */
function isControlChar(code: number): boolean {
  return code < 0x20 || code === 0x7f
}

function stripControlChars(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    out += isControlChar(code) ? '_' : ch
  }
  return out
}

/** 코드포인트 단위로 자른다. slice 는 서로게이트 쌍을 반으로 쪼갠다. */
function truncateCodePoints(raw: string, max: number): string {
  const points = [...raw]
  return points.length <= max ? raw : points.slice(0, max).join('')
}

/** UTF-8 바이트 길이로도 자른다. 한글 80자는 240바이트라 그냥 두면 상한을 넘는다. */
function truncateBytes(raw: string, maxBytes: number): string {
  let bytes = 0
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes + size > maxBytes) break
    bytes += size
    out += ch
  }
  return out
}

/**
 * 파일명 한 조각을 안전하게 만든다. 확장자는 건드리지 않는다.
 *
 * 빈 문자열을 돌려줄 수 있다. 호출자가 그 조각을 통째로 뺄지 대체 이름을 쓸지 정한다.
 */
export function sanitizeFileNamePart(raw: string, max = FILENAME_PART_MAX): string {
  return truncateCodePoints(
    stripControlChars(raw)
      .replace(ILLEGAL_CHARS, '_')
      // 공백은 위험하지는 않지만 URL 과 셸에서 매번 인용이 필요해 밑줄로 바꾼다.
      .replace(/\s+/g, '_')
      // 치환이 연달아 나오면 밑줄이 줄줄이 남는다. 하나로 접는다.
      .replace(/_{2,}/g, '_')
      // 앞뒤의 점은 숨김 파일(.name) 과 윈도우의 후행 점 문제를 만든다.
      .replace(/^[._]+/, '')
      .replace(/[._]+$/, ''),
    max,
  )
}

/**
 * 확장자를 떼고 정규화한다. 원본 에셋 이름(`cat.png`)에서 `cat` 을 얻는 용도다.
 * 결과가 비면 대체 이름을 준다.
 */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const safe = sanitizeFileNamePart(base)
  return safe.length > 0 ? safe : FILENAME_FALLBACK
}

export interface ExportFileNameArgs {
  /** 원본 에셋 이름. 확장자가 붙어 있어도 된다. */
  sourceName: string
  /** 적용된 모션 프리셋 이름. 없으면 이 조각을 통째로 뺀다. */
  presetName?: string | undefined
  /** 출력 긴 변 픽셀. 파일명 끝에 숫자로 붙는다. */
  width: number
  /** 점 없는 확장자. 'png' | 'gif' | 'webp' */
  extension: string
}

/**
 * `원본명_프리셋명_크기.확장자` 를 만든다.
 *
 * 프리셋명이 없으면 `원본명_크기.확장자` 가 된다. 빈 조각 자리에 밑줄만 남기면
 * `cat__512.png` 처럼 보기 흉하고, 사용자는 그걸 자기가 뭘 잘못한 신호로 읽는다.
 */
export function buildExportFileName(args: ExportFileNameArgs): string {
  const { sourceName, presetName, width, extension } = args

  const source = sanitizeFileName(sourceName)
  const preset = presetName === undefined ? '' : sanitizeFileNamePart(presetName)
  // 크기는 사용자 입력이 아니지만 NaN 이나 음수가 흘러들면 파일명이 무너진다.
  const size = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1

  /**
   * 크기 조각은 절대 잘리지 않는다.
   *
   * 그냥 이어 붙인 뒤 뒤에서 자르면 이름이 긴 파일에서 `_512` 가 통째로 날아가
   * 512px 와 1080px 결과가 같은 이름이 되고 저장할 때 서로 덮어쓴다.
   * 그래서 크기 자리를 먼저 떼어 두고 남은 예산으로만 앞부분을 자른다.
   */
  const suffix = `_${size}`
  const head = [source, preset].filter((p) => p.length > 0).join('_')
  const headMax = Math.max(1, FILENAME_STEM_MAX - suffix.length)
  const headMaxBytes = Math.max(1, FILENAME_STEM_MAX_BYTES - suffix.length)

  const headCut = truncateBytes(truncateCodePoints(head, headMax), headMaxBytes).replace(
    /[._]+$/,
    '',
  )
  const stem = `${headCut.length > 0 ? headCut : FILENAME_FALLBACK}${suffix}`

  const ext = sanitizeFileNamePart(extension, 8).toLowerCase()
  return ext.length > 0 ? `${stem}.${ext}` : stem
}
