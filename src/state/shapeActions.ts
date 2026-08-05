/**
 * 도형 패널이 문서를 바꾸는 유일한 통로.
 *
 * UI 컴포넌트가 스토어 액션을 직접 조립하지 않는다. 갤러리와 시작 화면과 단축키가
 * 같은 함수를 부르게 해야 "어디서 넣었느냐에 따라 결과가 다른" 일이 안 생긴다.
 * presetActions.ts 와 같은 역할이고 같은 규칙을 따른다.
 */

import { SHAPE_KIND_LABELS, createShapeSpec } from '@/core/shape.ts'
import type { Layer, MotionProject, ShapeKind } from '@/core/types.ts'
import { buildShapeScene, createSceneContext, SHAPE_SCENE_BY_ID } from '@/shapes/registry.ts'
import { useDocumentStore } from './document.ts'
import { useLayerUiStore } from './layerUi.ts'
import { useShapeUiStore } from './shapeUi.ts'
import { useUiStore } from './ui.ts'

/** 슬라이더 드래그 중 다시 만드는 간격. 실행취소 병합 창(500ms)보다 짧아야 한다. */
const LIVE_MS = 140

/**
 * 문서가 통째로 갈리면 세션 기억을 버린다.
 *
 * mutateDoc 은 반드시 past 에 한 칸을 쌓으므로, 문서가 바뀌었는데 past 와 future 가
 * 둘 다 비어 있는 경우는 replaceDocument 하나뿐이다. 파일 열기와 자동복구가 그
 * 경로를 탄다. 문서 스토어가 도형 패널을 알 필요는 없으므로 구독으로 붙인다.
 */
let watchedDoc: MotionProject | null = null
useDocumentStore.subscribe((state) => {
  if (watchedDoc !== null && state.doc !== watchedDoc && state.past.length === 0 && state.future.length === 0) {
    useShapeUiStore.getState().resetSession()
  }
  watchedDoc = state.doc
})

/**
 * 레이어 한 장의 지문. 세트가 만든 그대로인지 판정한다.
 *
 * **키의 개수가 아니라 값까지 본다.** 개수만 보던 때 큰 구멍이 있었다. 도형을
 * 캔버스에서 끌어 옮기는 길(document.ts writeTranslatePx)은 키가 하나뿐인 정적
 * 트랙의 값만 고치고 개수를 안 바꾼다. 세트의 위치 트랙은 전부 shared.ts fixed()
 * 가 만든 단일 키라 항상 그 길이다. 그래서 도형을 옮겨 놓고 세기 슬라이더를 한 칸
 * 움직이면 세트가 통째로 다시 만들어지며 옮긴 자리가 말없이 사라졌다.
 *
 * 표시/잠금/혼합/기준점/모디파이어도 같은 이유로 담는다. 전부 레이어를 갈아끼우면
 * 사라지는데 지문에는 안 잡히던 값들이다.
 *
 * 비용은 슬라이더 드래그마다 든다. 세트 하나가 최대 스무 장 × 트랙 서너 개 ×
 * 키 스무 개 수준이라 문자열 몇 KB 다. 140ms 간격에서 무시할 만하다.
 */
function fingerprintOf(layer: Layer): string {
  const shape = layer.shape
  const tracks = layer.tracks
    .map((t) => `${t.prop}:${t.unit}:${t.keys.map((k) => `${k.f}=${k.v}`).join('/')}`)
    .join(',')
  // 가리기와 원근을 통째로 담는다. 일부만 담으면 경계 흐림 하나 바꾼 세트를
  // 슬라이더가 못 알아보고 그대로 갈아끼운다.
  const reveal = layer.reveal ? JSON.stringify(layer.reveal) : '-'
  const persp = layer.perspective ?? '-'
  const flags = `${layer.visible ? 'v' : '-'}${layer.locked ? 'l' : '-'}${layer.blend}`
  const anchor = layer.anchor.join(',')
  return [
    layer.name,
    shape ? JSON.stringify(shape) : '-',
    tracks,
    layer.effects.length,
    reveal,
    persp,
    flags,
    anchor,
    layer.modifiers.length,
  ].join('|')
}

function signatureOf(doc: MotionProject, layerIds: readonly string[]): string {
  return layerIds
    .map((id) => {
      const layer = doc.layers.find((l) => l.id === id)
      return layer ? fingerprintOf(layer) : '?'
    })
    .join('\n')
}

/**
 * 이 세트가 방금 만든 그대로 남아 있는 레이어들. 아니면 빈 배열이다.
 *
 * 세 가지를 모두 만족해야 갈아끼운다.
 *   1. 전부 살아 있다. 몇 장을 지웠다면 그것도 사용자의 편집이다.
 *   2. 지문이 같다. 색이나 크기를 손봤으면 다시 만들지 않는다.
 *   3. 문서에서 **연달아** 놓여 있다. 순서를 바꿔 끼웠다면 다시 쌓지 않는다.
 */
function replaceableLayers(doc: MotionProject, sceneId: string): string[] {
  const applied = useShapeUiStore.getState().applied
  if (!applied || applied.sceneId !== sceneId) return []

  const indices: number[] = []
  for (const id of applied.layerIds) {
    const index = doc.layers.findIndex((l) => l.id === id)
    if (index < 0) return []
    indices.push(index)
  }
  for (let i = 1; i < indices.length; i += 1) {
    if ((indices[i] ?? 0) !== (indices[i - 1] ?? 0) + 1) return []
  }
  if (signatureOf(doc, applied.layerIds) !== applied.signature) return []
  return [...applied.layerIds]
}

export interface ShapeApplyReport {
  ok: boolean
  message?: string
  /** 켠 것이 아니라 끈 것이다. 화면이 재생을 시작하면 안 된다. */
  removed?: boolean
}

/**
 * 도형 한 개를 넣는다.
 *
 * 크기는 캔버스 짧은 변의 1/3 이다. 화면에 확실히 보이면서 어느 방향으로 움직여도
 * 여유가 남는 크기다. 넣자마자 아무 모션이나 골라 얹을 수 있다.
 */
export function addSingleShape(kind: ShapeKind): string | null {
  const store = useDocumentStore.getState()
  const doc = store.doc
  const base = Math.min(doc.canvas.w, doc.canvas.h)
  const size = Math.max(8, Math.round(base / 3))

  const { layerId } = store.addShape({
    name: SHAPE_KIND_LABELS[kind],
    shape: createShapeSpec(kind, {
      color: useShapeUiStore.getState().color,
      width: size,
      height: size,
      cornerRadius: kind === 'rect' ? Math.round(size * 0.12) : 0,
    }),
  })

  if (layerId) useLayerUiStore.getState().setSelectedLayerIds([layerId], layerId)
  return layerId || null
}

/**
 * 도형 모션 세트를 넣는다.
 *
 * 같은 세트를 다시 부르면 **직전에 넣은 레이어를 갈아끼운다.** 세기를 조금 올리려고
 * 슬라이더를 끌 때마다 파동이 한 벌씩 더 쌓이면 못 쓴다. 다른 세트를 고르면 앞의
 * 것은 그대로 두고 위에 얹는다. 여러 세트를 겹쳐 쓰는 것이 정상적인 사용이다.
 */
export function applyShapeScene(sceneId: string, live = false): ShapeApplyReport {
  const scene = SHAPE_SCENE_BY_ID.get(sceneId)
  if (!scene) return { ok: false, message: '알 수 없는 도형 세트입니다.' }

  const docStore = useDocumentStore.getState()
  const doc = docStore.doc
  const ui = useShapeUiStore.getState()

  const previous = replaceableLayers(doc, sceneId)

  /*
   * 켠 카드를 다시 누르면 끈다.
   *
   * 세트를 하나 얹어 보고 마음에 안 들면 되돌리는 것이 가장 잦은 조작인데, 그 길이
   * Ctrl+Z 뿐이면 그 사이에 한 다른 작업까지 함께 되감긴다. 카드가 곧 스위치여야 한다.
   *
   * 손댄 세트는 끄지 않는다(previous 가 빈 배열이다). 색을 바꿨거나 몇 장을 지운
   * 것도 사용자의 편집이고, 그것까지 지우면 편집을 말없이 버리는 것이 된다. 그때는
   * 아래로 흘러가 새 세트를 한 벌 더 만든다. 슬라이더 드래그(live)는 끄는 조작이 아니다.
   */
  if (!live && previous.length > 0 && ui.applied?.sceneId === sceneId) {
    docStore.removeLayers(previous)
    useShapeUiStore.getState().setApplied(null)
    useLayerUiStore.getState().setSelectedLayerIds([])
    // '세트' 를 붙여 두면 조사가 언제나 '를' 이다. 이름 끝 받침을 따질 필요가 없다.
    return { ok: true, removed: true, message: `${scene.label} 세트를 뺐습니다.` }
  }
  // 손댄 세트를 슬라이더 한 번에 되돌려 놓지 않는다. 카드도 '적용됨' 표시를 내린다.
  if (live && previous.length === 0) {
    useShapeUiStore.getState().setApplied(null)
    return { ok: false, message: '손댄 세트는 다시 만들지 않습니다. 카드를 다시 누르면 새로 만듭니다.' }
  }

  /*
   * 이미 만들어 둔 타임라인이 있으면 그 길이에 맞춘다.
   *
   * 갈아끼울 레이어를 뺀 나머지가 남아 있다는 것은 사용자가 만든 다른 내용이
   * 있다는 뜻이다. 배경 장식 하나를 얹었다고 5초짜리 모션이 1.2초로 잘리면 안 된다.
   *
   * 갈아끼우는 중이면 **처음 넣을 때 잰 길이**를 쓴다. 지금 문서 길이를 다시 읽으면,
   * 아주 느린 속도에서 세트가 늘려 놓은 길이가 다음 기준선이 되어 속도를 왕복할
   * 때마다 문서가 계속 길어진다 (shapeUi.ts AppliedScene.fitFrames).
   */
  const others = doc.layers.filter((l) => !previous.includes(l.id))
  const reused = previous.length > 0 ? ui.applied : null
  const fitFrames = reused
    ? (reused.fitFrames ?? undefined)
    : others.length > 0
      ? doc.timeline.durationFrames
      : undefined

  /*
   * 그 사이 사용자가 fps 를 직접 골랐으면 천장을 그 값으로 내린다.
   *
   * 천장(ceilFps)은 느린 속도에서 fps 를 얼마나 내릴 수 있는지의 기준이고, 한 번
   * 올라가면 안 내려간다. 그래서 세트를 넣은 뒤 fps 를 25 에서 10 으로 내려 두면,
   * 세기 슬라이더를 한 칸 움직이는 것만으로 옛 천장 25 가 다시 쓰여 fps 가
   * 되돌아갔다. 세기는 시간에 작용하지 않는다는 계약이 거기서 깨진다.
   *
   * 문서 스토어가 도형 패널을 알면 안 되므로(이 파일 상단 주석) 여기서 판정한다.
   * 우리가 써 넣은 fps 와 지금 문서 fps 가 다르면 그것은 사용자가 고른 값이다.
   */
  if (reused && reused.fps !== doc.timeline.fps) {
    useShapeUiStore.getState().setCeilFps(doc.timeline.fps)
  }

  const emission = buildShapeScene(
    sceneId,
    createSceneContext({
      canvasW: doc.canvas.w,
      canvasH: doc.canvas.h,
      fps: fitFrames === undefined ? ui.raiseCeilFps(doc.timeline.fps) : doc.timeline.fps,
      strength: ui.strength,
      speed: ui.speed,
      color: ui.color,
      ...(fitFrames === undefined ? {} : { fitFrames }),
    }),
  )
  if (!emission) return { ok: false, message: '도형 세트를 만들지 못했습니다.' }

  const { layerIds } = docStore.addShapeScene({
    label: `${scene.label} 넣기`,
    layers: emission.layers,
    durationFrames: emission.durationFrames,
    // 반복 방식은 공통 노브다. 문서에 아무것도 없을 때(첫 삽입)만 제안을 따른다.
    // others 로 판정하면 안 된다. 갈아끼우기(previous)를 뺀 나머지라 재적용 경로에서도
    // 항상 비어, 슬라이더를 끄는 140ms 마다 사용자가 고른 반복 방식이 되돌아간다.
    ...(doc.layers.length === 0 ? { loopMode: emission.loopMode } : {}),
    fps: emission.fps,
    replace: previous,
    coalesceKey: `shapeScene:${sceneId}`,
    /*
     * 두 장 이상이면 폴더로 묶는다.
     *
     * 세트 하나가 도형을 스무 장까지 만든다. 목록에 스무 줄이 쏟아지면 그다음
     * 작업이 스크롤 싸움이 되고, 무엇보다 **세트 전체를 한 번에 움직일 방법이
     * 없어진다.** 폴더 한 줄에 모션을 걸면 세트가 통째로 움직인다.
     *
     * 한 장짜리 세트는 묶지 않는다. 레이어 하나를 감싼 폴더는 껍데기만 늘린다.
     */
    ...(emission.layers.length > 1 ? { folderName: scene.label } : {}),
  })

  const nextDoc = useDocumentStore.getState().doc
  useShapeUiStore.getState().setApplied({
    sceneId,
    layerIds,
    fitFrames: fitFrames ?? null,
    fps: nextDoc.timeline.fps,
    signature: signatureOf(nextDoc, layerIds),
  })

  /*
   * 폴더는 접은 채로 내놓는다.
   *
   * 묶는 것만으로는 목록이 정리되지 않는다. 세트 하나가 도형을 스무 장까지 만들고,
   * 펼쳐져 있으면 폴더 한 줄에 스무 줄이 더 붙어 오히려 한 줄 늘어난 셈이다.
   * 접어 두면 목록에 한 줄이고, 삼각형을 눌러 언제든 안을 볼 수 있다.
   */
  const madeFolder = nextDoc.layers.find((l) => l.id === layerIds[0] && l.type === 'group')
  const layerUi = useLayerUiStore.getState()

  if (live) {
    /*
     * 슬라이더 재적용은 선택과 폴더 접힘을 **새 id 로 옮긴다.**
     *
     * 예전에는 라이브 경로에서 아무것도 안 건드렸다. 목적은 "인스펙터가 매번 다른
     * 레이어로 튀지 않게" 였는데 결과는 반대였다. 재적용은 옛 레이어를 지우고 새
     * id 로 다시 만들므로 기존 선택이 유지되는 것이 아니라 댕글링이 되고,
     * LayerPanel 의 정리(pruneLayerSelection)가 그것을 빈 배열로 걷어낸다. 인스펙터가
     * '선택 없음' 으로 비고, 그 상태로는 모션 갤러리에서 고를 대상도 없다.
     *
     * 옛 목록과 새 목록은 자리끼리 짝이 맞는다. 같은 세트를 같은 개수로 다시
     * 만들었기 때문이다. 개수가 다르면(그럴 이유는 없지만) 손대지 않는다.
     */
    if (previous.length === layerIds.length && layerIds.length > 0) {
      const remap = new Map(previous.map((old, i) => [old, layerIds[i] as string]))

      const nextSelected = layerUi.selectedLayerIds.map((id) => remap.get(id) ?? id)
      if (nextSelected.some((id, i) => id !== layerUi.selectedLayerIds[i])) {
        // 미러 대상(인스펙터가 보는 한 장)도 함께 옮긴다. state/ui.ts selectedLayerId.
        const primary = useUiStore.getState().selectedLayerId
        layerUi.setSelectedLayerIds(nextSelected, (primary && remap.get(primary)) ?? primary ?? null)
      }

      // 펼쳐 둔 폴더를 다시 접지 않는다. 접힘은 사용자가 정한 것이다.
      const oldFolderId = previous[0]
      if (madeFolder && oldFolderId !== undefined) {
        layerUi.setFolderCollapsed(madeFolder.id, layerUi.collapsedFolderIds.includes(oldFolderId))
      }
    }
    return { ok: true }
  }

  if (madeFolder) layerUi.setFolderCollapsed(madeFolder.id, true)
  if (layerIds.length > 0) {
    /*
     * 폴더로 묶었으면 **폴더 하나만** 고른다.
     *
     * 세트를 넣은 직후 사용자가 하고 싶은 일은 "이 세트를 움직이기" 다. 도형 스무
     * 장이 전부 선택돼 있으면 인스펙터가 다중 선택 상태가 되고, 모션 갤러리도
     * 어디에 걸릴지 알기 어렵다. 폴더 하나면 답이 분명하다.
     */
    const folderId = madeFolder?.id
    if (folderId) layerUi.setSelectedLayerIds([folderId], folderId)
    else layerUi.setSelectedLayerIds(layerIds, layerIds[layerIds.length - 1] ?? null)
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 슬라이더 실시간 반영
// ---------------------------------------------------------------------------

let liveTimer: ReturnType<typeof setTimeout> | null = null
let livePending = false

/**
 * 라이브 재적용이 할 말이 생겼을 때 부른다.
 *
 * 손댄 세트는 다시 만들지 않고 applied 를 놓는데(위 153행), 그러면 잡고 있던
 * 슬라이더가 드래그 도중에 잠긴다. 이유를 안 알려 주면 "슬라이더가 갑자기 안
 * 움직인다" 가 된다. 스로틀 때문에 반환값으로는 못 돌려주므로 콜백으로 뺀다.
 */
export type LiveNotice = (message: string) => void

function runLive(onNotice?: LiveNotice): void {
  const current = useShapeUiStore.getState().applied
  if (!current) return
  const report = applyShapeScene(current.sceneId, true)
  if (!report.ok && report.message && onNotice) onNotice(report.message)
}

/**
 * 방금 넣은 세트를 지금 노브 값으로 다시 만든다.
 *
 * 트레일링 스로틀이다. 드래그 한 번에 수십 번 다시 만들면 도형 스무 장짜리 세트에서
 * 프레임이 떨어진다. 간격(140ms)은 실행취소 병합 창(500ms)보다 짧아서 드래그 전체가
 * 실행취소 한 칸으로 남는다.
 */
export function reapplyShapeSceneSoon(onNotice?: LiveNotice): void {
  const applied = useShapeUiStore.getState().applied
  if (!applied) return
  livePending = true
  if (liveTimer !== null) return
  liveTimer = setTimeout(() => {
    liveTimer = null
    if (!livePending) return
    livePending = false
    runLive(onNotice)
  }, LIVE_MS)
}

/** 손을 뗐을 때 마지막 값으로 한 번 더 확정한다. */
export function commitShapeSceneNow(onNotice?: LiveNotice): void {
  if (liveTimer !== null) {
    clearTimeout(liveTimer)
    liveTimer = null
  }
  if (!livePending) return
  livePending = false
  runLive(onNotice)
}
