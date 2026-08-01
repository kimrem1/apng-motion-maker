/**
 * 프리셋을 레이어에 얹을 때의 소유권 규칙.
 *
 * ---------------------------------------------------------------------------
 * 왜 파일을 따로 두는가
 * ---------------------------------------------------------------------------
 * 같은 규칙이 두 곳에서 필요하다.
 *   1. state/document.ts 의 applyPresetTracks  (클릭 = 확정 적용)
 *   2. motions/apply.ts 의 withPresetApplied   (호버 = 미리보기 임시 문서)
 * 두 곳이 규칙을 각자 적어 두면 반드시 갈라진다. 실제로 갈라져 있었다.
 * 미리보기는 "프리셋이 이펙트를 정의하지 않으면 기존 스택을 그대로 둔다" 였고,
 * 확정 적용은 "앞 프리셋이 심은 이펙트는 걷어내고 사용자 것만 남긴다" 였다.
 * 그래서 이펙트를 쓰지 않는 프리셋을 미리 보면 앞 프리셋의 이펙트가 그대로 남고,
 * 눌러 보면 사라졌다. 같은 카드에서 본 것과 누른 결과가 다르다.
 *
 * 규칙 자체는 document.ts 가 이미 확정한 것이고 이 파일은 그 규칙의 순수 함수 사본이다.
 * **document.ts 도 이 헬퍼를 쓰도록 바꿔야 한다.** 그 파일은 이번 작업의 수정 범위가
 * 아니라 손대지 않았다. 옮기고 나면 규칙이 물리적으로 한 벌만 남는다.
 *
 * ---------------------------------------------------------------------------
 * 규칙
 * ---------------------------------------------------------------------------
 * 소유권은 doc.presetRef 가 기록한다. 앞 프리셋이 심은 트랙의 prop 과 이펙트 id 다.
 *   트랙   : 새 프리셋이 내는 prop + 앞 프리셋이 심은 prop 을 걷어내고 새 트랙을 넣는다.
 *   이펙트 : 앞 프리셋이 심은 id 를 걷어내고 새 이펙트를 뒤에 붙인다.
 * 두 목록 어디에도 없는 것은 사용자가 직접 만든 것이므로 살아남는다.
 */

import type { EffectInstance, PresetRef, RevealSpec, Track, TrackProp } from '@/core/types.ts'

/** 앞 프리셋이 심어 둔 것의 목록. doc.presetRef 에서 그대로 읽는다. */
export interface PresetOwnership {
  props: readonly TrackProp[]
  effectIds: readonly string[]
  /** 지금 문서의 가리기를 앞 프리셋이 심었는가. */
  reveal: boolean
  /** 지금 문서의 원근 거리를 앞 프리셋이 심었는가. */
  perspective: boolean
}

/** presetRef 가 없으면(프리셋을 한 번도 안 썼으면) 아무것도 소유하지 않는다. */
export function ownershipOf(ref: PresetRef | undefined): PresetOwnership {
  return {
    props: ref?.props ?? [],
    effectIds: ref?.effectIds ?? [],
    reveal: ref?.ownsReveal === true,
    perspective: ref?.ownsPerspective === true,
  }
}

/**
 * 가리기 병합.
 *
 * ---------------------------------------------------------------------------
 * 사용자가 손으로 넣은 것은 지우지 않는다
 * ---------------------------------------------------------------------------
 * 트랙 / 이펙트와 **같은 규칙**이다. 예전에는 이 둘만 언제나 통째로 대체했는데,
 * 인스펙터에 「가리기」 섹션이 생긴 뒤로는 사용자가 직접 만드는 값이 되었다.
 * 그런데도 대체를 유지하면, 손으로 블라인드를 걸어 둔 레이어에 아무 프리셋이나
 * 한 번 누르는 순간 말없이 사라진다. dirty 플래그는 이 경로를 막지 못한다.
 * 그 플래그를 보는 곳은 EASY 슬라이더 재적용뿐이고 갤러리 카드 클릭은 곧장
 * 적용으로 간다.
 *
 * 그래서 소유권을 본다. 앞 프리셋이 심은 것만 걷어내고 사용자 것은 살린다.
 * 반환값 undefined 는 "가리기 없음" 이다.
 */
export function mergePresetReveal(
  existing: RevealSpec | undefined,
  emitted: RevealSpec | undefined,
  owned: PresetOwnership,
): RevealSpec | undefined {
  if (emitted && emitted.mode !== 'none') return emitted
  // 앞 프리셋 것이면 걷어낸다. 사용자 것이면 그대로 둔다.
  return owned.reveal ? undefined : existing
}

/** 원근 거리도 같은 규칙이다. */
export function mergePresetPerspective(
  existing: number | undefined,
  emitted: number | undefined,
  owned: PresetOwnership,
): number | undefined {
  if (typeof emitted === 'number' && Number.isFinite(emitted) && emitted >= 0) return emitted
  return owned.perspective ? undefined : existing
}

/**
 * 트랙 병합.
 *
 * 앞 프리셋의 prop 을 안 지우면 두 모션이 겹쳐 재생된다. "톡 튀며 등장"(크기+투명도)
 * 다음에 "한 바퀴 회전"(회전)을 고르면 회전하면서 계속 튀어오른다.
 */
export function mergePresetTracks(
  existing: readonly Track[],
  emitted: readonly Track[],
  owned: PresetOwnership,
): Track[] {
  const drop = new Set<TrackProp>(emitted.map((t) => t.prop))
  for (const prop of owned.props) drop.add(prop)
  return [...existing.filter((t) => !drop.has(t.prop)), ...emitted]
}

/**
 * 이펙트 병합.
 *
 * emitted 가 undefined 인 것과 빈 배열인 것은 여기서 **같다.** 어느 쪽이든 앞 프리셋이
 * 심은 이펙트는 걷어낸다 (motions/types.ts 의 PresetEmission.effects 계약은 "기존 스택을
 * 통째로 유지" 가 아니라 "사용자 스택을 지우지 않는다" 는 뜻이다). 자글자글 다음에
 * 흔들기를 고르면 흔들기는 이펙트를 정의하지 않으므로, 정리하지 않으면 자글자글의
 * 워프가 그대로 남아 두 효과가 겹친다.
 */
export function mergePresetEffects(
  existing: readonly EffectInstance[],
  emitted: readonly EffectInstance[] | undefined,
  owned: PresetOwnership,
): EffectInstance[] {
  const ownedIds = new Set<string>(owned.effectIds)
  const userFx = existing.filter((e) => !ownedIds.has(e.id))
  return [...userFx, ...(emitted ?? [])]
}
