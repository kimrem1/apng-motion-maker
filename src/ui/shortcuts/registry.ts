/**
 * 커맨드 레지스트리.
 *
 * 이 파일은 **DOM 을 만지지 않는다.** window / document / React 를 import 하지 않으므로
 * node 환경 테스트에서 그대로 불러올 수 있다. 실제 키 바인딩은 useShortcuts.ts 가,
 * 화면은 CommandPalette.tsx / ShortcutHelp.tsx 가 맡는다.
 *
 * 설계 원칙 세 가지.
 *
 *   1. **명령이 정본이다.** 단축키는 명령에 달린 속성일 뿐이다. 그래야 커맨드 팔레트와
 *      단축키 도움말이 같은 배열 하나에서 파생된다. 두 곳에 따로 적으면 반드시 어긋난다.
 *   2. **키 조합 중복은 테스트로 막는다.** 두 명령이 같은 조합을 잡으면 tinykeys 는
 *      먼저 등록된 쪽만 실행하고 끝낸다(break). 나머지 하나는 영원히 눌리지 않는다.
 *      bindingSignature() 가 그 판정 기준이고 tests/unit/shortcuts.test.ts 가 강제한다.
 *   3. **스토어에 있는 것은 스토어에서 직접 부른다.** 스토어에 없는 동작(파일 열기, 저장,
 *      내보내기 다이얼로그 열기, 레이어 복제)만 CommandHost 로 주입받는다. 주입되지 않으면
 *      when() 이 false 가 되어 팔레트에서 흐리게 보이고 이유가 뜬다. 조용히 죽지 않는다.
 *
 * 등록하지 않은 것 (중복 실행 방지):
 *   - Ctrl+V 붙여넣기: imageprep/useImageDrop.ts 가 window 의 paste 이벤트로 이미 받는다.
 *   - Ctrl+C / Ctrl+X: 브라우저 기본 동작에 양보한다.
 */

import type { LoopMode } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'
import { applyPresetToDocument } from '@/state/presetActions.ts'
import { useTimelineUiStore, type GraphTarget } from '@/state/timelineUi.ts'
import { useUiStore } from '@/state/ui.ts'
import { EASY_PRESETS, MOTION_PRESETS } from '@/motions/registry.ts'

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

export type CommandCategory =
  | '파일'
  | '편집'
  | '재생'
  | '타임라인'
  | '캔버스'
  | '프리셋'
  | '도움말'

/** 도움말 오버레이가 묶어 보여 주는 순서. */
export const COMMAND_CATEGORY_ORDER: readonly CommandCategory[] = [
  '파일',
  '편집',
  '재생',
  '타임라인',
  '캔버스',
  '프리셋',
  '도움말',
]

export interface Command {
  id: string
  /** 사용자에게 보이는 한국어 이름 */
  label: string
  category: CommandCategory
  /** tinykeys 표기. 여러 개 가능. 없으면 팔레트에서만 부를 수 있다. */
  keys?: string[]
  /** 한 줄 설명. 팔레트 2행에 뜬다. */
  hint?: string
  /** 검색 보조어. 영문 별칭을 여기 넣어야 'export' 로 내보내기가 잡힌다. */
  keywords?: string[]
  /**
   * 키를 누르고 있을 때 반복 실행할 것인가.
   * 프레임 이동만 true 다. 재생 토글이 반복되면 화면이 발작한다.
   */
  repeatable?: boolean
  /**
   * 팔레트/도움말이 떠 있는 동안에도 살아 있는가.
   * 팔레트 토글만 true 다. 나머지는 오버레이가 떠 있으면 잠긴다.
   */
  overlaySafe?: boolean
  /** 지금 쓸 수 있는가. 없으면 항상 쓸 수 있다. */
  when?(): boolean
  /** when() 이 false 인 이유. 팔레트가 흐린 항목 옆에 보여 준다. */
  reason?(): string | undefined
  run(): void
}

// ---------------------------------------------------------------------------
// 키 문자열 파싱 (충돌 검사와 화면 표기가 같은 함수를 쓴다)
// ---------------------------------------------------------------------------

/** tinykeys 와 같은 규칙으로 자른다. `[Shift]+?` 처럼 대괄호 뒤의 + 도 구분자다. */
const PRESS_SPLIT = /(?<=\w|\])\+/

const MOD_CANON: Readonly<Record<string, string>> = {
  $mod: 'Mod',
  mod: 'Mod',
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
}

export interface ParsedBinding {
  /** 반드시 눌려 있어야 하는 수식자. 정렬되어 있다. */
  required: string[]
  /** 눌려 있어도 되고 아니어도 되는 수식자(`[Shift]` 표기). 정렬되어 있다. */
  optional: string[]
  /** 마지막 키. 원문 그대로다. */
  key: string
}

const canonMod = (raw: string): string => MOD_CANON[raw.toLowerCase()] ?? raw

/**
 * 단일 프레스 바인딩을 뜯는다. 시퀀스(`g g` 같은 연타)는 쓰지 않으므로 지원하지 않는다.
 * 공백이 들어오면 첫 프레스만 본다.
 */
export function parseBinding(binding: string): ParsedBinding {
  const press = binding.trim().split(' ')[0] ?? ''
  const parts = press.split(PRESS_SPLIT)
  const key = parts.pop() ?? ''
  const required: string[] = []
  const optional: string[] = []
  for (const part of parts) {
    const opt = part.match(/^\[(.*)\]$/)
    if (opt) optional.push(canonMod(opt[1] ?? ''))
    else required.push(canonMod(part))
  }
  required.sort()
  optional.sort()
  return { required, optional, key }
}

/**
 * 충돌 판정용 지문.
 *
 * 선택 수식자(optional)는 일부러 뺀다. `[Shift]+?` 는 `?` 가 잡는 입력을 전부 포함하므로
 * 둘이 함께 등록되면 한쪽은 죽는다. 같은 지문이 나오게 해서 테스트가 잡도록 한다.
 * 반대로 `Shift+ArrowLeft` 와 `ArrowLeft` 는 tinykeys 가 정확히 구분하므로 서로 다르다
 * (필수/선택에 없는 수식자가 눌려 있으면 매치되지 않는다).
 */
export function bindingSignature(binding: string): string {
  const { required, key } = parseBinding(binding)
  return `${required.join('+')}|${key.toUpperCase()}`
}

/** $mod 계열(Ctrl/Cmd)이 필요한 조합인가. 입력 필드 게이팅이 이 값으로 갈린다. */
export function needsPlatformMod(binding: string): boolean {
  const { required } = parseBinding(binding)
  return required.includes('Mod') || required.includes('Control') || required.includes('Meta')
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as { userAgentData?: { platform?: string }; platform?: string }
  const platform = nav.userAgentData?.platform ?? nav.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  escape: 'Esc',
  delete: 'Del',
  backspace: 'Backspace',
  space: 'Space',
  ' ': 'Space',
  home: 'Home',
  end: 'End',
  enter: 'Enter',
}

/** 화면 표기용 조각. `['Ctrl','Shift','E']` 처럼 돌려준다. */
export function formatBinding(binding: string, mac: boolean = isMacPlatform()): string[] {
  // 선택 수식자(optional)는 표기하지 않는다. `[Shift]+?` 는 사용자에게 그냥 `?` 다.
  const { required, key } = parseBinding(binding)
  const modLabel = (mod: string): string => {
    if (mod === 'Mod') return mac ? '⌘' : 'Ctrl'
    if (mod === 'Meta') return mac ? '⌘' : 'Win'
    if (mod === 'Control') return 'Ctrl'
    if (mod === 'Shift') return mac ? '⇧' : 'Shift'
    if (mod === 'Alt') return mac ? '⌥' : 'Alt'
    return mod
  }
  const head = required.map(modLabel)
  const tail = KEY_LABELS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...head, tail]
}

// ---------------------------------------------------------------------------
// 호스트 주입 (스토어에 없는 동작)
// ---------------------------------------------------------------------------

/**
 * 스토어만으로는 못 하는 동작을 앱 셸이 꽂아 준다.
 *
 * 여기 없는 핸들러는 when() 이 false 가 되어 팔레트에서 흐리게 뜬다.
 * 단축키가 아무 반응도 안 하는 것보다 "왜 못 쓰는지" 가 보이는 편이 낫다.
 */
export interface CommandHost {
  /** 파일 선택 대화상자를 연다. */
  openFile?(): void
  /** .mmproj 저장. */
  saveProject?(): void
  /** 내보내기 다이얼로그를 연다. */
  openExport?(): void
  /** 마지막 설정 그대로 즉시 내보낸다. */
  exportWithLastSettings?(): void
  /** 레이어를 복제한다. document.ts 에 액션이 없어 주입받는다. */
  duplicateLayer?(layerId: string): void
  /** 토스트/배너. 실패를 조용히 삼키지 않기 위해 쓴다. */
  notify?(message: string, tone?: 'info' | 'error'): void
}

let host: CommandHost = {}

/**
 * 핸들러를 꽂는다. 돌려주는 함수를 부르면 **자기가 꽂은 것만** 뺀다.
 * 언마운트된 컴포넌트의 낡은 클로저가 호스트에 남아 있으면 Ctrl+E 가 사라진 모달을 연다.
 */
export function setCommandHost(patch: CommandHost): () => void {
  const keys = Object.keys(patch) as (keyof CommandHost)[]
  const next: CommandHost = { ...host }
  for (const key of keys) {
    const value = patch[key]
    if (value === undefined) delete next[key]
    else Object.assign(next, { [key]: value })
  }
  host = next
  return () => {
    const cleaned: CommandHost = { ...host }
    let changed = false
    for (const key of keys) {
      // 그 사이 다른 쪽이 덮어썼으면 건드리지 않는다.
      if (cleaned[key] === patch[key]) {
        delete cleaned[key]
        changed = true
      }
    }
    if (changed) host = cleaned
  }
}

export function getCommandHost(): Readonly<CommandHost> {
  return host
}

/** 테스트 전용. */
export function resetCommandHost(): void {
  host = {}
}

function notify(message: string, tone: 'info' | 'error' = 'info'): void {
  host.notify?.(message, tone)
}

// ---------------------------------------------------------------------------
// 오버레이 상태 (커맨드 팔레트 / 단축키 도움말)
// ---------------------------------------------------------------------------

export type OverlayKind = 'palette' | 'help'

let overlay: OverlayKind | null = null
const overlayListeners = new Set<() => void>()

function emitOverlay(): void {
  for (const listener of overlayListeners) listener()
}

export function getOverlay(): OverlayKind | null {
  return overlay
}

export function subscribeOverlay(listener: () => void): () => void {
  overlayListeners.add(listener)
  return () => {
    overlayListeners.delete(listener)
  }
}

export function openOverlay(kind: OverlayKind): void {
  if (overlay === kind) return
  overlay = kind
  emitOverlay()
}

/** kind 를 주면 그것이 열려 있을 때만 닫는다. 생략하면 무조건 닫는다. */
export function closeOverlay(kind?: OverlayKind): void {
  if (overlay === null) return
  if (kind !== undefined && overlay !== kind) return
  overlay = null
  emitOverlay()
}

export function toggleOverlay(kind: OverlayKind): void {
  if (overlay === kind) closeOverlay(kind)
  else openOverlay(kind)
}

// ---------------------------------------------------------------------------
// 스토어 단축 접근
// ---------------------------------------------------------------------------

const docStore = () => useDocumentStore.getState()
const uiStore = () => useUiStore.getState()
const timelineStore = () => useTimelineUiStore.getState()
const layerStore = () => useLayerUiStore.getState()

const NO_LAYER = '먼저 이미지를 넣어 주세요'
const NOT_WIRED = '아직 연결되지 않았습니다'
const NO_TRACK = '타임라인에서 속성을 먼저 고르세요'

function hasLayer(): boolean {
  return docStore().doc.layers.length > 0
}

/** 지금 조작 대상 레이어. 다중 선택의 마지막 것 -> UI 미러 -> 맨 아래 레이어 순. */
function currentLayerId(): string | null {
  const selected = layerStore().selectedLayerIds
  const last = selected[selected.length - 1]
  if (last) return last
  const mirrored = uiStore().selectedLayerId
  if (mirrored) return mirrored
  return docStore().doc.layers[0]?.id ?? null
}

/** 키프레임을 찍을 대상. 그래프 대상 -> 선택된 키의 속성 순. */
function keyframeTarget(): GraphTarget | null {
  const timeline = timelineStore()
  if (timeline.graphTarget) return timeline.graphTarget
  const first = timeline.selectedKeys[0]
  if (first) return { layerId: first.layerId, prop: first.prop }
  return null
}

function maxFrame(): number {
  return Math.max(0, docStore().doc.timeline.durationFrames - 1)
}

/** 프레임 이동은 재생을 멈춘다. 안 멈추면 rAF 가 다음 프레임에 값을 덮어쓴다. */
function goToFrame(frame: number): void {
  const ui = uiStore()
  if (ui.playing) ui.setPlaying(false)
  const clamped = Math.min(maxFrame(), Math.max(0, Math.round(frame)))
  uiStore().setPlayheadFrame(clamped)
}

function stepFrame(delta: number): void {
  goToFrame(uiStore().playheadFrame + delta)
}

const LOOP_CYCLE: readonly LoopMode[] = ['loop', 'pingPong', 'once', 'loopWithHold']

function cycleLoopMode(): void {
  const store = docStore()
  const current = store.doc.timeline.loop.mode
  const index = LOOP_CYCLE.indexOf(current)
  const next = LOOP_CYCLE[(index + 1) % LOOP_CYCLE.length] ?? 'loop'
  store.setLoopMode(next)
}

function selectAllLayers(): void {
  const ids = docStore().doc.layers.map((l) => l.id)
  if (ids.length === 0) return
  layerStore().setSelectedLayerIds(ids, ids[ids.length - 1] ?? null)
}

function hasAnySelection(): boolean {
  return timelineStore().selectedKeys.length > 0 || layerStore().selectedLayerIds.length > 0
}

function clearAllSelection(): void {
  const timeline = timelineStore()
  // 키프레임 선택이 있으면 그것부터 푼다. Esc 한 번에 전부 날리면
  // 레이어 선택까지 잃어 다음 조작이 대상을 못 찾는다.
  if (timeline.selectedKeys.length > 0) {
    timeline.clearSelection()
    return
  }
  layerStore().clearLayerSelection()
}

function deleteSelection(): void {
  const timeline = timelineStore()
  if (timeline.selectedKeys.length > 0) {
    const store = docStore()
    // 배열 복사 후 지운다. 액션이 스토어를 바꾸는 동안 원본을 순회하면 안 된다.
    for (const key of [...timeline.selectedKeys]) {
      store.removeKeyframe(key.layerId, key.prop, key.frame)
    }
    timelineStore().clearSelection()
    return
  }

  const ids = [...layerStore().selectedLayerIds]
  if (ids.length === 0) return
  const store = docStore()
  for (const id of ids) store.removeLayer(id)
  layerStore().clearLayerSelection()
}

function applyPreset(presetId: string): void {
  const report = applyPresetToDocument(presetId)
  if (!report.ok) notify(report.message ?? '모션을 적용하지 못했습니다.', 'error')
}

// ---------------------------------------------------------------------------
// 명령 목록
// ---------------------------------------------------------------------------

/** 1 ~ 9 슬롯. EASY 노출 순서를 그대로 쓴다. */
const PRESET_SLOTS = EASY_PRESETS.slice(0, 9)

const FILE_COMMANDS: Command[] = [
  {
    id: 'file.open',
    label: '이미지 열기',
    category: '파일',
    keys: ['$mod+o'],
    hint: '파일에서 이미지를 불러옵니다',
    keywords: ['open', 'import', 'file', '불러오기', '가져오기'],
    when: () => host.openFile != null,
    reason: () => (host.openFile ? undefined : NOT_WIRED),
    run: () => host.openFile?.(),
  },
  {
    id: 'file.save',
    label: '프로젝트 저장',
    category: '파일',
    keys: ['$mod+s'],
    hint: '.mmproj 파일로 저장합니다',
    keywords: ['save', 'mmproj', '저장'],
    when: () => host.saveProject != null,
    reason: () => (host.saveProject ? undefined : NOT_WIRED),
    run: () => host.saveProject?.(),
  },
  {
    id: 'file.export',
    label: '내보내기',
    category: '파일',
    keys: ['$mod+e'],
    hint: 'GIF / APNG 로 내보냅니다',
    keywords: ['export', 'gif', 'apng', 'render', '저장'],
    when: () => host.openExport != null && hasLayer(),
    reason: () => {
      if (!host.openExport) return NOT_WIRED
      return hasLayer() ? undefined : NO_LAYER
    },
    run: () => host.openExport?.(),
  },
  {
    id: 'file.exportAgain',
    label: '마지막 설정으로 즉시 내보내기',
    category: '파일',
    keys: ['$mod+Shift+e'],
    hint: '대화상자 없이 지난 설정 그대로 인코딩합니다',
    keywords: ['export', 'again', 'quick', 'repeat', '재내보내기'],
    when: () => host.exportWithLastSettings != null && hasLayer(),
    reason: () => {
      if (!host.exportWithLastSettings) return NOT_WIRED
      return hasLayer() ? undefined : NO_LAYER
    },
    run: () => host.exportWithLastSettings?.(),
  },
]

const EDIT_COMMANDS: Command[] = [
  {
    id: 'edit.undo',
    label: '실행 취소',
    category: '편집',
    keys: ['$mod+z'],
    keywords: ['undo', '되돌리기'],
    when: () => docStore().past.length > 0,
    reason: () => (docStore().past.length > 0 ? undefined : '되돌릴 작업이 없습니다'),
    run: () => docStore().undo(),
  },
  {
    id: 'edit.redo',
    label: '다시 실행',
    category: '편집',
    keys: ['$mod+Shift+z', '$mod+y'],
    keywords: ['redo', '재실행'],
    when: () => docStore().future.length > 0,
    reason: () => (docStore().future.length > 0 ? undefined : '다시 실행할 작업이 없습니다'),
    run: () => docStore().redo(),
  },
  {
    id: 'edit.duplicate',
    label: '레이어 복제',
    category: '편집',
    keys: ['$mod+d'],
    keywords: ['duplicate', 'copy', '복사'],
    when: () => host.duplicateLayer != null && currentLayerId() != null,
    reason: () => {
      if (!host.duplicateLayer) return NOT_WIRED
      return currentLayerId() ? undefined : NO_LAYER
    },
    run: () => {
      const id = currentLayerId()
      if (id) host.duplicateLayer?.(id)
    },
  },
  {
    id: 'edit.selectAll',
    label: '레이어 전체 선택',
    category: '편집',
    keys: ['$mod+a'],
    keywords: ['select all', '전체선택'],
    when: hasLayer,
    reason: () => (hasLayer() ? undefined : NO_LAYER),
    run: selectAllLayers,
  },
  {
    id: 'edit.deselect',
    label: '선택 해제',
    category: '편집',
    keys: ['Escape'],
    hint: '키프레임 선택이 있으면 그것부터 풉니다',
    keywords: ['escape', 'deselect', '취소'],
    when: hasAnySelection,
    reason: () => (hasAnySelection() ? undefined : '선택된 것이 없습니다'),
    run: clearAllSelection,
  },
  {
    id: 'edit.delete',
    label: '삭제',
    category: '편집',
    keys: ['Delete', 'Backspace'],
    hint: '선택된 키프레임, 없으면 선택된 레이어를 지웁니다',
    keywords: ['delete', 'remove', '지우기'],
    when: hasAnySelection,
    reason: () => (hasAnySelection() ? undefined : '선택된 것이 없습니다'),
    run: deleteSelection,
  },
]

const PLAY_COMMANDS: Command[] = [
  {
    id: 'play.toggle',
    label: '재생 / 정지',
    category: '재생',
    keys: ['Space'],
    keywords: ['play', 'pause', 'space', '일시정지'],
    run: () => uiStore().togglePlaying(),
  },
  {
    id: 'play.prevFrame',
    label: '이전 프레임',
    category: '재생',
    keys: ['ArrowLeft'],
    keywords: ['prev', 'frame', 'step', '뒤로'],
    repeatable: true,
    run: () => stepFrame(-1),
  },
  {
    id: 'play.nextFrame',
    label: '다음 프레임',
    category: '재생',
    keys: ['ArrowRight'],
    keywords: ['next', 'frame', 'step', '앞으로'],
    repeatable: true,
    run: () => stepFrame(1),
  },
  {
    id: 'play.back10',
    label: '10프레임 뒤로',
    category: '재생',
    keys: ['Shift+ArrowLeft'],
    keywords: ['jump', 'back', '점프'],
    repeatable: true,
    run: () => stepFrame(-10),
  },
  {
    id: 'play.forward10',
    label: '10프레임 앞으로',
    category: '재생',
    keys: ['Shift+ArrowRight'],
    keywords: ['jump', 'forward', '점프'],
    repeatable: true,
    run: () => stepFrame(10),
  },
  {
    id: 'play.start',
    label: '처음으로',
    category: '재생',
    keys: ['Home'],
    keywords: ['start', 'first', '맨앞'],
    run: () => goToFrame(0),
  },
  {
    id: 'play.end',
    label: '끝으로',
    category: '재생',
    keys: ['End'],
    keywords: ['end', 'last', '맨뒤'],
    run: () => goToFrame(maxFrame()),
  },
  {
    id: 'play.loopMode',
    label: '반복 방식 전환',
    category: '재생',
    keys: ['l'],
    hint: '반복 -> 왕복 -> 한 번만 -> 반복 + 끝에서 멈춤',
    keywords: ['loop', 'pingpong', '왕복'],
    run: cycleLoopMode,
  },
]

const TIMELINE_COMMANDS: Command[] = [
  {
    id: 'timeline.graph',
    label: '그래프 에디터 열기 / 닫기',
    category: '타임라인',
    keys: ['g'],
    keywords: ['graph', 'curve', '곡선'],
    when: () => timelineStore().graphOpen || keyframeTarget() != null,
    reason: () =>
      timelineStore().graphOpen || keyframeTarget() != null ? undefined : NO_TRACK,
    run: () => timelineStore().toggleGraph(keyframeTarget()),
  },
  {
    id: 'timeline.graphTab',
    label: '그래프 값 / 속도 전환',
    category: '타임라인',
    keys: ['Shift+g'],
    keywords: ['graph', 'value', 'speed', '속도'],
    when: () => timelineStore().graphOpen,
    reason: () => (timelineStore().graphOpen ? undefined : '그래프가 닫혀 있습니다'),
    run: () => {
      const timeline = timelineStore()
      timeline.setGraphTab(timeline.graphTab === 'speed' ? 'value' : 'speed')
    },
  },
  {
    id: 'timeline.keyframe',
    label: '현재 프레임에 키프레임',
    category: '타임라인',
    keys: ['Alt+k'],
    keywords: ['keyframe', 'key', '키'],
    when: () => keyframeTarget() != null,
    reason: () => (keyframeTarget() ? undefined : NO_TRACK),
    run: () => {
      const target = keyframeTarget()
      if (!target) return
      docStore().addKeyframe(target.layerId, target.prop, Math.round(uiStore().playheadFrame))
    },
  },
  {
    id: 'timeline.zoomFit',
    label: '타임라인 전체 맞춤',
    category: '타임라인',
    keys: ['Shift+z'],
    keywords: ['zoom', 'fit', '확대'],
    run: () => {
      const timeline = timelineStore()
      timeline.setZoom(1)
      timeline.setScrollFrame(0)
    },
  },
]

const CANVAS_COMMANDS: Command[] = [
  {
    id: 'canvas.fit',
    label: '캔버스 화면에 맞춤',
    category: '캔버스',
    keys: ['$mod+0'],
    keywords: ['zoom', 'fit', '맞춤'],
    run: () => uiStore().setZoom('fit'),
  },
  {
    id: 'canvas.actual',
    label: '캔버스 100% 보기',
    category: '캔버스',
    keys: ['$mod+1'],
    keywords: ['zoom', '100', 'actual', '원본'],
    run: () => uiStore().setZoom(1),
  },
]

const PRESET_COMMANDS: Command[] = [
  ...PRESET_SLOTS.map((preset, index): Command => {
    const slot = index + 1
    return {
      id: `preset.slot${slot}`,
      label: `모션 ${slot}: ${preset.label}`,
      category: '프리셋',
      keys: [String(slot)],
      hint: preset.hint,
      keywords: ['preset', 'motion', preset.id, ...preset.tags],
      when: hasLayer,
      reason: () => (hasLayer() ? undefined : NO_LAYER),
      run: () => applyPreset(preset.id),
    }
  }),
  {
    id: 'preset.random',
    label: '무작위 모션 적용',
    category: '프리셋',
    keys: ['$mod+r'],
    hint: '56종 가운데 하나를 무작위로 겁니다',
    keywords: ['random', 'shuffle', '랜덤'],
    when: hasLayer,
    reason: () => (hasLayer() ? undefined : NO_LAYER),
    run: () => {
      const pick = MOTION_PRESETS[Math.floor(Math.random() * MOTION_PRESETS.length)]
      if (pick) applyPreset(pick.id)
    },
  },
]

const HELP_COMMANDS: Command[] = [
  {
    id: 'palette.toggle',
    label: '커맨드 팔레트',
    category: '도움말',
    keys: ['$mod+k'],
    hint: '이름으로 명령을 찾아 실행합니다',
    keywords: ['command', 'palette', 'search', '검색', '명령'],
    overlaySafe: true,
    run: () => toggleOverlay('palette'),
  },
  {
    id: 'help.shortcuts',
    label: '단축키 목록',
    category: '도움말',
    // `[Shift]` 로 감싸야 한다. tinykeys 는 필수/선택에 없는 수식자가 눌려 있으면
    // 매치하지 않는데, `?` 는 대부분의 배열에서 Shift 를 눌러야 나온다.
    keys: ['[Shift]+?'],
    keywords: ['help', 'shortcut', 'keyboard', '도움말', '키보드'],
    run: () => toggleOverlay('help'),
  },
]

export const COMMANDS: Command[] = [
  ...FILE_COMMANDS,
  ...EDIT_COMMANDS,
  ...PLAY_COMMANDS,
  ...TIMELINE_COMMANDS,
  ...CANVAS_COMMANDS,
  ...PRESET_COMMANDS,
  ...HELP_COMMANDS,
]

export const COMMAND_BY_ID: ReadonlyMap<string, Command> = new Map(
  COMMANDS.map((command) => [command.id, command]),
)

/** when() 이 없으면 항상 쓸 수 있다. 예외가 나면 못 쓰는 것으로 본다(팔레트가 죽으면 안 된다). */
export function isCommandAvailable(command: Command): boolean {
  if (!command.when) return true
  try {
    return command.when()
  } catch {
    return false
  }
}

export function commandReason(command: Command): string | undefined {
  if (!command.reason) return undefined
  try {
    return command.reason()
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 퍼지 검색
// ---------------------------------------------------------------------------

/** 초성 19자. 유니코드 한글 음절 블록의 초성 인덱스 순서다. */
const CHOSEONG = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
]

const HANGUL_BASE = 0xac00
const HANGUL_LAST = 0xd7a3
const CHOSEONG_SPAN = 588

/** 한글 음절을 초성으로 바꾼다. 한글이 아닌 글자는 그대로 둔다. */
export function toChoseong(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      out += CHOSEONG[Math.floor((code - HANGUL_BASE) / CHOSEONG_SPAN)] ?? ch
    } else {
      out += ch
    }
  }
  return out
}

/** 부분 문자열. 앞에서 걸릴수록, 군더더기가 적을수록 높다. 없으면 -1. */
function substringScore(hay: string, needle: string): number {
  const at = hay.indexOf(needle)
  if (at < 0) return -1
  return 1000 - at * 8 - Math.min(200, hay.length - needle.length)
}

/** 순서를 지키는 부분 수열. 연속으로 붙을수록 높다. 없으면 -1. */
function subsequenceScore(hay: string, needle: string): number {
  let score = 500
  let cursor = 0
  let prev = -2
  for (const ch of needle) {
    const at = hay.indexOf(ch, cursor)
    if (at < 0) return -1
    if (at === prev + 1) score += 12
    else score -= Math.min(24, (at - prev) * 2)
    if (at === 0) score += 16
    prev = at
    cursor = at + 1
  }
  return score
}

function bestScore(hay: string, needle: string): number {
  if (hay.length === 0) return -1
  const direct = substringScore(hay, needle)
  if (direct >= 0) return direct
  return subsequenceScore(hay, needle)
}

interface SearchField {
  text: string
  /** 라벨에서 멀어질수록 감점한다. 같은 점수면 라벨이 먼저 뜬다. */
  penalty: number
}

const fieldCache = new Map<string, SearchField[]>()

function fieldsOf(command: Command): SearchField[] {
  const cached = fieldCache.get(command.id)
  if (cached) return cached
  const label = command.label.toLowerCase()
  const fields: SearchField[] = [
    { text: label, penalty: 0 },
    { text: toChoseong(command.label).toLowerCase(), penalty: 140 },
    { text: (command.keywords ?? []).join(' ').toLowerCase(), penalty: 260 },
    { text: command.category.toLowerCase(), penalty: 320 },
    { text: (command.hint ?? '').toLowerCase(), penalty: 380 },
    { text: command.id.toLowerCase(), penalty: 420 },
  ]
  fieldCache.set(command.id, fields)
  return fields
}

/** 한 명령의 점수. 못 찾으면 -1. */
export function scoreCommand(command: Command, query: string): number {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return 0
  let best = -1
  for (const field of fieldsOf(command)) {
    const raw = bestScore(field.text, needle)
    if (raw < 0) continue
    const score = raw - field.penalty
    if (score > best) best = score
  }
  return best
}

/**
 * 퍼지 검색. 빈 문자열이면 등록 순서 그대로 전부 돌려준다.
 * 점수가 같으면 등록 순서를 지킨다(결과가 흔들리면 근육 기억이 생기지 않는다).
 */
export function findCommands(query: string): Command[] {
  const needle = query.trim()
  if (needle.length === 0) return [...COMMANDS]

  const hits: { command: Command; score: number; index: number }[] = []
  COMMANDS.forEach((command, index) => {
    const score = scoreCommand(command, needle)
    if (score >= 0) hits.push({ command, score, index })
  })

  hits.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
  return hits.map((hit) => hit.command)
}
