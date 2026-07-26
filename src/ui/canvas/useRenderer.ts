/**
 * 프리뷰 렌더 루프.
 *
 * 규칙 세 가지가 이 파일의 전부다.
 *
 * 1. 재생 헤드는 절대 시간 기준이다. 매 프레임 dt 를 더하면 부동소수 드리프트가 쌓인다.
 *    항상 playheadFrame(now, startMs, ...) 으로 다시 계산한다.
 * 2. 렌더 요청은 rAF 당 1회로 합친다.
 * 3. 프리뷰는 항상 내보내기 해상도(doc.canvas.w/h)로 렌더하고 표시만 CSS 로 줄인다.
 *    devicePixelRatio 를 엔진에 넘기는 순간 "프리뷰 = 결과물" 약속이 깨진다.
 *
 * StrictMode 는 이펙트를 두 번 실행한다. canvas element 를 JSX 가 아니라 이 훅이
 * 직접 만들고 정리에서 제거하기 때문에, 재마운트 때는 항상 새 element 에 새 컨텍스트가
 * 생긴다. 같은 element 에 getContext 를 두 번 부르면 같은 컨텍스트가 돌아오므로
 * 첫 정리에서 이미 해제된 컨텍스트를 두 번째 마운트가 쓰게 된다. 그 사고를 구조로 막는다.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { RenderTarget } from '@/core/types.ts'
import { Renderer, WebGL2UnsupportedError } from '@/core/renderer/index.ts'
import { GpuAssetCache } from '@/core/renderer/assetCache.ts'
import { createGlContext, type GlContext } from '@/core/renderer/gl.ts'
import { frameToSec, playheadFrame } from '@/core/time.ts'
import { assetRegistry } from '@/state/assets.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'
import { getPreviewDoc, subscribePreviewDoc } from '@/state/presetActions.ts'
import { setActiveRenderer } from './rendererHandle.ts'

/**
 * 재생 중 UI 스토어에 현재 프레임을 반영하는 최소 간격.
 * 매 프레임 setPlayheadFrame 을 부르면 스토어 구독자가 전부 리렌더되어
 * 캔버스 프레임 예산을 UI 가 잡아먹는다. 표시용 값이므로 이 정도면 충분하고,
 * 정지할 때 정확한 값으로 한 번 확정한다.
 */
const PUBLISH_INTERVAL_MS = 100

export interface UseRendererResult {
  /**
   * 캔버스를 담을 컨테이너에 붙이는 콜백 ref.
   * canvas element 자체는 훅이 만들어 이 안에 넣는다.
   */
  hostRef: (el: HTMLDivElement | null) => void
  /** rAF 1회 렌더 요청. 같은 프레임 안의 중복 호출은 합쳐진다. */
  requestRender: () => void
}

export function useRenderer(): UseRendererResult {
  const doc = useDocumentStore((s) => s.doc)
  const playing = useUiStore((s) => s.playing)
  // 픽셀은 문서 밖(assetRegistry)에 있다. 문서가 그대로여도 비트맵이 들어오면 다시 그려야 한다.
  const assetRevision = useSyncExternalStore(assetRegistry.subscribe, assetRegistry.getRevision)

  // 호스트를 state 로 들고 있어야 조건부 마운트(빈 상태 화면 등)에도 초기화가 다시 돈다.
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const hostRef = useCallback((el: HTMLDivElement | null) => {
    setHost(el)
  }, [])

  /**
   * 컨텍스트가 만들어지거나 버려질 때마다 증가한다.
   * 재생 루프 이펙트가 이 값을 의존성으로 잡아야 컨텍스트 재생성 뒤에 tick 이 다시 걸린다.
   * 이 값이 없으면 마지막 레이어를 지웠다가 다시 이미지를 넣었을 때
   * playing 은 true 인데 rAF 는 죽어 있는 상태로 영구히 멈춘다.
   */
  const [glEpoch, setGlEpoch] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const cacheRef = useRef<GpuAssetCache | null>(null)
  const targetRef = useRef<RenderTarget | null>(null)

  // rAF 콜백은 렌더 시점의 클로저가 아니라 항상 최신 문서를 봐야 한다.
  //
  // 프리셋 갤러리에서 카드를 호버하면 문서를 건드리지 않고 미리보기 문서만 얹는다.
  // 탐색이 파괴적이면 안 된다는 요구를 이 한 줄이 만든다.
  const docRef = useRef(doc)
  docRef.current = getPreviewDoc() ?? doc

  const playingRef = useRef(playing)
  /** 현재 표시 중인 프레임. 재생 중에는 루프가, 정지 중에는 스크럽이 쓴다. */
  const frameRef = useRef(0)
  /** 프레임 번호가 같아도 다시 그려야 하는 상태(문서/에셋 변경) */
  const dirtyRef = useRef(true)
  const pendingRafRef = useRef(0)
  const loopRafRef = useRef(0)
  const startMsRef = useRef(0)
  const publishedAtRef = useRef(0)

  const renderAt = useCallback((frame: number) => {
    const renderer = rendererRef.current
    const cache = cacheRef.current
    const canvas = canvasRef.current
    const target = targetRef.current
    if (!renderer || !cache || !canvas || !target) return

    const d = docRef.current
    const { w, h } = d.canvas

    // 표시 크기와 무관하게 드로잉 버퍼는 내보내기 해상도로 고정한다.
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    target.width = w
    target.height = h

    // sync 는 캐시 히트를 이미 처리한다. 매 프레임 불러도 싸다.
    const assets = cache.sync(d.assets, (id) => assetRegistry.get(id))

    // renderFrame 내부는 floor(t * fps) 로 정수 프레임을 되찾는다.
    // frame/fps 를 그대로 넘기면 부동소수 오차로 frame-1 이 될 수 있으므로
    // 프레임 한가운데 시각을 넘긴다. 어떤 fps 에서도 floor 가 정확히 frame 이 된다.
    renderer.renderFrame(d, frameToSec(frame + 0.5, d.timeline.fps), target, assets)
  }, [])

  const requestRender = useCallback(() => {
    // 재생 중에는 루프가 이미 rAF 마다 돌고 있다. 요청을 따로 잡을 필요가 없다.
    if (playingRef.current) return
    if (pendingRafRef.current !== 0) return
    pendingRafRef.current = requestAnimationFrame(() => {
      pendingRafRef.current = 0
      dirtyRef.current = false
      renderAt(frameRef.current)
    })
  }, [renderAt])

  // ---------------------------------------------------------------------
  // 컨텍스트 수명주기
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!host) return

    const canvas = document.createElement('canvas')
    canvas.className = 'preview-gl'
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    const initial = docRef.current
    canvas.width = initial.canvas.w
    canvas.height = initial.canvas.h
    host.appendChild(canvas)

    let ctx: GlContext | null = null
    let failure: string | null = null
    try {
      ctx = createGlContext(canvas)
    } catch (err) {
      failure =
        err instanceof WebGL2UnsupportedError ? err.message : '그래픽 초기화에 실패했습니다.'
    }

    if (!ctx) {
      canvas.remove()
      useUiStore.getState().setRendererError(failure ?? '그래픽 초기화에 실패했습니다.')
      setGlEpoch((n) => n + 1)
      return
    }

    const { gl, caps } = ctx
    useUiStore.getState().setRendererError(null)

    canvasRef.current = canvas
    rendererRef.current = new Renderer(gl, caps)
    cacheRef.current = new GpuAssetCache(gl)
    targetRef.current = { gl, width: initial.canvas.w, height: initial.canvas.h, fbo: null }

    // 내보내기가 프리뷰와 같은 컨텍스트/에셋을 쓰게 한다.
    // 컨텍스트를 따로 만들면 "프리뷰 = 결과물" 약속이 깨진다.
    const renderer = rendererRef.current
    setActiveRenderer({
      renderer,
      getAssets: () =>
        cacheRef.current?.sync(docRef.current.assets, (id) => assetRegistry.get(id)) ?? new Map(),
    })

    dirtyRef.current = true
    setGlEpoch((n) => n + 1)
    requestRender()

    return () => {
      // dispose 보다 먼저 등록을 걷어야 내보내기가 죽은 컨텍스트를 잡지 않는다.
      setActiveRenderer(null)
      if (pendingRafRef.current !== 0) {
        cancelAnimationFrame(pendingRafRef.current)
        pendingRafRef.current = 0
      }
      // loopRafRef 는 재생 루프 이펙트의 소유다. 여기서 취소하면 그 이펙트가
      // 다시 걸어 줄 방법이 없어 재생이 영구히 멈춘다. 정리는 소유자에게 맡긴다.
      rendererRef.current?.dispose()
      cacheRef.current?.dispose()
      rendererRef.current = null
      cacheRef.current = null
      targetRef.current = null
      canvasRef.current = null
      // 브라우저가 컨텍스트를 늦게 회수하면 StrictMode 재마운트에서 상한에 걸린다.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
      setGlEpoch((n) => n + 1)
    }
  }, [host, requestRender])

  // ---------------------------------------------------------------------
  // 재생 루프
  // ---------------------------------------------------------------------
  useEffect(() => {
    playingRef.current = playing

    if (!playing) {
      if (loopRafRef.current !== 0) {
        cancelAnimationFrame(loopRafRef.current)
        loopRafRef.current = 0
      }
      // 재생 중 UI 반영은 throttle 되어 뒤처져 있다. 정지 시점에 정확히 맞춘다.
      useUiStore.getState().setPlayheadFrame(frameRef.current)
      dirtyRef.current = true
      requestRender()
      return
    }

    // 컨텍스트가 없으면 돌릴 이유가 없다. glEpoch 가 바뀌면 이 이펙트가 다시 실행된다.
    if (!rendererRef.current) return

    // 기준점만 여기서 잡고, 이후 프레임은 전부 절대 시간으로 다시 계산한다.
    const d = docRef.current
    startMsRef.current = performance.now() - (frameRef.current / d.timeline.fps) * 1000
    publishedAtRef.current = 0

    const tick = (now: number): void => {
      loopRafRef.current = requestAnimationFrame(tick)

      const cur = docRef.current
      const frame = playheadFrame(
        now,
        startMsRef.current,
        cur.timeline.fps,
        cur.timeline.durationFrames,
        cur.timeline.loop.mode,
      )

      // 화면 주사율이 fps 보다 높을 때 같은 프레임을 다시 그리지 않는다.
      if (frame === frameRef.current && !dirtyRef.current) return
      frameRef.current = frame
      dirtyRef.current = false
      renderAt(frame)

      if (now - publishedAtRef.current >= PUBLISH_INTERVAL_MS) {
        publishedAtRef.current = now
        useUiStore.getState().setPlayheadFrame(frame)
      }
    }

    loopRafRef.current = requestAnimationFrame(tick)

    return () => {
      if (loopRafRef.current !== 0) {
        cancelAnimationFrame(loopRafRef.current)
        loopRafRef.current = 0
      }
    }
  }, [playing, glEpoch, renderAt, requestRender])

  // 문서나 에셋이 바뀌면 정지 상태에서도 1회 다시 그린다.
  useEffect(() => {
    dirtyRef.current = true
    requestRender()
  }, [doc, assetRevision, requestRender])

  // 미리보기 문서가 얹히거나 걷힐 때도 다시 그린다.
  useEffect(
    () =>
      subscribePreviewDoc(() => {
        dirtyRef.current = true
        requestRender()
      }),
    [requestRender],
  )

  // 스크럽(정지 상태의 playheadFrame 변경)을 리렌더 없이 받는다.
  // 셀렉터로 구독하면 재생 중 throttle 반영마다 이 훅을 쓰는 컴포넌트가 리렌더된다.
  useEffect(() => {
    return useUiStore.subscribe((state, prev) => {
      if (state.playheadFrame === prev.playheadFrame) return
      if (playingRef.current) return
      frameRef.current = state.playheadFrame
      dirtyRef.current = true
      requestRender()
    })
  }, [requestRender])

  // 속도나 길이가 바뀌면 기준점을 현재 프레임 위치로 다시 잡는다.
  // 안 하면 절대 시간 계산이 그대로라 재생 위치가 튄다.
  const { fps, durationFrames } = doc.timeline
  useEffect(() => {
    if (!playingRef.current) return
    startMsRef.current = performance.now() - (frameRef.current / fps) * 1000
  }, [fps, durationFrames])

  return { hostRef, requestRender }
}
