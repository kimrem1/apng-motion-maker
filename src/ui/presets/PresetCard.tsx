/**
 * 프리셋 카드 한 장.
 *
 * 카드가 하는 일은 세 가지다. 썸네일, 라벨과 배지, 즐겨찾기 별.
 *
 * ---------------------------------------------------------------------------
 * 썸네일 렌더 전략
 * ---------------------------------------------------------------------------
 * WebGL2 컨텍스트는 앱에 하나뿐이고 그 주인은 프리뷰 캔버스다(rendererHandle.ts).
 * 카드마다 컨텍스트를 만들면 텍스처가 중복으로 올라가고 브라우저 상한에도 걸린다.
 * 그렇다고 공유 렌더러로 카드 수십 장을 매 프레임 그리면 프리뷰가 그대로 끊긴다.
 *
 * 그래서 이렇게 나눴다.
 *   1. 호버/포커스 카드의 실제 애니메이션은 **메인 프리뷰 캔버스**가 맡는다
 *      (presetActions.previewPreset). 카드가 아니라 큰 화면에서 보는 편이 낫다.
 *   2. 카드는 공유 렌더러로 오프스크린 FBO 에 **미리 구워 둔 프레임**을 2D 캔버스로
 *      재생만 한다. 굽는 작업은 rAF 한 번에 한 프레임씩만 해서 프리뷰 프레임 예산을
 *      통째로 뺏지 않는다. 다 구운 뒤에는 GL 을 전혀 건드리지 않는다.
 *   3. 정지 카드는 첫 프레임 한 장만 굽는다. 비교 모드 카드만 스트립 전체를 굽는다.
 *      IntersectionObserver 로 화면 밖 카드는 굽기도 재생도 즉시 멈춘다.
 *
 * 내부 id 와 loopSafe 값은 어떤 형태로도 화면에 내보내지 않는다.
 */

import { useEffect, useId, useRef, useState } from 'react'

import type { MotionProject } from '@/core/types.ts'
import { frameToSec } from '@/core/time.ts'
import { readbackToStraight } from '@/export/pipeline.ts'
import type { MotionCategory, MotionPreset, SizeClass } from '@/motions/types.ts'
import { getActiveRenderer } from '@/ui/canvas/rendererHandle.ts'

// ---------------------------------------------------------------------------
// 프리셋 메타 어댑터
// ---------------------------------------------------------------------------

/*
 * MotionPreset 타입을 그대로 읽는다. 후보 키를 늘어놓고 추측해 읽지 않는다.
 *
 * 없는 키를 읽으면 예외가 아니라 조용한 기본값이다. 용량 배지에서 'cost' 를 찾는데
 * 실제 필드가 size 라면, 56종 전부에서 배지가 한 번도 뜨지 않아도 아무 일도
 * 일어나지 않는다. 타입을 그대로 읽으면 필드 이름이 바뀌는 순간 컴파일이 깨진다.
 */

export type PresetCost = SizeClass

export interface PresetMeta {
  id: string
  /** 사용자에게 보이는 한국어 이름 */
  label: string
  category: MotionCategory
  /** 툴팁 한 줄 */
  hint: string
  cost: PresetCost
  /** 원본 해상도가 부족하면 흐려진다는 경고 */
  needsLargeSource: boolean
  /** 점멸이 있다 */
  flashWarning: boolean
  /** 검색 대상 문자열 */
  keywords: string
}

/**
 * 카드가 쓰는 값만 뽑는다.
 *
 * flashWarning / largeSource 는 emit 의 안내(code:'flashWarning',
 * 'largeSourceRecommended')와 같은 값을 미리 선언해 둔 필드다. 갤러리는 56장을
 * 그리면서 emit 을 부르지 않는다. 둘이 어긋나지 않는다는 것은 테스트가 확인한다
 * (motions/types.ts 의 필드 주석).
 */
export function readPresetMeta(preset: MotionPreset): PresetMeta {
  return {
    id: preset.id,
    label: preset.label,
    category: preset.category,
    hint: preset.hint,
    cost: preset.size,
    needsLargeSource: preset.largeSource === true,
    flashWarning: preset.flashWarning === true,
    keywords: [preset.label, preset.hint, preset.category, ...preset.tags].join(' ').toLowerCase(),
  }
}

const COST_LABEL: Record<PresetCost, string> = {
  light: '가벼움',
  normal: '보통',
  heavy: '무거움',
}

// ---------------------------------------------------------------------------
// 썸네일 베이커 (모듈 하나에 공유 큐 하나)
// ---------------------------------------------------------------------------

/** 카드 썸네일 긴 변 상한. */
export const THUMB_MAX_PX = 128
/** 비교 모드 스트립 길이와 재생 속도. */
export const STRIP_MAX_FRAMES = 12
export const STRIP_FPS = 12

export interface ThumbRequest {
  /** 캐시 키. 문서와 프리셋이 같으면 같은 그림이 나와야 한다. */
  key: string
  /** 프리셋이 적용된 임시 문서. 굽기 직전에만 부른다. */
  build(): MotionProject | null
  frameCount: number
  onReady(strip: ImageData[]): void
}

interface Ticket {
  req: ThumbRequest
  cancelled: boolean
}

interface Job {
  key: string
  doc: MotionProject
  frames: number[]
  w: number
  h: number
  out: ImageData[]
  index: number
  tickets: Ticket[]
  /** 렌더러가 아직 없을 때의 재시도 횟수. 무한 rAF 루프를 막는다. */
  retries: number
}

/** 캐시 상한. 128x128 RGBA 12장이 약 786KB 라 넉넉히 잡아도 부담이 적다. */
const CACHE_LIMIT = 48

const stripCache = new Map<string, ImageData[]>()
let waiting: Ticket[] = []
let job: Job | null = null
let rafId = 0

function cachePut(key: string, strip: ImageData[]): void {
  stripCache.set(key, strip)
  if (stripCache.size <= CACHE_LIMIT) return
  const oldest = stripCache.keys().next()
  if (!oldest.done) stripCache.delete(oldest.value)
}

/** 문서가 바뀌면(이미지 교체, 캔버스 크기 변경) 구워 둔 그림이 전부 낡는다. */
export function clearThumbnailCache(): void {
  stripCache.clear()
}

/** 루프 전체를 균등 샘플한다. n=1 이면 첫 프레임 정지 썸네일이다. */
function pickFrames(doc: MotionProject, count: number): number[] {
  const total = Math.max(1, doc.timeline.durationFrames)
  const n = Math.max(1, Math.min(count, total))
  const frames: number[] = []
  for (let i = 0; i < n; i += 1) frames.push(Math.round((i * total) / n))
  return frames
}

/** 캔버스 비율을 지키며 128px 상자 안에 넣는다. */
function thumbSize(doc: MotionProject): { w: number; h: number } {
  const cw = Math.max(1, doc.canvas.w)
  const ch = Math.max(1, doc.canvas.h)
  const scale = Math.min(1, THUMB_MAX_PX / Math.max(cw, ch))
  return { w: Math.max(1, Math.round(cw * scale)), h: Math.max(1, Math.round(ch * scale)) }
}

function schedule(): void {
  if (rafId !== 0) return
  rafId = requestAnimationFrame(step)
}

function startNextJob(): void {
  while (waiting.length > 0) {
    const ticket = waiting.shift()!
    if (ticket.cancelled) continue

    const cached = stripCache.get(ticket.req.key)
    if (cached) {
      ticket.req.onReady(cached)
      continue
    }

    const doc = ticket.req.build()
    if (!doc) continue

    // 같은 키를 기다리는 다른 카드가 있으면 한 번만 굽고 나눠 준다.
    const sameKey = waiting.filter((t) => !t.cancelled && t.req.key === ticket.req.key)
    waiting = waiting.filter((t) => t.req.key !== ticket.req.key)

    const { w, h } = thumbSize(doc)
    job = {
      key: ticket.req.key,
      doc,
      frames: pickFrames(doc, ticket.req.frameCount),
      w,
      h,
      out: [],
      index: 0,
      tickets: [ticket, ...sameKey],
      retries: 0,
    }
    return
  }
}

/**
 * rAF 한 번에 한 프레임만 굽는다.
 *
 * 프리뷰 재생 루프도 rAF 위에서 돈다. 여기서 12프레임을 통짜로 그리면 그 프레임에
 * 프리뷰가 통째로 밀린다. readPixels 는 동기 스톨이라 특히 그렇다.
 */
function step(): void {
  rafId = 0

  if (!job) startNextJob()
  const current = job
  if (!current) return

  if (current.tickets.every((t) => t.cancelled)) {
    job = null
    if (waiting.length > 0) schedule()
    return
  }

  const handle = getActiveRenderer()
  if (!handle) {
    // 컨텍스트가 아직 없거나 재생성 중이다. 몇 초 기다렸다가 포기한다.
    current.retries += 1
    if (current.retries > 120) job = null
    schedule()
    return
  }

  const { renderer } = handle
  const gl = renderer.gl
  const frame = current.frames[current.index]!
  const pooled = renderer.targets.acquire(current.w, current.h, 'rgba8')

  try {
    renderer.renderFrame(
      current.doc,
      // 프레임 한가운데 시각을 넘긴다. frame/fps 를 그대로 주면 부동소수 오차로
      // floor 가 frame-1 이 될 수 있다 (useRenderer.ts 와 같은 이유).
      frameToSec(frame + 0.5, current.doc.timeline.fps),
      { gl, width: current.w, height: current.h, fbo: pooled.fbo },
      handle.getAssets(),
    )

    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    const raw = new Uint8Array(current.w * current.h * 4)
    gl.readPixels(0, 0, current.w, current.h, gl.RGBA, gl.UNSIGNED_BYTE, raw)

    // 엔진 내부는 premultiplied 이고 readPixels 원점은 좌하단이다. 둘 다 되돌린다.
    const straight = new Uint8Array(current.w * current.h * 4)
    readbackToStraight(raw, straight, current.w, current.h, null)
    current.out.push(new ImageData(new Uint8ClampedArray(straight), current.w, current.h))
  } catch {
    // 컨텍스트 손실 등. 이 카드만 조용히 포기한다. 갤러리를 죽이지 않는다.
    job = null
    schedule()
    return
  } finally {
    // 프리뷰가 다시 기본 프레임버퍼에 그리도록 되돌린다.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    renderer.targets.release(pooled)
  }

  current.index += 1
  if (current.index < current.frames.length) {
    schedule()
    return
  }

  cachePut(current.key, current.out)
  for (const ticket of current.tickets) {
    if (!ticket.cancelled) ticket.req.onReady(current.out)
  }
  job = null
  if (waiting.length > 0) schedule()
}

/** 썸네일을 요청한다. 반환값을 부르면 취소된다. */
export function requestThumbnail(req: ThumbRequest): () => void {
  const cached = stripCache.get(req.key)
  if (cached) {
    // 동기로 부르면 렌더 중 setState 가 된다.
    queueMicrotask(() => req.onReady(cached))
    return () => {}
  }

  const ticket: Ticket = { req, cancelled: false }
  waiting.push(ticket)
  schedule()
  return () => {
    ticket.cancelled = true
  }
}

// ---------------------------------------------------------------------------
// 카드
// ---------------------------------------------------------------------------

export interface PresetCardProps {
  meta: PresetMeta
  selected: boolean
  favorite: boolean
  comparing: boolean
  /** true 면 스트립을 굽고 재생한다. 비교 모드 카드만 해당된다. */
  animated: boolean
  /** 로빙 탭인덱스. 리스트박스 안에서 항상 한 장만 0 이다. */
  tabIndex: number
  /** 문서 상태 지문. 이미지나 캔버스가 바뀌면 값이 달라져 썸네일을 다시 굽는다. */
  docKey: string
  buildDoc(presetId: string): MotionProject | null
  onApply(id: string): void
  onHover(id: string | null): void
  onToggleFavorite(id: string): void
  onToggleCompare(id: string): void
  registerRef(id: string, el: HTMLLIElement | null): void
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function PresetCard(props: PresetCardProps) {
  const { meta, animated, docKey } = props
  const hostRef = useRef<HTMLLIElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [strip, setStrip] = useState<ImageData[] | null>(null)
  const [visible, setVisible] = useState(false)

  // 화면 밖 카드는 굽지도 재생하지도 않는다.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (entry) setVisible(entry.isIntersecting)
      },
      { rootMargin: '96px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const frameCount = animated ? STRIP_MAX_FRAMES : 1
  const cacheKey = `${meta.id}|${docKey}|${frameCount}`

  useEffect(() => {
    if (!visible) return
    let alive = true
    const cancel = requestThumbnail({
      key: cacheKey,
      frameCount,
      build: () => props.buildDoc(meta.id),
      onReady: (next) => {
        if (alive) setStrip(next)
      },
    })
    return () => {
      alive = false
      cancel()
    }
    // buildDoc 은 갤러리가 useCallback 으로 문서에 묶어 넘긴다. 문서가 바뀌면 docKey 도
    // 함께 바뀌고 docKey 는 cacheKey 안에 들어 있으므로 중복 굽기가 되지 않는다.
  }, [visible, cacheKey, frameCount, meta.id, props.buildDoc])

  // 재생. 정지 카드는 첫 장만 그린다.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !strip || strip.length === 0) return
    const first = strip[0]!
    if (canvas.width !== first.width) canvas.width = first.width
    if (canvas.height !== first.height) canvas.height = first.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    if (!animated || !visible || strip.length === 1) {
      ctx.putImageData(first, 0, 0)
      return
    }

    // 비교 모드는 12fps 로 재생한다. 카드 4장이 동시에 돌아도
    // 초당 48회 putImageData 라 예산 안에 들어온다.
    const holdMs = 1000 / STRIP_FPS
    let raf = 0
    let shown = -1
    const startedAt = performance.now()

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      const index = Math.floor(((now - startedAt) / holdMs) % strip.length)
      if (index === shown) return
      shown = index
      const image = strip[index]
      if (image) ctx.putImageData(image, 0, 0)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [strip, animated, visible])

  // 내부 id 는 DOM 에도 내보내지 않는다. 같은 카드가 비교 줄과 본 목록에
  // 두 번 그려져도 id 가 겹치지 않아야 한다.
  const hintId = useId()
  const describedBy = meta.hint ? hintId : undefined

  return (
    <li
      ref={(el) => {
        hostRef.current = el
        props.registerRef(meta.id, el)
      }}
      className={
        'mm-preset-card' +
        (props.selected ? ' is-selected' : '') +
        (props.comparing ? ' is-comparing' : '')
      }
      role="option"
      aria-selected={props.selected}
      aria-describedby={describedBy}
      tabIndex={props.tabIndex}
      onMouseEnter={() => props.onHover(meta.id)}
      onMouseLeave={() => props.onHover(null)}
      onFocus={() => props.onHover(meta.id)}
      onBlur={() => props.onHover(null)}
      onClick={() => props.onApply(meta.id)}
    >
      <div className="mm-preset-thumb mm-checker">
        <canvas ref={canvasRef} className="mm-preset-canvas" aria-hidden="true" />
        {!strip ? <span className="mm-preset-thumb-wait" aria-hidden="true" /> : null}
      </div>

      <div className="mm-preset-label">
        <span className="mm-preset-name">{meta.label}</span>
        {props.favorite ? (
          <span className="mm-preset-fav-mark" aria-hidden="true">
            <StarIcon filled />
          </span>
        ) : null}
      </div>

      <div className="mm-preset-badges">
        <span className={`mm-badge is-cost-${meta.cost}`}>용량 {COST_LABEL[meta.cost]}</span>
        {meta.needsLargeSource ? <span className="mm-badge is-warn">큰 원본 권장</span> : null}
        {meta.flashWarning ? <span className="mm-badge is-warn">점멸 주의</span> : null}
      </div>

      {/* 별과 비교는 리스트박스 안의 포커스 대상이 되면 안 된다(option 안에 포커스
          가능한 요소를 두면 화면 낭독기 순서가 깨진다). 키보드는 카드에서 F / C 로
          같은 동작을 한다. 갤러리 상단 안내와 aria-label 이 그 사실을 알린다. */}
      <div className="mm-preset-actions">
        <button
          type="button"
          className="mm-icon-btn mm-preset-star"
          tabIndex={-1}
          aria-hidden="true"
          title={props.favorite ? '즐겨찾기 해제 (F)' : '즐겨찾기 (F)'}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleFavorite(meta.id)
          }}
        >
          <StarIcon filled={props.favorite} />
        </button>
        <button
          type="button"
          className={props.comparing ? 'mm-btn mm-preset-compare is-on' : 'mm-btn mm-preset-compare'}
          tabIndex={-1}
          aria-hidden="true"
          title={props.comparing ? '비교에서 빼기 (C)' : '비교에 넣기 (C)'}
          onClick={(e) => {
            e.stopPropagation()
            props.onToggleCompare(meta.id)
          }}
        >
          비교
        </button>
      </div>

      {meta.hint ? (
        <span id={hintId} className="mm-visually-hidden">
          {meta.hint}
        </span>
      ) : null}
    </li>
  )
}
