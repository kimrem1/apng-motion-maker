/**
 * 자체 APNG 인코더.
 *
 * upng-js@2.1.0 은 encode(bufs,w,h,ps,dels,forbidPlte) 6인자라 num_plays 를 줄 수 없고
 * fcTL 의 delay_den 이 1000 으로 하드코딩돼 있다. 그래서 직접 먹싱한다.
 *
 * 청크 순서:
 *   시그니처, IHDR, acTL, [PLTE, tRNS], (프레임0) fcTL + IDAT, (프레임N) fcTL + fdAT ..., IEND
 *
 * sequence_number 는 fcTL 과 fdAT 를 통틀어 0부터 1씩 증가한다.
 * 프레임 n 개면 마지막 번호는 2n-2 다. 이걸 틀리면 디코더가 파일을 거부한다.
 * 프레임을 잘라 써도 이 규칙은 그대로다.
 *
 * 크기 최적화가 두 가지 들어 있다.
 *   1) 프레임 차분 사각형 (diff.ts). 바뀐 영역만 fdAT 로 쓰고 fcTL 오프셋을 맞춘다.
 *   2) 무손실 팔레트화 (quantize.ts). 전 프레임 고유색이 256개 이하면 color type 3.
 * 둘 다 기본 켜짐이고 둘 다 무손실이다. 끄려면 diff:false / palette:false 를 준다.
 *
 * window / document 를 import 하지 않으므로 워커에서 그대로 돈다.
 */

import { concatBytes, PNG_SIGNATURE, writeChunk, writeUint16BE, writeUint32BE } from './chunks.ts'
import { zlibDeflate } from './deflate.ts'
import { yieldToHost } from '../yield.ts'
import { filterScanlines } from './filter.ts'
import { changedRect, cropFrame, cropFrameOverDelta, pickBlendOp, type FrameRect } from './diff.ts'
import { buildGlobalPalette, filterIndexed, mapToIndices, type GlobalPalette } from './quantize.ts'

/** fcTL dispose_op */
export const DISPOSE_OP_NONE = 0
export const DISPOSE_OP_BACKGROUND = 1
export const DISPOSE_OP_PREVIOUS = 2

/** fcTL blend_op */
export const BLEND_OP_SOURCE = 0
export const BLEND_OP_OVER = 1

/** IHDR color type 6 = truecolour with alpha */
export const COLOR_TYPE_RGBA = 6
/** IHDR color type 3 = indexed colour (PLTE 필수) */
export const COLOR_TYPE_PALETTE = 3

const BIT_DEPTH_8 = 8

const UINT16_MAX = 0xffff
const UINT32_MAX = 0xffffffff

export interface ApngFrame {
  /** straight alpha RGBA8. width*height*4 바이트. 프리멀티플라이가 아니다. */
  rgba: Uint8Array
  /** 지연 분자. 반올림하지 않고 그대로 기록한다. */
  delayNum: number
  /** 지연 분모. num=1, den=fps 면 24/30fps 가 무손실이다. */
  delayDen: number
}

export interface ApngOptions {
  width: number
  height: number
  /** 0 = 무한 반복 */
  numPlays: number
  /**
   * 프레임 차분 사각형. 기본 true.
   * false 면 모든 프레임을 전체 크기로 쓴다 (디버깅용).
   */
  diff?: boolean
  /**
   * 무손실 팔레트화. 기본 true.
   * 전 프레임 고유색이 256개 이하일 때만 발동한다. 넘으면 자동으로 RGBA 로 남는다.
   * 색을 줄이는 손실 변환은 하지 않는다 (quantize.ts 주석 참고).
   */
  palette?: boolean
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

function abortError(): Error {
  const err = new Error('APNG 인코딩이 취소되었다')
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

function assertUint16(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
    throw new Error(`${label} 은 0..65535 정수여야 한다: ${value}`)
  }
}

/** IHDR 데이터 13바이트. */
function buildIhdr(width: number, height: number, colorType: number): Uint8Array {
  const data = new Uint8Array(13)
  writeUint32BE(data, 0, width)
  writeUint32BE(data, 4, height)
  data[8] = BIT_DEPTH_8
  data[9] = colorType
  data[10] = 0 // compression method: deflate
  data[11] = 0 // filter method: adaptive
  data[12] = 0 // interlace: none
  return data
}

/** acTL 데이터 8바이트. num_frames + num_plays. */
function buildActl(numFrames: number, numPlays: number): Uint8Array {
  const data = new Uint8Array(8)
  writeUint32BE(data, 0, numFrames)
  writeUint32BE(data, 4, numPlays)
  return data
}

/** fcTL 데이터 26바이트. */
function buildFctl(
  sequenceNumber: number,
  width: number,
  height: number,
  xOffset: number,
  yOffset: number,
  delayNum: number,
  delayDen: number,
  disposeOp: number,
  blendOp: number,
): Uint8Array {
  const data = new Uint8Array(26)
  writeUint32BE(data, 0, sequenceNumber)
  writeUint32BE(data, 4, width)
  writeUint32BE(data, 8, height)
  writeUint32BE(data, 12, xOffset)
  writeUint32BE(data, 16, yOffset)
  writeUint16BE(data, 20, delayNum)
  writeUint16BE(data, 22, delayDen)
  data[24] = disposeOp
  data[25] = blendOp
  return data
}

/** fdAT 데이터. sequence_number(4) + 압축 데이터. */
function buildFdat(sequenceNumber: number, compressed: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + compressed.length)
  writeUint32BE(data, 0, sequenceNumber)
  data.set(compressed, 4)
  return data
}

/** 사각형만큼 잘린 RGBA 를 필터링된 스캔라인으로 만든다. 팔레트면 인덱스로 먼저 옮긴다. */
function filterPayload(rgba: Uint8Array, rect: FrameRect, pal: GlobalPalette | null): Uint8Array {
  if (pal === null) return filterScanlines(rgba, rect.w, rect.h)
  return filterIndexed(mapToIndices(rgba, pal.lookup), rect.w, rect.h)
}

/** 프레임 하나가 차지할 사각형과 blend_op, 그리고 그 사각형의 RGBA 를 정한다. */
function planFrame(
  prev: Uint8Array | null,
  cur: Uint8Array,
  width: number,
  height: number,
  pal: GlobalPalette | null,
): { rect: FrameRect; blendOp: number; payload: Uint8Array } {
  // 첫 프레임(prev === null)과 diff 를 끈 경우는 항상 전체 사각형이다.
  if (prev === null) {
    return { rect: { x: 0, y: 0, w: width, h: height }, blendOp: BLEND_OP_SOURCE, payload: cur }
  }

  const changed = changedRect(prev, cur, width, height)
  if (changed === null) {
    // 변경이 전혀 없는 프레임. 1x1 더미 사각형으로 쓰되 delay 는 그대로 유지한다.
    // (0,0) 픽셀의 현재 값을 SOURCE 로 다시 쓰면 버퍼가 그대로라 무조건 무손실이다.
    // 정지 구간이 프레임당 수십 바이트로 떨어진다.
    const rect: FrameRect = { x: 0, y: 0, w: 1, h: 1 }
    return { rect, blendOp: BLEND_OP_SOURCE, payload: cropFrame(cur, width, rect) }
  }

  const blendOp = pickBlendOp(prev, cur, changed, width)
  // OVER 를 고른 사각형에서만 "안 바뀐 픽셀 = 완전 투명" 델타를 쓸 수 있다.
  // 팔레트 모드에서는 (0,0,0,0) 이 팔레트에 있어야 인덱스를 쓸 수 있다.
  const canDelta =
    blendOp === BLEND_OP_OVER && (pal === null || pal.transparentIndex >= 0)
  const payload = canDelta
    ? cropFrameOverDelta(prev, cur, width, changed)
    : cropFrame(cur, width, changed)
  return { rect: changed, blendOp, payload }
}

export interface ApngStreamOptions {
  width: number
  height: number
  /** 0 = 무한 반복 */
  numPlays: number
  /**
   * 전체 프레임 수. acTL(num_frames)이 파일 머리에 있어서 시작 전에 알아야 한다.
   * finish 까지 넣은 프레임 수가 이 값과 다르면 finish 가 던진다.
   */
  frameCount: number
  /** 프레임 차분 사각형. 기본 true. */
  diff?: boolean
  signal?: AbortSignal
}

/**
 * 프레임 push 형 APNG 인코더. encodeApng 는 이 클래스 위의 래퍼다.
 *
 * 내보내기 파이프라인의 스트리밍 경로가 렌더한 프레임을 즉시 여기 넣고 원시
 * RGBA 를 버린다. 차분(planFrame)에 필요한 것은 직전 프레임 하나뿐이라 상주
 * 메모리가 프레임 2장 + 압축 청크로 떨어진다.
 *
 * 팔레트(pal)는 전 프레임을 미리 훑어야 만들 수 있으므로 통짜 경로에서만 쓴다.
 * 스트리밍 호출자는 null 을 넘긴다. 700MB 를 넘는 내보내기가 전 프레임 256색
 * 이하일 가능성은 사실상 없어서 실질 손해도 없다.
 */
export class ApngStreamEncoder {
  private readonly parts: Uint8Array[]
  private readonly opts: ApngStreamOptions
  private readonly pal: GlobalPalette | null
  private readonly useDiff: boolean
  private sequenceNumber = 0
  private prev: Uint8Array | null = null
  private added = 0
  private finished = false
  /**
   * addFrame 도중 실패(취소 / deflate 오류)하면 true.
   * fcTL 을 push 한 뒤 deflate 에서 던지면 parts 에 데이터 없는 고아 fcTL 이 남는다.
   * 그 상태로 계속 쓰면 sequence_number 가 어긋난 손상 파일이 조용히 나온다.
   */
  private broken = false
  private written = 0
  /**
   * drain 으로 조각을 흘려보낸 적이 있는가.
   *
   * drain 을 쓰면 이 객체 안에는 파일의 뒷부분만 남는다. 그 상태로 finish() 를
   * 부르면 앞부분이 빠진 파일이 조용히 나온다. 그래서 막는다.
   */
  private drained = false

  constructor(opts: ApngStreamOptions, pal: GlobalPalette | null = null) {
    const { width, height, numPlays, frameCount } = opts
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`캔버스 크기가 잘못됐다: ${width}x${height}`)
    }
    if (!Number.isInteger(frameCount) || frameCount <= 0) {
      throw new Error('프레임이 하나도 없다')
    }
    if (!Number.isInteger(numPlays) || numPlays < 0 || numPlays > UINT32_MAX) {
      throw new Error(`numPlays 는 0..4294967295 정수여야 한다: ${numPlays}`)
    }

    this.opts = opts
    this.pal = pal
    this.useDiff = opts.diff !== false
    this.parts = [
      PNG_SIGNATURE,
      writeChunk('IHDR', buildIhdr(width, height, pal ? COLOR_TYPE_PALETTE : COLOR_TYPE_RGBA)),
      writeChunk('acTL', buildActl(frameCount, numPlays)),
    ]
    if (pal) {
      // PLTE 와 tRNS 는 IDAT 앞이면 된다. acTL 도 IDAT 앞이면 되므로 순서는 자유롭다.
      // acTL 을 IHDR 바로 뒤에 두는 배치가 apngasm 출력과 같다.
      this.parts.push(writeChunk('PLTE', pal.palette))
      if (pal.trns) this.parts.push(writeChunk('tRNS', pal.trns))
    }
  }

  /** 지금까지 쌓인 압축 출력 바이트. 파이프라인이 출력 폭주를 감시할 때 쓴다. */
  get bytesWritten(): number {
    return this.written
  }

  /**
   * 프레임 하나를 인코딩해 붙인다.
   * **넘긴 rgba 는 다음 addFrame 까지 차분 기준으로 참조한다. 재사용 버퍼를 넘기면 안 된다.**
   */
  async addFrame(frame: ApngFrame): Promise<void> {
    const { width, height, signal } = this.opts
    throwIfAborted(signal)
    if (this.broken) throw new Error('이전 프레임이 실패한 세션이다. 새로 만들어야 한다')
    if (this.finished) throw new Error('finish 뒤에 addFrame 을 불렀다')
    if (this.added >= this.opts.frameCount) {
      throw new Error(`선언한 프레임 수(${this.opts.frameCount})보다 많이 넣었다`)
    }

    const i = this.added
    const expectedBytes = width * height * 4
    if (frame.rgba.length !== expectedBytes) {
      throw new Error(
        `프레임 ${i} 의 RGBA 길이가 맞지 않는다: ${frame.rgba.length} != ${expectedBytes}`,
      )
    }
    assertUint16(frame.delayNum, `프레임 ${i} 의 delayNum`)
    assertUint16(frame.delayDen, `프레임 ${i} 의 delayDen`)

    try {
      const { rect, blendOp, payload } = planFrame(
        this.useDiff ? this.prev : null,
        frame.rgba,
        width,
        height,
        this.pal,
      )

      const fctl = writeChunk(
        'fcTL',
        buildFctl(
          this.sequenceNumber++,
          rect.w,
          rect.h,
          rect.x,
          rect.y,
          frame.delayNum,
          frame.delayDen,
          // dispose 는 언제나 NONE 이다. 차분은 이전 프레임이 버퍼에 남아야 성립한다.
          DISPOSE_OP_NONE,
          blendOp,
        ),
      )
      this.parts.push(fctl)
      this.written += fctl.length

      const compressed = await zlibDeflate(filterPayload(payload, rect, this.pal))

      throwIfAborted(signal)

      let data: Uint8Array
      if (i === 0) {
        // 첫 프레임의 픽셀은 IDAT 다. IDAT 에는 sequence_number 가 없다.
        data = writeChunk('IDAT', compressed)
      } else {
        data = writeChunk('fdAT', buildFdat(this.sequenceNumber++, compressed))
      }
      this.parts.push(data)
      this.written += data.length
    } catch (err) {
      // fcTL 만 push 된 채 던졌을 수 있다. 이후 호출을 막지 않으면 재시도한 호출자가
      // added 카운트가 맞아떨어지는 손상 파일을 받아 간다.
      this.broken = true
      throw err
    }

    this.prev = frame.rgba
    this.added += 1
  }

  /**
   * 지금까지 쌓인 조각을 넘기고 내부 목록을 비운다.
   *
   * **왜 필요한가.** APNG 는 무손실이라 큰 캔버스에서 출력이 GB 단위로 간다.
   * 조각을 finish 까지 전부 들고 있다가 한 번에 이어붙이면, 그 순간 원본만 한
   * 연속 버퍼가 하나 더 필요하다. 1GB 파일이 2GB 를 쓰고, 호출자가 Blob 으로
   * 옮기면 또 하나가 붙는다. 조각을 그때그때 Blob 으로 흘려보내면 JS 힙에는
   * 마지막 몇 MB 만 남는다.
   *
   * 돌려준 배열의 조각은 이 객체가 더 이상 참조하지 않는다. 호출자 것이다.
   * drain 을 한 번이라도 쓴 세션은 finish() 대신 finishParts() 로 닫아야 한다.
   */
  drain(): Uint8Array[] {
    if (this.finished) throw new Error('finish 뒤에 drain 을 불렀다')
    if (this.parts.length === 0) return []
    this.drained = true
    return this.parts.splice(0, this.parts.length)
  }

  /**
   * IEND 를 붙이고 **남은 조각**을 돌려준다. 이어붙이지 않는다.
   * 호출자가 Blob 으로 바로 옮기면 큰 연속 버퍼를 한 번도 만들지 않는다.
   */
  finishParts(): Uint8Array[] {
    if (this.broken) throw new Error('실패한 세션은 마무리할 수 없다')
    if (this.finished) throw new Error('finish 를 두 번 불렀다')
    if (this.added !== this.opts.frameCount) {
      // acTL 에 이미 frameCount 를 썼다. 모자란 채로 닫으면 디코더가 파일을 거부한다.
      throw new Error(`프레임이 모자란다: ${this.added} / ${this.opts.frameCount}`)
    }
    this.finished = true
    this.parts.push(writeChunk('IEND', new Uint8Array(0)))
    return this.parts.splice(0, this.parts.length)
  }

  /** IEND 를 붙이고 완성된 파일 바이트를 돌려준다. */
  finish(): Uint8Array {
    if (this.drained) {
      throw new Error('drain 을 쓴 세션은 finishParts 로 닫아야 한다. finish 는 앞부분이 빠진다')
    }
    return concatBytes(this.finishParts())
  }
}

/**
 * 프레임 배열을 APNG 바이트열로 먹싱한다.
 * 프레임마다 onProgress 를 부르고 signal.aborted 를 확인한다.
 * ApngStreamEncoder 의 래퍼라 스트리밍 경로와 바이트 단위로 같은 파일을 만든다.
 */
export async function encodeApng(frames: ApngFrame[], opts: ApngOptions): Promise<Uint8Array> {
  const { width, height, numPlays, onProgress, signal } = opts
  const usePalette = opts.palette !== false

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`캔버스 크기가 잘못됐다: ${width}x${height}`)
  }
  if (frames.length === 0) {
    throw new Error('프레임이 하나도 없다')
  }
  if (!Number.isInteger(numPlays) || numPlays < 0 || numPlays > UINT32_MAX) {
    throw new Error(`numPlays 는 0..4294967295 정수여야 한다: ${numPlays}`)
  }

  const expectedBytes = width * height * 4
  const total = frames.length

  // 팔레트를 만들려면 모든 프레임을 먼저 훑어야 한다. 그 전에 입력을 전부 검증한다.
  // (루프 안에서만 검증하면 팔레트 수집 쪽에서 엉뚱한 에러가 먼저 난다.)
  for (let i = 0; i < total; i++) {
    const frame = frames[i]!
    if (frame.rgba.length !== expectedBytes) {
      throw new Error(
        `프레임 ${i} 의 RGBA 길이가 맞지 않는다: ${frame.rgba.length} != ${expectedBytes}`,
      )
    }
    assertUint16(frame.delayNum, `프레임 ${i} 의 delayNum`)
    assertUint16(frame.delayDen, `프레임 ${i} 의 delayDen`)
  }

  throwIfAborted(signal)

  // 팔레트는 전 프레임 공통이다. PLTE 는 파일에 하나뿐이라 프레임마다 다르게 못 쓴다.
  const pal = usePalette ? buildGlobalPalette(frames.map((f) => f.rgba)) : null

  throwIfAborted(signal)

  const stream = new ApngStreamEncoder(
    { width, height, numPlays, frameCount: total, diff: opts.diff, signal },
    pal,
  )

  for (let i = 0; i < total; i++) {
    await stream.addFrame(frames[i]!)
    onProgress?.(i + 1, total)
    // CompressionStream 폴백(무압축 경로)에서는 위의 await 가 실질적으로 양보하지
    // 않는다. 그러면 인코딩 내내 메인 스레드가 막혀 취소 버튼과 진행률이 죽는다.
    await yieldToHost()
  }

  return stream.finish()
}
