/**
 * 노이즈 아틀라스.
 *
 * 왜 미리 굽는가.
 *
 *   1. 싸다. 매 프레임 셰이더에서 fBm 을 도는 것보다 텍스처 페치 두 번이 훨씬 싸다.
 *   2. 무엇보다 프레임 간 일관성이 보장된다. 아틀라스는 문서를 열 때 한 번만
 *      만들어지므로 어느 프레임을 어느 순서로 렌더하든 같은 데이터를 읽는다.
 *   3. 시간축이 닫힌다. 레이어 k 는 원 경로의 t = k / layers 지점이라
 *      마지막 레이어 다음이 정확히 레이어 0 이다. 무한 반복에서 이음새가 없다.
 *
 * 공간 일관성은 격자 보간으로 만든다. 텍셀마다 fbmLoop 을 부르면 시간축은 매끄럽지만
 * 공간축이 백색잡음이라 워프에 쓸 수 없다. 그래서 저해상도 격자점의 시계열만 fbmLoop 으로
 * 굽고, 텍셀은 그 격자를 5차 스무스스텝으로 보간한다. 격자를 모듈로로 감싸므로
 * 텍스처가 공간적으로도 타일링된다 (샘플러 WRAP = REPEAT).
 *
 * 채널 배치
 *   R, G : 도메인 워프 오프셋 (저주파 격자). 0.5 가 오프셋 0 이다.
 *   B    : 스칼라 노이즈 (고주파 격자). 임계값 흔들기 / 밴드 밝기용.
 *   A    : 1.0 고정. 프리멀티플라이드 규약과 무관한 데이터 텍스처다.
 */

import { hashSeed } from '@/core/rng.ts'
import { fbmLoop } from '@/motions/generators.ts'

export interface NoiseAtlas {
  texture: WebGLTexture
  size: number
  layers: number
}

export const NOISE_ATLAS_SIZE = 128
export const NOISE_ATLAS_LAYERS = 16

/** 저주파(워프) 격자와 고주파(스칼라) 격자. 텍스처 크기와 무관하게 고정한다. */
const WARP_GRID = 8
const DETAIL_GRID = 16

/** fbmLoop 파라미터. 옥타브를 2로 묶는다. */
const OCTAVES = 2
const PERSISTENCE = 0.5
const LACUNARITY = 2
const BASE_RADIUS = 2

function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * 격자점마다 한 주기짜리 시계열을 굽는다.
 * 반환 배열의 인덱스는 (layer * grid + gy) * grid + gx 다.
 */
function latticeSeries(seed: number, grid: number, layers: number, channel: number): Float32Array {
  const out = new Float32Array(grid * grid * layers)
  for (let gy = 0; gy < grid; gy += 1) {
    for (let gx = 0; gx < grid; gx += 1) {
      const pointSeed = hashSeed(seed, gy * grid + gx, channel)
      for (let k = 0; k < layers; k += 1) {
        // t = k / layers. fbmLoop 은 원 경로 샘플링이라 t=0 과 t=1 이 같은 점이다.
        const v = fbmLoop(pointSeed, k / layers, OCTAVES, PERSISTENCE, LACUNARITY, BASE_RADIUS)
        out[(k * grid + gy) * grid + gx] = v
      }
    }
  }
  return out
}

/** 격자를 토러스로 보간한다. u, v 는 [0, 1). */
function sampleLattice(
  series: Float32Array,
  grid: number,
  layer: number,
  u: number,
  v: number,
): number {
  const fx = u * grid
  const fy = v * grid
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = smoother(fx - x0)
  const ty = smoother(fy - y0)

  const ix0 = ((x0 % grid) + grid) % grid
  const iy0 = ((y0 % grid) + grid) % grid
  const ix1 = (ix0 + 1) % grid
  const iy1 = (iy0 + 1) % grid

  const base = layer * grid * grid
  const n00 = series[base + iy0 * grid + ix0] ?? 0
  const n10 = series[base + iy0 * grid + ix1] ?? 0
  const n01 = series[base + iy1 * grid + ix0] ?? 0
  const n11 = series[base + iy1 * grid + ix1] ?? 0

  const a = n00 + (n10 - n00) * tx
  const b = n01 + (n11 - n01) * tx
  return a + (b - a) * ty
}

/** [-1, 1] 을 0~255 로. 128 이 0 이다. */
function encode(n: number): number {
  const v = Math.round((n * 0.5 + 0.5) * 255)
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * CPU 데이터만 굽는다. GL 없이도 테스트할 수 있게 분리했다.
 * 길이는 size * size * layers * 4 다.
 */
export function buildNoiseAtlasData(
  size: number = NOISE_ATLAS_SIZE,
  layers: number = NOISE_ATLAS_LAYERS,
  seed = 1,
): Uint8Array {
  const w = Math.max(2, Math.floor(size))
  const l = Math.max(1, Math.floor(layers))

  const warpX = latticeSeries(seed, WARP_GRID, l, 0)
  const warpY = latticeSeries(seed, WARP_GRID, l, 1)
  const detail = latticeSeries(seed, DETAIL_GRID, l, 2)

  const data = new Uint8Array(w * w * l * 4)
  let o = 0
  for (let k = 0; k < l; k += 1) {
    for (let y = 0; y < w; y += 1) {
      const v = y / w
      for (let x = 0; x < w; x += 1) {
        const u = x / w
        data[o] = encode(sampleLattice(warpX, WARP_GRID, k, u, v))
        data[o + 1] = encode(sampleLattice(warpY, WARP_GRID, k, u, v))
        data[o + 2] = encode(sampleLattice(detail, DETAIL_GRID, k, u, v))
        data[o + 3] = 255
        o += 4
      }
    }
  }
  return data
}

/**
 * TEXTURE_2D_ARRAY 로 올린다. 문서당 한 번만 부른다.
 *
 * WRAP_S / WRAP_T 는 REPEAT 다. 격자를 모듈로로 감싸 구웠으므로 이음새가 없다.
 * WRAP_R 은 의미가 없다. 레이어 간 보간은 하드웨어가 해 주지 않으므로
 * 셰이더가 두 레이어를 각각 읽고 직접 섞는다 (registry.ts 의 warpBoil).
 */
export function createNoiseAtlas(
  gl: WebGL2RenderingContext,
  size: number = NOISE_ATLAS_SIZE,
  layers: number = NOISE_ATLAS_LAYERS,
  seed = 1,
): WebGLTexture {
  const w = Math.max(2, Math.floor(size))
  const l = Math.max(1, Math.floor(layers))
  const data = buildNoiseAtlasData(w, l, seed)

  const texture = gl.createTexture()
  if (!texture) throw new Error('노이즈 아틀라스 텍스처를 만들지 못했습니다.')

  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, w, w, l)
  gl.texSubImage3D(
    gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, w, w, l, gl.RGBA, gl.UNSIGNED_BYTE, data,
  )
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null)

  return texture
}
