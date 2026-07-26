/**
 * 단축키 목록 오버레이.
 *
 * 물음표(?) 로 연다. 카테고리별로 묶어 보여 준다. COMMANDS 하나에서 파생되므로
 * 단축키를 바꾸면 이 화면이 저절로 따라온다. 두 곳에 적으면 반드시 어긋난다.
 *
 * 여기 없는 것 두 가지를 아래 각주로 밝힌다. 목록에 없으면 사용자는 "안 되는 기능"
 * 으로 읽는데, 실제로는 다른 곳이 처리하고 있다.
 *   - Ctrl+V 붙여넣기: imageprep/useImageDrop.ts 의 paste 리스너
 *   - Alt+드래그 복제, Ctrl+휠 줌, Space+드래그 팬: 포인터 조작이라 키맵에 없다
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import {
  COMMANDS,
  COMMAND_CATEGORY_ORDER,
  closeOverlay,
  commandReason,
  formatBinding,
  getOverlay,
  isCommandAvailable,
  isMacPlatform,
  subscribeOverlay,
  type Command,
  type CommandCategory,
} from './registry.ts'

import './shortcuts.css'

/** tabindex="-1" 은 제외한다. */
const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 키맵에 없지만 사용자가 알아야 하는 포인터 조작. */
const POINTER_NOTES: readonly { label: string; how: string }[] = [
  { label: '이미지 붙여넣기', how: 'Ctrl+V (화면 아무 곳에서나)' },
  { label: '이미지 넣기', how: '앱 어디에나 끌어다 놓기' },
  { label: '타임라인 확대', how: 'Ctrl + 휠' },
]

interface Group {
  category: CommandCategory
  commands: Command[]
}

function KeyRow({ binding, mac }: { binding: string; mac: boolean }) {
  const parts = formatBinding(binding, mac)
  return (
    <span className="mm-help-keys">
      {parts.map((part, i) => (
        <kbd key={`${binding}-${i}`} className="mm-kbd">
          {part}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutHelp() {
  const overlay = useSyncExternalStore(subscribeOverlay, getOverlay, getOverlay)
  const open = overlay === 'help'

  const cardRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const mac = useMemo(() => isMacPlatform(), [])

  // 카테고리 순서는 COMMAND_CATEGORY_ORDER 가 정본이다. 목록에 없는 카테고리가
  // 생기면 조용히 빠지지 않도록 뒤에 붙인다.
  const groups: Group[] = useMemo(() => {
    const byCategory = new Map<CommandCategory, Command[]>()
    for (const command of COMMANDS) {
      const bucket = byCategory.get(command.category)
      if (bucket) bucket.push(command)
      else byCategory.set(command.category, [command])
    }
    const ordered: Group[] = []
    for (const category of COMMAND_CATEGORY_ORDER) {
      const commands = byCategory.get(category)
      if (commands && commands.length > 0) {
        ordered.push({ category, commands })
        byCategory.delete(category)
      }
    }
    for (const [category, commands] of byCategory) ordered.push({ category, commands })
    return ordered
  }, [])

  // when() 은 스토어를 직접 읽으므로 계산 결과를 캐시하지 않는다.
  // 오버레이가 열릴 때 useSyncExternalStore 가 리렌더를 일으켜 매번 새로 평가된다.

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => {
      const previous = returnFocusRef.current
      returnFocusRef.current = null
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [open])

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeOverlay('help')
      return
    }
    if (e.key !== 'Tab') return

    const card = cardRef.current
    if (!card) return
    const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    )
    if (items.length === 0) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  if (!open) return null

  return (
    <div
      className="mm-help-scrim"
      role="presentation"
      data-mm-shortcut-overlay=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeOverlay('help')
      }}
    >
      <div
        ref={cardRef}
        className="mm-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mm-help-title"
        onKeyDown={onKeyDown}
      >
        <header className="mm-help-head">
          <h2 id="mm-help-title" className="mm-help-title">
            단축키
          </h2>
          <p className="mm-help-sub">
            <kbd className="mm-kbd">{mac ? '⌘' : 'Ctrl'}</kbd>
            <kbd className="mm-kbd">K</kbd> 로 이름을 검색해 실행할 수도 있습니다
          </p>
          <button
            ref={closeRef}
            type="button"
            className="mm-icon-btn"
            aria-label="닫기"
            onClick={() => closeOverlay('help')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="mm-help-body mm-scroll">
          {groups.map((group) => (
            <section className="mm-help-group" key={group.category}>
              <h3 className="mm-help-cat">{group.category}</h3>
              <dl className="mm-help-list">
                {group.commands.map((command) => {
                  const available = isCommandAvailable(command)
                  const reason = available ? undefined : commandReason(command)
                  return (
                    <div
                      className={available ? 'mm-help-row' : 'mm-help-row is-off'}
                      key={command.id}
                    >
                      <dt className="mm-help-name">
                        {command.label}
                        {reason ? <span className="mm-help-reason">{reason}</span> : null}
                      </dt>
                      <dd className="mm-help-binding">
                        {(command.keys ?? []).map((binding, i) => (
                          <span key={binding} className="mm-help-alt">
                            {i > 0 ? <span className="mm-help-or">또는</span> : null}
                            <KeyRow binding={binding} mac={mac} />
                          </span>
                        ))}
                        {(command.keys ?? []).length === 0 ? (
                          <span className="mm-help-or">팔레트 전용</span>
                        ) : null}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </section>
          ))}

          <section className="mm-help-group">
            <h3 className="mm-help-cat">키맵 밖</h3>
            <dl className="mm-help-list">
              {POINTER_NOTES.map((note) => (
                <div className="mm-help-row" key={note.label}>
                  <dt className="mm-help-name">{note.label}</dt>
                  <dd className="mm-help-binding">
                    <span className="mm-help-or">{note.how}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>

        <footer className="mm-help-foot">
          <span className="mm-help-note">
            입력란에 커서가 있으면 한 글자 단축키는 잠깐 꺼집니다
          </span>
          <button type="button" className="mm-btn" onClick={() => closeOverlay('help')}>
            닫기
          </button>
        </footer>
      </div>
    </div>
  )
}

export default ShortcutHelp
