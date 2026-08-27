/**
 * 용량 다이어트 필터.
 *
 * 해상도도 프레임 수도 색상 수도 줄이지 않고 파일만 줄이는 두 가지를 한다.
 * 둘 다 straight alpha RGBA 버퍼를 제자리에서 고치는 순수 함수라, 렌더와 인코더
 * 사이 한 자리에만 끼면 세 포맷 전부가 같은 이득을 본다 (export/pipeline.ts).
 *
 *   1. 그레인 제거   프레임마다 달라지는 미세 노이즈를 걷어낸다
 *   2. 얼리기        화면에 이미 찍혀 있는 색과 충분히 가까우면 갱신하지 않는다
 *
 * 왜 이게 효과가 큰가
 *
 * 애니메이션 포맷은 전부 "직전 프레임과 무엇이 달라졌는가" 로 산다. APNG 는 바뀐
 * 사각형만 fdAT 로 쓰고(export/apng/diff.ts), GIF 는 같은 인덱스가 이어지면 LZW 런이
 * 길어지고, WebP 도 프레임 간 예측을 쓴다. 그런데 사진의 필름 그레인이나 그라데이션의
 * 디더 잡티는 매 프레임 1~2 정도씩 흔들린다. 눈에는 정지 화면인데 코덱에게는 전 화면이
 * 바뀐 프레임이다. 그 비트를 걷어내 선과 글자에 쓰는 것이 이 파일의 전부다.
 *
 * 얼리기가 왜 누적 오차를 내지 않는가
 *
 * 비교 대상이 "직전 입력 프레임" 이 아니라 **"지금 화면에 찍혀 있는 값"** 이다.
 * 직전 입력과 비교하면 매 프레임 임계값만큼 조금씩 밀려서 100프레임 뒤에는 완전히
 * 다른 색이 되어 있다. 화면 값과 비교하면 아무리 오래 얼어 있어도 참값과의 거리가
 * 언제나 임계값 안이다. 벗어나는 순간 갱신되고 화면 값이 참값으로 다시 붙는다.
 *
 * DOM / WebGL / React 를 참조하지 않는다. 결정론을 위해 Math.random 을 쓰지 않는다.
 */

// ---------------------------------------------------------------------------
// 지각 거리
// ---------------------------------------------------------------------------

/**
 * 얼리기 임계값의 범위.
 *
 * 아래의 지각 좌표계에서 잰 거리다. 0 이면 끈 것이고, 16~18 이 무손실 원본에서
 * 눈에 안 보이면서 가장 크게 줄어드는 자리다. 이미 압축된 GIF 를 다시 넣으면
 * 디더 잡티 때문에 28 근처까지 올려야 같은 효과가 난다. 상한 40 은 그 위로 올리면
 * 평평한 면에 얼룩이 눈에 띄기 시작하는 자리다.
 */
export const FREEZE_MIN = 0
export const FREEZE_MAX = 40
export const FREEZE_DEFAULT = 0
/** 「기본」 버튼이 넣는 값. 무손실 원본에서 안전한 자리다. */
export const FREEZE_GENTLE = 16

/**
 * 지각 좌표 변환표. `sqrt(v * 255)` 를 0..255 정수에 미리 풀어 둔다.
 *
 * 왜 제곱근인가
 *
 * 사람 눈은 어두운 쪽의 차이를 훨씬 잘 본다. 값을 그대로 빼면 검은 그림자에서
 * 5 만큼 어긋난 것과 흰 하늘에서 5 만큼 어긋난 것이 같은 거리로 잡혀서, 어두운
 * 곳이 먼저 뭉개진다. 제곱근을 씌우면 어두운 쪽의 같은 차이가 더 큰 거리가 되어
 * 그쪽을 먼저 보호한다.
 *
 * 표를 쓰는 이유는 4000x4000 프레임에서 픽셀마다 Math.sqrt 를 네 번 부르면
 * 프레임당 6400만 번이 되기 때문이다.
 */
const TONE = ((): Float32Array => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i += 1) t[i] = Math.sqrt(i * 255)
  return t
})()

/**
 * 두 픽셀의 지각 거리 제곱.
 *
 * 알파를 곱한 값(프리멀티플라이드)으로 잰다. 반투명한 곳에서 RGB 를 그대로 비교하면
 * 화면에 거의 안 보이는 색 차이가 크게 잡혀서, 정작 보이는 곳을 얼릴 예산을 거기에
 * 다 쓴다. 알파 자체도 한 축으로 함께 잰다. 색이 같아도 투명도가 달라지면 그것은
 * 눈에 보이는 변화다.
 */
export function perceptualDistanceSq(
  r0: number,
  g0: number,
  b0: number,
  a0: number,
  r1: number,
  g1: number,
  b1: number,
  a1: number,
): number {
  // (v * a + 127) >> 8 은 v * a / 255 의 정수 근사다. 표를 쓰려면 0..255 정수여야 한다.
  const dr = TONE[(r0 * a0 + 127) >> 8]! - TONE[(r1 * a1 + 127) >> 8]!
  const dg = TONE[(g0 * a0 + 127) >> 8]! - TONE[(g1 * a1 + 127) >> 8]!
  const db = TONE[(b0 * a0 + 127) >> 8]! - TONE[(b1 * a1 + 127) >> 8]!
  const da = TONE[a0]! - TONE[a1]!
  return dr * dr + dg * dg + db * db + da * da
}

// ---------------------------------------------------------------------------
// 얼리기
// ---------------------------------------------------------------------------

/**
 * 프레임 사이의 얼리기 상태.
 *
 * 화면에 찍혀 있는 값을 들고 있어야 하므로 함수가 아니라 객체다. 프레임 하나 분량의
 * 버퍼를 하나 더 쓴다. 스트리밍 경로가 이미 스크래치 + 출력 두 장을 들고 있으므로
 * 상주 메모리는 프레임 세 장이 된다. 4000px 에서 192MB 이고 MEMORY_BUDGET_BYTES
 * (700MB) 안이다.
 */
export class TemporalFreeze {
  private canvas: Uint8Array | null = null
  private readonly thresholdSq: number

  constructor(threshold: number) {
    const t = Number.isFinite(threshold) ? Math.max(0, Math.min(FREEZE_MAX, threshold)) : 0
    this.thresholdSq = t * t
  }

  /** 이 설정이 실제로 하는 일이 있는가. 없으면 호출부가 통째로 건너뛴다. */
  get active(): boolean {
    return this.thresholdSq > 0
  }

  /**
   * 프레임 하나를 제자리에서 고친다. 얼린 픽셀은 화면 값으로 되돌아간다.
   *
   * 첫 프레임은 그대로 통과한다. 비교할 화면이 없고, APNG 의 첫 프레임은 사양상
   * 캔버스 전체를 채워야 한다 (export/apng/encoder.ts).
   *
   * 돌려주는 값은 얼린 픽셀 수다. 진단과 테스트에만 쓴다.
   */
  apply(rgba: Uint8Array): number {
    if (!this.active) return 0
    if (this.canvas === null || this.canvas.length !== rgba.length) {
      this.canvas = new Uint8Array(rgba)
      return 0
    }

    const canvas = this.canvas
    let frozen = 0
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i]!
      const g = rgba[i + 1]!
      const b = rgba[i + 2]!
      const a = rgba[i + 3]!
      const pr = canvas[i]!
      const pg = canvas[i + 1]!
      const pb = canvas[i + 2]!
      const pa = canvas[i + 3]!

      if (r === pr && g === pg && b === pb && a === pa) continue

      if (perceptualDistanceSq(r, g, b, a, pr, pg, pb, pa) <= this.thresholdSq) {
        // 얼린다. 화면에 이미 있는 값을 그대로 내보내면 차분이 0 이 된다.
        rgba[i] = pr
        rgba[i + 1] = pg
        rgba[i + 2] = pb
        rgba[i + 3] = pa
        frozen += 1
        continue
      }

      canvas[i] = r
      canvas[i + 1] = g
      canvas[i + 2] = b
      canvas[i + 3] = a
    }
    return frozen
  }
}

// ---------------------------------------------------------------------------
// 그레인 제거
// ---------------------------------------------------------------------------

/**
 * 가우시안 근사 커널. sigma 0.9 를 5탭 정수 가중치로 편다.
 *
 * 부동소수 가우시안을 매번 계산하지 않는 이유는 두 가지다. 세로/가로 두 번 도는
 * 분리형이라 픽셀당 10번의 곱셈이 들고, 정수 가중치면 나눗셈 한 번을 시프트로
 * 바꿀 수 있다. 합이 16 이라 `>> 4` 로 끝난다.
 *
 * [1, 4, 6, 4, 1] / 16 은 sigma 약 1.0 의 이항 커널이다. 그레인의 특성 크기가
 * 1~2px 이므로 이 폭이면 충분히 뭉갠다.
 */
const KERNEL = [1, 4, 6, 4, 1] as const
const KERNEL_SUM = 16

/**
 * 그레인 제거의 기본 문턱값.
 *
 *   t1 아래의 세부는 전부 버린다      (필름 그레인, 디더 잡티, 압축 잔여물)
 *   t2 위의 세부는 한 값도 안 건드린다 (선화, 글자, 또렷한 경계)
 *   그 사이는 비례해서 섞는다          (문턱을 딱 자르면 경계에 띠가 생긴다)
 */
export const DEGRAIN_LOW = 4
export const DEGRAIN_HIGH = 9

/**
 * 프레임 하나에서 그레인을 걷어낸다. 제자리에서 고친다.
 *
 * 흐린 판(blur)과 세부(detail = 원본 - 흐린 판)로 나누고 세부의 약한 성분만 버린다.
 * 통째로 흐리면 그림이 뭉개지고, 통째로 두면 그레인이 남는다.
 *
 * 알파는 건드리지 않는다. 알파를 흐리면 투명 배경 스티커의 가장자리가 한 픽셀씩
 * 번져서 잘라 둔 경계가 무너진다. 색만 다듬는다.
 *
 * `scratch` 는 가로 방향 결과를 담는 임시 버퍼다. 호출부가 프레임마다 다시 할당하지
 * 않도록 밖에서 넘긴다. 길이가 안 맞으면 여기서 만든다.
 *
 * 비용 실측 (Node 24, 이 저장소의 vitest 환경):
 *   512x512    17ms
 *   1080x1080  50ms
 *   2048x2048  177ms
 * 같은 크기에서 인코딩 자체가 Mpx 당 130~260ms 이므로(ui/export/exportSettings.ts
 * estimateDurationSec) 프레임당 한 번 더 도는 값으로 감당할 만하다. 추측으로 최적화하지
 * 않고 이 숫자를 근거로 지금 형태를 유지한다.
 */
export function degrainFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  scratch?: Uint8Array,
  low = DEGRAIN_LOW,
  high = DEGRAIN_HIGH,
): void {
  const n = width * height * 4
  if (rgba.length !== n || width < 1 || height < 1) return
  // 커널 폭보다 좁으면 흐릴 것이 없다.
  if (width < 3 || height < 3) return

  const blur = scratch !== undefined && scratch.length === n ? scratch : new Uint8Array(n)
  const tmp = new Uint8Array(n)

  // 가로 패스. 가장자리는 끝 픽셀을 늘려 잡는다(clamp). 감싸면 반대쪽 색이 새어 든다.
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const at = row + x * 4
      for (let c = 0; c < 3; c += 1) {
        let sum = 0
        for (let k = -2; k <= 2; k += 1) {
          const sx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k
          sum += rgba[row + sx * 4 + c]! * KERNEL[k + 2]!
        }
        tmp[at + c] = (sum / KERNEL_SUM + 0.5) | 0
      }
      tmp[at + 3] = rgba[at + 3]!
    }
  }

  // 세로 패스.
  const rowBytes = width * 4
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * rowBytes + x * 4
      for (let c = 0; c < 3; c += 1) {
        let sum = 0
        for (let k = -2; k <= 2; k += 1) {
          const sy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k
          sum += tmp[sy * rowBytes + x * 4 + c]! * KERNEL[k + 2]!
        }
        blur[at + c] = (sum / KERNEL_SUM + 0.5) | 0
      }
    }
  }

  // 세부 게이트. 세 채널 중 가장 센 성분으로 판정해야 색 하나만 튀는 잡티도 잡힌다.
  const span = Math.max(1e-6, high - low)
  for (let i = 0; i < n; i += 4) {
    const d0 = rgba[i]! - blur[i]!
    const d1 = rgba[i + 1]! - blur[i + 1]!
    const d2 = rgba[i + 2]! - blur[i + 2]!
    const mag = Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2))
    if (mag >= high) continue // 선화와 경계는 한 값도 안 건드린다
    const w = mag <= low ? 0 : (mag - low) / span
    rgba[i] = clamp255(blur[i]! + d0 * w)
    rgba[i + 1] = clamp255(blur[i + 1]! + d1 * w)
    rgba[i + 2] = clamp255(blur[i + 2]! + d2 * w)
  }
}

function clamp255(v: number): number {
  const r = (v + 0.5) | 0
  return r < 0 ? 0 : r > 255 ? 255 : r
}

// ---------------------------------------------------------------------------
// 사슬
// ---------------------------------------------------------------------------

export interface FrameFilterOptions {
  freeze: number
  degrain: boolean
  width: number
  height: number
}

/**
 * 프레임 하나에 거는 필터 사슬. 상태(얼리기 화면)를 들고 있으므로 내보내기 한 번에
 * 하나를 만들어 쓴다.
 *
 * 순서가 중요하다. 그레인을 먼저 걷어야 얼리기가 제대로 먹는다. 그레인이 남아 있으면
 * 거의 모든 픽셀이 임계값을 넘겨서 얼릴 것이 없다. 실제로 이 순서가 뒤집히면
 * 얼리기 임계값을 두 배 가까이 올려야 같은 크기가 나온다.
 */
export class FrameFilterChain {
  private readonly freeze: TemporalFreeze
  private readonly degrainOn: boolean
  private readonly width: number
  private readonly height: number
  private scratch: Uint8Array | null = null

  constructor(options: FrameFilterOptions) {
    this.freeze = new TemporalFreeze(options.freeze)
    this.degrainOn = options.degrain === true
    this.width = options.width
    this.height = options.height
  }

  /** 아무것도 안 하면 호출부가 통째로 건너뛴다. */
  get active(): boolean {
    return this.degrainOn || this.freeze.active
  }

  apply(rgba: Uint8Array): void {
    if (!this.active) return
    if (this.degrainOn) {
      if (this.scratch === null) this.scratch = new Uint8Array(this.width * this.height * 4)
      degrainFrame(rgba, this.width, this.height, this.scratch)
    }
    this.freeze.apply(rgba)
  }
}
