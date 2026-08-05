/**
 * 우측 인스펙터.
 *
 * 캔버스 / 레이어 / 반복 세 섹션을 만든다. 이펙트 섹션과 이음새 검사는 별도 조각이다.
 * 내부 단위와 UI 단위가 다른 값이 둘 있다.
 *   크기: 내부 배율(1.0) <-> UI 퍼센트(100)
 *   불투명도: 내부 0~1 <-> UI 0~100
 * 변환은 이 파일 안에서만 한다. 스토어에는 항상 내부 단위로 쓴다.
 */

import { useRef, useState } from 'react'

import {
  CANVAS_MAX,
  CANVAS_MIN,
  PERSPECTIVE_DEFAULT,
  PERSPECTIVE_MAX,
  REVEAL_MODE_LIST,
  type FitMode,
  type Layer,
  type LoopMode,
  type RevealMode,
} from '@/core/types.ts'
import { REVEAL_LIMITS, REVEAL_MODE_LABELS, REVEAL_SLATS_LABELS } from '@/core/reveal.ts'
import { isAnimated, readStaticValue, useDocumentStore } from '@/state/document.ts'
import { AnimateToggle } from '@/ui/inspector/AnimateToggle.tsx'
import { EffectStack } from '@/ui/effects/EffectStack.tsx'
import { LayerProperties } from '@/ui/layers/LayerProperties.tsx'
import { PrepPanel } from '@/ui/prep/PrepPanel.tsx'
import { TextSection } from './TextSection.tsx'
import { CharAnimSection } from './CharAnimSection.tsx'
import { ShapeSection } from '@/ui/inspector/ShapeSection.tsx'
import { useUiStore } from '@/state/ui.ts'
import { useEditFrame } from './useEditFrame.ts'
import { AnchorGrid, anchorLabelOf } from '@/ui/widgets/AnchorGrid.tsx'
import { NumberField, SelectField, TextField, ToggleField, type SelectOption } from '@/ui/widgets/Field.tsx'

const FIT_OPTIONS: readonly SelectOption<FitMode>[] = [
  { value: 'cover', label: '꽉 채우기' },
  { value: 'contain', label: '전체 보이기' },
  { value: 'fill', label: '늘여 채우기' },
  { value: 'none', label: '원본 크기' },
]

const REVEAL_OPTIONS: readonly SelectOption<RevealMode>[] = REVEAL_MODE_LIST.map((mode) => ({
  value: mode,
  label: REVEAL_MODE_LABELS[mode],
}))

const LOOP_OPTIONS: readonly SelectOption<LoopMode>[] = [
  { value: 'once', label: '한 번만' },
  { value: 'loop', label: '반복' },
  { value: 'pingPong', label: '왕복' },
  { value: 'loopWithHold', label: '반복 + 멈춤' },
]

/** <input type="color"> 는 #rrggbb 만 받는다. 알파가 붙은 값은 잘라 낸다. */
function toHex6(color: string): string {
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return color.slice(0, 7)
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    const r = color[1] ?? '0'
    const g = color[2] ?? '0'
    const b = color[3] ?? '0'
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return '#ffffff'
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// ---------------------------------------------------------------------------
// 캔버스 섹션
// ---------------------------------------------------------------------------

function CanvasSection() {
  const canvas = useDocumentStore((s) => s.doc.canvas)
  const setCanvasSize = useDocumentStore((s) => s.setCanvasSize)
  const setBackgroundType = useDocumentStore((s) => s.setBackgroundType)
  const setBackgroundColor = useDocumentStore((s) => s.setBackgroundColor)

  const [ratioLocked, setRatioLocked] = useState(false)
  // 잠금을 켠 순간의 비율을 고정한다. 매번 현재 값에서 다시 구하면 드리프트가 쌓인다.
  const ratioRef = useRef(1)
  // 이 컴포넌트가 쓴 크기. 밖에서 캔버스가 바뀌면(이미지 추가 등) 비율을 다시 잡아야 한다.
  const lastWrittenRef = useRef<[number, number]>([canvas.w, canvas.h])

  if (
    ratioLocked &&
    canvas.h > 0 &&
    (canvas.w !== lastWrittenRef.current[0] || canvas.h !== lastWrittenRef.current[1])
  ) {
    // 이미지를 새로 넣으면 캔버스가 그 비율로 맞춰진다. 잠금이 옛 비율을 계속
    // 강제하면 폭을 한 번 건드리는 순간 높이가 엉뚱한 값으로 튄다.
    ratioRef.current = canvas.w / canvas.h
    lastWrittenRef.current = [canvas.w, canvas.h]
  }

  function toggleLock(next: boolean): void {
    if (next && canvas.h > 0) ratioRef.current = canvas.w / canvas.h
    lastWrittenRef.current = [canvas.w, canvas.h]
    setRatioLocked(next)
  }

  /** 두 축을 함께 상한 안으로 넣는다. 한쪽만 잘리면 비율이 깨진 채 남는다. */
  function commitSize(w: number, h: number): void {
    let cw = clamp(Math.round(w), CANVAS_MIN, CANVAS_MAX)
    let ch = clamp(Math.round(h), CANVAS_MIN, CANVAS_MAX)
    if (ratioLocked) {
      const ratio = ratioRef.current || 1
      // 클램프에 걸린 쪽을 기준으로 반대편을 다시 계산한다.
      if (ch !== Math.round(h)) cw = clamp(Math.round(ch * ratio), CANVAS_MIN, CANVAS_MAX)
      else if (cw !== Math.round(w)) ch = clamp(Math.round(cw / ratio), CANVAS_MIN, CANVAS_MAX)
    }
    lastWrittenRef.current = [cw, ch]
    // 폭/높이는 결과물 해상도다. 그림도 같은 비율로 따라가야 잘리지 않는다.
    setCanvasSize(cw, ch, { scaleContent: true })
  }

  /*
   * 타이핑 중간값을 문서에 넣지 않는다.
   *
   * NumberField 는 글자 하나마다 onChange 를 쏜다. "800" 을 치면 8 -> 80 -> 800 이
   * 차례로 들어오는데, setCanvasSize 의 그림 배율 보정은 줄어들 때만 곱하는 래칫이라
   * ('8' 에서 0.016배) 뒤이어 커진 값이 그것을 되돌리지 못한다. 결과적으로 폭 칸을
   * 한 번 타이핑하는 것만으로 그림이 점으로 사라지고, 같은 숫자를 다시 쳐도 안 돌아온다.
   * 그래서 편집이 끝날 때(블러 / Enter) 한 번만 확정한다.
   */
  const sizeEditingRef = useRef(false)
  const pendingSizeRef = useRef<[number, number] | null>(null)

  function requestSize(w: number, h: number): void {
    if (sizeEditingRef.current) {
      pendingSizeRef.current = [w, h]
      return
    }
    commitSize(w, h)
  }

  function beginSizeEdit(): void {
    sizeEditingRef.current = true
    pendingSizeRef.current = null
  }

  function endSizeEdit(): void {
    sizeEditingRef.current = false
    const pending = pendingSizeRef.current
    pendingSizeRef.current = null
    if (pending) commitSize(pending[0], pending[1])
  }

  function changeWidth(w: number): void {
    requestSize(w, ratioLocked ? w / (ratioRef.current || 1) : canvas.h)
  }

  function changeHeight(h: number): void {
    requestSize(ratioLocked ? h * (ratioRef.current || 1) : canvas.w, h)
  }

  const isSolid = canvas.background.type === 'solid'

  return (
    <section className="mm-section" aria-labelledby="mm-sec-canvas">
      <h2 className="mm-section-title" id="mm-sec-canvas">
        캔버스
      </h2>
      <div className="mm-stack">
        <div className="mm-row-2">
          <NumberField
            label="폭"
            value={canvas.w}
            min={CANVAS_MIN}
            max={CANVAS_MAX}
            suffix="px"
            ariaLabel="캔버스 폭(px)"
            onChange={changeWidth}
            onEditStart={beginSizeEdit}
            onEditEnd={endSizeEdit}
          />
          <NumberField
            label="높이"
            value={canvas.h}
            min={CANVAS_MIN}
            max={CANVAS_MAX}
            suffix="px"
            ariaLabel="캔버스 높이(px)"
            onChange={changeHeight}
            onEditStart={beginSizeEdit}
            onEditEnd={endSizeEdit}
          />
        </div>

        <ToggleField label="비율 잠금" checked={ratioLocked} onChange={toggleLock} />

        <fieldset className="mm-field mm-fieldset">
          <legend className="mm-field-label">배경</legend>
          <div className="mm-radio-row">
            <label className="mm-radio">
              <input
                type="radio"
                name="mm-bg-type"
                checked={!isSolid}
                onChange={() => setBackgroundType('alpha')}
              />
              투명
            </label>
            <label className="mm-radio">
              <input
                type="radio"
                name="mm-bg-type"
                checked={isSolid}
                onChange={() => setBackgroundType('solid')}
              />
              단색
            </label>
          </div>
        </fieldset>

        {isSolid ? (
          <div className="mm-field mm-field-inline">
            <label className="mm-field-label" htmlFor="mm-bg-color">
              배경색
            </label>
            <div className="mm-field-control mm-color-row">
              <span className="mm-field-hint">{toHex6(canvas.background.color)}</span>
              <input
                id="mm-bg-color"
                className="mm-color"
                type="color"
                value={toHex6(canvas.background.color)}
                aria-label="배경 단색"
                onChange={(e) => setBackgroundColor(e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 레이어 섹션
// ---------------------------------------------------------------------------

function LayerSection({ layer }: { layer: Layer }) {
  const setLayerName = useDocumentStore((s) => s.setLayerName)
  const setLayerFit = useDocumentStore((s) => s.setLayerFit)
  const setLayerAnchor = useDocumentStore((s) => s.setLayerAnchor)
  const setStaticValue = useDocumentStore((s) => s.setStaticValue)
  const setValueAtFrame = useDocumentStore((s) => s.setValueAtFrame)
  const setLayerPerspective = useDocumentStore((s) => s.setLayerPerspective)
  const frame = useUiStore((s) => s.playheadFrame)

  // 한 번의 편집이 쓰는 프레임. 규칙은 useEditFrame.ts 한 곳에만 있다.
  const { beginEdit, endEdit } = useEditFrame()

  /**
   * 애니메이션 중인 속성은 현재 프레임 값을 보여주고, 편집하면 그 프레임에 키를 찍는다.
   * 애니메이션이 아니면 상수 키를 그대로 고친다.
   * 이 분기를 안 하면 키프레임을 찍어 둔 속성을 인스펙터에서 건드리는 순간
   * 애니메이션 전체가 상수로 뭉개진다.
   */
  const read = (prop: Parameters<typeof readStaticValue>[1]): number =>
    readStaticValue(layer, prop, frame)
  const write = (prop: Parameters<typeof readStaticValue>[1], value: number): void => {
    // 포커스 없이 값이 들어오는 경로(스피너 등)도 여기서 세션을 연다.
    const at = beginEdit()
    if (isAnimated(layer, prop)) setValueAtFrame(layer.id, prop, at, value)
    else setStaticValue(layer.id, prop, value)
  }

  const [ax, ay] = layer.anchor
  const tx = read('translateX')
  const ty = read('translateY')
  const scalePercent = read('scale') * 100
  const rotate = read('rotate')
  const rotateX = read('rotateX')
  const rotateY = read('rotateY')
  const opacityPercent = read('opacity') * 100

  return (
    <section className="mm-section" aria-labelledby="mm-sec-layer">
      <h2 className="mm-section-title" id="mm-sec-layer">
        레이어
      </h2>
      <div className="mm-stack">
        <TextField
          label="이름"
          value={layer.name}
          ariaLabel="레이어 이름"
          onChange={(v) => setLayerName(layer.id, v)}
        />

        <SelectField
          label="맞춤"
          value={layer.fit}
          options={FIT_OPTIONS}
          ariaLabel="캔버스에 맞추는 방식"
          onChange={(v) => setLayerFit(layer.id, v)}
        />

        <div className="mm-field">
          <span className="mm-field-label" id="mm-anchor-label">
            모션 기준점
          </span>
          <AnchorGrid
            ax={ax}
            ay={ay}
            labelledBy="mm-anchor-label"
            onChange={(nx, ny) => setLayerAnchor(layer.id, nx, ny)}
          />
          <p className="mm-field-hint">
            회전과 확대가 도는 축입니다. 지금은 {anchorLabelOf(ax, ay)}. 기준점을 옮겨도 그림
            자리는 캔버스 가운데 그대로입니다.
          </p>
        </div>

        <div className="mm-row-2">
          <div className="mm-anim-row">
            <AnimateToggle layerId={layer.id} prop="translateX" frame={frame} label="가로 위치" />
            <NumberField
              label="위치 X"
              value={tx}
              suffix="px"
              ariaLabel="가로 위치(px)"
              onEditStart={beginEdit}
              onEditEnd={endEdit}
              onChange={(v) => write('translateX', v)}
            />
          </div>
          <div className="mm-anim-row">
            <AnimateToggle layerId={layer.id} prop="translateY" frame={frame} label="세로 위치" />
            <NumberField
              label="위치 Y"
              value={ty}
              suffix="px"
              ariaLabel="세로 위치(px)"
              onEditStart={beginEdit}
              onEditEnd={endEdit}
              onChange={(v) => write('translateY', v)}
            />
          </div>
        </div>

        <div className="mm-row-2">
          {/* UI 는 퍼센트, 문서는 배율이다. */}
          <div className="mm-anim-row">
            <AnimateToggle layerId={layer.id} prop="scale" frame={frame} label="크기" />
            <NumberField
              label="크기"
              value={scalePercent}
              min={1}
              step={1}
              suffix="%"
              ariaLabel="크기(퍼센트)"
              onEditStart={beginEdit}
              onEditEnd={endEdit}
              onChange={(v) => write('scale', v / 100)}
            />
          </div>
          <div className="mm-anim-row">
            <AnimateToggle layerId={layer.id} prop="rotate" frame={frame} label="회전" />
            <NumberField
              label="회전"
              value={rotate}
              step={1}
              suffix="도"
              ariaLabel="회전(도)"
              onEditStart={beginEdit}
              onEditEnd={endEdit}
              onChange={(v) => write('rotate', v)}
            />
          </div>
        </div>

        <div className="mm-row-2">
          <div className="mm-anim-row">
            <AnimateToggle layerId={layer.id} prop="rotateY" frame={frame} label="세로축 회전" />
            <NumberField
              label="세로축 회전"
              value={rotateY}
              step={1}
              suffix="도"
              ariaLabel="세로축 회전(도)"
              onEditStart={beginEdit}
              onEditEnd={endEdit}
              onChange={(v) => write('rotateY', v)}
            />
          </div>
          <div className="mm-anim-row">
            <AnimateToggle layerId={layer.id} prop="rotateX" frame={frame} label="가로축 회전" />
            <NumberField
              label="가로축 회전"
              value={rotateX}
              step={1}
              suffix="도"
              ariaLabel="가로축 회전(도)"
              onEditStart={beginEdit}
              onEditEnd={endEdit}
              onChange={(v) => write('rotateX', v)}
            />
          </div>
        </div>

        {/*
          원근은 애니메이션되지 않는 값이라 스톱워치가 없다.
          입체 회전을 애니메이션하면 0도를 지나는 순간이 반드시 있으므로, 지금 값이
          아니라 **트랙의 존재**로도 판정한다. 안 그러면 재생 중에 입력행이 깜빡인다.
        */}
        {rotateX !== 0 ||
        rotateY !== 0 ||
        isAnimated(layer, 'rotateX') ||
        isAnimated(layer, 'rotateY') ||
        layer.perspective !== undefined ? (
          <NumberField
            label="원근 거리"
            value={layer.perspective ?? PERSPECTIVE_DEFAULT}
            min={0}
            max={PERSPECTIVE_MAX}
            step={0.5}
            hint="레이어 긴 변의 몇 배만큼 떨어져서 보는가입니다. 작을수록 원근이 셉니다. 0 이면 원근 없이 각도만큼 눌립니다."
            ariaLabel="원근 카메라 거리"
            onChange={(v) => setLayerPerspective(layer.id, v)}
          />
        ) : null}

        {/* UI 는 0~100, 문서는 0~1 이다. */}
        <div className="mm-anim-row">
          <AnimateToggle layerId={layer.id} prop="opacity" frame={frame} label="불투명도" />
          <NumberField
            label="불투명도"
            value={opacityPercent}
            min={0}
            max={100}
            step={1}
            suffix="%"
            ariaLabel="불투명도(퍼센트)"
            onEditStart={beginEdit}
            onEditEnd={endEdit}
            onChange={(v) => write('opacity', Math.min(1, Math.max(0, v / 100)))}
          />
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 가리기 섹션
// ---------------------------------------------------------------------------

/**
 * 경계선이 지나가는 모양.
 *
 * 진행률은 여기 없다. 「가리기」 트랙이 민다. 모양과 진행률을 나눠 두는 이유는
 * 프리셋이 트랙만 갈아끼우기 때문이다. 한 덩어리로 두면 세기 슬라이더를 움직일
 * 때마다 모양까지 새로 정해진다.
 */
function RevealSection({ layer }: { layer: Layer }) {
  const setLayerReveal = useDocumentStore((s) => s.setLayerReveal)
  const setStaticValue = useDocumentStore((s) => s.setStaticValue)
  const setValueAtFrame = useDocumentStore((s) => s.setValueAtFrame)
  const frame = useUiStore((s) => s.playheadFrame)
  const spec = layer.reveal
  const mode: RevealMode = spec?.mode ?? 'none'
  const active = mode !== 'none'
  // 재생 헤드 자리의 값이다. 0 프레임으로 고정하면 애니메이션 중인 가리기를
  // 인스펙터가 언제나 시작값으로 보여 준다.
  const progressPercent = readStaticValue(layer, 'reveal', frame) * 100

  /**
   * 레이어 섹션과 같은 규칙이다. 애니메이션 중이면 그 프레임에 키를 찍고,
   * 아니면 상수 키를 고친다. 이 분기가 없으면 진행률을 한 번 건드리는 순간
   * 찍어 둔 키가 통째로 상수로 뭉개진다.
   */
  const { beginEdit, endEdit } = useEditFrame()

  function writeProgress(value: number): void {
    // 레이어 섹션과 같은 편집 세션을 쓴다. 없으면 재생 중에 두 자리 수를 입력할 때
    // 서로 다른 프레임에 키가 두 개 생긴다 (useEditFrame.ts).
    const at = beginEdit()
    if (isAnimated(layer, 'reveal')) setValueAtFrame(layer.id, 'reveal', at, value)
    else setStaticValue(layer.id, 'reveal', value)
  }

  return (
    <section className="mm-section" aria-labelledby="mm-sec-reveal">
      <h2 className="mm-section-title" id="mm-sec-reveal">
        가리기
      </h2>
      <div className="mm-stack">
        <SelectField
          label="모양"
          value={mode}
          options={REVEAL_OPTIONS}
          ariaLabel="가리기 모양"
          onChange={(v) => setLayerReveal(layer.id, { mode: v })}
        />

        {active ? (
          <>
            <NumberField
              label="경계 흐림"
              value={(spec?.softness ?? 0) * 100}
              min={REVEAL_LIMITS.softness.min * 100}
              max={REVEAL_LIMITS.softness.max * 100}
              step={1}
              suffix="%"
              hint="0 이면 칼로 자른 듯 끊깁니다."
              ariaLabel="가리기 경계 흐림"
              onChange={(v) => setLayerReveal(layer.id, { softness: clamp(v / 100, 0, 1) })}
            />

            {/*
              슬랫 값 하나가 모양에 따라 다른 뜻을 갖는다. 블라인드에서는 칸 수이고
              잉크에서는 얼룩의 잘기다. 이름표만 갈아 끼우고 값은 한 벌로 둔다.
              값을 나누면 모양을 갈아탈 때마다 한쪽이 기본값으로 되돌아간다.
            */}
            {REVEAL_SLATS_LABELS[mode] ? (
              <NumberField
                label={REVEAL_SLATS_LABELS[mode]!}
                value={spec?.slats ?? 8}
                min={REVEAL_LIMITS.slats.min}
                max={REVEAL_LIMITS.slats.max}
                step={1}
                suffix={mode === 'blinds' ? '칸' : ''}
                hint={mode === 'ink' ? '클수록 얼룩이 잘게 갈라집니다.' : undefined}
                ariaLabel={mode === 'blinds' ? '블라인드 칸 수' : '잉크 얼룩 잘기'}
                onChange={(v) => setLayerReveal(layer.id, { slats: Math.round(v) })}
              />
            ) : null}

            {mode === 'clock' ? (
              <NumberField
                label="시작 각도"
                value={spec?.angle ?? 0}
                min={REVEAL_LIMITS.angle.min}
                max={REVEAL_LIMITS.angle.max}
                step={15}
                suffix="도"
                hint="0 이 열두 시입니다."
                ariaLabel="시계 가리기 시작 각도"
                onChange={(v) => setLayerReveal(layer.id, { angle: v })}
              />
            ) : null}

            <ToggleField
              label="반대로 뒤집기"
              checked={spec?.invert === true}
              ariaLabel="드러나는 쪽과 가려지는 쪽 맞바꾸기"
              onChange={(v) => setLayerReveal(layer.id, { invert: v })}
            />

            <div className="mm-anim-row">
              <AnimateToggle layerId={layer.id} prop="reveal" frame={frame} label="가리기" />
              <NumberField
                label="진행률"
                value={progressPercent}
                min={0}
                max={100}
                step={1}
                suffix="%"
                hint="스톱워치를 켜면 타임라인에서 시간에 따라 밀 수 있습니다."
                ariaLabel="가리기 진행률"
                onEditStart={beginEdit}
                onEditEnd={endEdit}
                onChange={(v) => writeProgress(clamp(v / 100, 0, 1))}
              />
            </div>
          </>
        ) : (
          <p className="mm-field-hint">
            그림은 제자리에 두고 경계선만 지나가게 합니다. 모양을 고르면 설정이 나타납니다.
          </p>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 반복 섹션
// ---------------------------------------------------------------------------

function LoopSection() {
  const loop = useDocumentStore((s) => s.doc.timeline.loop)
  const setLoopMode = useDocumentStore((s) => s.setLoopMode)
  const setLoopCount = useDocumentStore((s) => s.setLoopCount)

  return (
    <section className="mm-section" aria-labelledby="mm-sec-loop">
      <h2 className="mm-section-title" id="mm-sec-loop">
        반복
      </h2>
      <div className="mm-stack">
        <SelectField
          label="반복 방식"
          value={loop.mode}
          options={LOOP_OPTIONS}
          onChange={setLoopMode}
        />
        <NumberField
          label="반복 횟수"
          value={loop.count}
          min={0}
          step={1}
          hint="0 이면 무한 반복"
          disabled={loop.mode === 'once'}
          ariaLabel="반복 횟수, 0 이면 무한"
          onChange={setLoopCount}
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

export function Inspector() {
  const layers = useDocumentStore((s) => s.doc.layers)
  const selectedLayerId = useUiStore((s) => s.selectedLayerId)
  const layer = layers.find((l) => l.id === selectedLayerId) ?? null
  const isFolder = layer?.type === 'group'

  return (
    <aside className="mm-panel mm-app-inspector" aria-label="인스펙터">
      <div className="mm-panel-head">
        <span>인스펙터</span>
      </div>
      <div className="mm-panel-body mm-scroll">
        <CanvasSection />
        {layer ? (
          <>
            <LayerSection key={layer.id} layer={layer} />
            {/* 도형이면 모양부터. "이게 무엇인가" 다음에 "남들과 어떤 관계인가" 가 온다 */}
            {layer.shape ? <ShapeSection key={`shape:${layer.id}`} layer={layer} /> : null}
            {layer.text ? <TextSection key={`text:${layer.id}`} layer={layer} /> : null}
            {/*
              등장. 글자면 한 글자씩, 그 외에는 오브제 통째로 들어온다.
              규칙이 한 벌이라 화면도 한 벌이다 (core/charAnim.ts).
            */}
            <CharAnimSection key={`charin:${layer.id}`} layer={layer} />
            {/*
              폴더는 픽셀이 없다. 가리기 / 이펙트 / 다듬기는 그릴 그림이 있어야 뜻이
              있으므로 통째로 숨긴다. 눌러도 아무 일 없는 노브가 가장 나쁘다.
              대신 위치·회전·배율은 그대로 보인다. 그것이 폴더의 쓰임새다.
            */}
            {isFolder ? null : <RevealSection key={`reveal:${layer.id}`} layer={layer} />}
            {/* 레이어 고유 속성: 혼합, 깊이감, 부모, 캔버스 채움, 오버스캔 진단 */}
            <LayerProperties layer={layer} />
            {isFolder ? null : <EffectStack layer={layer} />}
            {/* 배경 제거와 크롭. 도형과 폴더는 픽셀이 없어 다듬을 것이 없다 */}
            {layer.shape || isFolder ? null : <PrepPanel />}
          </>
        ) : (
          <section className="mm-section">
            <p className="mm-note">왼쪽에서 이미지를 선택하면 레이어 속성이 여기에 나타납니다.</p>
          </section>
        )}
        <LoopSection />
      </div>
    </aside>
  )
}

export default Inspector
