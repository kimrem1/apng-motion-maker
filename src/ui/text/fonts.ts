/**
 * 글꼴 목록과 직접 올린 글꼴.
 *
 * 웹폰트를 앱에 넣지 않는다. 결과물이 이미지라 보는 사람 PC 에 그 글꼴이 없어도
 * 되고, 한글 글꼴 하나가 몇 MB 라 첫 로딩이 그만큼 느려지기 때문이다.
 *
 * 대신 두 가지를 준다.
 *   1. 설치돼 있을 법한 글꼴 목록 (core/text.ts 의 FONT_CHOICES)
 *   2. 사용자가 올린 .ttf / .otf
 *
 * 올린 글꼴은 이 세션에만 산다. 프로젝트 파일에는 글꼴 이름만 저장되므로,
 * 다음에 열 때 같은 파일을 다시 올리지 않으면 대체 글꼴로 그려진다. 글꼴 바이트를
 * 프로젝트에 넣지 않는 이유는 파일 크기와 글꼴 재배포 문제 둘 다다.
 */

import { FONT_CHOICES, type FontChoice } from '@/core/text.ts'

/** 올린 글꼴. key 는 CSS 에서 쓸 이름이다. */
const uploaded = new Map<string, FontChoice>()
const listeners = new Set<() => void>()
let revision = 0

function bump(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribeFonts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getFontsRevision(): number {
  return revision
}

/** 고를 수 있는 글꼴 전부. 올린 글꼴이 앞에 온다. */
export function allFontChoices(): FontChoice[] {
  return [...uploaded.values(), ...FONT_CHOICES]
}

/** CSS 에 넣어도 안전한 이름으로 다듬는다. 따옴표와 쉼표가 들어가면 선언이 깨진다. */
function safeFamilyName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '').trim()
  const cleaned = base.replace(/["',;{}()]/g, '').slice(0, 40)
  return cleaned.length > 0 ? cleaned : '올린 글꼴'
}

export interface FontLoadResult {
  ok: boolean
  /** 성공하면 TextSpec.fontFamily 에 그대로 넣을 값. */
  family?: string
  label?: string
  message?: string
}

const FONT_EXT = /\.(ttf|otf|woff2?|ttc)$/i

export function isFontFile(file: File): boolean {
  return FONT_EXT.test(file.name) || file.type.startsWith('font/')
}

/**
 * 글꼴 파일을 읽어 document.fonts 에 등록한다.
 *
 * 실패해도 던지지 않는다. 글꼴 하나를 못 읽었다고 편집 흐름이 끊기면 안 된다.
 */
export async function loadFontFile(file: File): Promise<FontLoadResult> {
  if (!isFontFile(file)) {
    return { ok: false, message: 'ttf, otf, woff 파일만 올릴 수 있습니다.' }
  }
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') {
    return { ok: false, message: '이 브라우저에서는 글꼴을 올릴 수 없습니다.' }
  }

  const label = safeFamilyName(file.name)
  // 같은 이름을 두 번 올리면 뒤엣것이 이긴다. 이름이 겹치면 구별할 방법이 없다.
  const family = label

  try {
    const bytes = await file.arrayBuffer()
    const face = new FontFace(family, bytes)
    await face.load()
    document.fonts.add(face)
    uploaded.set(family, { id: `up:${family}`, label: `${label} (올림)`, family: `"${family}", sans-serif` })
    bump()
    return { ok: true, family: `"${family}", sans-serif`, label }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? `글꼴을 읽지 못했습니다. ${err.message}` : '글꼴을 읽지 못했습니다.',
    }
  }
}

/**
 * 글꼴이 실제로 준비될 때까지 기다린다.
 *
 * 글자를 굽는 시점에 글꼴이 아직 안 왔으면 대체 글꼴로 구워지고, 그 그림이 캐시에
 * 남아 글꼴이 도착해도 바뀌지 않는다. 레이어를 만들기 전에 한 번 기다린다.
 */
export async function waitForFont(cssFont: string): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  try {
    await document.fonts.load(cssFont, '가A')
    await document.fonts.ready
  } catch {
    // 못 기다려도 그리기는 계속한다. 대체 글꼴로 나올 뿐이다.
  }
}
