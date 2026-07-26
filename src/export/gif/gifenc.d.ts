// gifenc 1.0.3 은 타입 정의를 포함하지 않는다.
// node_modules/gifenc/src/*.js 를 직접 읽고 실제 시그니처만 옮겨 적은 앰비언트 선언이다.
declare module 'gifenc' {
  /** 팔레트 항목은 [r, g, b] 또는 [r, g, b, a]. */
  export type GifencPalette = number[][]

  export type GifencFormat = 'rgb565' | 'rgb444' | 'rgba4444'

  export interface GifencWriteFrameOptions {
    /**
     * 첫 프레임에 넘기면 글로벌 컬러 테이블이 된다.
     * 두 번째 이후 프레임에 넘기면 **로컬** 컬러 테이블이 추가로 기록되므로
     * 글로벌 팔레트만 쓰려면 첫 프레임에서만 넘겨야 한다.
     */
    palette?: GifencPalette | null
    /** 밀리초. 내부에서 Math.round(delay / 10) 으로 센티초 변환한다. */
    delay?: number
    /** -1 = NETSCAPE 확장 생략(1회), 0 = 무한, >0 = 횟수. 첫 프레임에서만 기록된다. */
    repeat?: number
    transparent?: boolean
    transparentIndex?: number
    /** 0..7. 생략(-1)하고 transparent 가 true 면 내부에서 2 로 강제된다. */
    dispose?: number
    colorDepth?: number
    /** auto: false 인 인코더에서만 의미가 있다. */
    first?: boolean
  }

  export interface GifencEncoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: GifencWriteFrameOptions,
    ): void
    writeHeader(): void
    finish(): void
    reset(): void
    /** 복사본을 반환한다. */
    bytes(): Uint8Array
    /** 내부 버퍼의 subarray 를 반환한다. */
    bytesView(): Uint8Array
    readonly buffer: ArrayBuffer
  }

  export interface GifencEncoderOptions {
    initialCapacity?: number
    auto?: boolean
  }

  export interface GifencQuantizeOptions {
    format?: GifencFormat
    clearAlpha?: boolean
    clearAlphaColor?: number
    clearAlphaThreshold?: number
    /** true 면 임계 127, 숫자면 그 값을 임계로 써서 알파를 0/255 로 스냅한다. */
    oneBitAlpha?: boolean | number
    useSqrt?: boolean
  }

  export function GIFEncoder(opt?: GifencEncoderOptions): GifencEncoder

  /**
   * 주의: 내부에서 `new Uint32Array(rgba.buffer)` 를 쓴다.
   * byteOffset 이 0 이고 버퍼 전체가 픽셀 데이터인 배열만 넘겨야 한다.
   */
  export function quantize(
    rgba: Uint8Array,
    maxColors: number,
    opts?: GifencQuantizeOptions,
  ): GifencPalette

  /** quantize 와 동일한 버퍼 제약이 있다. */
  export function applyPalette(
    rgba: Uint8Array,
    palette: GifencPalette,
    format?: GifencFormat,
  ): Uint8Array

  export function prequantize(
    rgba: Uint8Array,
    opts?: {
      roundRGB?: number
      roundAlpha?: number
      oneBitAlpha?: boolean | number | null
    },
  ): void

  export function snapColorsToPalette(
    palette: GifencPalette,
    knownColors: number[][],
    threshold?: number,
  ): void

  const _default: typeof GIFEncoder
  export default _default
}
