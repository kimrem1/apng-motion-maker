/**
 * WebGL2 컨텍스트 생성과 색 정책.
 *
 * 알파 정책이 이 프로젝트의 핵심이다 (14.A1: 주 용도가 투명 배경 스티커).
 *
 *   - 텍스처 업로드는 straight alpha 로 한다.
 *     UNPACK_PREMULTIPLY_ALPHA_WEBGL = false, colorSpaceConversion = none.
 *   - 셰이더는 출력 직전에 rgb 에 a 를 곱해 premultiplied 로 내보낸다.
 *   - 블렌드는 (ONE, ONE_MINUS_SRC_ALPHA) 로 통일한다.
 *   - 표시용 캔버스 컨텍스트는 premultipliedAlpha: true 로 만든다.
 *   - 리드백에서 다시 straight 로 되돌린다.
 *
 * straight alpha 로 블렌딩하면 반투명 가장자리에 검은 테두리가 남는다.
 * 투명 스티커에서 이건 치명적이므로 내부는 premultiplied 로 고정한다.
 */

export interface GlCapabilities {
  /** RGBA16F 렌더 타깃 (블룸/누산 이펙트가 요구한다) */
  colorBufferFloat: boolean
  floatLinear: boolean
  maxTextureSize: number
  maxRenderbufferSize: number
  renderer: string
}

export class WebGL2UnsupportedError extends Error {
  constructor() {
    super('WebGL2를 사용할 수 없습니다.')
    this.name = 'WebGL2UnsupportedError'
  }
}

export interface GlContext {
  gl: WebGL2RenderingContext
  caps: GlCapabilities
}

const CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: true,
  // 내부 파이프라인이 premultiplied 이므로 표시 컨텍스트도 premultiplied 로 맞춘다.
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: false,
}

export function createGlContext(canvas: HTMLCanvasElement | OffscreenCanvas): GlContext {
  const gl = canvas.getContext('webgl2', CONTEXT_ATTRS) as WebGL2RenderingContext | null
  if (!gl) throw new WebGL2UnsupportedError()
  applyPixelStorePolicy(gl)
  return { gl, caps: probeCapabilities(gl) }
}

/** 픽셀 저장 정책. 초기화 코드 한 곳에서만 설정한다. */
export function applyPixelStorePolicy(gl: WebGL2RenderingContext): void {
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
}

function probeCapabilities(gl: WebGL2RenderingContext): GlCapabilities {
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float') !== null
  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null

  let renderer = 'unknown'
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  if (dbg) {
    const v = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    if (typeof v === 'string') renderer = v
  }

  return {
    colorBufferFloat,
    floatLinear,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    renderer,
  }
}

/** 표준 블렌딩. 소스는 항상 premultiplied 다. */
export function setPremultipliedBlend(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND)
  gl.blendEquation(gl.FUNC_ADD)
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
}

export interface UploadedTexture {
  texture: WebGLTexture
  width: number
  height: number
}

/**
 * ImageBitmap 을 텍스처로 올린다.
 * 프레임마다 호출하지 않는다. 에셋당 1회다.
 */
export function uploadImageBitmap(
  gl: WebGL2RenderingContext,
  bitmap: ImageBitmap,
): UploadedTexture {
  // 상한을 넘으면 texImage2D 가 INVALID_VALUE 로 조용히 실패하고, 레벨 0 이 없는
  // incomplete 텍스처는 샘플링 결과가 (0,0,0,1) 이라 화면에 검은 사각형이 그려진다.
  // 실패를 눈에 보이게 만든다.
  const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  if (bitmap.width > limit || bitmap.height > limit) {
    throw new Error(
      `이미지가 이 기기에서 다룰 수 있는 크기를 넘습니다 (${bitmap.width}x${bitmap.height}, 최대 ${limit}px).`,
    )
  }

  const texture = gl.createTexture()
  if (!texture) throw new Error('텍스처를 만들지 못했습니다.')

  gl.bindTexture(gl.TEXTURE_2D, texture)
  applyPixelStorePolicy(gl)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)

  // CLAMP_TO_EDGE 가 오버스캔의 edgeBleed 와 짝을 이룬다.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.bindTexture(gl.TEXTURE_2D, null)

  return { texture, width: bitmap.width, height: bitmap.height }
}

export function deleteTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): void {
  gl.deleteTexture(texture)
}
