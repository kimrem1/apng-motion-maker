/**
 * 모션 옮기기.
 *
 * 한 오브제에 얹힌 움직임과 효과를 떼어 다른 오브제에 붙인다.
 *
 * 왜 별도 파일인가
 *
 * "무엇이 모션인가" 라는 판정이 이 기능의 전부다. 레이어는 움직임과 정체성을 한
 * 객체에 담고 있어서, 통째로 복사하면 그림까지 바뀌고 필드를 하나씩 고르면 새 필드가
 * 생길 때마다 조용히 빠진다. 그래서 목록을 여기 한 곳에 두고 스토어 액션과 화면이
 * 같은 함수를 부른다. motions/merge.ts 가 소유권 규칙을 한 곳에 모아 둔 것과 같은 이유다.
 *
 * 옮기는 것
 *   tracks / modifiers                  시간에 따라 값을 미는 것          (갈래 'tracks')
 *   effects                             셰이더 효과 스택                  (갈래 'effects')
 *   reveal / charAnim / anchor           경계선, 등장, 모션이 도는 축      (갈래 'shaping')
 *   perspective / motionExitsFrame       원근 거리, 프레임 이탈 표식       (갈래 'shaping')
 *   motionRepeat                        이 레이어만의 모션 배수            (갈래 'tracks')
 *
 * 옮기지 않는 것 (정체성과 배치)
 *   id / name / type / assetId          무엇을 그리는가
 *   shape / text                        도형과 글자의 생김새
 *   z / visible / locked / folderId     목록에서의 자리
 *   fit / baseScale / blend             화면에 앉는 규칙
 *   inFrame / outFrame / inFade / outFade  타임라인에서 보이는 구간
 *   parentId / parallaxFactor / clipToBelow
 *   fillsCanvas / keepInside            프레임을 벗어날 때의 처리
 *   containScale                        담기 배율
 *
 * 마지막 두 줄에 이유가 있다.
 *
 * 담기/채우기는 그 그림이 무엇이냐로 정해지는 값이다. 스티커의 모션을 배경 사진에
 * 붙였는데 배경이 갑자기 담기로 바뀌면 사용자는 "붙여넣기가 그림을 줄였다" 고 읽는다.
 *
 * containScale 은 더 나쁘다. 그 값은 **원본 레이어의 픽셀 크기**를 기준으로 푼 배율이라
 * (core/types.ts Layer.containScale), 크기가 다른 대상에 그대로 심으면 이유 없이
 * 작아지거나 커진다. 그래서 대상에서는 지운다. 지우면 담기 솔버가 문서에서 다시
 * 풀고, 그것이 손으로 만든 레이어와 옛 프로젝트가 이미 타는 경로다.
 *
 * 반대로 motionExitsFrame 은 **모션에서 파생된 사실**이라 함께 간다. 슬라이드 등장을
 * 붙였는데 이 표식이 안 따라오면 담기 솔버가 개입해서, 빠져나가야 할 그림이
 * 가장자리에 붙어 멈춘다 (core/overscan.ts isContainTarget).
 *
 * DOM / React / 스토어를 참조하지 않는다. 순수 계산부다.
 */

import type {
  CharAnimSpec,
  EffectInstance,
  EffectParam,
  Layer,
  Modifier,
  RevealSpec,
  Track,
} from '@/core/types.ts'

// ---------------------------------------------------------------------------
// 갈래
// ---------------------------------------------------------------------------

/**
 * 무엇을 옮길 것인가.
 *
 * 셋으로 나누는 이유는 사용자가 실제로 부르는 이름이 셋이기 때문이다. "저것처럼
 * 움직이게" 와 "저 반짝임만 가져와" 는 다른 요구다. 한 덩어리로 묶으면 효과만
 * 옮기고 싶을 때 대상의 움직임까지 통째로 갈린다.
 */
export interface MotionParts {
  /** 트랙 + 모디파이어 + 모션 배수. 폴더에도 그대로 걸린다. */
  tracks: boolean
  /** 이펙트 스택. 대상이 폴더면 무시된다. */
  effects: boolean
  /** 가리기 / 등장 / 기준점 / 원근 / 프레임 이탈 표식. 가리기는 폴더에서 무시된다. */
  shaping: boolean
}

export const ALL_MOTION_PARTS: MotionParts = { tracks: true, effects: true, shaping: true }

// ---------------------------------------------------------------------------
// 꾸러미
// ---------------------------------------------------------------------------

/**
 * 레이어에서 떼어낸 모션 한 벌.
 *
 * 값 사본이다. 원본 레이어를 지우거나 실행취소로 되돌려도 이 꾸러미는 그대로 살아
 * 있어야 붙여넣기가 성립한다. 그래서 참조를 들고 있지 않고 깊은 사본을 만든다.
 */
export interface MotionBundle {
  /** 어디서 떼어냈는가. 화면 문구에만 쓴다. */
  sourceLayerId: string
  sourceLayerName: string
  tracks: Track[]
  modifiers: Modifier[]
  effects: EffectInstance[]
  reveal?: RevealSpec
  charAnim?: CharAnimSpec
  perspective?: number
  anchor: [number, number]
  motionRepeat?: number
  motionExitsFrame: boolean
}

/**
 * 이 갈래에 실제로 옮길 것이 들어 있는가.
 *
 * 빈 레이어에서 떼어낸 꾸러미를 붙이면 대상의 모션이 조용히 지워진다. 그 조작에는
 * 이름이 없으므로(사용자는 "보내기" 를 눌렀다) 호출부가 미리 막아야 한다.
 */
/** 기준점이 기본값(가운데)에서 벗어나 있는가. shaping 갈래의 판정과 요약이 함께 쓴다. */
function anchorIsCustom(bundle: MotionBundle): boolean {
  return bundle.anchor[0] !== 0.5 || bundle.anchor[1] !== 0.5
}

export function bundleIsEmpty(bundle: MotionBundle, parts: MotionParts): boolean {
  if (parts.tracks && (bundle.tracks.length > 0 || bundle.modifiers.length > 0)) return false
  // shaping 갈래는 가리기/등장만이 아니라 기준점/원근/프레임 이탈 표식도 함께 옮긴다
  // (applyMotionBundle). 여기서 그 셋을 빼먹으면 '경첩 열리며 등장' 처럼 기준점과
  // 원근만 심는 모션이 "보낼 것이 없습니다" 로 부당하게 막힌다.
  if (parts.effects && bundle.effects.length > 0) return false
  if (
    parts.shaping &&
    (bundle.reveal !== undefined ||
      bundle.charAnim !== undefined ||
      bundle.perspective !== undefined ||
      bundle.motionExitsFrame ||
      anchorIsCustom(bundle))
  ) {
    return false
  }
  return true
}

/** 꾸러미에 든 것을 사람이 읽는 조각으로. 보내기 전에 무엇이 갈지 보여 준다. */
export function describeBundle(bundle: MotionBundle, parts: MotionParts): string[] {
  const out: string[] = []
  if (parts.tracks) {
    if (bundle.tracks.length > 0) out.push(`움직임 ${bundle.tracks.length}개`)
    if (bundle.modifiers.length > 0) out.push(`흔들림 ${bundle.modifiers.length}개`)
    if (bundle.motionRepeat !== undefined && bundle.motionRepeat > 1) {
      out.push(`속도 ${bundle.motionRepeat}배`)
    }
  }
  if (parts.effects && bundle.effects.length > 0) out.push(`효과 ${bundle.effects.length}개`)
  if (parts.shaping) {
    if (bundle.reveal) out.push('가리기')
    if (bundle.charAnim) out.push('등장')
    // bundleIsEmpty 의 shaping 판정과 짝. 요약에 없는 것이 판정에만 있으면
    // "보낼 것" 문구와 실제 전송 내용이 어긋난다.
    if (anchorIsCustom(bundle)) out.push('기준점')
    if (bundle.perspective !== undefined) out.push('원근')
    if (bundle.motionExitsFrame) out.push('프레임 이탈')
  }
  return out
}

// ---------------------------------------------------------------------------
// 떼어내기
// ---------------------------------------------------------------------------

function cloneTrack(t: Track): Track {
  return {
    ...t,
    keys: t.keys.map((k) => ({
      ...k,
      ...(k.out ? { out: { ...k.out } } : {}),
      ...(k.in ? { in: { ...k.in } } : {}),
      ...(k.spring ? { spring: { ...k.spring } } : {}),
    })),
  }
}

function cloneModifier(m: Modifier): Modifier {
  return {
    ...m,
    ...(m.envelope ? { envelope: m.envelope.map((k) => ({ ...k })) } : {}),
  }
}

/**
 * 이펙트 파라미터가 상수가 아니라 트랙인가.
 *
 * effects/registry.ts 에 같은 판정이 있지만 그쪽은 export 되어 있지 않다. 여기서
 * import 하려고 그 파일의 공개 얼굴을 넓히지 않는다. 판정식은 한 줄이고, 넓히면
 * 이 파일이 이펙트 레지스트리에 묶인다.
 */
function paramIsTrack(v: EffectParam): v is Track {
  return typeof v === 'object' && v !== null && Array.isArray((v as Track).keys)
}

function cloneEffect(e: EffectInstance): EffectInstance {
  const params: Record<string, EffectParam> = {}
  for (const [key, value] of Object.entries(e.params)) {
    // 얕게 복사하면 두 레이어가 같은 트랙 객체와 같은 id 를 공유한다. 한쪽을 고치면
    // 다른 쪽도 움직이고, 저장했다 열면 id 가 충돌한다.
    params[key] = paramIsTrack(value) ? cloneTrack(value) : value
  }
  return {
    ...e,
    ...(e.range ? { range: [e.range[0], e.range[1]] as [number, number] } : {}),
    params,
  }
}

/** 레이어에서 모션 한 벌을 떼어낸다. 레이어는 바뀌지 않는다. */
export function extractMotion(layer: Layer): MotionBundle {
  return {
    sourceLayerId: layer.id,
    sourceLayerName: layer.name,
    tracks: layer.tracks.map(cloneTrack),
    modifiers: layer.modifiers.map(cloneModifier),
    effects: layer.effects.map(cloneEffect),
    ...(layer.reveal ? { reveal: { ...layer.reveal } } : {}),
    ...(layer.charAnim ? { charAnim: { ...layer.charAnim } } : {}),
    ...(typeof layer.perspective === 'number' ? { perspective: layer.perspective } : {}),
    anchor: [layer.anchor[0], layer.anchor[1]],
    ...(typeof layer.motionRepeat === 'number' ? { motionRepeat: layer.motionRepeat } : {}),
    motionExitsFrame: layer.motionExitsFrame === true,
  }
}

// ---------------------------------------------------------------------------
// 붙이기
// ---------------------------------------------------------------------------

/**
 * 붙일 때 새 id 를 발급받는 것들.
 *
 * 트랙 / 모디파이어 / 이펙트의 id 는 문서 안에서 유일해야 한다. 두 레이어가 같은
 * 트랙 id 를 들면 그래프 에디터가 어느 쪽을 고쳤는지 구별하지 못하고, 이펙트 id 는
 * 프리셋 소유권 목록(presetRef.effectIds)의 열쇠라 겹치면 다음 프리셋 한 번에
 * 엉뚱한 레이어의 이펙트가 걷힌다.
 *
 * 시드는 새로 뽑지 않는다. 옮긴 흔들림이 원본과 같은 패턴이어야 "같은 모션" 이다.
 */
export interface IdMinter {
  track(): string
  modifier(): string
  effect(): string
}

/**
 * 꾸러미를 레이어에 얹는다. 고른 갈래는 통째로 대체된다.
 *
 * 왜 병합이 아니라 대체인가
 *
 * 프리셋 적용(motions/merge.ts)은 소유권을 보고 사용자가 만든 것을 남긴다. 그쪽은
 * "카드를 갈아탄다" 는 조작이라 앞 카드의 흔적만 걷어내는 것이 옳다. 이쪽은
 * "저 오브제와 똑같이 움직이게 해 줘" 라는 조작이다. 남겨 두면 결과가 원본과
 * 달라져서, 사용자가 눈으로 확인한 움직임과 보낸 결과가 다르다. 대체가 계약이다.
 *
 * 없는 값은 undefined 를 대입하지 않고 키를 지운다. 뜻이 없는 키가 문서에 남으면
 * 저장하고 여는 왕복에서 JSON 이 달라진다 (core/types.ts 의 shape 주석).
 *
 * 폴더 가드
 *
 * 폴더는 그리는 픽셀이 없어서 인스펙터가 가리기와 이펙트 화면을 아예 띄우지 않는다
 * (ui/inspector/Inspector.tsx). 그런 레이어에 값을 심으면 사용자가 지울 화면이 없는
 * 유령 값이 된다. 움직임은 폴더의 쓰임새 그 자체이므로 그대로 걸린다.
 */
export function applyMotionBundle(
  layer: Layer,
  bundle: MotionBundle,
  parts: MotionParts,
  mint: IdMinter,
): void {
  const isFolder = layer.type === 'group'

  if (parts.tracks) {
    layer.tracks = bundle.tracks.map((t) => ({ ...cloneTrack(t), id: mint.track() }))
    layer.modifiers = bundle.modifiers.map((m) => ({ ...cloneModifier(m), id: mint.modifier() }))
    if (typeof bundle.motionRepeat === 'number' && bundle.motionRepeat > 1) {
      layer.motionRepeat = bundle.motionRepeat
    } else {
      delete layer.motionRepeat
    }
  }

  if (parts.effects && !isFolder) {
    layer.effects = bundle.effects.map((e) => ({ ...cloneEffect(e), id: mint.effect() }))
  }

  if (parts.shaping) {
    if (bundle.reveal && !isFolder) layer.reveal = { ...bundle.reveal }
    else delete layer.reveal

    /*
     * 글자 등장은 글자 레이어가 아니어도 얹는다.
     *
     * 오브제(이미지 / 도형)도 글자 한 개짜리 글 상자로 보고 같은 등장을 태우기
     * 때문이다 (core/evaluate.ts applyObjectCharAnim). 여기서 글자 레이어만 걸러내면
     * "글자에 건 등장을 그림에도" 라는 가장 자연스러운 사용처가 막힌다.
     */
    if (bundle.charAnim) layer.charAnim = { ...bundle.charAnim }
    else delete layer.charAnim

    if (typeof bundle.perspective === 'number') layer.perspective = bundle.perspective
    else delete layer.perspective

    // 배열 대입은 immer 가 패치로 기록한다. 값이 같으면 쓰지 않는다.
    if (layer.anchor[0] !== bundle.anchor[0] || layer.anchor[1] !== bundle.anchor[1]) {
      layer.anchor = [bundle.anchor[0], bundle.anchor[1]]
    }

    layer.motionExitsFrame = bundle.motionExitsFrame
  }

  /*
   * 담기 배율은 옮기지 않고 지운다 (머리 주석). 대상은 문서에서 다시 푼다.
   * 움직임이 바뀌면 어차피 옛 값은 틀린 값이므로, 어느 갈래를 보내든 지운다.
   */
  if (parts.tracks || parts.shaping) delete layer.containScale
}

/**
 * 레이어에서 모션을 걷어낸다. "옮기기" 의 원본 쪽이다.
 *
 * 갈래를 그대로 받는다. 효과만 옮겼으면 원본에서도 효과만 빠져야 한다.
 */
export function clearMotion(layer: Layer, parts: MotionParts): void {
  if (parts.tracks) {
    layer.tracks = []
    layer.modifiers = []
    delete layer.motionRepeat
  }
  if (parts.effects) layer.effects = []
  if (parts.shaping) {
    delete layer.reveal
    delete layer.charAnim
    delete layer.perspective
    layer.motionExitsFrame = false
    if (layer.anchor[0] !== 0.5 || layer.anchor[1] !== 0.5) layer.anchor = [0.5, 0.5]
  }
  if (parts.tracks || parts.shaping) delete layer.containScale
}
