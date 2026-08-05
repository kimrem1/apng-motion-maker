/**
 * 프리셋 갤러리.
 *
 * 이 화면의 규칙은 하나다. 탐색은 절대 파괴적이면 안 된다.
 *   호버 / 포커스 -> 캔버스가 임시로 그 프리셋을 재생한다 (문서는 그대로다)
 *   떼면          -> 원래 상태로 돌아온다
 *   클릭 / Enter  -> 그때만 문서에 확정된다
 *
 * 강도와 속도는 프리셋을 갈아타도 유지되는 공통 노브다. 그래서 카드 위가 아니라
 * 갤러리 상단에 하나만 둔다.
 *
 * 접근성: 그리드는 listbox / option 이고 화살표로 이동, Enter 로 적용한다. 카드 안에
 * 별도의 포커스 대상을 두지 않는 대신 F(즐겨찾기) / C(비교) 단축키를 준다.
 * prefers-reduced-motion 이면 자동 재생을 하지 않고 재생 버튼만 남긴다.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'

import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'
import {
  applyPresetToDocument,
  buildPresetDoc,
  clearAppliedPreset,
  clearPreview,
  commitMacroNow,
  previewPreset,
  reapplyAppliedPresetSoon,
  resolveTargetLayerId,
} from '@/state/presetActions.ts'
import { MAX_COMPARE, usePresetUiStore, type PresetCategoryFilter } from '@/state/presetUi.ts'
import { SPEED_STEP, pFromSpeed, speedFromP } from '@/state/speedScale.ts'
import { useUiStore } from '@/state/ui.ts'
import { CATEGORY_LABELS, EASY_PRESETS, MOTION_PRESETS } from '@/motions/registry.ts'
import { SKIP_TARGET_IDS } from '@/ui/a11y/SkipLinks.tsx'
import { PresetCard, readPresetMeta, type PresetMeta } from './PresetCard.tsx'

import './presets.css'

// ---------------------------------------------------------------------------
// 작은 훅
// ---------------------------------------------------------------------------

/** 결과물이 아니라 UI 자동 재생만 끈다. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (): void => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** 비교 줄 카드는 ref 를 등록하지 않는다. renderCard 주석 참조. */
const noRegister = (): void => {}

/** 그리드의 열 수. 화살표 위아래 이동 폭을 알아야 한다. */
function columnCount(el: HTMLElement | null): number {
  if (!el) return 1
  const template = getComputedStyle(el).gridTemplateColumns
  const cols = template.split(' ').filter((s) => s.length > 0).length
  return Math.max(1, cols)
}

// ---------------------------------------------------------------------------
// 갤러리
// ---------------------------------------------------------------------------

export function PresetGallery() {
  const doc = useDocumentStore((s) => s.doc)
  const mode = useUiStore((s) => s.mode)
  const selectedLayerId = useUiStore((s) => s.selectedLayerId)
  const assetRevision = useSyncExternalStore(assetRegistry.subscribe, assetRegistry.getRevision)
  const reducedMotion = usePrefersReducedMotion()

  const query = usePresetUiStore((s) => s.query)
  const category = usePresetUiStore((s) => s.category)
  const strength = usePresetUiStore((s) => s.strength)
  const speed = usePresetUiStore((s) => s.speed)
  const appliedId = usePresetUiStore((s) => s.appliedId)
  const favorites = usePresetUiStore((s) => s.favorites)
  const recent = usePresetUiStore((s) => s.recent)
  const compareIds = usePresetUiStore((s) => s.compareIds)

  const setQuery = usePresetUiStore((s) => s.setQuery)
  const setCategory = usePresetUiStore((s) => s.setCategory)
  const setStrength = usePresetUiStore((s) => s.setStrength)
  const setSpeed = usePresetUiStore((s) => s.setSpeed)
  const hover = usePresetUiStore((s) => s.hover)
  const toggleFavorite = usePresetUiStore((s) => s.toggleFavorite)
  const toggleCompare = usePresetUiStore((s) => s.toggleCompare)
  const clearCompare = usePresetUiStore((s) => s.clearCompare)

  const [showAll, setShowAll] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const gridRef = useRef<HTMLUListElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLLIElement>())
  /** 미리보기 시작 전의 재생 상태. 떼면 여기로 되돌린다. */
  const playingBeforeRef = useRef<boolean | null>(null)

  // -------------------------------------------------------------------------
  // 목록
  // -------------------------------------------------------------------------

  const metas = useMemo<PresetMeta[]>(() => MOTION_PRESETS.map(readPresetMeta), [])
  const metaById = useMemo(() => new Map(metas.map((m) => [m.id, m])), [metas])
  const easyIds = useMemo(() => new Set(EASY_PRESETS.map((p) => readPresetMeta(p).id)), [])

  const categories = useMemo(() => Object.entries(CATEGORY_LABELS), [])

  /*
   * 고른 레이어가 글자인가.
   *
   * 글자 등장은 거의 전부 이미지와 도형에도 그대로 걸린다. 예외는 글자 순번의
   * 홀짝으로 방향이 갈리는 몇 종뿐이고, 그것만 감춘다 (motions/types.ts textOnly).
   */
  const targetIsText = useMemo(() => {
    const id = selectedLayerId
    if (!id) return false
    return doc.layers.find((l) => l.id === id)?.text !== undefined
  }, [doc.layers, selectedLayerId])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return metas.filter((m) => {
      // EASY 는 추천 목록만 보여 준다. 카탈로그를 통째로 늘어놓으면 선택 마비가 온다.
      if (mode === 'easy' && !showAll && !easyIds.has(m.id)) return false
      if (m.textOnly && !targetIsText) return false
      if (category !== 'all' && m.category !== category) return false
      if (q.length > 0 && !m.keywords.includes(q)) return false
      return true
    })
  }, [metas, query, category, mode, showAll, easyIds, targetIsText])

  // "변형 더 보기" 숫자는 EASY 필터가 감춘 개수다. 검색으로 걸러진 것까지 세면
  // 검색어를 지우면 숫자가 확 바뀌어 버튼이 거짓말을 한다.
  const hiddenCount = metas.length - easyIds.size

  // 필터가 바뀌면 포커스 인덱스가 범위를 벗어난다.
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(0, visible.length - 1)))
  }, [visible.length])

  // -------------------------------------------------------------------------
  // 썸네일 입력
  // -------------------------------------------------------------------------

  // 선택이 없으면 맨 아래 레이어다. 선택이 바뀌면 썸네일도 다시 구워야 한다.
  const layerId = useMemo(() => resolveTargetLayerId(), [selectedLayerId, doc.layers])

  /**
   * 썸네일 캐시 지문. 그림이 달라지는 입력만 넣는다.
   * 강도/속도는 소수점 1자리로 뭉갠다. 슬라이더를 끄는 동안 매 픽셀마다 새 키가
   * 생기면 캐시가 의미를 잃고 굽기만 반복된다.
   */
  const docKey = useMemo(
    () =>
      [
        layerId ?? '-',
        `${doc.canvas.w}x${doc.canvas.h}`,
        doc.timeline.fps,
        // 도형은 에셋 리비전이 없다. 모양이 바뀌면 그림도 바뀌므로 지문에 넣는다.
        // 빠뜨리면 색이나 종류를 바꿔도 카드가 옛 그림을 계속 보여 준다.
        doc.layers
          .map((l) => {
            const s = l.shape
            const shapeKey = s
              ? `${s.kind}/${s.color}/${s.width}x${s.height}/${s.strokeWidth}/${s.cornerRadius}/${s.points}/${s.innerRatio}/${s.sweepDeg}`
              : '-'
            return `${l.id}:${l.assetId ?? '-'}:${shapeKey}`
          })
          .join(','),
        assetRevision,
        strength.toFixed(1),
        speed.toFixed(3),
      ].join('|'),
    [layerId, doc.canvas.w, doc.canvas.h, doc.timeline.fps, doc.layers, assetRevision, strength, speed],
  )

  const buildDoc = useCallback(
    (presetId: string) => buildPresetDoc(presetId),
    // 문서가 바뀌면 새로 만들어야 한다. buildPresetDoc 이 스토어를 직접 읽으므로
    // 의존성은 지문 하나로 충분하다.
    [docKey],
  )

  // -------------------------------------------------------------------------
  // 미리보기
  // -------------------------------------------------------------------------

  const stopPreview = useCallback(() => {
    clearPreview()
    const before = playingBeforeRef.current
    if (before !== null) {
      useUiStore.getState().setPlaying(before)
      playingBeforeRef.current = null
    }
  }, [])

  const startPreview = useCallback((presetId: string) => {
    if (playingBeforeRef.current === null) {
      playingBeforeRef.current = useUiStore.getState().playing
    }
    previewPreset(presetId)
    useUiStore.getState().setPlaying(true)
  }, [])

  const handleHover = useCallback(
    (id: string | null) => {
      hover(id)
      // 자동 재생을 원치 않는 사용자에게는 카드에 손을 올렸다고 화면이 움직이면 안 된다.
      if (reducedMotion) return
      if (id) startPreview(id)
      else stopPreview()
    },
    [hover, reducedMotion, startPreview, stopPreview],
  )

  // 갤러리를 떠나면 반드시 원래 상태로 돌린다. 미리보기가 남으면 사용자는 자기가
  // 고르지 않은 모션을 자기 문서로 착각한다.
  useEffect(() => stopPreview, [stopPreview])

  // -------------------------------------------------------------------------
  // 적용
  // -------------------------------------------------------------------------

  const handleApply = useCallback(
    (presetId: string) => {
      playingBeforeRef.current = null

      /*
       * 켠 카드를 다시 누르면 끈다.
       *
       * 모션을 얹어 보고 물리는 것이 가장 잦은 조작인데, 그 길이 Ctrl+Z 뿐이면
       * 그 사이에 한 다른 작업까지 함께 되감긴다. 카드가 곧 스위치여야 한다.
       *
       * PRO 에서 손본 문서(dirty)는 끄지 않는다. 프리셋이 심은 것을 걷어내는
       * 계산이 그 편집을 함께 지울 수 있다. 되돌리는 길은 배너의 [프리셋으로 리셋]이다.
       */
      const store = useDocumentStore.getState()
      if (
        usePresetUiStore.getState().appliedId === presetId &&
        store.doc.presetRef?.dirty !== true
      ) {
        const off = clearAppliedPreset()
        setNotice(off.ok ? off.message : null)
        if (off.ok) return
      }

      const report = applyPresetToDocument(presetId)
      if (!report.ok) {
        setNotice(report.message ?? '모션을 적용하지 못했습니다.')
        return
      }
      setNotice(report.message)
      // 확정 뒤에는 결과를 바로 보여 준다.
      useUiStore.getState().setPlaying(true)
    },
    [],
  )

  // -------------------------------------------------------------------------
  // 키보드
  // -------------------------------------------------------------------------

  const focusCard = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(index, visible.length - 1))
      setFocusedIndex(clamped)
      const meta = visible[clamped]
      if (!meta) return
      cardRefs.current.get(meta.id)?.focus()
    },
    [visible],
  )

  const onGridKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLUListElement>) => {
      const current = visible[focusedIndex]
      const cols = columnCount(gridRef.current)

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          focusCard(focusedIndex + 1)
          return
        case 'ArrowLeft':
          event.preventDefault()
          focusCard(focusedIndex - 1)
          return
        case 'ArrowDown':
          event.preventDefault()
          focusCard(focusedIndex + cols)
          return
        case 'ArrowUp':
          event.preventDefault()
          focusCard(focusedIndex - cols)
          return
        case 'Home':
          event.preventDefault()
          focusCard(0)
          return
        case 'End':
          event.preventDefault()
          focusCard(visible.length - 1)
          return
        case 'Enter':
        case ' ':
          event.preventDefault()
          if (current) handleApply(current.id)
          return
        case 'Escape':
          stopPreview()
          return
        default:
          break
      }

      // 단일 문자 단축키. 카드 안에 버튼을 두지 않는 대신이다.
      const key = event.key.toLowerCase()
      if (key === 'f' && current) {
        event.preventDefault()
        toggleFavorite(current.id)
      } else if (key === 'c' && current) {
        event.preventDefault()
        toggleCompare(current.id)
      }
    },
    [visible, focusedIndex, focusCard, handleApply, stopPreview, toggleFavorite, toggleCompare],
  )

  const registerRef = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) cardRefs.current.set(id, el)
    else cardRefs.current.delete(id)
  }, [])

  // -------------------------------------------------------------------------
  // 렌더
  // -------------------------------------------------------------------------

  const compareMetas = compareIds
    .map((id) => metaById.get(id))
    .filter((m): m is PresetMeta => m !== undefined)

  const quickList = (ids: readonly string[]): PresetMeta[] =>
    ids.map((id) => metaById.get(id)).filter((m): m is PresetMeta => m !== undefined)

  const favoriteMetas = quickList(favorites)
  const recentMetas = quickList(recent)

  /**
   * index 가 -1 이면 비교 줄이다. 같은 카드가 두 번 그려지므로 ref 등록은 본 목록만
   * 한다. 둘 다 등록하면 나중에 언마운트된 쪽이 살아 있는 쪽의 ref 를 지워 버린다.
   */
  const renderCard = (meta: PresetMeta, index: number, animated: boolean) => (
    <PresetCard
      key={meta.id}
      meta={meta}
      selected={appliedId === meta.id}
      favorite={favorites.includes(meta.id)}
      comparing={compareIds.includes(meta.id)}
      animated={animated && !reducedMotion}
      tabIndex={index >= 0 && index === focusedIndex ? 0 : -1}
      docKey={docKey}
      buildDoc={buildDoc}
      onApply={handleApply}
      onHover={handleHover}
      onToggleFavorite={toggleFavorite}
      onToggleCompare={toggleCompare}
      registerRef={index >= 0 ? registerRef : noRegister}
    />
  )

  return (
    <section className="mm-preset-gallery" aria-labelledby="mm-preset-title">
      <h2 className="mm-section-title" id="mm-preset-title">
        모션
      </h2>

      <div className="mm-preset-search">
        <input
          type="search"
          className="mm-input"
          value={query}
          placeholder="검색 (예: 흔들, 지지직)"
          aria-label="모션 검색"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="mm-preset-chips" role="group" aria-label="분류">
        <button
          type="button"
          className="mm-chip"
          aria-pressed={category === 'all'}
          onClick={() => setCategory('all')}
        >
          전체
        </button>
        {categories.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="mm-chip"
            aria-pressed={category === value}
            onClick={() => setCategory(value as PresetCategoryFilter)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mm-preset-knobs">
        <label className="mm-field mm-preset-knob">
          <span className="mm-field-label">세기</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={strength}
            onChange={(e) => {
              setStrength(Number(e.target.value))
              // 적용된 프리셋이 있으면 다시 클릭하지 않아도 드래그를 따라 실시간 적용된다.
              // PRO 에서 손본 문서(dirty)는 건드리지 않는다 (presetActions 참조).
              reapplyAppliedPresetSoon()
            }}
            onPointerUp={() => commitMacroNow()}
            onKeyUp={() => commitMacroNow()}
            onBlur={() => commitMacroNow()}
          />
        </label>
        <label className="mm-field mm-preset-knob">
          <span className="mm-field-label">속도</span>
          <input
            type="range"
            /* EASY 와 같은 로그 눈금을 쓴다. 범위가 다르면 여기서 한 번 건드리는 것만으로
               EASY 에서 맞춰 둔 느린 속도가 경고 없이 날아간다. */
            min={0}
            max={1}
            step={SPEED_STEP}
            value={pFromSpeed(speed)}
            onChange={(e) => {
              setSpeed(speedFromP(Number(e.target.value)))
              reapplyAppliedPresetSoon()
            }}
            onPointerUp={() => commitMacroNow()}
            onKeyUp={() => commitMacroNow()}
            onBlur={() => commitMacroNow()}
          />
        </label>
      </div>

      <p className="mm-preset-help">
        올리면 미리 재생, 누르면 적용됩니다. 키보드는 화살표로 이동, Enter 로 적용, F 로
        즐겨찾기, C 로 비교에 넣습니다.
      </p>

      {/* 자동 재생을 끈 사용자에게는 대신 누를 것을 준다. */}
      {reducedMotion ? (
        <div className="mm-preset-reduced">
          <span className="mm-field-hint">움직임 줄이기 설정이라 자동 재생을 하지 않습니다.</span>
          <button
            type="button"
            className="mm-btn"
            disabled={visible.length === 0}
            onClick={() => {
              const meta = visible[focusedIndex]
              if (meta) startPreview(meta.id)
            }}
          >
            고른 모션 미리 재생
          </button>
          <button type="button" className="mm-btn" onClick={stopPreview}>
            미리보기 끄기
          </button>
        </div>
      ) : null}

      {notice ? (
        <p className="mm-preset-notice" role="status">
          {notice}
        </p>
      ) : null}

      {compareMetas.length > 0 ? (
        <div className="mm-preset-compare-strip">
          <div className="mm-preset-strip-head">
            <span className="mm-field-label">비교 ({compareMetas.length}/{MAX_COMPARE})</span>
            <button type="button" className="mm-btn" onClick={clearCompare}>
              비우기
            </button>
          </div>
          {/* option 은 listbox 안에만 놓을 수 있다. 비교 줄은 같은 프리셋을 다시
              보여 주는 곳이라 포커스는 아래 본 목록 하나만 받는다. */}
          <ul className="mm-preset-grid is-compare" role="listbox" aria-label="비교 중인 모션">
            {compareMetas.map((meta) => renderCard(meta, -1, true))}
          </ul>
        </div>
      ) : null}

      {favoriteMetas.length > 0 ? (
        <QuickRow title="즐겨찾기" metas={favoriteMetas} onApply={handleApply} onHover={handleHover} />
      ) : null}
      {recentMetas.length > 0 ? (
        <QuickRow title="최근 사용" metas={recentMetas} onApply={handleApply} onHover={handleHover} />
      ) : null}

      <ul
        ref={gridRef}
        id={SKIP_TARGET_IDS.presets}
        className="mm-preset-grid"
        role="listbox"
        aria-label="모션 프리셋"
        onKeyDown={onGridKeyDown}
      >
        {visible.map((meta, index) => renderCard(meta, index, false))}
      </ul>

      {visible.length === 0 ? (
        <p className="mm-preset-empty">조건에 맞는 모션이 없습니다.</p>
      ) : null}

      {mode === 'easy' && !showAll && hiddenCount > 0 ? (
        <button type="button" className="mm-btn mm-btn-block" onClick={() => setShowAll(true)}>
          변형 더 보기 ({hiddenCount})
        </button>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 재방문 동선
// ---------------------------------------------------------------------------

interface QuickRowProps {
  title: string
  metas: readonly PresetMeta[]
  onApply(id: string): void
  onHover(id: string | null): void
}

/** 즐겨찾기 / 최근 사용은 카드 대신 이름 칩으로 둔다. 같은 카드를 두 번 굽지 않는다. */
function QuickRow({ title, metas, onApply, onHover }: QuickRowProps) {
  return (
    <div className="mm-preset-quick">
      <span className="mm-field-label">{title}</span>
      <div className="mm-preset-quick-row">
        {metas.map((meta) => (
          <button
            key={meta.id}
            type="button"
            className="mm-chip"
            onClick={() => onApply(meta.id)}
            onMouseEnter={() => onHover(meta.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(meta.id)}
            onBlur={() => onHover(null)}
          >
            {meta.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export default PresetGallery
