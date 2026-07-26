/**
 * 알파 채널 실측.
 *
 * AssetRef.hasAlpha 는 렌더러와 내보내기(APNG 컬러타입 결정)가 참조한다.
 * 확장자만 믿으면 PNG 전부가 알파 있음으로 잡혀 불필요한 비용을 낸다.
 */

/**
 * 검사 해상도 상한.
 * 전체 스캔은 4K 이미지에서 수십 ms 가 걸리고(16M 픽셀 x 4바이트 = 64MB 읽기)
 * 임포트 순간 UI 가 눈에 띄게 멈춘다. 256x256 이면 최대 65536 픽셀로 1ms 수준이다.
 */
const PROBE_MAX = 256

/**
 * 두 컨텍스트(Offscreen/HTML)가 공통으로 만족하는 최소 인터페이스.
 * 유니온 타입으로 두면 오버로드 호출이 꼬여서 구조적 타입으로 좁힌다.
 */
interface Probe2d {
  drawImage(image: ImageBitmap, dx: number, dy: number, dw: number, dh: number): void
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData
}

function createProbeContext(w: number, h: number): Probe2d | null {
  // willReadFrequently: true 는 GPU 왕복 대신 CPU 백킹을 쓰게 해 getImageData 를 빠르게 한다.
  if (typeof OffscreenCanvas !== 'undefined') {
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    if (ctx) return ctx
  }
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas.getContext('2d', { willReadFrequently: true })
}

/**
 * 한 픽셀이라도 a < 255 면 true.
 *
 * 트레이드오프: 다운스케일 보간 때문에 완전 불투명 이미지가 투명으로 잡히는
 * false positive 는 생기지 않는다(불투명 픽셀끼리 섞여도 알파는 255 유지).
 * 반대로 몇 픽셀짜리 아주 작은 투명 영역은 다운스케일 과정에서 사라져 놓칠 수 있다.
 * 놓치면 알파 없는 이미지로 취급되어 내보내기에서 그 미세 영역이 검게 합성될 수 있으나,
 * 임포트마다 수십 ms 를 태우는 것보다 이쪽이 낫다고 판단했다.
 */
export function probeAlpha(bitmap: ImageBitmap): boolean {
  const long = Math.max(bitmap.width, bitmap.height)
  const scale = long > PROBE_MAX ? PROBE_MAX / long : 1
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))

  const ctx = createProbeContext(w, h)
  // 2D 컨텍스트를 못 얻으면 알파가 있다고 가정한다. 있는데 없다고 하는 쪽이 더 위험하다.
  if (!ctx) return true

  try {
    // 캔버스를 정확히 덮도록 그린다. 덮이지 않은 픽셀은 투명이라 오판을 만든다.
    ctx.drawImage(bitmap, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 255) < 255) return true
    }
    return false
  } catch {
    // 오염된 캔버스 등으로 getImageData 가 막히면 보수적으로 알파 있음 처리.
    return true
  }
}
