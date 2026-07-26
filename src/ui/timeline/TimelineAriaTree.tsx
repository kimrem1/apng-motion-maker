/**
 * 타임라인의 병행 접근성 트리.
 *
 * Canvas 는 접근성 트리에 아무것도 남기지 않는다. 그래서 같은 데이터를 시각적으로
 * 숨긴 DOM 리스트로 한 번 더 제공한다. **이건 장식이 아니라 키보드 편집 경로다.**
 * 화살표로 이동하고 Enter 로 선택하고 Delete 로 지우고 Shift+화살표로 프레임을
 * 옮길 수 있어야 타임라인이 키보드만으로 완주 가능해진다.
 *
 * 데이터는 Timeline.tsx 와 똑같은 TimelineModel 하나에서 나온다. 두 곳에서
 * 따로 계산하면 반드시 어긋난다.
 *
 * 평소에는 숨어 있지만 포커스가 들어오면 화면에 뜬다. 보이는 키보드 사용자가
 * 자기가 어디에 있는지 모르는 상태로 조작하게 두면 안 된다.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import type { TrackProp } from '@/core/types.ts'
import {
  describeKeyframe,
  describeTrack,
  formatPropValue,
  INTERP_LABELS,
  selectionId,
  type TimelineModel,
} from './timelineDraw.ts'

const ARIA_CSS = `
/* 포커스가 없을 때는 시각적으로 숨긴다. 낭독기에는 그대로 남는다. */
.tl-aria:not(:focus-within) {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.tl-aria:focus-within {
  position: absolute;
  right: var(--sp-4);
  bottom: var(--sp-4);
  z-index: 20;
  width: min(340px, calc(100% - var(--sp-6)));
  max-height: 60vh;
  overflow: auto;
  padding: var(--sp-3);
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--surface-raised);
  box-shadow: var(--shadow-2);
  scrollbar-width: thin;
}

.tl-aria__title {
  margin-bottom: var(--sp-2);
  color: var(--text-muted);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.tl-aria__track {
  padding: 2px var(--sp-2);
  border-radius: var(--r-sm);
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 600;
}

.tl-aria__keys {
  margin: 0 0 var(--sp-2) var(--sp-4);
}

.tl-aria__key {
  padding: 2px var(--sp-2);
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--fs-xs);
}

/* 선택은 색 하나에 기대지 않는다. 테두리 + 배경 + 접두 기호까지 바꾼다. */
.tl-aria__key[aria-selected='true'] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.tl-aria__mark {
  display: inline-block;
  width: 1.2em;
  color: var(--accent);
}

.tl-aria__hint {
  margin-top: var(--sp-2);
  color: var(--text-faint);
  font-size: var(--fs-xs);
  line-height: 1.5;
}
`

const HINT =
  '위아래 화살표로 이동, Enter 로 선택, Delete 로 삭제, Shift + 좌우 화살표로 프레임 이동, G 로 그래프 열기.'

/**
 * 이 트리가 직접 처리하는 키.
 *
 * 처리한 키를 그대로 올려보내면 Timeline 루트의 onKeyDown 이 한 번 더 반응한다.
 * 실제로 Delete 한 번에 커서 위의 키와 선택된 키가 둘 다 지워졌다.
 */
const HANDLED_KEYS: ReadonlySet<string> = new Set([
  'ArrowDown',
  'ArrowUp',
  'ArrowRight',
  'ArrowLeft',
  'Home',
  'End',
  'Enter',
  ' ',
  'Delete',
  'Backspace',
  'g',
  'G',
])

interface FlatNode {
  id: string
  kind: 'track' | 'key'
  rowIndex: number
  keyIndex: number
}

function trackId(prop: TrackProp): string {
  return `t:${prop}`
}

function keyId(prop: TrackProp, frame: number): string {
  return `k:${prop}:${frame}`
}

function flatten(model: TimelineModel): FlatNode[] {
  const out: FlatNode[] = []
  for (let r = 0; r < model.rows.length; r++) {
    const row = model.rows[r]
    if (!row) continue
    out.push({ id: trackId(row.prop), kind: 'track', rowIndex: r, keyIndex: -1 })
    for (let i = 0; i < row.keys.length; i++) {
      const key = row.keys[i]
      if (!key) continue
      out.push({ id: keyId(row.prop, key.f), kind: 'key', rowIndex: r, keyIndex: i })
    }
  }
  return out
}

export interface TimelineAriaTreeProps {
  model: TimelineModel
  /** timelineDraw.selectionId 로 만든 `${prop}:${frame}` 집합 */
  selected: ReadonlySet<string>
  onSelectKey(prop: TrackProp, frame: number, additive: boolean): void
  onDeleteKey(prop: TrackProp, frame: number): void
  /** 실제로 옮겼으면 true. 대상 프레임이 차 있어 거부되면 false 다. */
  onMoveKey(prop: TrackProp, from: number, to: number): boolean
  onGoToFrame(frame: number): void
  onOpenGraph(prop: TrackProp): void
}

export function TimelineAriaTree({
  model,
  selected,
  onSelectKey,
  onDeleteKey,
  onMoveKey,
  onGoToFrame,
  onOpenGraph,
}: TimelineAriaTreeProps): ReactNode {
  const nodes = flatten(model)
  const [wantedId, setWantedId] = useState<string>(() => nodes[0]?.id ?? '')
  // 키를 지우면 wantedId 가 사라진 노드를 가리킨다. 상태를 고치는 대신 파생값으로
  // 흘려보낸다. 렌더 중 setState 를 부르지 않아 루프가 생기지 않는다.
  const activeId = nodes.some((n) => n.id === wantedId) ? wantedId : (nodes[0]?.id ?? '')

  // 마운트나 외부 변경으로 포커스를 훔치지 않는다. 키 조작으로 옮길 때만 true.
  const wantFocusRef = useRef(false)
  const itemsRef = useRef(new Map<string, HTMLElement>())

  const registerItem = useCallback((id: string, el: HTMLElement | null) => {
    if (el) itemsRef.current.set(id, el)
    else itemsRef.current.delete(id)
  }, [])

  useEffect(() => {
    if (!wantFocusRef.current) return
    wantFocusRef.current = false
    itemsRef.current.get(activeId)?.focus()
  }, [activeId])

  function moveActive(id: string): void {
    wantFocusRef.current = true
    setWantedId(id)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLUListElement>): void {
    if (!HANDLED_KEYS.has(e.key)) return
    // 여기서 끊지 않으면 Timeline 루트가 같은 키를 한 번 더 처리한다.
    e.stopPropagation()

    const index = nodes.findIndex((n) => n.id === activeId)
    if (index < 0) return
    const node = nodes[index]
    if (!node) return
    const row = model.rows[node.rowIndex]
    if (!row) return
    const key = node.kind === 'key' ? row.keys[node.keyIndex] : undefined

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault()
        const next = nodes[Math.min(nodes.length - 1, index + 1)]
        if (next) moveActive(next.id)
        return
      }
      case 'ArrowUp': {
        e.preventDefault()
        const prev = nodes[Math.max(0, index - 1)]
        if (prev) moveActive(prev.id)
        return
      }
      case 'ArrowRight': {
        e.preventDefault()
        if (e.shiftKey && key) {
          // 프레임 이동. 이게 키보드 편집 경로의 핵심이다.
          // 이동이 거부되면 커서를 옮기지 않는다. 없는 노드를 가리키면 포커스가 첫 줄로 튄다.
          const to = Math.min(model.durationFrames - 1, key.f + 1)
          if (to !== key.f && onMoveKey(row.prop, key.f, to)) {
            moveActive(keyId(row.prop, to))
          }
          return
        }
        const next = nodes[index + 1]
        if (next) moveActive(next.id)
        return
      }
      case 'ArrowLeft': {
        e.preventDefault()
        if (e.shiftKey && key) {
          const to = Math.max(0, key.f - 1)
          if (to !== key.f && onMoveKey(row.prop, key.f, to)) {
            moveActive(keyId(row.prop, to))
          }
          return
        }
        if (node.kind === 'key') {
          moveActive(trackId(row.prop))
          return
        }
        const prev = nodes[index - 1]
        if (prev) moveActive(prev.id)
        return
      }
      case 'Home': {
        e.preventDefault()
        const first = nodes[0]
        if (first) moveActive(first.id)
        return
      }
      case 'End': {
        e.preventDefault()
        const last = nodes[nodes.length - 1]
        if (last) moveActive(last.id)
        return
      }
      case 'Enter':
      case ' ': {
        e.preventDefault()
        if (!key) return
        onSelectKey(row.prop, key.f, e.ctrlKey || e.metaKey || e.shiftKey)
        onGoToFrame(key.f)
        return
      }
      case 'Delete':
      case 'Backspace': {
        e.preventDefault()
        if (!key) return
        onDeleteKey(row.prop, key.f)
        return
      }
      case 'g':
      case 'G': {
        e.preventDefault()
        onOpenGraph(row.prop)
        return
      }
      default:
    }
  }

  if (model.rows.length === 0) {
    return (
      <div className="tl-aria">
        <style href="mm-timeline-aria" precedence="default">
          {ARIA_CSS}
        </style>
        <p className="tl-aria__title">{model.layerName} 타임라인</p>
        <p className="tl-aria__hint">애니메이션된 속성이 없습니다.</p>
      </div>
    )
  }

  return (
    <div className="tl-aria">
      <style href="mm-timeline-aria" precedence="default">
        {ARIA_CSS}
      </style>
      <p className="tl-aria__title" id="tl-aria-title">
        {model.layerName} 타임라인 (키보드 편집)
      </p>

      <ul role="tree" aria-labelledby="tl-aria-title" onKeyDown={handleKeyDown}>
        {model.rows.map((row) => {
          const tid = trackId(row.prop)
          return (
            <li
              key={row.prop}
              role="treeitem"
              aria-expanded="true"
              aria-label={describeTrack(row)}
              className="tl-aria__track"
              tabIndex={activeId === tid ? 0 : -1}
              ref={(el) => registerItem(tid, el)}
              onFocus={() => setWantedId(tid)}
            >
              <span aria-hidden="true">
                {row.label} ({row.keys.length})
              </span>

              <ul role="group" className="tl-aria__keys">
                {row.keys.map((key, i) => {
                  const kid = keyId(row.prop, key.f)
                  const isSelected = selected.has(selectionId(row.prop, key.f))
                  return (
                    <li
                      key={key.f}
                      role="treeitem"
                      aria-label={describeKeyframe(row, i)}
                      aria-selected={isSelected}
                      className="tl-aria__key"
                      tabIndex={activeId === kid ? 0 : -1}
                      ref={(el) => registerItem(kid, el)}
                      onFocus={() => setWantedId(kid)}
                      onClick={() => {
                        onSelectKey(row.prop, key.f, false)
                        onGoToFrame(key.f)
                      }}
                    >
                      <span aria-hidden="true">
                        <span className="tl-aria__mark">{isSelected ? '*' : ''}</span>
                        {`f${key.f} ${formatPropValue(row.prop, key.v)} ${INTERP_LABELS[key.interp]}`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        })}
      </ul>

      <p className="tl-aria__hint">{HINT}</p>
    </div>
  )
}

export default TimelineAriaTree
