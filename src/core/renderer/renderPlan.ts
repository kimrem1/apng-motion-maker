/**
 * 렌더 절차 계획.
 *
 * 렌더 루프에서 "무엇을 어떤 순서로 그릴 것인가" 만 떼어 낸 순수 로직이다.
 * WebGL 을 전혀 모르므로 Node 에서 그대로 테스트한다 (tests/unit/clip.test.ts).
 *
 * 렌더러(renderer/index.ts)의 최상위 루프와 폴더 서브트리(renderRange)가 똑같이
 * 이 절차를 따른다. 예전에는 서브트리 순회가 자르기 덩어리를 몰라서, 자르기에
 * 참여한 폴더 안의 중첩 자르기가 통째로 무시됐다. 순회 규칙이 한 곳에 있으면
 * 두 경로가 어긋날 수 없다.
 */

import type { ClipGroup } from '../clip.ts'

/** 절차 계산에 필요한 최소한의 레이어 정보. ResolvedLayer 가 그대로 들어온다. */
export interface PlanLayer {
  visible: boolean
  isFolder?: boolean
  /** 없으면 'normal' 로 본다. 테스트가 최소 입력으로 부를 수 있게 한다. */
  blend?: string
}

export type RenderStep =
  /** 자르기 덩어리. 밑판을 마스크로 삼아 멤버를 깎는 절차 전체가 한 단계다. */
  | { kind: 'clipGroup'; group: ClipGroup }
  /** 혼합 모드가 걸린 폴더. index+1..end 를 한 장에 담아 폴더의 blend 로 얹는다. */
  | { kind: 'folderBlend'; index: number; end: number }
  /** 보통 레이어 한 장. 이펙트/혼합 처리는 렌더러가 레이어를 보고 정한다. */
  | { kind: 'layer'; index: number }

/**
 * from..to 를 그리는 절차.
 *
 *   - 덩어리 검사가 보임 검사보다 먼저다. 밑판이 안 보여도 덩어리는 만들어져야
 *     멤버들이 (빈 마스크에 깎여) 함께 사라진다. 밑판만 건너뛰면 멤버가
 *     안 잘린 채 그대로 그려진다.
 *   - 덩어리 멤버(와 그 폴더 식구)는 밑판 차례에 그려지므로 건너뛴다. 멤버는
 *     항상 밑판보다 뒤 번호라(clip.ts 가 아래로 내려가며 밑판을 찾는다) 덩어리를
 *     만난 시점에 건너뛸 번호를 다 안다.
 *   - 폴더 자체는 아무것도 그리지 않으므로 단계를 만들지 않는다. 혼합 모드가
 *     걸린 보이는 폴더만 서브트리를 한 장에 담는 단계가 된다.
 */
export function renderStepsForRange(
  layers: readonly PlanLayer[],
  groupByBase: ReadonlyMap<number, ClipGroup>,
  subtreeEnd: readonly number[],
  from: number,
  to: number,
): RenderStep[] {
  const steps: RenderStep[] = []
  /** 이 범위 안에서 밑판 차례에 이미 그려질 번호들. 덩어리를 만날 때 채운다. */
  let skip: Set<number> | null = null

  for (let k = Math.max(0, from); k <= to; k += 1) {
    if (skip?.has(k)) continue

    const group = groupByBase.get(k)
    if (group) {
      steps.push({ kind: 'clipGroup', group })
      if (!skip) skip = new Set()
      // 멤버가 폴더면 그 안쪽까지 전부 밑판 차례에 그려진다.
      for (const m of group.members) {
        for (let x = m; x <= (subtreeEnd[m] ?? m); x += 1) skip.add(x)
      }
      // 밑판이 폴더면 그 식구들까지 이 차례에 끝났다.
      k = Math.max(k, group.baseEnd)
      continue
    }

    const layer = layers[k]!
    if (!layer.visible) continue

    if (layer.isFolder) {
      if ((layer.blend ?? 'normal') !== 'normal') {
        const end = subtreeEnd[k] ?? k
        steps.push({ kind: 'folderBlend', index: k, end })
        k = end
      }
      // 노멀 폴더는 그릴 것이 없다. 식구들이 각자 그려진다.
      continue
    }

    steps.push({ kind: 'layer', index: k })
  }
  return steps
}

/**
 * 글자 잉크의 가로 중심.
 *
 * glyph.w 는 자간을 포함한 전진폭이고(core/text.ts layoutText — 마지막 글자도
 * 포함한다), 아틀라스는 잉크를 순수 전진폭의 중심에 굽는다(textAtlas.bakeText 가
 * textAlign 'center' 로 칸 가운데에 그린다). 쿼드를 w 의 중심에 놓으면 잉크가
 * 전부 +자간/2 만큼 밀리고, 마지막 글자는 layout.width 상자를 벗어난다.
 * 자간을 빼면 순수 전진폭(>= 0)이 남으므로 자간이 음수여도 식이 그대로 성립한다.
 */
export function glyphInkCenterX(x: number, w: number, letterSpacing: number): number {
  return x + (w - letterSpacing) / 2
}
