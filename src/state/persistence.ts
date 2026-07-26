/**
 * IndexedDB 자동저장과 크래시 복구.
 *
 * 문서는 800ms 디바운스로 저장한다. 에셋 픽셀은 문서가 바뀔 때마다가 아니라
 * assetRegistry 의 revision 이 바뀔 때만 저장한다. 그림 한 장이 수 MB 인데
 * 키프레임을 옮길 때마다 다시 쓰면 디스크와 배터리만 먹는다.
 *
 * 픽셀을 같이 저장해야 복구가 의미를 갖는다. 문서만 살아 돌아오면 레이어 이름만
 * 남고 화면은 비어 있다.
 *
 * 저장 실패는 조용히 넘어가지 않는다. 콜백으로 알리고 .mmproj 내려받기를 권한다.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

import type { MotionProject } from '@/core/types.ts'
import { migrateProject } from '@/project/migrate.ts'
import { bitmapToPng, restoreBundle } from '@/project/io.ts'

import { assetRegistry } from './assets.ts'
import { useDocumentStore } from './document.ts'

const DB_NAME = 'motion-maker'
const DB_VERSION = 1

/** 스냅샷 롤링 개수. */
const SNAPSHOT_LIMIT = 10

const DEBOUNCE_MS = 800

/** 정상 종료 플래그. localStorage 는 beforeunload 에서 동기로 쓸 수 있다. */
const CLEAN_KEY = 'mm.session.clean'

const META_SESSION = 'session'

interface SnapshotRecord {
  id?: number
  at: number
  layerCount: number
  /** JSON 문자열로 둔다. 구조를 그대로 넣으면 immer 가 얼린 객체를 복제하다 형태가 미묘하게 달라진다. */
  doc: string
}

interface AssetRecord {
  id: string
  bytes: Uint8Array
  at: number
}

interface MetaRecord {
  clean: boolean
  at: number
}

interface AutosaveDB extends DBSchema {
  snapshots: { key: number; value: SnapshotRecord }
  assets: { key: string; value: AssetRecord }
  meta: { key: string; value: MetaRecord }
}

// ---------------------------------------------------------------------------
// DB 접근
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBPDatabase<AutosaveDB>> | null = null

function getDb(): Promise<IDBPDatabase<AutosaveDB>> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('이 브라우저에서는 자동저장을 쓸 수 없습니다.'))
  }
  if (!dbPromise) {
    dbPromise = openDB<AutosaveDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true })
        }
        if (!db.objectStoreNames.contains('assets')) {
          db.createObjectStore('assets', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta')
        }
      },
      blocked() {
        // 다른 탭이 옛 버전을 붙잡고 있다. 여기서 막히면 저장이 통째로 멈춘다.
        report('다른 탭이 열려 있어 자동저장을 시작하지 못했습니다.', null)
      },
    }).catch((err) => {
      // 실패한 Promise 를 캐시에 남기면 이후 호출이 전부 같은 오류를 재사용한다.
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

// ---------------------------------------------------------------------------
// 정상 종료 플래그
// ---------------------------------------------------------------------------

function setCleanFlag(clean: boolean): void {
  try {
    window.localStorage.setItem(CLEAN_KEY, clean ? '1' : '0')
  } catch {
    // 프라이빗 모드에서 막힐 수 있다. 아래 IndexedDB 미러가 대신한다.
  }
  void getDb()
    .then((db) => db.put('meta', { clean, at: Date.now() }, META_SESSION))
    .catch(() => {
      // 플래그 기록 실패로 사용자를 방해하지 않는다. 최악이라도 복구 배너가 한 번 더 뜰 뿐이다.
    })
}

async function readCleanFlag(): Promise<boolean> {
  try {
    const v = window.localStorage.getItem(CLEAN_KEY)
    if (v !== null) return v === '1'
  } catch {
    // 무시하고 IndexedDB 미러를 본다.
  }
  try {
    const db = await getDb()
    const meta = await db.get('meta', META_SESSION)
    return meta?.clean ?? false
  } catch {
    // 읽을 수 없으면 '비정상 종료' 쪽으로 기운다. 스냅샷이 없으면 어차피 배너는 안 뜬다.
    return false
  }
}

// ---------------------------------------------------------------------------
// 상태 알림
// ---------------------------------------------------------------------------

export type AutosaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface AutosaveStatus {
  state: AutosaveState
  /** 마지막으로 성공한 저장 시각 (epoch ms). 없으면 0. */
  at: number
  /** state 가 'error' 일 때만 채워진다. */
  message: string | null
}

let status: AutosaveStatus = { state: 'idle', at: 0, message: null }
const listeners = new Set<(s: AutosaveStatus) => void>()
let onErrorCallback: ((message: string, error: unknown) => void) | null = null

function setStatus(next: AutosaveStatus): void {
  // 매번 새 객체를 만든다. useSyncExternalStore 가 참조로 변화를 판정한다.
  status = next
  for (const l of listeners) l(status)
}

function report(message: string, error: unknown): void {
  setStatus({ state: 'error', at: status.at, message })
  if (onErrorCallback) onErrorCallback(message, error)
}

/** useSyncExternalStore 용. */
export function subscribeAutosave(listener: (s: AutosaveStatus) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getAutosaveStatus(): AutosaveStatus {
  return status
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------

/** 마지막으로 저장한 비트맵. 같은 객체면 다시 인코딩하지 않는다. */
const encodedBitmaps = new Map<string, ImageBitmap>()

function describeError(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22)) {
    return '저장 공간이 부족해 자동저장에 실패했습니다. 프로젝트 파일로 내려받아 두세요.'
  }
  if (err instanceof Error && err.message.length > 0) return `자동저장에 실패했습니다. ${err.message}`
  return '자동저장에 실패했습니다. 프로젝트 파일로 내려받아 두세요.'
}

async function writeAssets(db: IDBPDatabase<AutosaveDB>, doc: MotionProject): Promise<void> {
  const keep = new Set<string>()

  for (const ref of doc.assets) {
    keep.add(ref.id)
    const bitmap = assetRegistry.get(ref.id)
    if (!bitmap) continue
    if (encodedBitmaps.get(ref.id) === bitmap) continue
    const bytes = await bitmapToPng(bitmap)
    await db.put('assets', { id: ref.id, bytes, at: Date.now() })
    encodedBitmaps.set(ref.id, bitmap)
  }

  // 문서에서 사라진 이미지는 지운다. 안 지우면 DB 가 세션마다 커진다.
  for (const key of await db.getAllKeys('assets')) {
    if (keep.has(key)) continue
    await db.delete('assets', key)
    encodedBitmaps.delete(key)
  }
}

async function trimSnapshots(db: IDBPDatabase<AutosaveDB>): Promise<void> {
  const keys = await db.getAllKeys('snapshots')
  if (keys.length <= SNAPSHOT_LIMIT) return
  // autoIncrement 키는 단조 증가라 앞쪽이 오래된 것이다.
  for (const key of keys.slice(0, keys.length - SNAPSHOT_LIMIT)) {
    await db.delete('snapshots', key)
  }
}

let docDirty = false
let assetsDirty = false

/**
 * 저장은 직렬화한다.
 * 겹쳐 돌면 스냅샷 순서가 뒤집히고 같은 에셋을 두 번 인코딩한다.
 * 앞의 저장이 끝난 뒤 실행되며, 그 사이 변경이 없으면 곧바로 빠져나간다.
 */
let queue: Promise<boolean> = Promise.resolve(true)

function flush(): Promise<boolean> {
  const next = queue.then(runSave, runSave)
  queue = next.catch(() => false)
  return next
}

async function runSave(): Promise<boolean> {
  if (!docDirty && !assetsDirty) return true

  const wantAssets = assetsDirty
  docDirty = false
  assetsDirty = false
  setStatus({ state: 'saving', at: status.at, message: null })

  try {
    const db = await getDb()
    const doc = useDocumentStore.getState().doc
    if (wantAssets) await writeAssets(db, doc)

    const at = Date.now()
    await db.add('snapshots', { at, layerCount: doc.layers.length, doc: JSON.stringify(doc) })
    await trimSnapshots(db)

    // 저장할 게 생겼다는 것은 이 세션이 작업 중이라는 뜻이다.
    setCleanFlag(false)
    setStatus({ state: 'saved', at, message: null })
    return true
  } catch (err) {
    // 실패한 변경을 다시 시도할 수 있도록 표시를 되돌린다.
    docDirty = true
    if (wantAssets) assetsDirty = true
    report(describeError(err), err)
    return false
  }
}

// ---------------------------------------------------------------------------
// 자동저장 시작 / 정지
// ---------------------------------------------------------------------------

export interface AutosaveOptions {
  /** 저장 실패를 사용자에게 알린다. 조용히 실패하지 않기 위한 통로다. */
  onError?(message: string, error: unknown): void
  debounceMs?: number
}

let running = false

/** 자동저장을 켠다. 반환값을 호출하면 멈춘다. 두 번 켜지지 않는다. */
export function startAutosave(options: AutosaveOptions = {}): () => void {
  if (running) return () => {}
  running = true
  onErrorCallback = options.onError ?? null

  const delay = options.debounceMs ?? DEBOUNCE_MS
  let timer: number | null = null

  const schedule = (): void => {
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      void flush()
    }, delay)
  }

  const unsubDoc = useDocumentStore.subscribe((state, prev) => {
    if (state.doc === prev.doc) return
    docDirty = true
    schedule()
  })

  let lastRevision = assetRegistry.getRevision()
  const unsubAssets = assetRegistry.subscribe(() => {
    const revision = assetRegistry.getRevision()
    if (revision === lastRevision) return
    lastRevision = revision
    assetsDirty = true
    schedule()
  })

  /**
   * 정상 종료 표시.
   * beforeunload 안에서는 비동기 쓰기가 끝난다는 보장이 없다. localStorage 는 동기라
   * 여기서 확실히 남는다 (setCleanFlag 안에서 처리한다).
   */
  const onExit = (): void => {
    setCleanFlag(true)
  }
  window.addEventListener('beforeunload', onExit)
  window.addEventListener('pagehide', onExit)

  return () => {
    running = false
    onErrorCallback = null
    if (timer !== null) window.clearTimeout(timer)
    unsubDoc()
    unsubAssets()
    window.removeEventListener('beforeunload', onExit)
    window.removeEventListener('pagehide', onExit)
  }
}

/** 디바운스를 기다리지 않고 즉시 저장한다. 내보내기 직전 같은 순간에 쓴다. */
export async function saveNow(): Promise<boolean> {
  docDirty = true
  return await flush()
}

// ---------------------------------------------------------------------------
// 복구
// ---------------------------------------------------------------------------

async function latestSnapshot(db: IDBPDatabase<AutosaveDB>): Promise<SnapshotRecord | null> {
  const keys = await db.getAllKeys('snapshots')
  const last = keys[keys.length - 1]
  if (last === undefined) return null
  return (await db.get('snapshots', last)) ?? null
}

export interface RecoveryInfo {
  /** 스냅샷 시각 (epoch ms) */
  at: number
  layerCount: number
}

/** 비정상 종료 뒤 남은 작업이 있으면 알려 준다. 없으면 null. */
export async function hasRecovery(): Promise<RecoveryInfo | null> {
  try {
    if (await readCleanFlag()) return null
    const db = await getDb()
    const snapshot = await latestSnapshot(db)
    if (!snapshot) return null
    // 빈 문서는 복구할 것이 없다. 배너만 뜨면 사용자를 혼란스럽게 한다.
    if (snapshot.layerCount === 0) return null
    return { at: snapshot.at, layerCount: snapshot.layerCount }
  } catch {
    return null
  }
}

/** 마지막 스냅샷으로 되돌린다. 현재 문서는 교체된다. */
export async function restoreRecovery(): Promise<boolean> {
  try {
    const db = await getDb()
    const snapshot = await latestSnapshot(db)
    if (!snapshot) return false

    const { doc } = migrateProject(snapshot.doc)
    const assets = new Map<string, Uint8Array>()
    for (const ref of doc.assets) {
      const record = await db.get('assets', ref.id)
      if (record) assets.set(ref.id, record.bytes)
    }

    await restoreBundle({ doc, assets })

    // 복구한 비트맵은 방금 DB 에서 온 것이다. 다시 인코딩할 필요가 없다.
    encodedBitmaps.clear()
    for (const ref of doc.assets) {
      const bitmap = assetRegistry.get(ref.id)
      if (bitmap) encodedBitmaps.set(ref.id, bitmap)
    }

    setCleanFlag(false)
    return true
  } catch (err) {
    report('작업을 복구하지 못했습니다.', err)
    return false
  }
}

/** 복구를 거절한다. 스냅샷은 지우지 않는다. 실수로 눌렀을 때 되돌릴 여지를 남긴다. */
export async function dismissRecovery(): Promise<void> {
  setCleanFlag(true)
}

/** 자동저장 데이터를 통째로 지운다. '새 프로젝트' 같은 동작에서 쓴다. */
export async function clearAutosave(): Promise<void> {
  try {
    const db = await getDb()
    await db.clear('snapshots')
    await db.clear('assets')
    encodedBitmaps.clear()
    setCleanFlag(true)
  } catch {
    // 지우기 실패는 사용자가 할 수 있는 일이 없다. 알리지 않는다.
  }
}
