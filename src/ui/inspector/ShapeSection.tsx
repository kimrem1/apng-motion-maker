/**
 * 도형 레이어의 모양 편집.
 *
 * 여기서 다루는 것은 모양뿐이다. 위치와 회전과 크기 배율은 이미지와 똑같이
 * 위쪽 레이어 섹션이 맡는다. 도형이라고 별도의 이동 입력을 만들면 같은 일을 하는
 * 입력이 두 벌이 되고, 하나로 옮긴 값이 다른 쪽에 안 보인다.
 *
 * 폭과 높이는 "이 도형의 원본 크기" 다. 이미지의 원본 픽셀 크기와 같은 자리이므로
 * 맞춤 / 프레임 처리 / 캔버스 배율 규칙이 그대로 적용된다.
 */

import { SHAPE_KIND_LABELS, SHAPE_LIMITS, toHex6 } from '@/core/shape.ts'
import {
  SHAPE_KIND_LIST,
  SHAPE_SIZE_MAX,
  SHAPE_SIZE_MIN,
  type Layer,
  type ShapeKind,
} from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
import { NumberField, SelectField, type SelectOption } from '@/ui/widgets/Field.tsx'

const KIND_OPTIONS: readonly SelectOption<ShapeKind>[] = SHAPE_KIND_LIST.map((kind) => ({
  value: kind,
  label: SHAPE_KIND_LABELS[kind],
}))

export function ShapeSection({ layer }: { layer: Layer }) {
  const setShapeSpec = useDocumentStore((s) => s.setShapeSpec)
  const shape = layer.shape
  if (!shape) return null

  const round = shape.kind === 'rect' || shape.kind === 'cross' || shape.kind === 'ticks'
  // 개수 노브를 쓰는 종류. 꼭짓점 / 살 / 눈금이 전부 같은 필드를 나눠 쓴다.
  const many =
    shape.kind === 'polygon' ||
    shape.kind === 'star' ||
    shape.kind === 'burst' ||
    shape.kind === 'ticks' ||
    shape.kind === 'sparkle'

  /** 개수 노브의 이름. 종류마다 뜻이 다르다. */
  const countLabel =
    shape.kind === 'burst' ? '살 개수' : shape.kind === 'ticks' ? '눈금 개수' : '꼭짓점'

  /**
   * 색 입력은 #rrggbb 만 주고받는다. 세트가 넣어 둔 반투명 알파(#rrggbbaa 의 뒤 두 자리)를
   * 여기서 되붙이지 않으면 색을 한 번 고르는 것만으로 반투명이 사라진다.
   * parseHexColor 는 형식이 깨졌을 때 알파 0 을 돌려주므로 쓰지 않는다.
   */
  const alphaHex = /^#[0-9a-f]{8}$/i.test(shape.color.trim())
    ? shape.color.trim().slice(7).toLowerCase()
    : 'ff'

  return (
    <section className="mm-section" aria-labelledby="mm-sec-shape">
      <h2 className="mm-section-title" id="mm-sec-shape">
        도형
      </h2>
      <div className="mm-stack">
        <SelectField
          label="종류"
          value={shape.kind}
          options={KIND_OPTIONS}
          ariaLabel="도형 종류"
          onChange={(kind) => setShapeSpec(layer.id, { kind })}
        />

        <div className="mm-field mm-field-inline">
          <label className="mm-field-label" htmlFor="mm-shape-fill">
            색
          </label>
          <div className="mm-field-control mm-color-row">
            <span className="mm-field-hint">{toHex6(shape.color)}</span>
            <input
              id="mm-shape-fill"
              className="mm-color"
              type="color"
              value={toHex6(shape.color)}
              aria-label="도형 색"
              onChange={(e) => setShapeSpec(layer.id, { color: `${e.target.value}${alphaHex}` })}
            />
          </div>
        </div>

        <div className="mm-row-2">
          <NumberField
            label="폭"
            value={shape.width}
            min={SHAPE_SIZE_MIN}
            max={SHAPE_SIZE_MAX}
            suffix="px"
            ariaLabel="도형 폭(px)"
            onChange={(width) => setShapeSpec(layer.id, { width })}
          />
          <NumberField
            label="높이"
            value={shape.height}
            min={SHAPE_SIZE_MIN}
            max={SHAPE_SIZE_MAX}
            suffix="px"
            ariaLabel="도형 높이(px)"
            onChange={(height) => setShapeSpec(layer.id, { height })}
          />
        </div>

        <NumberField
          label="선 두께"
          value={shape.strokeWidth}
          min={SHAPE_LIMITS.strokeWidth.min}
          max={SHAPE_LIMITS.strokeWidth.max}
          suffix="px"
          hint={
            shape.kind === 'burst'
              ? '살 한 줄의 굵기입니다.'
              : '0 이면 안을 꽉 채웁니다. 올리면 테두리만 남습니다.'
          }
          ariaLabel="도형 선 두께(px)"
          onChange={(strokeWidth) => setShapeSpec(layer.id, { strokeWidth })}
        />

        {round ? (
          <NumberField
            label={shape.kind === 'cross' ? '모서리 둥글기' : '모서리 반지름'}
            value={shape.cornerRadius}
            min={SHAPE_LIMITS.cornerRadius.min}
            max={SHAPE_LIMITS.cornerRadius.max}
            suffix="px"
            hint="짧은 변의 절반까지 올리면 알약 모양이 됩니다."
            ariaLabel="도형 모서리 반지름(px)"
            onChange={(cornerRadius) => setShapeSpec(layer.id, { cornerRadius })}
          />
        ) : null}

        {many ? (
          <NumberField
            label={countLabel}
            value={shape.points}
            min={SHAPE_LIMITS.points.min}
            max={SHAPE_LIMITS.points.max}
            suffix="개"
            ariaLabel={countLabel}
            onChange={(points) => setShapeSpec(layer.id, { points })}
          />
        ) : null}

        {shape.kind === 'star' ? (
          <NumberField
            label="뾰족함"
            value={shape.innerRatio}
            min={SHAPE_LIMITS.innerRatio.min}
            max={SHAPE_LIMITS.innerRatio.max}
            step={0.05}
            hint="작을수록 날카롭습니다."
            ariaLabel="별의 안쪽 반지름 비율"
            onChange={(innerRatio) => setShapeSpec(layer.id, { innerRatio })}
          />
        ) : null}

        {shape.kind === 'cross' ? (
          <NumberField
            label="팔 두께"
            value={shape.innerRatio}
            min={SHAPE_LIMITS.innerRatio.min}
            max={SHAPE_LIMITS.innerRatio.max}
            step={0.05}
            ariaLabel="십자 팔 두께 비율"
            onChange={(innerRatio) => setShapeSpec(layer.id, { innerRatio })}
          />
        ) : null}

        {shape.kind === 'burst' ? (
          <NumberField
            label="가운데 빈 곳"
            value={shape.innerRatio}
            min={SHAPE_LIMITS.innerRatio.min}
            max={SHAPE_LIMITS.innerRatio.max}
            step={0.05}
            hint="0 에 가까울수록 살이 가운데까지 모입니다."
            ariaLabel="방사살 안쪽 반지름 비율"
            onChange={(innerRatio) => setShapeSpec(layer.id, { innerRatio })}
          />
        ) : null}

        {shape.kind === 'ticks' ? (
          <NumberField
            label="눈금 굵기"
            value={shape.innerRatio}
            min={SHAPE_LIMITS.innerRatio.min}
            max={SHAPE_LIMITS.innerRatio.max}
            step={0.05}
            hint="1 에 가까우면 빈틈이 사라져 한 줄이 됩니다."
            ariaLabel="눈금 한 칸에서 막대가 차지하는 비율"
            onChange={(innerRatio) => setShapeSpec(layer.id, { innerRatio })}
          />
        ) : null}

        {shape.kind === 'sparkle' ? (
          <NumberField
            label="뾰족함"
            value={shape.innerRatio}
            min={SHAPE_LIMITS.innerRatio.min}
            max={SHAPE_LIMITS.innerRatio.max}
            step={0.05}
            hint="작을수록 날카롭습니다."
            ariaLabel="별빛 뾰족함"
            onChange={(innerRatio) => setShapeSpec(layer.id, { innerRatio })}
          />
        ) : null}

        {shape.kind === 'arc' ? (
          <NumberField
            label="벌어진 각"
            value={shape.sweepDeg}
            min={SHAPE_LIMITS.sweepDeg.min}
            max={SHAPE_LIMITS.sweepDeg.max}
            suffix="도"
            hint="360 이면 원이 됩니다. 선 두께를 올리면 고리 조각이 됩니다."
            ariaLabel="부채꼴 각도"
            onChange={(sweepDeg) => setShapeSpec(layer.id, { sweepDeg })}
          />
        ) : null}
      </div>
    </section>
  )
}

export default ShapeSection
