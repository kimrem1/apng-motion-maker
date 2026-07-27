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
  /**
   * 마지막으로 업로드(또는 시도)한 원본 비트맵. **참조 비교 전용이다.**
   *
   * 이미지 다듬기가 assetRegistry.set 으로 같은 id 의 비트맵을 교체하면 여기서
   * 감지해 텍스처를 다시 올린다. 이게 없으면 프리뷰가 다듬기 전 픽셀을 영원히
   * 보여 준다. 레지스트리가 교체 시 이전 비트맵을 close 하므로 이 Map 의 값은
   * 닫힌 비트맵일 수 있다. 픽셀을 읽는 데 쓰면 안 되고, 실제로 안 쓴다.
   */
  private readonly sources = new Map<string, ImageBitmap>()

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
      const bitmap = resolve(ref.id)
      const cached = this.map.get(ref.id)

      if (cached) {
        // hasAlpha 의 정본은 문서다. 배경 제거가 알파를 만들면 문서 쪽이 먼저 바뀐다.
        cached.hasAlpha = ref.hasAlpha
        // 같은 비트맵이면 그대로 쓴다. 비트맵이 아직 없으면(로딩 중) 옛 텍스처를 유지한다.
        if (!bitmap || this.sources.get(ref.id) === bitmap) continue
        this.gl.deleteTexture(cached.texture)
        this.map.delete(ref.id)
      } else if (this.failed.has(ref.id)) {
        // 실패도 비트맵이 교체되면 다시 시도한다. 같은 비트맵 재시도는 여전히 막는다.
        if (!bitmap || this.sources.get(ref.id) === bitmap) continue
        this.failed.delete(ref.id)
      }

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
      this.sources.set(ref.id, bitmap)
    }

    for (const [id, asset] of this.map) {
      if (live.has(id)) continue
      this.gl.deleteTexture(asset.texture)
      this.map.delete(id)
    }
    for (const id of this.failed.keys()) {
      if (!live.has(id)) this.failed.delete(id)
    }
    for (const id of this.sources.keys()) {
      if (!live.has(id)) this.sources.delete(id)
    }

    return this.map
  }

  dispose(): void {
    for (const asset of this.map.values()) this.gl.deleteTexture(asset.texture)
    this.map.clear()
    this.failed.clear()
    this.sources.clear()
  }
}
