/**
 * zlib 스트림 생성 (IDAT / fdAT 페이로드용).
 *
 * PNG 의 압축 방식 0 은 "zlib 래퍼를 포함한 deflate" 다.
 * 따라서 CompressionStream('deflate') 을 쓴다. 'deflate-raw' 는 래퍼가 없어 쓰면 안 된다.
 *
 * CompressionStream 이 없는 환경에서는 무압축(stored block) zlib 스트림으로 폴백한다.
 * 파일은 커지지만 디코더 호환성은 동일하다. 정확성이 우선이다.
 */

/** deflate 무압축 블록 1개의 최대 길이. LEN 이 uint16 이라 65535 다. */
const MAX_STORED_BLOCK = 0xffff

/** adler32 누산 시 오버플로가 나지 않는 최대 반복 수. */
const ADLER_NMAX = 5552
const ADLER_MOD = 65521

export interface DeflateResult {
  data: Uint8Array
  /** true 면 CompressionStream 이 없어 무압축 폴백을 탔다. */
  usedFallback: boolean
}

/** 현재 런타임에 네이티브 deflate 가 있는지. */
export function hasNativeDeflate(): boolean {
  return typeof CompressionStream !== 'undefined'
}

/** zlib 체크섬. 무압축 폴백에서 직접 써야 하므로 노출한다. */
export function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  let i = 0
  while (i < data.length) {
    const end = Math.min(i + ADLER_NMAX, data.length)
    for (; i < end; i++) {
      a += data[i]!
      b += a
    }
    a %= ADLER_MOD
    b %= ADLER_MOD
  }
  return (((b << 16) | a) >>> 0)
}

/**
 * 무압축 deflate. zlib 헤더(0x78 0x01) + stored block 들 + adler32(BE).
 *
 * stored block 헤더 바이트: BFINAL(1비트) + BTYPE=00(2비트). 나머지 비트는 버리고
 * 바이트 경계에 맞춘 뒤 LEN(2, LE) + NLEN(2, LE, LEN 의 1의 보수) 이 온다.
 */
export function zlibStored(data: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(data.length / MAX_STORED_BLOCK))
  const out = new Uint8Array(2 + blockCount * 5 + data.length + 4)
  // zlib 헤더: CMF=0x78 (deflate, 32K 윈도) / FLG=0x01 (FLEVEL=0, FDICT=0, (0x78*256+1)%31===0)
  out[0] = 0x78
  out[1] = 0x01

  let at = 2
  let read = 0
  for (let block = 0; block < blockCount; block++) {
    const len = Math.min(MAX_STORED_BLOCK, data.length - read)
    const isLast = block === blockCount - 1
    out[at++] = isLast ? 0x01 : 0x00
    out[at++] = len & 0xff
    out[at++] = (len >>> 8) & 0xff
    const nlen = ~len & 0xffff
    out[at++] = nlen & 0xff
    out[at++] = (nlen >>> 8) & 0xff
    if (len > 0) {
      out.set(data.subarray(read, read + len), at)
      at += len
      read += len
    }
  }

  const sum = adler32(data)
  out[at++] = (sum >>> 24) & 0xff
  out[at++] = (sum >>> 16) & 0xff
  out[at++] = (sum >>> 8) & 0xff
  out[at++] = sum & 0xff
  return out.subarray(0, at)
}

/**
 * zlib 압축. 폴백 여부까지 알려준다.
 * 읽기와 쓰기를 동시에 진행해야 큰 입력에서 백프레셔로 교착되지 않는다.
 */
export async function zlibDeflateWithInfo(data: Uint8Array): Promise<DeflateResult> {
  if (typeof CompressionStream === 'undefined') {
    return { data: zlibStored(data), usedFallback: true }
  }

  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  const reader = cs.readable.getReader()

  const chunks: Uint8Array[] = []
  let total = 0
  const pump = (async () => {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      const chunk = result.value as Uint8Array
      chunks.push(chunk)
      total += chunk.length
    }
  })()

  // TS 5.7+ 는 Uint8Array 를 버퍼 종류로 구분한다(ArrayBuffer vs SharedArrayBuffer).
  // WritableStreamDefaultWriter 는 ArrayBuffer 뒷받침만 받는데, 여기 오는 값은
  // 항상 일반 ArrayBuffer 다. 타입만 좁힌다.
  await writer.write(data as unknown as ArrayBufferView<ArrayBuffer>)
  await writer.close()
  await pump

  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return { data: out, usedFallback: false }
}

/** zlib 래퍼를 포함한 압축 결과. IDAT / fdAT 에 그대로 넣을 수 있다. */
export async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const result = await zlibDeflateWithInfo(data)
  return result.data
}
