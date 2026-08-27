/**
 * 프리셋을 레이어에 얹을 때의 소유권 규칙.
 *
 * 왜 파일을 따로 두는가
 *
 * 같은 규칙이 두 곳에서 필요하다.
 *   1. state/document.ts 의 applyPresetTracks  (클릭 = 확정 적용)
 *   2. motions/apply.ts 의 withPresetApplied   (호버 = 미리보기 임시 문서)
 * 두 곳이 규칙을 각자 적어 두면 반드시 갈라진다. 갈라지면 이렇게 된다.
 * 미리보기는 "프리셋이 이펙트를 정의하지 않으면 기존 스택을 그대로 둔다" 였고,
 * 확정 적용은 "앞 프리셋이 심은 이펙트는 걷어내고 사용자 것만 남긴다" 였다.
 * 그래서 이펙트를 쓰지 않는 프리셋을 미리 보면 앞 프리셋의 이펙트가 그대로 남고,
 * 눌러 보면 사라졌다. 같은 카드에서 본 것과 누른 결과가 다르다.
 *
 * 지금은 두 곳 다 이 파일의 헬퍼를 부른다. 규칙이 물리적으로 한 벌만 있다.
 *
 * 규칙
 *
 * 소유권은 **레이어의 presetOwnership** 이 기록한다. 앞 프리셋이 심은 트랙의 prop 과
 * 이펙트 id 다. 문서(presetRef)에 한 벌만 두면 다른 레이어에 프리셋을 얹는 순간
 * 이 레이어의 기록이 덮여 사라진다 (ownershipFor 주석의 A -> B -> A).
 *   트랙   : 새 프리셋이 내는 prop + 앞 프리셋이 심은 prop 을 걷어내고 새 트랙을 넣는다.
 *   이펙트 : 앞 프리셋이 심은 id 를 걷어내고 새 이펙트를 뒤에 붙인다.
 * 두 목록 어디에도 없는 것은 사용자가 직접 만든 것이므로 살아남는다.
 */

import type {
  CharAnimSpec,
  EffectInstance,
  MotionProject,
  PresetOwnershipRecord,
  PresetRef,
  RevealSpec,
  Track,
  TrackProp,
} from '@/core/types.ts'

/** 앞 프리셋이 심어 둔 것의 목록. 레이어의 presetOwnership 에서 그대로 읽는다. */
export interface PresetOwnership {
  props: readonly TrackProp[]
  effectIds: readonly string[]
  /** 지금 문서의 가리기를 앞 프리셋이 심었는가. */
  reveal: boolean
  /** 지금 문서의 원근 거리를 앞 프리셋이 심었는가. */
  perspective: boolean
  /** 지금 레이어의 글자 등장을 앞 프리셋이 심었는가. */
  charAnim: boolean
  /** 지금 레이어의 기준점을 앞 프리셋이 옮겼는가. */
  anchor: boolean
}

/** 기준점의 기본값. 프리셋이 옮긴 것을 걷어낼 때 이 자리로 되돌린다. */
export const ANCHOR_DEFAULT: readonly [number, number] = [0.5, 0.5]

/** 기록이 없으면(프리셋을 한 번도 안 썼으면) 아무것도 소유하지 않는다. */
export function ownershipOf(
  ref: PresetRef | PresetOwnershipRecord | undefined,
): PresetOwnership {
  return {
    props: ref?.props ?? [],
    effectIds: ref?.effectIds ?? [],
    reveal: ref?.ownsReveal === true,
    perspective: ref?.ownsPerspective === true,
    charAnim: ref?.ownsCharAnim === true,
    anchor: ref?.ownsAnchor === true,
  }
}

/**
 * **이 레이어에 대한** 소유권. 프리셋을 얹을 때는 언제나 이쪽을 쓴다.
 *
 * 정본은 레이어의 presetOwnership 이다. 소유권은 레이어마다 다른데 문서(presetRef)에
 * 한 벌만 두면 이렇게 된다. A 에 '톡 튀며 등장'(크기+투명도)을 걸고 B 에 아무
 * 프리셋을 걸면 A 의 기록이 B 것으로 덮인다. 다시 A 에 '한 바퀴 회전'(회전만)을
 * 얹으면 걷어낼 목록에 크기/투명도가 없어서, 앞 프리셋의 트랙이 사용자 것으로
 * 오인되어 잔류한다. 회전하면서 계속 튀어오르는, 이 파일이 막겠다고 한 바로 그
 * 증상이 레이어를 오가는 것만으로 되살아난다. 이펙트도 같은 길로 잔류한다.
 *
 * 레이어에 기록이 없으면 presetRef 폴백이다. layerId 를 아는 옛 파일은
 * 마이그레이션이 이미 레이어로 옮겼으므로(project/migrate.ts), 폴백에 걸리는 것은
 * layerId 조차 없는 아주 옛 문서뿐이다. 그때는 대조할 방법이 없으므로 지금까지처럼
 * 본다. 다른 레이어를 가리키는 presetRef 의 소유권으로 이 레이어의 수동 편집을
 * 걷어내지 않는 것도 그대로다.
 */
export function ownershipFor(
  doc: Pick<MotionProject, 'layers' | 'presetRef'>,
  layerId: string,
): PresetOwnership {
  const layer = doc.layers.find((l) => l.id === layerId)
  if (layer?.presetOwnership) return ownershipOf(layer.presetOwnership)
  const ref = doc.presetRef
  if (ref?.layerId !== undefined && ref.layerId !== layerId) return ownershipOf(undefined)
  return ownershipOf(ref)
}

/**
 * 프리셋 한 번의 적용이 심은 것을 레이어 기록으로 만든다.
 *
 * 확정 적용(state/document.ts applyPresetTracks)과 미리보기(motions/apply.ts
 * withPresetApplied)가 같은 함수를 써야 두 문서가 갈리지 않는다. 아무것도
 * 소유하지 않으면 undefined 를 돌려 키 자체를 만들지 않는다 (JSON 왕복 결정론).
 */
export function presetOwnershipRecord(args: {
  tracks: readonly Track[]
  effectIds: readonly string[]
  reveal?: RevealSpec | undefined
  charAnim?: CharAnimSpec | undefined
  perspective?: number | undefined
  anchor?: readonly [number, number] | undefined
}): PresetOwnershipRecord | undefined {
  const record: PresetOwnershipRecord = {
    ...(args.tracks.length > 0 ? { props: args.tracks.map((t) => t.prop) } : {}),
    ...(args.effectIds.length > 0 ? { effectIds: [...args.effectIds] } : {}),
    ...(args.reveal && args.reveal.mode !== 'none' ? { ownsReveal: true } : {}),
    ...(args.charAnim && args.charAnim.mode !== 'none' ? { ownsCharAnim: true } : {}),
    ...(args.perspective !== undefined ? { ownsPerspective: true } : {}),
    ...(args.anchor ? { ownsAnchor: true } : {}),
  }
  return Object.keys(record).length > 0 ? record : undefined
}

/**
 * 가리기 병합.
 *
 * 사용자가 손으로 넣은 것은 지우지 않는다
 *
 * 트랙 / 이펙트와 같은 규칙이다. 가리기는 인스펙터의 「가리기」 섹션에서 사용자가
 * 직접 만드는 값이다. 이걸 언제나 통째로 대체하면, 손으로 블라인드를 걸어 둔
 * 레이어에 아무 프리셋이나 한 번 누르는 순간 말없이 사라진다.
 * dirty 플래그는 이 경로를 막지 못한다.
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

/**
 * 글자 등장 병합. 가리기와 한 글자도 다르지 않은 규칙이다.
 *
 * 인스펙터에서 손으로 고른 등장 모양이 아무 프리셋이나 한 번 누르는 것으로
 * 사라지면 안 된다. 앞 프리셋이 심은 것만 걷어낸다.
 */
export function mergePresetCharAnim(
  existing: CharAnimSpec | undefined,
  emitted: CharAnimSpec | undefined,
  owned: PresetOwnership,
): CharAnimSpec | undefined {
  if (emitted && emitted.mode !== 'none') return emitted
  return owned.charAnim ? undefined : existing
}

/**
 * 기준점 병합.
 *
 * 가리기 / 원근과 같은 규칙인데 되돌릴 자리가 undefined 가 아니라 한가운데다.
 * 기준점은 없을 수 있는 값이 아니라 언제나 두 숫자를 갖는 필드이기 때문이다.
 * 앞 프리셋이 옮겨 둔 것을 걷어낼 때는 기본값으로 되돌린다.
 */
export function mergePresetAnchor(
  existing: readonly [number, number],
  emitted: readonly [number, number] | undefined,
  owned: PresetOwnership,
): [number, number] {
  if (emitted) return [emitted[0], emitted[1]]
  if (owned.anchor) return [ANCHOR_DEFAULT[0], ANCHOR_DEFAULT[1]]
  return [existing[0], existing[1]]
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
 * emitted 가 undefined 인 것과 빈 배열인 것은 여기서 같다. 어느 쪽이든 앞 프리셋이
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
