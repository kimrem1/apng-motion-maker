/**
 * 이펙트 스택.
 *
 * 인스펙터에 끼워 넣는 <section> 하나다. 자체 패널이 아니다.
 *
 * 순서가 곧 파이프라인이다. 위에 있는 것이 먼저 적용된다. 목록을 렌더 순서와
 * 반대로 보여 주면 "왜 블러 위에 그린 선이 흐려지지 않지" 를 설명할 방법이 없다.
 * 그래서 목록의 위에서 아래가 그대로 처리 순서다.
 *
 * 재정렬은 HTML5 드래그를 쓰지 않는다. dragImage 를 브라우저가 마음대로 그리고
 * dragover 좌표가 끊겨 들어와 손가락보다 늦게 따라온다. LayerPanel 과 같은 이유로
 * pointer 이벤트 + setPointerCapture 로 직접 구현한다. 키보드 사용자는 각 행의
 * 위/아래 버튼을 쓴다. 드래그만 있으면 키보드로는 순서를 못 바꾼다.
 */

import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import type { Layer } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { EFFECT_CATEGORY_LABELS, EFFECT_DEFS, byStage } from '@/effects/registry.ts'
import type { EffectCategory, EffectStage } from '@/effects/types.ts'
import { EffectRow, normalizeEffectDef, type EffectView } from './EffectRow.tsx'
import './effects.css'

/** 파이프라인 순서. A(변형) -> B(파괴) -> C(마감) 이 패스 그래프의 순서다. */
const STAGE_ORDER: EffectStage[] = ['A', 'B', 'C']

/**
 * 추가 메뉴에 보여 줄 이펙트 목록.
 *
 * 스테이지 순서로 훑는다. 카탈로그 배열 순서가 곧 융합 셰이더의 적용 순서라서
 * (registry.ts 상단 주석) 그 순서를 그대로 보여 주면 목록에서 위에 있는 것이
 * 실제로 먼저 적용된다. 스테이지에 안 잡힌 것이 있으면 뒤에 붙여 빠뜨리지 않는다.
 */
function useEffectCatalog(): EffectView[] {
  return useMemo(() => {
    const out: EffectView[] = []
    const seen = new Set<string>()

    const push = (def: (typeof EFFECT_DEFS)[number]): void => {
      if (seen.has(def.id)) return
      seen.add(def.id)
      out.push(normalizeEffectDef(def))
    }

    for (const stage of STAGE_ORDER) for (const def of byStage(stage)) push(def)
    for (const def of EFFECT_DEFS) push(def)

    return out
  }, [])
}

// ---------------------------------------------------------------------------
// 드래그 상태
// ---------------------------------------------------------------------------

interface DragMeta {
  effectId: string
  fromIndex: number
  /** 드래그 시작 시점의 행 중심 y. 도중에 다시 재지 않는다. 재면 손끝이 튄다. */
  centers: number[]
  /** 눌렀을 때의 포인터 y. 임계 판정의 기준선이다. */
  startY: number
  toIndex: number
  moved: boolean
}

/**
 * 이 거리 미만은 드래그가 아니라 클릭의 흔들림으로 본다 (px).
 *
 * 자기 행을 포함한 중심 목록에서 "포인터보다 아래인 첫 행" 을 고르면 안 된다.
 * 손잡이를 잡은 지점은 거의 항상 자기 행 중심 근처라, 1~2px 만 위아래로 움직여도
 * 자기 중심을 넘어가 순서가 한 칸 튄다. 마우스를 떼기만 해도 스택이 뒤바뀐다.
 */
const DRAG_THRESHOLD_PX = 4

/**
 * 이웃으로 넘어갈 때 요구하는 여유 (px).
 *
 * 경계에서 손이 미세하게 떨리면 목표 인덱스가 두 값 사이를 계속 오간다. 한 번 넘어간
 * 뒤에는 반대 방향으로 이 거리만큼 되돌아와야 다시 바뀐다.
 */
const DRAG_HYSTERESIS_PX = 6

// ---------------------------------------------------------------------------

export interface EffectStackProps {
  layer: Layer
}

export function EffectStack({ layer }: EffectStackProps) {
  const transparentCanvas = useDocumentStore((s) => s.doc.canvas.background.type === 'alpha')
  const addEffect = useDocumentStore((s) => s.addEffect)
  const removeEffect = useDocumentStore((s) => s.removeEffect)
  const setEffectEnabled = useDocumentStore((s) => s.setEffectEnabled)
  const setEffectParam = useDocumentStore((s) => s.setEffectParam)
  const setEffectSeed = useDocumentStore((s) => s.setEffectSeed)
  const setEffectHold = useDocumentStore((s) => s.setEffectHold)
  const reorderEffect = useDocumentStore((s) => s.reorderEffect)

  const catalog = useEffectCatalog()
  const effects = layer.effects

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const dragRef = useRef<DragMeta | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  /**
   * 읽기 전용 사유.
   * 버튼만 죽여 두고 이유를 안 밝히면 사용자는 자기 잘못이라고 생각한다.
   * 지금 잠기는 경우는 하나뿐이지만, 늘어나도 문구를 여기 한 곳에만 둔다.
   */
  const readOnlyReason = useMemo<string | undefined>(
    () => (layer.locked ? '잠긴 레이어입니다. 자물쇠를 풀면 바꿀 수 있습니다.' : undefined),
    [layer.locked],
  )

  const locked = readOnlyReason !== undefined
  const catalogEmpty = catalog.length === 0

  // -------------------------------------------------------------------------
  // 추가
  // -------------------------------------------------------------------------

  const handleAdd = useCallback(
    (typeId: string): void => {
      const def = catalog.find((d) => d.id === typeId)
      if (!def) return
      const defaults: Record<string, number> = {}
      for (const control of def.controls) defaults[control.key] = control.default
      const created = addEffect(layer.id, def.id, defaults)
      // 방금 넣은 것을 바로 펼친다. 값을 못 보면 추가했는지도 알 수 없다.
      if (created) setExpandedId(created)
    },
    [addEffect, catalog, layer.id],
  )

  // -------------------------------------------------------------------------
  // 재정렬
  // -------------------------------------------------------------------------

  /** 한 칸씩 미는 액션밖에 없다. 거리를 반복 호출로 옮긴다. */
  const moveBy = useCallback(
    (effectId: string, from: number, to: number): void => {
      const step: -1 | 1 = to > from ? 1 : -1
      for (let i = 0; i < Math.abs(to - from); i += 1) reorderEffect(layer.id, effectId, step)
    },
    [layer.id, reorderEffect],
  )

  const onGripPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, effectId: string, index: number): void => {
      if (locked) return
      const list = listRef.current
      if (!list) return

      const rows = [...list.querySelectorAll<HTMLElement>('.mm-fx-row')]
      const centers = rows.map((row) => {
        const rect = row.getBoundingClientRect()
        return rect.top + rect.height / 2
      })

      dragRef.current = {
        effectId,
        fromIndex: index,
        centers,
        startY: e.clientY,
        toIndex: index,
        moved: false,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
      e.preventDefault()
    },
    [locked],
  )

  const onGripPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    const meta = dragRef.current
    if (!meta) return

    // 손가락이 사실상 제자리면 순서를 건드리지 않는다. 목록은 드래그 중에 실제로
    // 움직이지 않으므로(놓을 때 한 번에 옮긴다) 여기서 되돌려도 화면이 튀지 않는다.
    if (Math.abs(e.clientY - meta.startY) < DRAG_THRESHOLD_PX) {
      meta.toIndex = meta.fromIndex
      return
    }

    /*
     * 이웃 중심과 비교하는 히스테리시스.
     *
     * 지금 목표 자리에서 **한 칸 아래 행의 중심**을 지나야 한 칸 내려간다. 자기 중심이
     * 아니라 이웃 중심이 기준이라 한 칸 넘어가려면 대략 행 하나만큼 움직여야 한다.
     * centers 는 드래그 시작 시점에 잰 값이고 목록은 놓을 때까지 안 움직이므로
     * 드래그 내내 유효하다.
     */
    const last = meta.centers.length - 1
    let target = Math.min(Math.max(meta.toIndex, 0), last)
    for (;;) {
      const next = meta.centers[target + 1]
      if (target < last && next !== undefined && e.clientY > next + DRAG_HYSTERESIS_PX) {
        target += 1
        continue
      }
      const prev = meta.centers[target - 1]
      if (target > 0 && prev !== undefined && e.clientY < prev - DRAG_HYSTERESIS_PX) {
        target -= 1
        continue
      }
      break
    }

    if (!meta.moved) {
      meta.moved = true
      setDragId(meta.effectId)
    }
    meta.toIndex = target
  }, [])

  const onGripPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>, commit: boolean): void => {
      const meta = dragRef.current
      dragRef.current = null
      setDragId(null)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      if (!meta || !commit) return
      if (meta.toIndex === meta.fromIndex) return
      moveBy(meta.effectId, meta.fromIndex, meta.toIndex)
    },
    [moveBy],
  )

  // -------------------------------------------------------------------------
  // 그룹별 추가 메뉴
  // -------------------------------------------------------------------------

  const grouped = useMemo(() => {
    const map = new Map<EffectCategory, EffectView[]>()
    for (const def of catalog) {
      const list = map.get(def.category)
      if (list) list.push(def)
      else map.set(def.category, [def])
    }
    return [...map.entries()]
  }, [catalog])

  return (
    <section className="mm-section mm-fx-stack" aria-labelledby="mm-sec-effects">
      <h2 className="mm-section-title" id="mm-sec-effects">
        효과
      </h2>

      <div className="mm-stack">
        {effects.length === 0 ? (
          <p className="mm-fx-empty">
            아직 효과가 없습니다. 아래에서 골라 넣으면 위에서부터 차례로 적용됩니다.
          </p>
        ) : (
          <ul className={`mm-fx-list${dragId ? ' is-dragging mm-dragging' : ''}`} ref={listRef}>
            {effects.map((effect, index) => (
              <EffectRow
                key={effect.id}
                effect={effect}
                index={index}
                total={effects.length}
                expanded={expandedId === effect.id}
                transparentCanvas={transparentCanvas}
                {...(readOnlyReason !== undefined ? { readOnlyReason } : {})}
                dragging={dragId === effect.id}
                onToggleExpand={() => setExpandedId(expandedId === effect.id ? null : effect.id)}
                onToggleEnabled={(next) => setEffectEnabled(layer.id, effect.id, next)}
                onRemove={() => {
                  if (expandedId === effect.id) setExpandedId(null)
                  removeEffect(layer.id, effect.id)
                }}
                onMove={(direction) => reorderEffect(layer.id, effect.id, direction)}
                onParam={(key, value) => setEffectParam(layer.id, effect.id, key, value)}
                onSeed={(seed) => setEffectSeed(layer.id, effect.id, seed)}
                onHold={(hold) => setEffectHold(layer.id, effect.id, hold)}
                onGripPointerDown={(e) => onGripPointerDown(e, effect.id, index)}
                onGripPointerMove={onGripPointerMove}
                onGripPointerUp={onGripPointerUp}
              />
            ))}
          </ul>
        )}

        {/*
         * 이 select 는 상태가 아니라 버튼이다. 고른 즉시 추가하고 값은 항상 빈 문자열로
         * 되돌린다. 값이 남으면 같은 효과를 연달아 두 번 넣을 수 없다.
         * 팝업 목록을 직접 그리지 않는 이유는 접근성이다. 네이티브 select 는 키보드,
         * 스크린리더, 모바일 휠 선택이 전부 공짜로 따라온다.
         */}
        <div className="mm-fx-add">
          <label className="mm-visually-hidden" htmlFor="mm-fx-add-select">
            효과 추가
          </label>
          <select
            id="mm-fx-add-select"
            className="mm-select"
            value=""
            disabled={locked || catalogEmpty}
            title={locked ? readOnlyReason : catalogEmpty ? '아직 쓸 수 있는 효과가 없습니다.' : undefined}
            onChange={(e) => {
              const value = e.target.value
              if (value) handleAdd(value)
            }}
          >
            <option value="">+ 효과 추가</option>
            {grouped.map(([category, defs]) => (
              <optgroup key={category} label={EFFECT_CATEGORY_LABELS[category]}>
                {defs.map((def) => (
                  <option key={def.id} value={def.id}>
                    {def.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {transparentCanvas && effects.length > 0 ? (
          <p className="mm-fx-note">
            배경이 투명입니다. &lsquo;배경 번짐&rsquo; 표시가 붙은 효과는 투명한 부분을
            뿌옇게 남길 수 있습니다.
          </p>
        ) : null}
      </div>
    </section>
  )
}

export default EffectStack
