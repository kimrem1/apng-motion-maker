/**
 * 내보내기 실행 훅.
 *
 * 렌더러 인스턴스는 여기서 만들지 않는다. WebGL2 컨텍스트가 두 개 생기면 에셋이
 * 두 배로 올라가고 브라우저 컨텍스트 상한에도 걸린다. 프리뷰가 등록해 둔 인스턴스를
 * rendererHandle 에서 읽기만 한다.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { MotionProject } from '@/core/types.ts'
import type { WebpWarning } from '@/export/webp/encoder.ts'
import {
  ExportAbortError,
  exportFrames,
  outputSize,
  runExport,
  type ExportProgress,
  type ExportSettings,
} from '@/export/pipeline.ts'
import { MOTION_PRESET_BY_ID } from '@/motions/registry.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'
import {
  getActiveRenderer,
  getRendererRevision,
  subscribeActiveRenderer,
} from '@/ui/canvas/rendererHandle.ts'
import { buildExportFileName } from './exportFileName.ts'

export interface ExportResult {
  blob: Blob
  byteLength: number
  mime: string
  extension: string
  /** 원본명_프리셋명_크기.확장자 */
  fileName: string
  /** 파일명에 들어간 모션 프리셋 이름. 없으면 빈 문자열. */
  presetName: string
  width: number
  height: number
  frameCount: number
  fps: number
  /** "무한 반복" 처럼 사람이 읽는 루프 설명 */
  loopLabel: string
  /** 재인코딩 버튼이 기준으로 삼을 설정 */
  settings: ExportSettings
  /**
   * 인코더가 조용히 바꾼 것들. 없으면 undefined.
   *
   * 무손실을 못 만들었거나 알파를 버린 경우가 여기 담긴다. 화면에 띄우지 않으면
   * 사용자는 결과를 다른 앱에서 열어 보기 전까지 원인을 알 방법이 없다.
   */
  warnings?: WebpWarning[]
  /**
   * 이 결과를 만든 문서 스냅샷.
   *
   * 참조 하나면 충분하다. immer 라 문서를 조금이라도 고치면 새 객체가 되므로
   * 지금 문서와 !== 비교만으로 "결과가 낡았다" 를 알 수 있다.
   */
  sourceDoc: MotionProject
}

export interface StartOptions {
  /**
   * 내보내기 직전에 타임라인을 이 값으로 바꾼다 (목표 용량 계획, fps 낮추기).
   *
   * 왜 여기서 바꾸는가. 문서를 먼저 고치고 따로 start 를 부르면 두 동작 사이에
   * 리렌더가 끼어들어 어떤 문서로 만든 결과인지가 흐려진다. 바꾸고 바로 읽는
   * 순서를 한곳에 묶어야 sourceDoc 이 결과와 정확히 일치한다.
   */
  applyTimeline?: { fps: number; durationFrames: number }
}

export interface UseExportResult {
  /** 프리뷰 컨텍스트가 살아 있는가. false 면 내보낼 수 없다. */
  ready: boolean
  busy: boolean
  progress: ExportProgress | null
  result: ExportResult | null
  error: string | null
  start(settings: ExportSettings, options?: StartOptions): Promise<void>
  cancel(): void
  reset(): void
}

function loopLabel(doc: MotionProject): string {
  const { mode, count } = doc.timeline.loop
  if (mode === 'once') return '한 번만 재생'
  // 프레임 배열이 이미 2N-2 로 왕복 한 번이라 count 가 곧 왕복 횟수다 (mapLoop 과 같은 규칙).
  if (mode === 'pingPong') return count <= 0 ? '왕복 무한 반복' : `왕복 ${count}번 반복`
  return count <= 0 ? '무한 반복' : `${count}번 반복`
}

function sourceName(doc: MotionProject): string {
  const first = doc.assets[0]
  return first ? first.name : 'motion'
}

/**
 * 파일명에 넣을 프리셋 이름.
 *
 * 내부 id 는 절대 쓰지 않는다. 사용자에게 보이는 한국어 label 만 쓴다.
 * 프리셋을 안 썼으면 빈 문자열이고, 그때는 조각 자체가 빠져 `cat_512.png` 가 된다.
 */
function presetNameOf(doc: MotionProject): string {
  const id = doc.presetRef?.id
  if (id === undefined) return ''
  return MOTION_PRESET_BY_ID.get(id)?.label ?? ''
}

export function useExport(): UseExportResult {
  // 값 자체는 쓰지 않는다. 컨텍스트가 생기거나 사라질 때 리렌더를 받기 위한 구독이다.
  useSyncExternalStore(subscribeActiveRenderer, getRendererRevision)
  const ready = getActiveRenderer() !== null

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  /** 언마운트 뒤에 도착한 결과로 setState 하지 않기 위한 표식 */
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // 다이얼로그가 닫혀도 렌더 루프가 계속 돌면 GL 컨텍스트를 붙잡는다.
      abortRef.current?.abort()
    }
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
    setProgress(null)
  }, [])

  const start = useCallback(async (settings: ExportSettings, options?: StartOptions) => {
    if (abortRef.current) return

    const handle = getActiveRenderer()
    if (!handle) {
      setError('미리보기가 아직 준비되지 않았습니다. 잠시 뒤에 다시 시도해 주세요.')
      return
    }

    /**
     * 타임라인 변경을 먼저 커밋하고 그 다음 줄에서 문서를 읽는다.
     * zustand 는 동기 커밋이라 이 순서가 곧 "바뀐 문서로 내보낸다" 를 보장한다.
     * 순서가 뒤집히면 fps 만 낮추고 결과는 옛 fps 로 나오는 조용한 버그가 된다.
     */
    const timeline = options?.applyTimeline
    if (timeline) {
      const store = useDocumentStore.getState()
      store.setFps(timeline.fps)
      store.setDurationFrames(timeline.durationFrames)
    }

    const doc = useDocumentStore.getState().doc
    if (doc.layers.length === 0) {
      setError('내보낼 것이 없습니다. 이미지나 도형을 먼저 넣어 주세요.')
      return
    }

    const controller = new AbortController()
    abortRef.current = controller

    /**
     * 내보내는 동안 프리뷰 재생을 멈춘다.
     * 같은 GL 컨텍스트를 rAF 루프와 나눠 쓰면 프레임마다 뷰포트와 프레임버퍼가
     * 서로 엎치락뒤치락하고 속도도 절반이 된다. 결과 픽셀은 같지만 기다릴 이유가 없다.
     */
    const wasPlaying = useUiStore.getState().playing
    if (wasPlaying) useUiStore.getState().setPlaying(false)

    setBusy(true)
    setError(null)
    setProgress({ phase: 'render', done: 0, total: 100, message: '준비 중' })

    // 진행률 콜백은 프레임마다 온다. 백분율이 실제로 바뀔 때만 리렌더한다.
    let lastPercent = -1

    try {
      const output = await runExport({
        doc,
        renderer: handle.renderer,
        assets: handle.getAssets(),
        settings,
        signal: controller.signal,
        onProgress: (p) => {
          if (!aliveRef.current) return
          const percent = Math.round(p.done)
          if (percent === lastPercent && p.phase !== 'done') return
          lastPercent = percent
          setProgress(p)
        },
      })

      if (!aliveRef.current) return

      // 파이프라인이 이미 Blob 으로 준다. 여기서 다시 바이트로 만들면 GB 단위
      // 결과에서 사본이 하나 더 생겨 탭이 죽는다.
      const blob = output.blob
      const presetName = presetNameOf(doc)
      const out = outputSize(settings)

      setResult({
        blob,
        byteLength: output.byteLength,
        mime: output.mime,
        extension: output.extension,
        fileName: buildExportFileName({
          sourceName: sourceName(doc),
          presetName: presetName.length > 0 ? presetName : undefined,
          // 파일명에 들어가는 것은 "결과물의 긴 변" 이다. 회전이 걸리면 렌더 크기가
          // 아니라 회전 후 크기여야 파일명과 실제 파일이 맞는다.
          width: Math.max(out.width, out.height),
          extension: output.extension,
        }),
        presetName,
        // 화면에 보이는 크기도 회전 후 크기다. 결과 패널이 이 값으로 크기를 적는다.
        width: out.width,
        height: out.height,
        frameCount: exportFrames(doc).length,
        fps: doc.timeline.fps,
        loopLabel: loopLabel(doc),
        settings,
        ...(output.warnings && output.warnings.length > 0 ? { warnings: output.warnings } : {}),
        sourceDoc: doc,
      })
      setProgress({ phase: 'done', done: 100, total: 100, message: '완성' })
    } catch (err) {
      if (!aliveRef.current) return
      if (err instanceof ExportAbortError || (err instanceof Error && err.name === 'AbortError')) {
        // 사용자가 직접 누른 취소다. 에러로 표시하지 않는다.
        setProgress(null)
      } else {
        setError(err instanceof Error ? err.message : '내보내기에 실패했습니다.')
        setProgress(null)
      }
    } finally {
      abortRef.current = null
      if (aliveRef.current) setBusy(false)
      if (wasPlaying) useUiStore.getState().setPlaying(true)
    }
  }, [])

  return { ready, busy, progress, result, error, start, cancel, reset }
}
