/**
 * 파일명 생성 규칙.
 *
 * 여기서 지키려는 것은 세 가지다.
 *   1. 한글이 살아남는다. 로마자로 바꾸거나 버리지 않는다.
 *   2. 실제로 위험한 문자만 치환한다. 삭제가 아니라 치환이라 서로 다른 이름이 뭉개지지 않는다.
 *   3. 길이 상한을 넘겨도 크기 조각과 확장자는 살아남는다. 안 그러면 512px 결과와
 *      1080px 결과가 같은 이름이 되어 저장할 때 서로 덮어쓴다.
 */

import { describe, expect, it } from 'vitest'

import {
  FILENAME_FALLBACK,
  FILENAME_PART_MAX,
  FILENAME_STEM_MAX,
  FILENAME_STEM_MAX_BYTES,
  buildExportFileName,
  sanitizeFileName,
  sanitizeFileNamePart,
} from '@/ui/export/exportFileName.ts'

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

// ---------------------------------------------------------------------------
// 조각 정규화
// ---------------------------------------------------------------------------

describe('sanitizeFileNamePart', () => {
  it('한글을 그대로 남긴다', () => {
    expect(sanitizeFileNamePart('고양이')).toBe('고양이')
    expect(sanitizeFileNamePart('톡 튀며 등장')).toBe('톡_튀며_등장')
  })

  it('한글 자모 조합과 특수 한글 음절도 건드리지 않는다', () => {
    expect(sanitizeFileNamePart('뷁똠쀓')).toBe('뷁똠쀓')
  })

  it('금지 문자 9종을 밑줄로 치환한다', () => {
    // \ / : * ? " < > |
    expect(sanitizeFileNamePart('a\\b')).toBe('a_b')
    expect(sanitizeFileNamePart('a/b')).toBe('a_b')
    expect(sanitizeFileNamePart('a:b')).toBe('a_b')
    expect(sanitizeFileNamePart('a*b')).toBe('a_b')
    expect(sanitizeFileNamePart('a?b')).toBe('a_b')
    expect(sanitizeFileNamePart('a"b')).toBe('a_b')
    expect(sanitizeFileNamePart('a<b')).toBe('a_b')
    expect(sanitizeFileNamePart('a>b')).toBe('a_b')
    expect(sanitizeFileNamePart('a|b')).toBe('a_b')
  })

  it('삭제가 아니라 치환이라 서로 다른 이름이 하나로 뭉개지지 않는다', () => {
    expect(sanitizeFileNamePart('a/b')).not.toBe(sanitizeFileNamePart('ab'))
  })

  it('제어문자를 치환한다', () => {
    // 리터럴 제어문자는 에디터가 지우거나 보이지 않게 만든다. 전부 이스케이프로 쓴다.
    expect(sanitizeFileNamePart('a\u0000b')).toBe('a_b')
    expect(sanitizeFileNamePart('a\u0001b')).toBe('a_b')
    expect(sanitizeFileNamePart('a\u001fb')).toBe('a_b')
    expect(sanitizeFileNamePart('a\u007fb')).toBe('a_b')
    // 개행과 탭도 제어문자다.
    expect(sanitizeFileNamePart('a\nb')).toBe('a_b')
    expect(sanitizeFileNamePart('a\tb')).toBe('a_b')
  })

  it('금지 목록에 없는 문자는 건드리지 않는다', () => {
    // 막아야 하는 것은 제어문자와 \ / : * ? " < > | 뿐이다.
    expect(sanitizeFileNamePart('cat-01(v2)+final#1')).toBe('cat-01(v2)+final#1')
    expect(sanitizeFileNamePart('사진 100%')).toBe('사진_100%')
  })

  it('연속된 치환을 밑줄 하나로 접는다', () => {
    expect(sanitizeFileNamePart('a///b')).toBe('a_b')
    expect(sanitizeFileNamePart('a   b')).toBe('a_b')
  })

  it('앞뒤의 점과 밑줄을 떼어 낸다', () => {
    // 앞의 점은 숨김 파일, 뒤의 점은 윈도우에서 파일명이 잘리는 원인이다.
    expect(sanitizeFileNamePart('.hidden')).toBe('hidden')
    expect(sanitizeFileNamePart('name.')).toBe('name')
    expect(sanitizeFileNamePart('__name__')).toBe('name')
  })

  it('조각 길이를 상한으로 자른다', () => {
    const long = '가'.repeat(200)
    expect([...sanitizeFileNamePart(long)]).toHaveLength(FILENAME_PART_MAX)
  })

  it('남는 글자가 없으면 빈 문자열을 준다', () => {
    expect(sanitizeFileNamePart('///')).toBe('')
    expect(sanitizeFileNamePart('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 확장자 제거
// ---------------------------------------------------------------------------

describe('sanitizeFileName', () => {
  it('마지막 확장자만 떼어 낸다', () => {
    expect(sanitizeFileName('cat.png')).toBe('cat')
    expect(sanitizeFileName('고양이.gif')).toBe('고양이')
    expect(sanitizeFileName('my.photo.v2.png')).toBe('my.photo.v2')
  })

  it('확장자가 없으면 그대로 둔다', () => {
    expect(sanitizeFileName('cat')).toBe('cat')
  })

  it('남는 것이 없으면 대체 이름을 준다', () => {
    expect(sanitizeFileName('.png')).toBe(FILENAME_FALLBACK)
    expect(sanitizeFileName('///')).toBe(FILENAME_FALLBACK)
  })
})

// ---------------------------------------------------------------------------
// 최종 파일명
// ---------------------------------------------------------------------------

describe('buildExportFileName', () => {
  it('원본명_프리셋명_크기.확장자 로 만든다', () => {
    expect(
      buildExportFileName({
        sourceName: 'cat.png',
        presetName: '톡 튀기',
        width: 512,
        extension: 'png',
      }),
    ).toBe('cat_톡_튀기_512.png')
  })

  it('프리셋명이 없으면 그 조각을 통째로 뺀다', () => {
    expect(
      buildExportFileName({ sourceName: 'cat.png', width: 512, extension: 'png' }),
    ).toBe('cat_512.png')
    // 빈 문자열도 없는 것으로 본다. cat__512 처럼 밑줄이 두 개 남으면 안 된다.
    expect(
      buildExportFileName({
        sourceName: 'cat.png',
        presetName: '   ',
        width: 512,
        extension: 'png',
      }),
    ).toBe('cat_512.png')
  })

  it('한글 원본명과 한글 프리셋명을 모두 남긴다', () => {
    expect(
      buildExportFileName({
        sourceName: '고양이.png',
        presetName: '천천히 축소',
        width: 800,
        extension: 'webp',
      }),
    ).toBe('고양이_천천히_축소_800.webp')
  })

  it('포맷별 확장자를 정확히 붙인다', () => {
    const base = { sourceName: 'cat.png', width: 256 }
    expect(buildExportFileName({ ...base, extension: 'png' }).endsWith('.png')).toBe(true)
    expect(buildExportFileName({ ...base, extension: 'gif' }).endsWith('.gif')).toBe(true)
    expect(buildExportFileName({ ...base, extension: 'webp' }).endsWith('.webp')).toBe(true)
    expect(buildExportFileName({ ...base, extension: 'zip' }).endsWith('.zip')).toBe(true)
  })

  it('확장자를 소문자로 맞추고 점은 붙이지 않는다', () => {
    expect(buildExportFileName({ sourceName: 'cat', width: 64, extension: 'PNG' })).toBe(
      'cat_64.png',
    )
    // 확장자 자리에 점 하나만 남는 일이 없어야 한다.
    expect(buildExportFileName({ sourceName: 'cat', width: 64, extension: '' })).toBe('cat_64')
  })

  it('원본명이 위험 문자뿐이면 대체 이름을 쓴다', () => {
    expect(buildExportFileName({ sourceName: '///', width: 64, extension: 'gif' })).toBe(
      `${FILENAME_FALLBACK}_64.gif`,
    )
  })

  it('크기 조각은 아무리 이름이 길어도 잘리지 않는다', () => {
    const name = buildExportFileName({
      sourceName: '가'.repeat(300),
      presetName: '나'.repeat(300),
      width: 1080,
      extension: 'png',
    })
    expect(name.endsWith('_1080.png')).toBe(true)
  })

  it('긴 이름 두 개가 크기만 다르면 파일명도 달라진다', () => {
    const long = { sourceName: '가'.repeat(300), presetName: '나'.repeat(300), extension: 'png' }
    const a = buildExportFileName({ ...long, width: 512 })
    const b = buildExportFileName({ ...long, width: 1080 })
    expect(a).not.toBe(b)
  })

  it('코드포인트 상한과 UTF-8 바이트 상한을 모두 지킨다', () => {
    const name = buildExportFileName({
      sourceName: '가'.repeat(300),
      presetName: '나'.repeat(300),
      width: 1080,
      extension: 'png',
    })
    const stem = name.slice(0, name.lastIndexOf('.'))
    expect([...stem].length).toBeLessThanOrEqual(FILENAME_STEM_MAX)
    expect(utf8Length(stem)).toBeLessThanOrEqual(FILENAME_STEM_MAX_BYTES)
    // 파일시스템 상한 255바이트 안에 확장자까지 들어가야 한다.
    expect(utf8Length(name)).toBeLessThanOrEqual(255)
  })

  it('자른 끝에 밑줄이 남지 않는다', () => {
    const name = buildExportFileName({
      sourceName: `${'가'.repeat(70)}_꼬리`,
      presetName: '프리셋',
      width: 512,
      extension: 'gif',
    })
    expect(name).not.toContain('__')
  })

  it('잘못된 크기가 들어와도 파일명이 무너지지 않는다', () => {
    expect(buildExportFileName({ sourceName: 'cat', width: Number.NaN, extension: 'png' })).toBe(
      'cat_1.png',
    )
    expect(buildExportFileName({ sourceName: 'cat', width: -10, extension: 'png' })).toBe(
      'cat_1.png',
    )
    expect(buildExportFileName({ sourceName: 'cat', width: 511.6, extension: 'png' })).toBe(
      'cat_512.png',
    )
  })

  it('경로가 섞여 들어와도 디렉터리로 새지 않는다', () => {
    const name = buildExportFileName({
      sourceName: '../../etc/passwd.png',
      width: 128,
      extension: 'png',
    })
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name.startsWith('.')).toBe(false)
  })
})
