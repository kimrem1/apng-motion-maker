/**
 * RIFF 컨테이너 리더 / 라이터 (WebP 전용).
 *
 * WebP 는 RIFF 위에 얹힌 포맷이다. PNG 와 비교하면 두 가지가 다르다.
 *
 * 1. CRC 가 없다. 청크를 갈아끼워도 체크섬을 다시 계산할 일이 없다.
 *    WebP 의 루프 카운트 패치가 APNG 보다 간단한 이유가 이것이다.
 * 2. 리틀엔디언이다. PNG 는 전부 빅엔디언이라 두 모듈의 정수 유틸을 섞으면 안 된다.
 *    그래서 apng/chunks.ts 를 재사용하지 않고 별도로 둔다.
 *
 * 청크 레이아웃: fourCC(4, ASCII) + size(4, LE) + data(size) + pad(size 가 홀수면 1)
 *
 * 패딩이 이 파일의 핵심이다. size 필드에는 패딩을 세지 않지만 다음 청크는 짝수
 * 오프셋에서 시작해야 한다. 패드 바이트를 빼먹으면 그 뒤 청크가 전부 한 칸씩 밀려
 * 디코더가 파일을 통째로 거부한다. 홀수 길이 청크는 ALPH 와 VP8 비트스트림에서
 * 흔하게 나오므로 우연히 넘어가는 경우가 없다.
 */

/** RIFF 컨테이너 fourCC. */
export const RIFF_FOURCC = 'RIFF'
/** WebP 폼 타입 fourCC. */
export const WEBP_FOURCC = 'WEBP'

/** 24비트 필드의 최댓값. ANMF duration 과 VP8X 캔버스 크기가 이 폭이다. */
export const UINT24_MAX = 0xffffff

export interface RiffChunk {
  /** 4글자 ASCII. 손실 비트스트림은 뒤에 공백이 붙은 "VP8 " 이다. */
  fourCC: string
  /** 페이로드 뷰. 원본 버퍼를 가리키는 subarray 라 복사하지 않는다. */
  data: Uint8Array
  /** 청크 시작 오프셋 (fourCC 첫 바이트 위치) */
  offset: number
  /** size 필드 값. 패딩 바이트는 포함하지 않는다. */
  length: number
}

// ---------------------------------------------------------------------------
// 정수 (전부 리틀엔디언)
// ---------------------------------------------------------------------------

export function readUint16LE(bytes: Uint8Array, at: number): number {
  return (byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8)) >>> 0
}

export function writeUint16LE(bytes: Uint8Array, at: number, value: number): void {
  const v = value & 0xffff
  bytes[at] = v & 0xff
  bytes[at + 1] = (v >>> 8) & 0xff
}

/**
 * 3바이트 정수. ANMF 의 좌표 / 크기 / duration 과 VP8X 캔버스 크기가 전부 이 폭이다.
 * WebP 먹싱에서 가장 자주 틀리는 지점이라 읽기/쓰기를 한 쌍으로 둔다.
 */
export function readUint24LE(bytes: Uint8Array, at: number): number {
  return (byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8) | (byteAt(bytes, at + 2) << 16)) >>> 0
}

export function writeUint24LE(bytes: Uint8Array, at: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT24_MAX) {
    throw new Error(`24비트 필드는 0..${UINT24_MAX} 정수여야 한다: ${value}`)
  }
  bytes[at] = value & 0xff
  bytes[at + 1] = (value >>> 8) & 0xff
  bytes[at + 2] = (value >>> 16) & 0xff
}

export function readUint32LE(bytes: Uint8Array, at: number): number {
  return (
    (byteAt(bytes, at) |
      (byteAt(bytes, at + 1) << 8) |
      (byteAt(bytes, at + 2) << 16) |
      (byteAt(bytes, at + 3) << 24)) >>>
    0
  )
}

export function writeUint32LE(bytes: Uint8Array, at: number, value: number): void {
  const v = value >>> 0
  bytes[at] = v & 0xff
  bytes[at + 1] = (v >>> 8) & 0xff
  bytes[at + 2] = (v >>> 16) & 0xff
  bytes[at + 3] = (v >>> 24) & 0xff
}

function byteAt(bytes: Uint8Array, at: number): number {
  const v = bytes[at]
  if (v === undefined) throw new Error(`RIFF: offset ${at} 가 버퍼 범위를 벗어났다`)
  return v
}

// ---------------------------------------------------------------------------
// fourCC
// ---------------------------------------------------------------------------

export function readFourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(
    byteAt(bytes, at),
    byteAt(bytes, at + 1),
    byteAt(bytes, at + 2),
    byteAt(bytes, at + 3),
  )
}

export function writeFourCC(bytes: Uint8Array, at: number, fourCC: string): void {
  if (fourCC.length !== 4) {
    throw new Error(`fourCC 는 4글자여야 한다: "${fourCC}"`)
  }
  for (let i = 0; i < 4; i += 1) {
    const code = fourCC.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) {
      throw new Error(`fourCC 에 출력 가능한 ASCII 가 아닌 문자가 있다: "${fourCC}"`)
    }
    bytes[at + i] = code
  }
}

// ---------------------------------------------------------------------------
// 청크
// ---------------------------------------------------------------------------

/**
 * 청크 하나를 완성된 바이트열로 만든다.
 * data 길이가 홀수면 뒤에 0 바이트 하나를 붙인다. size 필드에는 그 패드를 세지 않는다.
 */
export function writeChunk(fourCC: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1
  const out = new Uint8Array(8 + data.length + pad)
  writeFourCC(out, 0, fourCC)
  writeUint32LE(out, 4, data.length)
  out.set(data, 8)
  // 패드 바이트는 new Uint8Array 가 이미 0 으로 채워 두었다.
  return out
}

/**
 * 청크가 연달아 놓인 구간을 분해한다.
 * RIFF 헤더(12바이트)를 이미 건너뛴 위치를 넘겨야 한다. 파일 전체는 parseRiff 를 쓴다.
 *
 * ANMF 페이로드 안의 서브청크(ALPH / VP8 / VP8L)도 같은 함수로 읽는다.
 */
export function readChunks(bytes: Uint8Array, start = 0, end: number = bytes.length): RiffChunk[] {
  const limit = Math.min(end, bytes.length)
  const out: RiffChunk[] = []
  let p = start

  while (p + 8 <= limit) {
    const fourCC = readFourCC(bytes, p)
    const length = readUint32LE(bytes, p + 4)
    const dataStart = p + 8
    if (dataStart + length > limit) {
      throw new Error(`RIFF: "${fourCC}" 청크 길이가 버퍼를 넘는다 (offset ${p}, size ${length})`)
    }
    out.push({ fourCC, data: bytes.subarray(dataStart, dataStart + length), offset: p, length })
    // 패드 포함해 다음 청크로. 마지막 청크의 패드가 잘려 있어도 그대로 끝낸다.
    p = dataStart + length + (length & 1)
  }

  return out
}

/** 첫 번째로 나오는 해당 fourCC 청크. 없으면 null. */
export function findChunk(chunks: readonly RiffChunk[], fourCC: string): RiffChunk | null {
  for (const chunk of chunks) {
    if (chunk.fourCC === fourCC) return chunk
  }
  return null
}

/**
 * 이미 writeChunk 로 만든 청크들을 RIFF 컨테이너로 감싼다.
 * 헤더: "RIFF" + size(4, LE) + formType(4)
 * size 는 파일 전체 길이에서 8 을 뺀 값, 즉 formType + 청크 전부의 길이다.
 */
export function buildRiff(chunks: readonly Uint8Array[], formType: string = WEBP_FOURCC): Uint8Array {
  let payload = 0
  for (const chunk of chunks) payload += chunk.length

  const out = new Uint8Array(12 + payload)
  writeFourCC(out, 0, RIFF_FOURCC)
  writeUint32LE(out, 4, 4 + payload)
  writeFourCC(out, 8, formType)

  let at = 12
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export interface RiffFile {
  formType: string
  chunks: RiffChunk[]
  /** 헤더의 size 필드 값 */
  declaredSize: number
}

/** RIFF 파일 전체를 분해한다. 시그니처와 폼 타입을 검사한다. */
export function parseRiff(bytes: Uint8Array, expectedFormType: string | null = WEBP_FOURCC): RiffFile {
  if (bytes.length < 12) {
    throw new Error('RIFF: 헤더 12바이트도 안 되는 길이다')
  }
  const riff = readFourCC(bytes, 0)
  if (riff !== RIFF_FOURCC) {
    throw new Error(`RIFF: 시그니처가 아니다 ("${riff}")`)
  }
  const declaredSize = readUint32LE(bytes, 4)
  const formType = readFourCC(bytes, 8)
  if (expectedFormType !== null && formType !== expectedFormType) {
    throw new Error(`RIFF: 폼 타입이 "${expectedFormType}" 가 아니다 ("${formType}")`)
  }
  if (declaredSize < 4) {
    throw new Error(`RIFF: size 필드가 너무 작다 (${declaredSize})`)
  }
  // 선언 길이가 실제보다 크면 잘린 파일이다. 조용히 넘기면 파서가 엉뚱한 값을 읽는다.
  if (8 + declaredSize > bytes.length) {
    throw new Error(`RIFF: size 필드가 버퍼를 넘는다 (${8 + declaredSize} > ${bytes.length})`)
  }

  return { formType, declaredSize, chunks: readChunks(bytes, 12, 8 + declaredSize) }
}

/** 조각들을 하나의 연속 버퍼로 합친다. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
