/**
 * 전역 단축키 바인딩.
 *
 * COMMANDS 하나에서 tinykeys 맵을 만든다. 키 목록을 여기 다시 적지 않는다.
 *
 * ---------------------------------------------------------------------------
 * 포커스 컨텍스트 게이팅
 * ---------------------------------------------------------------------------
 * 이것은 처음부터 구조로 넣어야 한다. 나중에 넣으면 모든 핸들러를
 * 다시 고쳐야 한다. 규칙은 네 겹이고 순서가 곧 우선순위다.
 *
 *   1. **다른 모달**이 떠 있으면 전부 잠근다. `[aria-modal="true"]` 가 화면에 있는데
 *      우리 오버레이가 아니면 그 모달이 키보드의 주인이다.
 *   2. **우리 오버레이**(팔레트/도움말)가 떠 있으면 overlaySafe 만 통과시킨다.
 *   3. **입력 필드 포커스**면 수식자 없는 단일 키를 전부 끈다. 그리고 Ctrl+A/C/V/X/Z 처럼
 *      텍스트 편집 기본 동작이 필요한 조합은 브라우저에 양보한다.
 *   4. **위젯 포커스**면 그 위젯이 쓰는 키를 양보한다. 버튼에 포커스가 있을 때 Space 를
 *      가로채면 키보드만 쓰는 사용자는 버튼을 누를 방법이 없다.
 *
 * IME 도 여기서 막는다. 한글 입력 중에는 keydown 이 isComposing / keyCode 229 로 들어오는데
 * 이것을 흘려보내면 "ㄱ" 을 칠 때마다 그래프가 열린다.
 */

import { useEffect } from 'react'
import { tinykeys, type KeybindingsMap } from 'tinykeys'

import {
  COMMANDS,
  getOverlay,
  isCommandAvailable,
  needsPlatformMod,
  parseBinding,
  type Command,
} from './registry.ts'

/** 우리 오버레이를 표시하는 속성. 이게 붙어 있으면 "다른 모달" 로 세지 않는다. */
export const OVERLAY_ATTR = 'data-mm-shortcut-overlay'

/** 입력 필드 안에서는 브라우저 기본 동작이 이겨야 하는 키. */
const BROWSER_RESERVED = new Set(['a', 'c', 'v', 'x', 'z'])

/** Space / Enter 로 눌리는 것들. 포커스가 여기 있으면 Space 를 가로채지 않는다. */
const ACTIVATABLE =
  'button, a[href], summary, [role="button"], [role="option"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

/** 화살표로 항목을 옮기는 것들. 포커스가 여기 있으면 화살표를 가로채지 않는다. */
const ARROW_NAVIGABLE =
  '[role="listbox"], [role="radiogroup"], [role="tablist"], [role="menu"], [role="menubar"], [role="slider"], [role="spinbutton"], [role="tree"], [role="grid"], [role="combobox"]'

const ARROW_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end'])

function asElement(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null
  return el && typeof el.tagName === 'string' ? el : null
}

/** 텍스트를 입력받는 자리인가. select 도 포함한다(화살표로 항목을 고른다). */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = asElement(target)
  if (!el) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return el.isContentEditable === true
}

/** 포커스된 위젯이 이 키를 직접 쓰는가. */
function widgetConsumes(event: KeyboardEvent, key: string): boolean {
  const el = asElement(event.target)
  if (!el || typeof el.closest !== 'function') return false
  const lower = key.toLowerCase()
  if (lower === 'space' || lower === ' ' || lower === 'enter') {
    return el.closest(ACTIVATABLE) !== null
  }
  if (ARROW_KEYS.has(lower)) {
    return el.closest(ARROW_NAVIGABLE) !== null
  }
  return false
}

/** 우리 것이 아닌 모달이 화면에 있는가. */
function hasForeignModal(): boolean {
  if (typeof document === 'undefined') return false
  for (const el of document.querySelectorAll('[aria-modal="true"]')) {
    if (!el.closest(`[${OVERLAY_ATTR}]`)) return true
  }
  return false
}

/**
 * 이 바인딩을 지금 포커스 상태에서 실행해도 되는가.
 * 위의 3번, 4번 규칙만 본다. 1번 2번은 호출부에서 먼저 걸러진다.
 */
export function contextAllows(binding: string, event: KeyboardEvent): boolean {
  const { key } = parseBinding(binding)

  if (isEditableTarget(event.target)) {
    // 입력 중에는 단일 문자 / 화살표 / Space 를 전부 텍스트 쪽에 넘긴다.
    if (!needsPlatformMod(binding)) return false
    // Ctrl+Z 는 입력 필드 안에서 "방금 친 글자 되돌리기" 여야 한다.
    if (key.length === 1 && BROWSER_RESERVED.has(key.toLowerCase())) return false
    return true
  }

  if (!needsPlatformMod(binding) && widgetConsumes(event, key)) return false
  return true
}

// ---------------------------------------------------------------------------
// 전역 on/off
// ---------------------------------------------------------------------------

let enabled = true

/**
 * 전역 단축키를 통째로 끈다.
 *
 * 모달을 aria-modal 로 표시하면 자동으로 잠기므로 보통은 부를 일이 없다.
 * 온보딩처럼 aria-modal 이 아닌 전체 화면 흐름이 생기면 이 스위치를 쓴다.
 */
export function setShortcutsEnabled(next: boolean): void {
  enabled = next
}

export function areShortcutsEnabled(): boolean {
  return enabled
}

// ---------------------------------------------------------------------------
// 바인딩 맵
// ---------------------------------------------------------------------------

function makeHandler(command: Command, binding: string) {
  const ownsKey = needsPlatformMod(binding)
  return (event: KeyboardEvent): void => {
    if (!enabled) return
    /*
     * 이미 처리된 키는 건드리지 않는다.
     *
     * tinykeys 는 window 에 걸리고 React 리스너는 #root 에 걸린다. 즉 패널이 자기
     * 키를 처리한 뒤에도 같은 네이티브 이벤트가 여기까지 올라온다. 이 가드가 없으면
     * 타임라인의 Delete 가 키프레임을 지운 다음 전역 삭제가 레이어까지 지우고,
     * 레이어 행의 Delete 는 두 장을 지우며, 화살표는 재생 헤드를 2프레임씩 민다.
     * preventDefault 를 부른 쪽이 그 키의 주인이다.
     */
    if (event.defaultPrevented) return
    if (hasForeignModal()) return
    if (getOverlay() !== null && command.overlaySafe !== true) return
    if (!contextAllows(binding, event)) return

    if (!isCommandAvailable(command)) {
      // 쓸 수 없어도 브라우저 기본 동작은 막는다. Ctrl+S 가 "웹페이지 저장" 을 띄우면
      // 사용자는 이 앱이 고장 났다고 생각한다. 대신 아무 일도 하지 않는다.
      if (ownsKey) event.preventDefault()
      return
    }

    event.preventDefault()
    try {
      command.run()
    } catch (err) {
      // 단축키 하나가 던져도 나머지 바인딩은 살아 있어야 한다.
      console.error(`[shortcuts] ${command.id} 실행 실패`, err)
    }
  }
}

/** repeatable 여부로 두 맵을 나눈다. tinykeys 의 repeat 무시는 핸들러 단위가 아니다. */
function buildMaps(): { once: KeybindingsMap; repeat: KeybindingsMap } {
  const once: KeybindingsMap = {}
  const repeat: KeybindingsMap = {}
  for (const command of COMMANDS) {
    for (const binding of command.keys ?? []) {
      const target = command.repeatable === true ? repeat : once
      target[binding] = makeHandler(command, binding)
    }
  }
  return { once, repeat }
}

// COMMANDS 는 정적이므로 맵도 한 번만 만든다.
const MAPS = buildMaps()

/** 누르고 있을 때 반복하지 않는다. 재생 토글이 연타되면 화면이 발작한다. */
function ignoreOnce(event: KeyboardEvent): boolean {
  return isComposingEvent(event) || event.repeat
}

/** 프레임 이동은 눌러서 감아 볼 수 있어야 한다. */
function ignoreRepeat(event: KeyboardEvent): boolean {
  return isComposingEvent(event)
}

function isComposingEvent(event: KeyboardEvent): boolean {
  // Safari 는 isComposing 을 늦게 세운다. keyCode 229 가 더 확실한 신호다.
  return event.isComposing || event.keyCode === 229
}

export interface UseShortcutsOptions {
  /** false 면 이 훅이 살아 있는 동안 전역 단축키를 끈다. */
  enabled?: boolean
}

/**
 * 앱 루트에서 한 번만 부른다. 두 번 부르면 명령이 두 번 실행된다.
 *
 * Toolbar 의 Ctrl+Z 직접 바인딩은 반드시 걷어내야 한다. 남겨 두면 실행취소가
 * 두 칸씩 건너뛴다 (통합 담당 확인 사항).
 */
export function useShortcuts(options: UseShortcutsOptions = {}): void {
  const wanted = options.enabled ?? true

  useEffect(() => {
    setShortcutsEnabled(wanted)
    return () => {
      setShortcutsEnabled(true)
    }
  }, [wanted])

  useEffect(() => {
    const unbindOnce = tinykeys(window, MAPS.once, { ignore: ignoreOnce })
    const unbindRepeat = tinykeys(window, MAPS.repeat, { ignore: ignoreRepeat })
    return () => {
      unbindOnce()
      unbindRepeat()
    }
  }, [])
}
