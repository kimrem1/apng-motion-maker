/**
 * 속성 옆에 붙는 애니메이션 스톱워치.
 *
 * 버튼이 둘이다.
 *   1. 스톱워치: 이 속성의 애니메이션을 켜고 끈다.
 *   2. 마름모: 현재 프레임에 키프레임을 추가하거나 지운다. 켜져 있을 때만 나온다.
 *
 * 마름모의 모양은 그 프레임 키의 보간 타입을 따른다. 타임라인 마커와 같은 규칙이라
 * 인스펙터와 타임라인 사이에서 눈이 다시 배울 필요가 없다.
 *
 * 문서 스토어의 isAnimated 는 키가 2개 이상일 때만 true 다. 스톱워치를 막 켠
 * 직후에는 키가 하나뿐이라 그것만으로는 버튼이 곧바로 꺼진 것처럼 보인다.
 * 그래서 "켜려는 의도" 는 timelineUi 스토어의 armed 집합이 따로 기억한다.
 */

import type { ReactNode } from 'react'

import type { Interp, TrackProp } from '@/core/types.ts'
import { isAnimated, keyframesOf, useDocumentStore } from '@/state/document.ts'
import { propId, useTimelineUiStore } from '@/state/timelineUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { INTERP_LABELS, PROP_LABELS, shapeForInterp } from '@/ui/timeline/timelineDraw.ts'

const TOGGLE_CSS = `
.animtoggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.animtoggle__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-faint);
  transition:
    background var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}

.animtoggle__btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.animtoggle__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* 켜진 상태는 색 + 테두리 + 배경 세 가지로 표시한다. */
.animtoggle__btn[aria-pressed='true'] {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
`

function StopwatchIcon({ on }: { on: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M6 1.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle
        cx="8"
        cy="9.5"
        r="5.2"
        fill={on ? 'currentColor' : 'none'}
        fillOpacity={on ? 0.22 : 0}
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M8 6.4v3.1h2.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  )
}

/** 타임라인 마커와 같은 모양 규칙. 색이 아니라 모양이 보간 타입을 말한다. */
function KeyGlyph({ interp, filled }: { interp: Interp; filled: boolean }): ReactNode {
  const shape = shapeForInterp(interp)
  const fill = filled ? 'currentColor' : 'none'
  const stroke = 'currentColor'
  const sw = 1.4

  let node: ReactNode
  switch (shape) {
    case 'circle':
      node = <circle cx="8" cy="8" r="4.6" fill={fill} stroke={stroke} strokeWidth={sw} />
      break
    case 'square':
      node = <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1" fill={fill} stroke={stroke} strokeWidth={sw} />
      break
    case 'triangle':
      node = <path d="M8 3 13 12.4H3z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      break
    case 'star':
      node = (
        <path
          d="M8 2.6l1.6 3.5 3.8.4-2.8 2.6.8 3.8L8 11l-3.4 1.9.8-3.8L2.6 6.5l3.8-.4z"
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
      )
      break
    case 'diamond':
    default:
      node = <path d="M8 2.6 13.4 8 8 13.4 2.6 8z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />
      break
  }

  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      {node}
    </svg>
  )
}

export interface AnimateToggleProps {
  layerId: string
  prop: TrackProp
  /** 생략하면 재생 헤드 프레임을 쓴다. */
  frame?: number
  /** 접근 가능한 이름에 쓸 속성 표시명. 생략하면 기본 표를 쓴다. */
  label?: string
}

export function AnimateToggle({ layerId, prop, frame, label }: AnimateToggleProps): ReactNode {
  const layers = useDocumentStore((s) => s.doc.layers)
  const toggleAnimated = useDocumentStore((s) => s.toggleAnimated)
  const addKeyframe = useDocumentStore((s) => s.addKeyframe)
  const removeKeyframe = useDocumentStore((s) => s.removeKeyframe)

  const playhead = useUiStore((s) => s.playheadFrame)
  const armed = useTimelineUiStore((s) => s.armed)
  const setArmed = useTimelineUiStore((s) => s.setArmed)

  const layer = layers.find((l) => l.id === layerId) ?? null
  const at = frame ?? playhead
  const name = label ?? PROP_LABELS[prop]

  if (!layer) return null

  const animatedInDoc = isAnimated(layer, prop)
  const isArmed = armed.includes(propId(layerId, prop))
  const on = animatedInDoc || isArmed

  const keys = keyframesOf(layer, prop)
  const keyHere = on ? keys.find((k) => k.f === at) : undefined
  const interp: Interp = keyHere?.interp ?? 'bezier'
  // 키가 하나뿐이면 문서 스토어가 삭제를 거부한다. 눌러도 아무 일이 없는 버튼을
  // 남기는 대신 비활성으로 이유를 보여준다.
  const cannotRemove = !!keyHere && keys.length <= 1

  function toggle(): void {
    if (on) {
      setArmed(layerId, prop, false)
      // 키가 하나뿐이면 문서는 이미 상수와 같다. 굳이 건드려 키 위치를 옮기지 않는다.
      if (animatedInDoc) toggleAnimated(layerId, prop, at)
      return
    }
    setArmed(layerId, prop, true)
    toggleAnimated(layerId, prop, at)
  }

  function toggleKeyHere(): void {
    if (keyHere) removeKeyframe(layerId, prop, at)
    else addKeyframe(layerId, prop, at)
  }

  return (
    <span className="animtoggle">
      <style href="mm-animate-toggle" precedence="default">
        {TOGGLE_CSS}
      </style>

      <button
        type="button"
        className="animtoggle__btn"
        aria-pressed={on}
        aria-label={`${name} 애니메이션 ${on ? '끄기' : '켜기'}`}
        title={on ? `${name} 애니메이션 끄기` : `${name} 애니메이션 켜기`}
        onClick={toggle}
      >
        <StopwatchIcon on={on} />
      </button>

      {on ? (
        <button
          type="button"
          className="animtoggle__btn"
          aria-pressed={!!keyHere}
          disabled={cannotRemove}
          aria-label={
            keyHere
              ? `프레임 ${at} 키프레임 삭제, 보간 ${INTERP_LABELS[interp]}`
              : `프레임 ${at} 에 키프레임 추가`
          }
          title={
            cannotRemove
              ? '키프레임이 하나뿐이라 지울 수 없습니다'
              : keyHere
                ? `프레임 ${at} 의 키프레임 삭제 (보간 ${INTERP_LABELS[interp]})`
                : `프레임 ${at} 에 키프레임 추가`
          }
          onClick={toggleKeyHere}
        >
          <KeyGlyph interp={interp} filled={!!keyHere} />
        </button>
      ) : null}
    </span>
  )
}

export default AnimateToggle
