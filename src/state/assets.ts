/**
 * 디코드된 픽셀 보관소.
 *
 * ImageBitmap 은 문서 상태에 넣지 않는다. 넣으면 undo 스택이 수백 MB 가 된다
 * 문서에는 id 만 있고 픽셀은 여기 있다.
 *
 * IndexedDB 영속화가 붙을 자리다. 인터페이스는 그대로 두고 구현만 비동기로 바뀐다.
 */

class AssetRegistry {
  private readonly bitmaps = new Map<string, ImageBitmap>()
  private readonly listeners = new Set<() => void>()
  private revision = 0

  set(id: string, bitmap: ImageBitmap): void {
    const prev = this.bitmaps.get(id)
    if (prev && prev !== bitmap) prev.close()
    this.bitmaps.set(id, bitmap)
    this.bump()
  }

  get(id: string): ImageBitmap | undefined {
    return this.bitmaps.get(id)
  }

  delete(id: string): void {
    const prev = this.bitmaps.get(id)
    if (!prev) return
    prev.close()
    this.bitmaps.delete(id)
    this.bump()
  }

  /** useSyncExternalStore 용 */
  getRevision = (): number => this.revision

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private bump(): void {
    this.revision += 1
    for (const l of this.listeners) l()
  }
}

export const assetRegistry = new AssetRegistry()
