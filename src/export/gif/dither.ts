/**
 * Bayer 8x8 오디널 디더.
 *
 * **왜 Floyd-Steinberg 가 아닌가**
 * FS 같은 오차 확산 디더는 픽셀 값이 조금만 달라져도 오차가 스캔라인을 따라
 * 다르게 전파된다. 그래서 인접 프레임의 내용이 거의 같아도 디더 패턴이 통째로
 * 바뀐다. 결과는 두 가지 손해다.
 *   1) 애니메이션에서 정지한 영역까지 매 프레임 지글거린다 (crawling / boiling).
 *   2) 프레임 간 픽셀이 달라지므로 GIF 의 델타(LZW 반복) 압축 효율이 무너져
 *      파일이 크게 부푼다.
 * Bayer 오디널 디더는 화면 좌표에만 의존하는 고정 임계값 행렬이라
 * 같은 입력 픽셀이면 언제나 같은 출력이 나온다. 두 문제가 모두 사라지고
 * 결정론도 공짜로 얻는다.
 */

/**
 * 표준 8x8 Bayer(오디널) 행렬. 값 범위 0..63.
 * 재귀 정의 M(2n) = [[4M, 4M+2], [4M+3, 4M+1]] 로 만들어진 고전 배열이다.
 */
export const BAYER_8X8: readonly number[] = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]

/** Bayer 행렬 한 변의 길이. */
export const BAYER_SIZE = 8

/**
 * strength 1.0 일 때 채널에 더해지는 최대 진폭(±).
 * 팔레트가 촘촘할수록 작은 값이 좋지만, 인터페이스가 strength 하나뿐이라
 * 64색(채널당 대략 32 스텝) 기준으로 눈에 띄면서도 과하지 않은 값을 고정으로 쓴다.
 */
export const DITHER_MAX_AMPLITUDE = 32

/**
 * 양자화 전에 픽셀 값에 Bayer 임계 오프셋을 더한다.
 *
 * 알파 채널은 건드리지 않는다. 알파를 디더하면 1비트 투명 경계가 프레임마다
 * 들쭉날쭉해져서 테두리가 떨린다.
 *
 * @param rgba   RGBA8 픽셀. 길이는 width * height * 4 여야 한다.
 * @param width  픽셀 폭
 * @param height 픽셀 높이
 * @param strength 0 = 끔, 1 = 최대. 범위를 벗어나면 클램프한다.
 * @returns 항상 새로 할당한 Uint8Array (입력은 변형하지 않는다).
 */
export function applyBayerDither(
  rgba: Uint8Array,
  width: number,
  height: number,
  strength: number,
): Uint8Array {
  const expected = width * height * 4
  if (rgba.length !== expected) {
    throw new Error(
      `applyBayerDither: 픽셀 길이 불일치 (기대 ${expected}, 실제 ${rgba.length})`,
    )
  }

  // 입력 변형 금지. 항상 새 버퍼를 만든다.
  const out = new Uint8Array(rgba.length)
  out.set(rgba)

  const s = strength < 0 ? 0 : strength > 1 ? 1 : strength
  if (s === 0) return out

  const amplitude = DITHER_MAX_AMPLITUDE * s

  for (let y = 0; y < height; y += 1) {
    const rowBase = (y & (BAYER_SIZE - 1)) * BAYER_SIZE
    for (let x = 0; x < width; x += 1) {
      // (m + 0.5) / 64 - 0.5 -> [-0.5, 0.5) 대칭 오프셋. 평균 0 이라 밝기가 밀리지 않는다.
      const m = BAYER_8X8[rowBase + (x & (BAYER_SIZE - 1))] ?? 0
      const offset = ((m + 0.5) / (BAYER_SIZE * BAYER_SIZE) - 0.5) * amplitude

      const i = (y * width + x) * 4
      out[i] = clampByte((rgba[i] ?? 0) + offset)
      out[i + 1] = clampByte((rgba[i + 1] ?? 0) + offset)
      out[i + 2] = clampByte((rgba[i + 2] ?? 0) + offset)
      // out[i + 3] (알파) 는 그대로 둔다.
    }
  }

  return out
}

/** 0..255 로 반올림 + 클램프. */
function clampByte(v: number): number {
  const r = Math.round(v)
  return r < 0 ? 0 : r > 255 ? 255 : r
}
