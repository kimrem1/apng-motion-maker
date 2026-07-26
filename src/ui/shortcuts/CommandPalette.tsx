/**
 * 커맨드 팔레트.
 *
 * Ctrl+K 로 연다. 단축키를 외우지 못한 사용자가 기능에 닿는 유일한 길이므로 검색은
 * 관대해야 한다. 부분 문자열 -> 부분 수열 -> 초성 -> 영문 별칭 순으로 훑는다
 * (registry.ts 의 findCommands).
 *
 * 접근성
 *   - role="dialog" aria-modal, 열릴 때 입력에 포커스, 닫을 때 원래 요소로 복귀
 *   - 입력은 combobox, 목록은 listbox. 포커스는 입력에 묶어 두고 활성 항목은
 *     aria-activedescendant 로 알린다. 훑으면서 계속 타이핑할 수 있어야 한다
 *   - Tab 은 팔레트 밖으로 나가지 않는다
 *   - 쓸 수 없는 명령은 흐리게 두고 이유를 함께 읽어 준다. 목록에서 지우면
 *     "왜 없지" 를 사용자가 혼자 추측해야 한다
 *
 * 바깥 껍데기에 data-mm-shortcut-overlay 를 단다. useShortcuts.ts 가 이 표식으로
 * "우리 오버레이" 와 "다른 모달" 을 구분한다 (OVERLAY_ATTR).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import {
  closeOverlay,
  commandReason,
  findCommands,
  formatBinding,
  getOverlay,
  isCommandAvailable,
  isMacPlatform,
  subscribeOverlay,
  type Command,
} from './registry.ts'

import './shortcuts.css'

const LIST_ID = 'mm-cmdk-list'
const optionId = (index: number): string => `mm-cmdk-opt-${index}`

interface Row {
  command: Command
  available: boolean
  reason: string | undefined
  /** 대표 단축키. 없을 수도 있다(팔레트 전용 명령). */
  binding: string | undefined
}

function KeyChips({ binding, mac }: { binding: string; mac: boolean }) {
  const parts = formatBinding(binding, mac)
  return (
    <span className="mm-cmdk-keys">
      {parts.map((part, i) => (
        <kbd key={`${binding}-${i}`} className="mm-kbd">
          {part}
        </kbd>
      ))}
    </span>
  )
}

function itemClass(active: boolean, available: boolean): string {
  let cls = 'mm-cmdk-item'
  if (active) cls += ' is-active'
  if (!available) cls += ' is-off'
  return cls
}

export function CommandPalette() {
  const overlay = useSyncExternalStore(subscribeOverlay, getOverlay, getOverlay)
  const open = overlay === 'palette'

  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  // 열릴 때마다 검색어를 비운다. 지난 검색어가 남아 있으면 Ctrl+K 를 눌러도 목록이
  // 비어 있는 것처럼 보인다. effect 로 하면 한 프레임 늦게 지워져 깜빡인다.
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setQuery('')
      setActive(0)
    }
  }

  const mac = useMemo(() => isMacPlatform(), [])

  // 후보와 사용 가능 여부는 매 렌더 다시 계산한다. when() 은 스토어를 직접 읽으므로
  // 한 번 캐시해 두면 실행취소 스택이 비어도 계속 활성으로 보인다.
  const rows: Row[] = useMemo(() => {
    if (!open) return []
    return findCommands(query).map((command) => {
      const available = isCommandAvailable(command)
      return {
        command,
        available,
        reason: available ? undefined : commandReason(command),
        binding: command.keys?.[0],
      }
    })
  }, [open, query])

  const clamped = rows.length === 0 ? 0 : Math.min(active, rows.length - 1)
  const activeRow = rows[clamped]

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => {
      const previous = returnFocusRef.current
      returnFocusRef.current = null
      // 그 사이 사라진 요소에 포커스를 주면 body 로 튄다. 확인하고 되돌린다.
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [open])

  // 활성 항목을 화면 안으로. 화살표로 훑는데 목록이 따라오지 않으면 길을 잃는다.
  useEffect(() => {
    if (!open) return
    document.getElementById(optionId(clamped))?.scrollIntoView({ block: 'nearest' })
  }, [open, clamped])

  if (!open) return null

  const move = (delta: number): void => {
    if (rows.length === 0) return
    setActive((prev) => {
      const base = Math.min(prev, rows.length - 1)
      return (base + delta + rows.length) % rows.length
    })
  }

  const run = (row: Row | undefined): void => {
    if (!row || !row.available) return
    closeOverlay('palette')
    // 팔레트 자신을 실행하면 방금 닫은 것이 곧바로 다시 열린다. 닫기로 끝낸다.
    if (row.command.id === 'palette.toggle') return
    row.command.run()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeOverlay('palette')
      return
    }
    if (e.key === 'Tab') {
      // 포커스는 입력에 묶어 둔다. 팔레트 밖으로 나가면 뒤 화면을 조작하게 된다.
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
      return
    }
    // 한글 조합 중의 Enter 는 글자를 확정하는 것이지 실행이 아니다.
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      run(activeRow)
    }
  }

  return (
    <div
      className="mm-cmdk-scrim"
      role="presentation"
      data-mm-shortcut-overlay=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeOverlay('palette')
      }}
    >
      <div
        className="mm-cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="커맨드 팔레트"
        onKeyDown={onKeyDown}
      >
        <div className="mm-cmdk-search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M10.2 10.2L13.5 13.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={inputRef}
            className="mm-cmdk-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeRow ? optionId(clamped) : undefined}
            aria-label="명령 검색"
            placeholder="명령 검색 (초성도 됩니다)"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
          />
          <kbd className="mm-kbd">Esc</kbd>
        </div>

        <ul id={LIST_ID} className="mm-cmdk-list mm-scroll" role="listbox" aria-label="명령">
          {rows.map((row, index) => (
            <li
              key={row.command.id}
              id={optionId(index)}
              className={itemClass(index === clamped, row.available)}
              role="option"
              aria-selected={index === clamped}
              aria-disabled={!row.available}
              onMouseMove={() => setActive(index)}
              // 클릭으로 포커스가 목록으로 옮겨 가면 입력의 조합 상태가 끊긴다.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(row)}
            >
              <span className="mm-cmdk-cat">{row.command.category}</span>
              <span className="mm-cmdk-text">
                <span className="mm-cmdk-label">{row.command.label}</span>
                {row.available ? (
                  row.command.hint ? (
                    <span className="mm-cmdk-hint">{row.command.hint}</span>
                  ) : null
                ) : (
                  <span className="mm-cmdk-hint is-reason">
                    {row.reason ?? '지금은 쓸 수 없습니다'}
                  </span>
                )}
              </span>
              {row.binding ? <KeyChips binding={row.binding} mac={mac} /> : null}
            </li>
          ))}

          {rows.length === 0 ? (
            <li className="mm-cmdk-empty" role="presentation">
              찾는 명령이 없습니다
            </li>
          ) : null}
        </ul>

        <div className="mm-cmdk-foot">
          <span>
            <kbd className="mm-kbd">↑</kbd>
            <kbd className="mm-kbd">↓</kbd> 이동
          </span>
          <span>
            <kbd className="mm-kbd">Enter</kbd> 실행
          </span>
          <span>
            <kbd className="mm-kbd">?</kbd> 단축키 목록
          </span>
        </div>

        {/* 결과 수를 낭독기에 알린다. 목록이 비었을 때 침묵하면 안 된다. */}
        <p className="mm-visually-hidden" role="status">
          {rows.length}개 명령
        </p>
      </div>
    </div>
  )
}

export default CommandPalette
