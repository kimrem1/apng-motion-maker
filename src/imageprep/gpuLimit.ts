/**
 * 이 기기가 다룰 수 있는 최대 텍스처 크기.
 *
 * 왜 필요한가. 임포트 축소 상한을 상수로 박아 두면 둘 중 하나가 손해를 본다.
 * 낮게 잡으면 8000px 사진을 크게 자르려는 사용자가 이미 뭉개진 픽셀을 자르게 되고,
 * 높게 잡으면 MAX_TEXTURE_SIZE 가 4096 인 기기에서 업로드가 통째로 실패한다
 * (renderer/gl.ts 의 uploadImageBitmap 이 에러를 던진다).
 *
 * 그래서 추측하지 않고 잰다. 1x1 컨텍스트를 한 번 만들어 값만 읽고 버린다.
 * WebGL2 를 못 만드는 환경(테스트 러너, 아주 오래된 브라우저)에서는 4096 을
 * 돌려준다. 그 값은 WebGL2 명세가 보장하는 하한이다.
 */

/** WebGL2 구현이 최소한 보장하는 값. 실측에 실패하면 이 값을 쓴다. */
export const MIN_GUARANTEED_TEXTURE_SIZE = 4096

let cached: number | null = null

function probe(): number {
  try {
    let canvas: HTMLCanvasElement | OffscreenCanvas | null = null
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(1, 1)
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
    }
    if (!canvas) return MIN_GUARANTEED_TEXTURE_SIZE

    // 실제 렌더링에 쓸 컨텍스트가 아니다. 값만 읽으므로 최소 옵션으로 만든다.
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    }) as WebGL2RenderingContext | null
    if (!gl) return MIN_GUARANTEED_TEXTURE_SIZE

    const value = gl.getParameter(gl.MAX_TEXTURE_SIZE) as unknown
    // 컨텍스트를 바로 놓아 준다. 안 그러면 브라우저의 컨텍스트 개수 상한을 하나 먹는다.
    gl.getExtension('WEBGL_lose_context')?.loseContext()

    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      return MIN_GUARANTEED_TEXTURE_SIZE
    }
    return Math.max(MIN_GUARANTEED_TEXTURE_SIZE, Math.floor(value))
  } catch {
    return MIN_GUARANTEED_TEXTURE_SIZE
  }
}

/** 실측값. 첫 호출에서 한 번만 재고 이후에는 캐시를 돌려준다. */
export function maxTextureSize(): number {
  if (cached === null) cached = probe()
  return cached
}
