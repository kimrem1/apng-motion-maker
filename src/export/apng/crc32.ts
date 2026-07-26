/**
 * CRC-32 (PNG 사양, 반사형 다항식 0xEDB88320).
 *
 * PNG 청크의 CRC 는 타입 4바이트 + 데이터에 대해 계산한다. 길이 필드는 포함하지 않는다.
 * 결정론적 순수 함수다. window / document 를 참조하지 않으므로 워커에서 그대로 돈다.
 */

/** 표준 CRC-32 테이블. 모듈 로드 시 1회만 만든다. */
const CRC_TABLE: Uint32Array = buildTable()

function buildTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
}

/**
 * bytes[start .. start+length) 의 CRC-32 를 계산한다.
 * 반환값은 부호 없는 32비트 정수다.
 */
export function crc32(bytes: Uint8Array, start = 0, length = bytes.length - start): number {
  let c = 0xffffffff
  const end = start + length
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 이어붙인 두 버퍼를 한 번에 돌리기 위한 누산형. 초기 seed 는 0xffffffff 다. */
export function crc32Update(
  seed: number,
  bytes: Uint8Array,
  start = 0,
  length = bytes.length - start,
): number {
  let c = seed >>> 0
  const end = start + length
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  }
  return c >>> 0
}

/** 누산 결과를 최종 CRC 값으로 마무리한다. */
export function crc32Finish(seed: number): number {
  return (seed ^ 0xffffffff) >>> 0
}
