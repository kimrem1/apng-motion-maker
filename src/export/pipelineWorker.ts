/**
 * 인코딩 워커 얇은 층.
 *
 * 하는 일은 네 가지뿐이다.
 *   1. 워커를 띄우고 comlink 로 감싼다
 *   2. 프레임 버퍼를 transfer 로 넘긴다 (복사 없음)
 *   3. 취소를 cancel 메시지 -> terminate 순으로 처리한다
 *   4. 워커를 못 띄우면 메인 스레드에서 같은 함수를 돈다
 *
 * 인코딩 로직은 여기에 한 줄도 없다. workers/protocol.ts 의 runEncodeJob 하나뿐이다.
 * 워커 경로와 폴백 경로가 다른 코드를 타면 "워커에서만 색이 다르다" 를 디버깅하게 된다.
 *
 * ## 워커 재사용
 *
 * 매번 새로 띄우면 모듈 로드(그리고 나중에 붙을 wasm 인스턴스화)를 매번 반복한다.
 * 그래서 한 번 띄운 워커를 계속 쓰고, 마지막 job 이 끝나고 60초 동안 아무 요청이
 * 없으면 종료한다. 사용자가 내보내기를 연속으로 여러 번 하는 흐름("fps 낮추기 /
 * 크기 줄이기 / GIF 로" 재인코딩 버튼)에서 이 재사용이 그대로 이득이다.
 *
 * ## 소유권 (반복해서 적는다)
 *
 * encodeFramesOffThread 에 넘긴 frames 는 **호출 후 읽을 수 없다.** 워커로 transfer
 * 되면서 detached 되기 때문이다. 압축 전 미리보기처럼 프레임이 더
 * 필요하면 넘기기 전에 복사해 두어라.
 */

import * as Comlink from 'comlink'

import type { MotionProject } from '@/core/types.ts'
import { ExportAbortError, type EncodedBuffer, type ExportSettings } from '@/export/pipeline.ts'
import {
  buildEncodeRequest,
  collectTransferables,
  runEncodeJob,
  toOwnedFrames,
  ENCODE_PROTOCOL_VERSION,
  type EncodeWorkerApi,
  type WorkerCapabilities,
} from '@/workers/protocol.ts'

/** 마지막 job 이 끝난 뒤 이 시간 동안 요청이 없으면 워커를 종료한다. */
export const WORKER_IDLE_TIMEOUT_MS = 60_000

/**
 * 취소 메시지를 보낸 뒤 이만큼 기다렸다가 terminate 한다.
 * 인코더는 프레임 경계마다 signal 을 보므로 보통 이 안에 스스로 끝난다.
 * deflate 한 덩어리 중간에 걸리면 안 끝나는데, 그때는 죽이는 쪽이 맞다.
 */
export const CANCEL_GRACE_MS = 300

/** 워커 모듈 로드 + 첫 응답까지 이만큼 기다린다. 넘으면 폴백한다. */
const HANDSHAKE_TIMEOUT_MS = 8_000

interface WorkerHandle {
  worker: Worker
  api: Comlink.Remote<EncodeWorkerApi>
  capabilities: WorkerCapabilities
  /** 워커가 죽거나 terminate 되면 거절된다. 진행 중인 호출을 이걸로 깨운다. */
  failure: Promise<never>
  fail(error: Error): void
  broken: boolean
}

let handle: WorkerHandle | null = null
let starting: Promise<WorkerHandle | null> | null = null
/**
 * 워커를 못 띄운 이유. 한 번 실패하면 다시 시도하지 않는다.
 * 내보내기마다 8초씩 기다렸다가 폴백하면 실패보다 나쁘다.
 */
let disabledReason: string | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let activeJobs = 0
let nextJobId = 1

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * signal.aborted 를 함수로 감싼다.
 * 인라인으로 쓰면 TS 가 초입 가드 이후 false 로 좁혀 버려서, await 뒤에 값이 바뀌었는데도
 * "겹치는 타입이 없다" 고 판단한다. abort 는 비동기로 켜지므로 매번 새로 읽어야 한다.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

// ---------------------------------------------------------------------------
// 워커 수명
// ---------------------------------------------------------------------------

function cancelIdleShutdown(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdleShutdown(): void {
  cancelIdleShutdown()
  if (!handle) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (activeJobs === 0) shutdownEncodeWorker()
  }, WORKER_IDLE_TIMEOUT_MS)
}

/** 워커를 즉시 죽이고 진행 중인 호출을 거절한다. */
function killWorker(target: WorkerHandle, error: Error): void {
  target.broken = true
  target.fail(error)
  try {
    target.api[Comlink.releaseProxy]()
  } catch {
    // 이미 죽은 엔드포인트. 무시한다.
  }
  target.worker.terminate()
  if (handle === target) handle = null
  cancelIdleShutdown()
}

async function startWorker(): Promise<WorkerHandle | null> {
  if (typeof Worker === 'undefined') {
    disabledReason = '이 환경에는 Worker 가 없어 메인 스레드에서 압축합니다.'
    return null
  }

  let worker: Worker
  try {
    // Vite 가 이 형태를 보고 워커 번들을 따로 만든다. 문자열 경로로 바꾸면 안 된다.
    worker = new Worker(new URL('../workers/encode.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch (err) {
    disabledReason = `워커를 만들지 못했습니다: ${messageOf(err)}`
    return null
  }

  let rejectFailure: (error: Error) => void = () => {}
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  // race 에 걸리기 전에 거절되면 unhandled rejection 으로 잡힌다. 미리 소비해 둔다.
  failure.catch(() => {})

  const created: WorkerHandle = {
    worker,
    api: Comlink.wrap<EncodeWorkerApi>(worker),
    capabilities: {
      protocolVersion: ENCODE_PROTOCOL_VERSION,
      offscreenCanvas: false,
      webpStill: false,
      webpAnimated: false,
      note: '',
    },
    failure,
    fail: (error: Error) => {
      rejectFailure(error)
    },
    broken: false,
  }

  const onWorkerError = (event: Event): void => {
    const detail = event instanceof ErrorEvent && event.message ? event.message : '알 수 없는 오류'
    killWorker(created, new Error(`인코딩 워커가 중단되었습니다: ${detail}`))
  }
  worker.addEventListener('error', onWorkerError)
  worker.addEventListener('messageerror', onWorkerError)

  try {
    // 프레임을 transfer 하기 **전에** 워커가 살아 있는지 확인한다. transfer 뒤에는
    // 메인 스레드에 데이터가 남지 않아 폴백으로 되돌릴 수 없기 때문이다.
    const capabilities = await withTimeout(
      Promise.race([created.api.capabilities(), created.failure]),
      HANDSHAKE_TIMEOUT_MS,
      '워커가 응답하지 않습니다',
    )
    if (capabilities.protocolVersion !== ENCODE_PROTOCOL_VERSION) {
      throw new Error(
        `프로토콜 버전이 다릅니다 (워커 ${capabilities.protocolVersion}, 메인 ${ENCODE_PROTOCOL_VERSION})`,
      )
    }
    created.capabilities = capabilities
    handle = created
    scheduleIdleShutdown()
    return created
  } catch (err) {
    created.broken = true
    worker.terminate()
    disabledReason = `워커 준비에 실패해 메인 스레드에서 압축합니다: ${messageOf(err)}`
    return null
  }
}

async function ensureWorker(): Promise<WorkerHandle | null> {
  if (handle && !handle.broken) return handle
  if (disabledReason) return null
  if (starting) return starting
  starting = startWorker()
  try {
    return await starting
  } finally {
    starting = null
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} (${ms}ms)`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** 지금 워커가 살아 있는가. UI 표시용. */
export function isEncodeWorkerAlive(): boolean {
  return handle !== null && !handle.broken
}

/** 워커를 못 쓰는 이유. 쓸 수 있으면 null. */
export function encodeWorkerDisabledReason(): string | null {
  return disabledReason
}

/**
 * 워커 능력을 확인한다. 필요하면 워커를 띄운다.
 * 워커를 못 쓰면 null. (WebP 가능 여부 표시 등에 쓴다)
 */
export async function getEncodeWorkerCapabilities(): Promise<WorkerCapabilities | null> {
  const h = await ensureWorker()
  return h ? h.capabilities : null
}

/** 워커를 종료한다. 진행 중인 job 이 있으면 그 job 은 실패한다. */
export function shutdownEncodeWorker(): void {
  cancelIdleShutdown()
  if (!handle) return
  killWorker(handle, new Error('인코딩 워커를 종료했습니다.'))
}

/** 실패 기록을 지우고 다음 호출에서 워커를 다시 시도하게 한다. 개발/테스트용. */
export function resetEncodeWorker(): void {
  shutdownEncodeWorker()
  disabledReason = null
  starting = null
  activeJobs = 0
}

// ---------------------------------------------------------------------------
// 인코딩 요청
// ---------------------------------------------------------------------------

export interface OffThreadEncodeArgs {
  doc: MotionProject
  settings: ExportSettings
  /**
   * straight alpha RGBA8 프레임.
   * **소유권을 넘긴다. 이 호출 뒤에 읽지 마라.** 파일 머리말의 소유권 절을 보라.
   */
  frames: Uint8Array[]
  width: number
  height: number
  onProgress?(done: number, total: number): void
  signal?: AbortSignal
}

export interface OffThreadEncodeOutput extends EncodedBuffer {
  /** true 면 워커에서, false 면 메인 스레드 폴백으로 만들었다. */
  ranOnWorker: boolean
}

/**
 * 렌더된 프레임을 워커에서 최종 바이트로 만든다.
 * 워커를 못 쓰면 조용히 메인 스레드에서 같은 일을 한다(결과는 바이트 단위로 동일하다).
 */
export async function encodeFramesOffThread(
  args: OffThreadEncodeArgs,
): Promise<OffThreadEncodeOutput> {
  const { doc, settings, frames, width, height, onProgress, signal } = args
  if (isAborted(signal)) throw new ExportAbortError()

  const jobId = nextJobId
  nextJobId += 1

  const h = await ensureWorker()

  if (!h) {
    // 폴백. transfer 하지 않으므로 frames 는 여전히 유효하다.
    const request = buildEncodeRequest({ jobId, doc, settings, frames, width, height })
    const result = await runEncodeJob(
      request,
      onProgress ? (p) => onProgress(p.done, p.total) : undefined,
      signal,
    )
    return { bytes: result.bytes, mime: result.mime, extension: result.extension, ranOnWorker: false }
  }

  // 여기서부터는 되돌릴 수 없다. 그래서 위에서 handshake 로 워커 상태를 먼저 확인했다.
  const owned = toOwnedFrames(frames)
  const request = buildEncodeRequest({ jobId, doc, settings, frames: owned, width, height })
  const transferables = collectTransferables(owned)

  activeJobs += 1
  cancelIdleShutdown()
  const detachCancel = signal ? attachCancel(h, jobId, signal) : null

  try {
    const result = await Promise.race([
      h.api.encode(
        Comlink.transfer(request, transferables),
        // 날것의 함수는 구조적 복제가 안 된다. 반드시 proxy 로 감싼다.
        onProgress
          ? Comlink.proxy((p: { done: number; total: number }) => {
              onProgress(p.done, p.total)
            })
          : undefined,
      ),
      h.failure,
    ])
    return { bytes: result.bytes, mime: result.mime, extension: result.extension, ranOnWorker: true }
  } catch (err) {
    // 취소로 죽인 경우는 파이프라인이 아는 타입으로 통일한다.
    if (isAborted(signal)) throw new ExportAbortError()
    throw err
  } finally {
    detachCancel?.()
    activeJobs -= 1
    if (activeJobs === 0) scheduleIdleShutdown()
  }
}

/**
 * 취소 배선.
 *
 * 1단계로 cancel 메시지를 보낸다. 인코더가 프레임 경계에서 스스로 멈춘다.
 * 2단계로 유예 시간이 지나면 terminate 한다. 이때 failure 를 거절해야 encode 호출이
 * 영원히 매달리지 않는다.
 */
function attachCancel(h: WorkerHandle, jobId: number, signal: AbortSignal): () => void {
  let terminateTimer: ReturnType<typeof setTimeout> | null = null

  const onAbort = (): void => {
    void h.api.cancel(jobId).catch(() => {
      // 이미 죽었거나 끝난 job. 아래 terminate 가 정리한다.
    })
    terminateTimer = setTimeout(() => {
      terminateTimer = null
      if (!h.broken) killWorker(h, new ExportAbortError())
    }, CANCEL_GRACE_MS)
  }

  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  return () => {
    if (terminateTimer !== null) {
      clearTimeout(terminateTimer)
      terminateTimer = null
    }
    signal.removeEventListener('abort', onAbort)
  }
}
