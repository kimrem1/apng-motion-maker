/**
 * PNG 청크 리더 / 라이터.
 *
 * 청크 레이아웃: length(4, BE) + type(4, ASCII) + data(length) + crc(4, BE)
 * CRC 범위는 type + data 다. length 는 제외한다.
 */

import { crc32 } from './crc32.ts'

/** PNG 파일 시그니처 8바이트. */
export const PNG_SIGNATURE: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

export interface PngChunk {
  /** 4글자 ASCII 타입 ("IHDR", "acTL", "fcTL", "fdAT", "IDAT", "IEND" 등) */
  type: string
  /** 데이터 뷰. 원본 버퍼를 가리키는 subarray 라 복사하지 않는다. */
  data: Uint8Array
  /** 청크 시작 오프셋 (length 필드의 첫 바이트 위치) */
  offset: number
  /** 데이터 길이 (length 필드의 값) */
  length: number
}

export function readUint32BE(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  )
}

export function readUint16BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 8) | bytes[at + 1]!) >>> 0
}

export function writeUint32BE(bytes: Uint8Array, at: number, value: number): void {
  const v = value >>> 0
  bytes[at] = (v >>> 24) & 0xff
  bytes[at + 1] = (v >>> 16) & 0xff
  bytes[at + 2] = (v >>> 8) & 0xff
  bytes[at + 3] = v & 0xff
}

export function writeUint16BE(bytes: Uint8Array, at: number, value: number): void {
  const v = value & 0xffff
  bytes[at] = (v >>> 8) & 0xff
  bytes[at + 1] = v & 0xff
}

/**
 * 청크 하나를 완성된 바이트열로 만든다.
 * type 은 정확히 4글자 ASCII 여야 한다.
 */
export function writeChunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) {
    throw new Error(`청크 타입은 4글자여야 한다: "${type}"`)
  }
  const out = new Uint8Array(12 + data.length)
  writeUint32BE(out, 0, data.length)
  for (let i = 0; i < 4; i++) {
    const code = type.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) {
      throw new Error(`청크 타입에 ASCII 가 아닌 문자가 있다: "${type}"`)
    }
    out[4 + i] = code
  }
  out.set(data, 8)
  // CRC 는 type(4) + data 에 대해 계산한다.
  writeUint32BE(out, 8 + data.length, crc32(out, 4, 4 + data.length))
  return out
}

/**
 * PNG 바이트열을 청크 배열로 분해한다. 검증용이며 시그니처와 경계를 엄격히 본다.
 * CRC 는 여기서 검사하지 않는다. 필요하면 chunkCrcOk 를 쓴다.
 */
export function parseChunks(png: Uint8Array): PngChunk[] {
  if (png.length < PNG_SIGNATURE.length) {
    throw new Error('PNG 시그니처가 들어갈 길이도 안 된다')
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (png[i] !== PNG_SIGNATURE[i]) {
      throw new Error(`PNG 시그니처가 아니다 (offset ${i})`)
    }
  }

  const out: PngChunk[] = []
  let p = PNG_SIGNATURE.length
  while (p < png.length) {
    if (p + 8 > png.length) {
      throw new Error(`청크 헤더가 잘렸다 (offset ${p})`)
    }
    const length = readUint32BE(png, p)
    const typeStart = p + 4
    const dataStart = typeStart + 4
    if (dataStart + length + 4 > png.length) {
      throw new Error(`청크 길이가 버퍼를 넘는다 (offset ${p}, length ${length})`)
    }
    const type = String.fromCharCode(
      png[typeStart]!,
      png[typeStart + 1]!,
      png[typeStart + 2]!,
      png[typeStart + 3]!,
    )
    out.push({ type, data: png.subarray(dataStart, dataStart + length), offset: p, length })
    p = dataStart + length + 4
  }
  if (p !== png.length) {
    throw new Error('청크 경계가 파일 끝과 맞지 않는다')
  }
  return out
}

/** 청크에 기록된 CRC 가 실제 내용과 맞는지 확인한다. */
export function chunkCrcOk(png: Uint8Array, chunk: PngChunk): boolean {
  const stored = readUint32BE(png, chunk.offset + 8 + chunk.length)
  const actual = crc32(png, chunk.offset + 4, 4 + chunk.length)
  return stored === actual
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
