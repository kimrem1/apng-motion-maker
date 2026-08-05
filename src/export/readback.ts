/**
 * PBO 비동기 리드백.
 *
 * gl.readPixels 를 ArrayBufferView 로 직접 부르면 그 자리에서 GPU 파이프라인이 멈춘다.
 * 드라이버는 앞서 큐에 넣은 그리기 명령이 전부 끝날 때까지 CPU 를 붙잡아 둔다.
 * 1080x1080 한 장에 5~15ms 가 통째로 날아가고, 그동안 취소 버튼도 진행률도 돌지 않는다.
 *
 * PIXEL_PACK_BUFFER 에 readPixels 를 걸면 "이 프레임버퍼를 이 버퍼로 내려라" 라는
 * 명령만 큐에 들어가고 즉시 반환한다. 그 뒤 fenceSync 로 완료 시점을 표시해 두고
 * clientWaitSync(timeout=0) 로 물어본다. 그래서 프레임 N 이 DMA 로 내려오는 동안
 * 프레임 N+1 을 렌더할 수 있다.
 *
 * clientWaitSync 를 블로킹으로 부르면 안 된다. 애초에 WebGL2 는
 * MAX_CLIENT_WAIT_TIMEOUT_WEBGL 이 0 이라 0 이외의 타임아웃을 허용하지 않는다.
 * 여기서는 항상 0 을 넘기고, 준비가 안 됐으면 false 를 돌려 호출자가 다른 일을 하게 한다.
 *
 * 링버퍼 깊이 기본 3 은 스크래치 버퍼 3장에 맞춘 값이다.
 * 1 장이면 다음 enqueue 가 직전 결과를 기다려야 해서 동기 readPixels 와 같아진다.
 *
 * DOM 을 참조하지 않는다. 워커에서 OffscreenCanvas 컨텍스트로도 그대로 돈다.
 *
 * 사용 형태 (렌더 N+1 과 리드백 N 을 겹친다)
 * ```ts
 * const reader = createPboReader(gl, width * height * 4)
 * for (const frame of frames) {
 *   renderer.renderFrame(doc, t, target, assets)
 *   gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
 *   reader.enqueue(gl, 0, 0, width, height)
 *   // 직전 프레임이 내려와 있으면 받아 간다. 없으면 그냥 다음 프레임을 그린다.
 *   if (reader.poll(gl, scratch)) consume(scratch)
 *   await yieldToHost()
 * }
 * await reader.flush(gl, consume)
 * reader.dispose(gl)
 * ```
 */

import { yieldToHost } from './yield.ts'

/** RGBA8 한 픽셀의 바이트 수. 이 리더는 RGBA/UNSIGNED_BYTE 만 다룬다. */
const BYTES_PER_PIXEL = 4

/** 링버퍼 기본 깊이. */
export const DEFAULT_PBO_DEPTH = 3

export type ReadbackMode = 'pbo' | 'sync'

export interface PboReader {
  /**
   * 'pbo' 면 비동기 경로, 'sync' 면 동기 readPixels 폴백이다.
   * 폴백은 동작은 같지만 enqueue 에서 파이프라인이 멈춘다. UI 가 "느릴 수 있음" 을
   * 알려야 한다면 이 값을 보면 된다.
   */
  readonly mode: ReadbackMode
  /** 폴백으로 떨어진 이유. mode 가 'pbo' 면 null. */
  readonly fallbackReason: string | null
  /** 링버퍼 깊이. */
  readonly depth: number
  /** 슬롯 하나의 바이트 용량. */
  readonly byteLength: number
  /** 아직 결과를 받아 가지 않은 요청 수. */
  readonly pending: number
  /** 마지막 poll 이 out 에 채운 바이트 수. w*h*4 다. */
  readonly lastFrameBytes: number

  /**
   * 현재 프레임버퍼를 비동기로 읽기 시작한다.
   * 호출 전에 읽고 싶은 FBO 를 gl.bindFramebuffer 로 걸어 두어야 한다.
   * 링이 가득 차 있으면 가장 오래된 요청을 강제로 회수한다(이때만 잠깐 멈춘다).
   */
  enqueue(gl: WebGL2RenderingContext, x: number, y: number, w: number, h: number): void

  /**
   * 가장 오래된 요청이 끝났으면 그 결과를 out 에 채우고 true. 아직이면 false.
   * out 은 byteLength 이상이어야 한다. 채운 길이는 lastFrameBytes 로 알 수 있다.
   */
  poll(gl: WebGL2RenderingContext, out: Uint8Array): boolean

  /**
   * 남은 요청을 전부 끝낼 때까지 기다린다.
   * onFrame 에 넘어가는 배열은 내부 스크래치라 다음 호출에서 덮어쓴다.
   * 보관하려면 콜백 안에서 복사해라.
   */
  flush(gl: WebGL2RenderingContext, onFrame: (data: Uint8Array) => void): Promise<void>

  dispose(gl: WebGL2RenderingContext): void
}

interface Slot {
  buffer: WebGLBuffer
  sync: WebGLSync | null
  /** 이 슬롯에 실제로 담긴 바이트 수. 슬롯 용량과 다를 수 있다. */
  bytes: number
}

function assertRequest(byteLength: number, w: number, h: number): number {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`PboReader: 잘못된 읽기 영역 ${w}x${h}`)
  }
  const need = w * h * BYTES_PER_PIXEL
  if (need > byteLength) {
    throw new Error(`PboReader: 슬롯 용량 ${byteLength}B 보다 큰 요청 ${need}B`)
  }
  return need
}

// ---------------------------------------------------------------------------
// PBO 경로
// ---------------------------------------------------------------------------

class PboRingReader implements PboReader {
  readonly mode: ReadbackMode = 'pbo'
  readonly fallbackReason: string | null = null
  readonly depth: number
  readonly byteLength: number

  private readonly slots: Slot[]
  /** 다음에 쓸 슬롯 */
  private head = 0
  /** 다음에 회수할 슬롯 */
  private tail = 0
  private inFlight = 0
  private lastBytes = 0
  private disposed = false

  /**
   * 링이 가득 찼을 때 강제 회수한 결과를 잠시 담아 둔다.
   * 정상 사용(프레임마다 enqueue 1 + poll 1)에서는 비어 있다.
   */
  private readonly spill: Uint8Array[] = []

  constructor(slots: Slot[], byteLength: number) {
    this.slots = slots
    this.depth = slots.length
    this.byteLength = byteLength
  }

  get pending(): number {
    return this.inFlight + this.spill.length
  }

  get lastFrameBytes(): number {
    return this.lastBytes
  }

  enqueue(gl: WebGL2RenderingContext, x: number, y: number, w: number, h: number): void {
    if (this.disposed) throw new Error('PboReader: 이미 dispose 되었다')
    const bytes = assertRequest(this.byteLength, w, h)

    // 링이 가득 차면 어차피 기다려야 한다. 가장 오래된 것을 강제로 내린다.
    if (this.inFlight >= this.depth) this.drainOldestBlocking(gl)

    const slot = this.slots[this.head]
    if (!slot) throw new Error('PboReader: 슬롯이 비었다')

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
    // 오프셋 오버로드다. 마지막 인자가 숫자면 바인딩된 PIXEL_PACK_BUFFER 로 내려간다.
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)

    slot.bytes = bytes
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    // fence 를 실제로 GPU 에 밀어 넣지 않으면 clientWaitSync 가 영원히 TIMEOUT_EXPIRED 다.
    gl.flush()

    this.head = (this.head + 1) % this.depth
    this.inFlight += 1
  }

  poll(gl: WebGL2RenderingContext, out: Uint8Array): boolean {
    if (this.disposed) return false

    const spilled = this.spill.shift()
    if (spilled) {
      this.copyOut(spilled, out)
      return true
    }

    if (this.inFlight === 0) return false
    const slot = this.slots[this.tail]
    if (!slot) return false

    if (!isSignaled(gl, slot.sync)) return false

    this.readSlot(gl, slot, out)
    this.retireTail(gl, slot)
    return true
  }

  async flush(gl: WebGL2RenderingContext, onFrame: (data: Uint8Array) => void): Promise<void> {
    if (this.disposed) return
    const scratch = new Uint8Array(this.byteLength)
    while (this.pending > 0) {
      if (this.poll(gl, scratch)) {
        onFrame(scratch.subarray(0, this.lastBytes))
        continue
      }
      // 아직 GPU 가 안 끝났다. 스핀 대신 이벤트 루프에 양보한다.
      await yieldToHost()
    }
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.disposed) return
    this.disposed = true
    for (const slot of this.slots) {
      if (slot.sync) gl.deleteSync(slot.sync)
      slot.sync = null
      gl.deleteBuffer(slot.buffer)
    }
    this.slots.length = 0
    this.spill.length = 0
    this.inFlight = 0
  }

  /**
   * 링이 가득 찼을 때만 부른다. getBufferSubData 는 fence 와 무관하게
   * 결과가 준비될 때까지 CPU 를 잡으므로 여기서만 멈춘다.
   */
  private drainOldestBlocking(gl: WebGL2RenderingContext): void {
    const slot = this.slots[this.tail]
    if (!slot) return
    const copy = new Uint8Array(slot.bytes)
    this.readSlot(gl, slot, copy)
    this.retireTail(gl, slot)
    this.spill.push(copy)
  }

  private readSlot(gl: WebGL2RenderingContext, slot: Slot, out: Uint8Array): void {
    if (out.length < slot.bytes) {
      throw new Error(`PboReader: out 이 ${slot.bytes}B 보다 작다 (${out.length}B)`)
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out, 0, slot.bytes)
    // 반드시 풀어 준다. 걸어 둔 채로 두면 다른 코드의 평범한 readPixels 가
    // ArrayBufferView 대신 이 버퍼로 내려가 조용히 빈 배열을 받는다.
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.lastBytes = slot.bytes
  }

  private retireTail(gl: WebGL2RenderingContext, slot: Slot): void {
    if (slot.sync) gl.deleteSync(slot.sync)
    slot.sync = null
    this.tail = (this.tail + 1) % this.depth
    this.inFlight -= 1
  }

  private copyOut(src: Uint8Array, out: Uint8Array): void {
    if (out.length < src.length) {
      throw new Error(`PboReader: out 이 ${src.length}B 보다 작다 (${out.length}B)`)
    }
    out.set(src)
    this.lastBytes = src.length
  }
}

/** fence 가 끝났는지 **논블로킹으로** 묻는다. timeout 은 항상 0 이다. */
function isSignaled(gl: WebGL2RenderingContext, sync: WebGLSync | null): boolean {
  if (!sync) return true // fence 생성 실패. 기다릴 방법이 없으니 준비된 것으로 본다.
  const status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0)
  if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return true
  if (status === gl.WAIT_FAILED) {
    // 컨텍스트 로스트 등. 더 기다려도 안 온다. 받아서 넘기고 상위가 판단하게 한다.
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// 동기 폴백
// ---------------------------------------------------------------------------

/**
 * PBO 나 fenceSync 를 못 쓰는 환경(WebGL2 를 흉내 내는 래퍼, 일부 소프트웨어 렌더러)용.
 * enqueue 시점에 그냥 읽어 큐에 쌓는다. 인터페이스 계약은 같지만 파이프라인은 멈춘다.
 */
class SyncReadbackReader implements PboReader {
  readonly mode: ReadbackMode = 'sync'
  readonly depth: number
  readonly byteLength: number
  readonly fallbackReason: string

  private readonly queue: Uint8Array[] = []
  /** 재사용 풀. 매 프레임 새로 할당하지 않는다. */
  private readonly pool: Uint8Array[] = []
  private lastBytes = 0
  private disposed = false

  constructor(byteLength: number, depth: number, reason: string) {
    this.byteLength = byteLength
    this.depth = depth
    this.fallbackReason = reason
  }

  get pending(): number {
    return this.queue.length
  }

  get lastFrameBytes(): number {
    return this.lastBytes
  }

  enqueue(gl: WebGL2RenderingContext, x: number, y: number, w: number, h: number): void {
    if (this.disposed) throw new Error('PboReader: 이미 dispose 되었다')
    const bytes = assertRequest(this.byteLength, w, h)
    const buf = this.pool.pop() ?? new Uint8Array(this.byteLength)
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    this.queue.push(buf.subarray(0, bytes))
  }

  poll(_gl: WebGL2RenderingContext, out: Uint8Array): boolean {
    const head = this.queue.shift()
    if (!head) return false
    if (out.length < head.length) {
      throw new Error(`PboReader: out 이 ${head.length}B 보다 작다 (${out.length}B)`)
    }
    out.set(head)
    this.lastBytes = head.length
    // subarray 는 같은 buffer 를 공유하므로 원본 뷰로 되돌려 풀에 넣는다.
    this.pool.push(new Uint8Array(head.buffer, 0, this.byteLength))
    return true
  }

  async flush(gl: WebGL2RenderingContext, onFrame: (data: Uint8Array) => void): Promise<void> {
    const scratch = new Uint8Array(this.byteLength)
    while (this.queue.length > 0) {
      if (!this.poll(gl, scratch)) break
      onFrame(scratch.subarray(0, this.lastBytes))
    }
  }

  dispose(_gl: WebGL2RenderingContext): void {
    this.disposed = true
    this.queue.length = 0
    this.pool.length = 0
  }
}

// ---------------------------------------------------------------------------
// 생성
// ---------------------------------------------------------------------------

/**
 * 리드백 리더를 만든다.
 *
 * byteLength 는 슬롯 하나의 용량이다. width * height * 4 를 넘긴다.
 * PBO 를 못 만들면 **예외를 던지지 않고** 동기 폴백 리더를 돌려준다.
 * 어느 경로인지는 반환값의 mode / fallbackReason 으로 확인해라.
 */
export function createPboReader(
  gl: WebGL2RenderingContext,
  byteLength: number,
  depth: number = DEFAULT_PBO_DEPTH,
): PboReader {
  const slotCount = Math.max(1, Math.floor(depth))
  const size = Math.max(1, Math.floor(byteLength))

  const reason = detectPboBlocker(gl)
  if (reason) return new SyncReadbackReader(size, slotCount, reason)

  const slots: Slot[] = []
  try {
    for (let i = 0; i < slotCount; i += 1) {
      const buffer = gl.createBuffer()
      if (!buffer) throw new Error('createBuffer 가 null 을 돌려줬다')
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
      // STREAM_READ = 한 번 쓰고 한 번 읽는다. 드라이버가 DMA 로 잡기 좋은 힌트다.
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ)
      slots.push({ buffer, sync: null, bytes: 0 })
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  } catch (err) {
    for (const slot of slots) gl.deleteBuffer(slot.buffer)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    const message = err instanceof Error ? err.message : String(err)
    return new SyncReadbackReader(size, slotCount, `PBO 할당 실패: ${message}`)
  }

  return new PboRingReader(slots, size)
}

/** PBO 경로를 못 타는 이유를 찾는다. 없으면 null. */
function detectPboBlocker(gl: WebGL2RenderingContext): string | null {
  if (gl.isContextLost()) return 'WebGL 컨텍스트가 손실되었다'
  if (typeof gl.fenceSync !== 'function') return 'fenceSync 가 없다 (WebGL2 미지원 래퍼)'
  if (typeof gl.getBufferSubData !== 'function') return 'getBufferSubData 가 없다'
  if (typeof gl.clientWaitSync !== 'function') return 'clientWaitSync 가 없다'
  return null
}
