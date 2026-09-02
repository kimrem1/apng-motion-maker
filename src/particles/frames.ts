/**
 * 파티클 레이어의 프레임 공급.
 *
 * 렌더러(WebGL)와 엔진(Canvas 2D) 사이의 다리다. 레이어마다 엔진과 캔버스를
 * 하나씩 들고, 프레임마다 spec 과 시간에 맞는 그림을 캔버스에 그려 돌려준다.
 * 텍스처 업로드는 렌더러의 일이다. 여기는 GL 을 모른다.
 *
 * 시간 매핑
 *
 * 파티클 루프의 자연 길이는 BASE_T/speed 초지만 문서 길이는 그와 무관하게 고정이다.
 * 그래서 문서 길이 안에 그 루프가 몇 번 들어가는지를 **정수로** 반올림해 그 횟수만큼
 * 돌린다. 정수가 아니면 문서가 반복될 때 파티클만 이음매에서 도약한다. 속도 슬라이더는
 * 그래서 연속값이되, 실제 체감 속도는 문서 길이에 맞는 가장 가까운 정수 반복으로
 * 맞춰진다.
 */

import type { ParticleSpec } from './types.ts'
import { BASE_T, ParticleEngine } from './engine.ts'

/** 문서 길이 안에서 도는 루프 수. 항상 1 이상의 정수라 이음매가 없다. */
export function particleLoops(
  spec: Pick<ParticleSpec, 'speed'>,
  durationFrames: number,
  fps: number,
): number {
  const baseFrames = fps > 0 ? (fps * BASE_T) / Math.max(0.25, spec.speed) : durationFrames
  return Math.max(1, Math.round(durationFrames / Math.max(2, baseFrames)))
}

/** 문서 프레임을 엔진의 t ∈ [0,1) 로 옮긴다. */
export function particlePhase(
  spec: Pick<ParticleSpec, 'speed'>,
  frame: number,
  durationFrames: number,
  fps: number,
): number {
  if (durationFrames <= 0) return 0
  const loops = particleLoops(spec, durationFrames, fps)
  const t = (frame * loops) / durationFrames
  return t - Math.floor(t)
}

interface Entry {
  engine: ParticleEngine
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/**
 * 레이어별 엔진 + 캔버스. 엔진은 스프라이트 캐시를 들고 있어 프레임마다 새로
 * 만들면 안 된다. 문서에서 사라진 레이어의 것은 prune 으로 돌려준다.
 */
export class ParticleFrameCache {
  private readonly entries = new Map<string, Entry>()

  /**
   * 이 레이어의 이 프레임 그림. 입력 여섯 개가 같으면 언제나 같은 픽셀이다.
   * 돌려주는 캔버스는 다음 호출까지만 유효하므로 받은 즉시 텍스처로 올려야 한다.
   */
  frame(
    layerId: string,
    spec: ParticleSpec,
    w: number,
    h: number,
    frame: number,
    durationFrames: number,
    fps: number,
  ): HTMLCanvasElement | null {
    let entry = this.entries.get(layerId)
    if (!entry) {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      entry = { engine: new ParticleEngine(spec, w, h), canvas, ctx }
      this.entries.set(layerId, entry)
    }
    if (entry.canvas.width !== w) entry.canvas.width = w
    if (entry.canvas.height !== h) entry.canvas.height = h
    entry.engine.update(spec, w, h)
    entry.engine.render(entry.ctx, particlePhase(spec, frame, durationFrames, fps))
    return entry.canvas
  }

  /** 문서에 없는 레이어의 엔진을 정리한다. 스프라이트 캐시가 계속 자라면 안 된다. */
  prune(aliveIds: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) {
      if (!aliveIds.has(id)) this.entries.delete(id)
    }
  }
}
