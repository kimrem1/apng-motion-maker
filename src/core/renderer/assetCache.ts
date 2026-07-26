/**
 * GPU 에셋 캐시.
 *
 * 에셋당 텍스처 1장. 프레임마다 createImageBitmap 이나 texImage2D 를 호출하지
 * 않는다. core/ 규칙을 지키기 위해 비트맵은 밖에서 주입받는다.
 */

import type { AssetRef, AssetTable, GpuAsset } from '../types.ts'
import { uploadImageBitmap } from './gl.ts'

export type BitmapResolver = (assetId: string) => ImageBitmap | undefined

export class GpuAssetCache {
  private readonly gl: WebGL2RenderingContext
  private readonly map = new Map<string, GpuAsset>()
  /** 업로드에 실패한 에셋. 매 프레임 같은 에러를 다시 던지지 않기 위해 기억한다. */
  private readonly failed = new Map<string, string>()

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  /** 업로드하지 못한 에셋의 사유. UI 가 사용자에게 알릴 때 쓴다. */
  getFailures(): ReadonlyMap<string, string> {
    return this.failed
  }

  /** 문서의 에셋 목록에 맞춰 GPU 상태를 동기화하고 렌더러가 쓸 테이블을 돌려준다. */
  sync(refs: readonly AssetRef[], resolve: BitmapResolver): AssetTable {
    const live = new Set<string>()

    for (const ref of refs) {
      live.add(ref.id)
      if (this.map.has(ref.id)) continue
      if (this.failed.has(ref.id)) continue
      const bitmap = resolve(ref.id)
      if (!bitmap) continue
      try {
        const uploaded = uploadImageBitmap(this.gl, bitmap)
        this.map.set(ref.id, {
          texture: uploaded.texture,
          width: uploaded.width,
          height: uploaded.height,
          hasAlpha: ref.hasAlpha,
        })
      } catch (err) {
        // 렌더 루프 안에서 던지면 프리뷰가 통째로 멈춘다. 해당 레이어만 빠지게 두고
        // 사유를 남긴다. 검은 사각형이 조용히 그려지는 것보다 낫다.
        this.failed.set(ref.id, err instanceof Error ? err.message : String(err))
      }
    }

    for (const [id, asset] of this.map) {
      if (live.has(id)) continue
      this.gl.deleteTexture(asset.texture)
      this.map.delete(id)
    }
    for (const id of this.failed.keys()) {
      if (!live.has(id)) this.failed.delete(id)
    }

    return this.map
  }

  dispose(): void {
    for (const asset of this.map.values()) this.gl.deleteTexture(asset.texture)
    this.map.clear()
    this.failed.clear()
  }
}
