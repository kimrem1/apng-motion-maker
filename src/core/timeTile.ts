/**
 * 주기 이어 붙이기.
 *
 * 한 주기짜리 키프레임 트랙을 이미 정해진 타임라인 길이 안에 여러 번 편다.
 * 도형 세트(shapes/registry.ts)가 쓰던 것을 모션 프리셋의 길이 못박기
 * (motions/apply.ts 의 pinned 분기)도 쓰게 되어 여기로 올렸다. 두 벌이 되면
 * 같은 이어 붙이기가 두 곳에서 다른 이음새를 만든다.
 *
 * **새 이음새가 생기지 않는다.** 이어 붙이는 대상은 전부 반복 재생을 전제로 만든
 * 트랙이고, 주기의 끝에서 처음으로 돌아가는 자리는 이미 반복 재생이 매 바퀴 지나는
 * 자리다. 이어 붙이기는 그 자리를 문서 안으로 옮겨 놓을 뿐이다.
 *
 * DOM / 스토어를 참조하지 않는 순수 함수다.
 */

import type { Keyframe, Track } from './types.ts'

/**
 * 각 주기의 시작 프레임. 길이는 reps + 1 이고 마지막이 총 길이다.
 *
 * 주기마다 폭이 한 프레임씩 다를 수 있다(총 길이가 reps 로 안 나누어떨어질 때).
 * 키를 그 폭에 맞춰 다시 펴야 마지막 주기가 정확히 총 길이에서 끝난다.
 */
export function cycleOffsets(total: number, reps: number): number[] {
  const out: number[] = []
  for (let r = 0; r < reps; r += 1) out.push(Math.round((total * r) / reps))
  out.push(total)
  return out
}

/**
 * 한 주기를 여러 번 이어 붙인다.
 *
 * offsets 는 cycleOffsets 가 만든 것이어야 한다. reps 가 1 이하이거나 키가 두 개
 * 미만이면 손대지 않고 돌려준다.
 */
export function tileTrack(source: Track, cycle: number, offsets: readonly number[]): Track {
  const reps = offsets.length - 1
  if (reps <= 1 || cycle < 2 || source.keys.length < 2) return source

  const first = source.keys[0]
  const last = source.keys[source.keys.length - 1]
  if (!first || !last) return source

  /** 끝 값이 첫 값으로 돌아오는가. cycle() 이 만든 트랙은 전부 그렇다. */
  const closed = last.v === first.v
  /*
   * **한 바퀴**를 도는 회전만 이어서 돈다.
   *
   * 레이더와 팽이는 한 주기에 360도를 돈다(0 -> 360). 값을 그대로 복사하면 두 번째
   * 주기의 첫 키가 다시 0 이라, 겹친 키를 버리는 규칙에 걸려 트랙이 360 에 멈춘다.
   * 주기마다 한 바퀴씩 더해 두면 계속 돈다. 360 과 0 은 같은 그림이라 이음새도 없다.
   *
   * "각도면 무조건" 이 아니다. 쫀득 팝의 회전은 -18도에서 0도로 펴지는 흔들림이고,
   * 한 바퀴가 아니다. 그것까지 더하면 주기마다 18도씩 기울어 간다. 360의 배수만
   * 같은 그림으로 돌아오므로 그 경우만 잇는다.
   */
  const delta = last.v - first.v
  const fullTurns = Math.abs(delta) >= 359.9 && Math.abs(delta % 360) < 0.1
  const step = source.unit === 'deg' && fullTurns ? delta : 0

  const keys: Keyframe[] = []
  for (let r = 0; r < reps; r += 1) {
    const from = offsets[r] ?? 0
    const to = offsets[r + 1] ?? from
    const width = Math.max(1, to - from)
    /*
     * 마지막 주기가 아니면 끝 키가 다음 주기의 첫 키 자리를 침범한다.
     *
     * 값이 이어지면(closed 이거나 각도) 같은 자리에 같은 값이므로 하나로 합친다.
     * 값이 안 이어지면 한 프레임 앞에서 끝낸다. 되돌아가는 순간을 한 프레임에
     * 몰아넣는 wipe.ts 의 lastFrame 과 같은 규칙이다.
     */
    const limit = r === reps - 1 || closed || step !== 0 ? to : to - 1
    for (const key of source.keys) {
      const f = Math.min(from + Math.round((key.f * width) / cycle), limit)
      const prev = keys[keys.length - 1]
      // 이음새에서 겹친다. 앞 주기가 만든 키를 남긴다.
      if (prev !== undefined && f <= prev.f) continue
      keys.push({ ...key, f, v: key.v + step * r })
    }
  }
  return { ...source, keys }
}
