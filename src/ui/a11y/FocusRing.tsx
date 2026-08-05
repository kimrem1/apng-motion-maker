/**
 * 포커스 링 정책.
 *
 * 화면에 아무것도 그리지 않는다. 하는 일은 둘이다.
 *   1. a11y.css 를 앱에 들여온다. 포커스 링 / 색 의존 보정 규칙이 거기 있다.
 *   2. 마지막 입력 수단(키보드인가 포인터인가)을 <html data-modality> 로 남긴다.
 *
 * 왜 2번이 필요한가.
 * :focus-visible 은 대부분의 경우를 알아서 처리한다. 그런데 이 앱은 로빙
 * tabindex 목록이 많고(프리셋 갤러리 / 레이어 목록 / 타임라인 트리),
 * 그 목록들은 화살표를 받으면 el.focus() 를 직접 부른다.
 * 프로그램 포커스에 :focus-visible 을 붙일지는 브라우저마다 판단이 갈린다.
 * 마우스로 카드를 클릭한 직후 코드가 focus() 를 부르면 엉뚱하게 링이 뜨거나,
 * 반대로 키보드로 이동했는데 링이 안 뜨는 일이 실제로 생긴다.
 *
 * data-modality 는 그 판단을 뒤집는 스위치가 아니라 관측값이다.
 * 링을 강제로 켜고 끄는 CSS 는 두지 않는다. 필요한 컴포넌트가 필요할 때만
 * useInputModality() 로 읽어 쓰라고 열어 둔다. 전역으로 :focus-visible 을
 * 흉내 내기 시작하면 브라우저가 개선될 때마다 우리 쪽이 틀려진다.
 */

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'

import './a11y.css'

export type InputModality = 'keyboard' | 'pointer'

// ---------------------------------------------------------------------------
// 관측
// ---------------------------------------------------------------------------

let modality: InputModality = 'keyboard'
const listeners = new Set<() => void>()
let installed = 0

/**
 * 포커스를 옮기는 키만 센다.
 *
 * 글자 키까지 세면 입력창에 타이핑하는 동안 modality 가 계속 keyboard 로 튄다.
 * 그건 사실이긴 하지만 포커스 표시와는 무관하다.
 */
const FOCUS_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Enter',
  ' ',
  'Escape',
])

function setModality(next: InputModality): void {
  if (modality === next) return
  modality = next
  if (typeof document !== 'undefined') {
    document.documentElement.dataset['modality'] = next
  }
  for (const listener of listeners) listener()
}

function onKeyDown(e: KeyboardEvent): void {
  // 단축키 조합은 포인터 사용자도 누른다. 포커스 이동 키만 본다.
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (!FOCUS_KEYS.has(e.key)) return
  setModality('keyboard')
}

function onPointerDown(): void {
  setModality('pointer')
}

/**
 * 리스너를 한 벌만 건다. StrictMode 는 이펙트를 두 번 돌리고,
 * FocusRing 이 실수로 두 번 마운트될 수도 있다.
 */
function install(): () => void {
  installed += 1
  if (installed === 1 && typeof window !== 'undefined') {
    document.documentElement.dataset['modality'] = modality
    // capture 로 받는다. 중간에서 stopPropagation 하는 핸들러가 이 앱에 여럿 있다.
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
  }
  return () => {
    installed -= 1
    if (installed === 0 && typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): InputModality {
  return modality
}

/** 마지막 입력 수단. 서버 렌더는 없지만 훅 규약대로 두 번째 인자를 준다. */
export function useInputModality(): InputModality {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 훅 밖에서 한 번만 읽고 싶을 때. */
export function getInputModality(): InputModality {
  return modality
}

// ---------------------------------------------------------------------------
// 컴포넌트
// ---------------------------------------------------------------------------

/**
 * 앱 루트에 한 번 놓는다. 렌더 결과는 없다.
 *
 *   <FocusRing />
 *
 * a11y.css 를 여기서 import 하므로 이 컴포넌트를 빼면 보정 규칙이 통째로 빠진다.
 * 그게 의도다. 접근성 레이어를 껐다 켰다 하는 스위치가 여러 개면 반드시 어긋난다.
 */
export function FocusRing(): ReactNode {
  useEffect(install, [])
  return null
}

export default FocusRing
