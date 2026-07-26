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

import { CANVAS_MAX, CANVAS_MIN, type FitMode, type Layer, type LoopMode } from '@/core/types.ts'
import { isAnimated, readStaticValue, useDocumentStore } from '@/state/document.ts'
import { AnimateToggle } from '@/ui/inspector/AnimateToggle.tsx'
import { EffectStack } from '@/ui/effects/EffectStack.tsx'
import { LayerProperties } from '@/ui/layers/LayerProperties.tsx'
import { PrepPanel } from '@/ui/prep/PrepPanel.tsx'
import { useUiStore } from '@/state/ui.ts'
import { NumberField, SelectField, TextField, ToggleField, type SelectOption } from '@/ui/widgets/Field.tsx'

const FIT_OPTIONS: readonly SelectOption<FitMode>[] = [
  { value: 'cover', label: '꽉 채우기' },
  { value: 'contain', label: '전체 보이기' },
  { value: 'fill', label: '늘여 채우기' },
  { value: 'none', label: '원본 크기' },
]

const LOOP_OPTIONS: readonly SelectOption<LoopMode>[] = [
  { value: 'once', label: '한 번만' },
  { value: 'loop', label: '반복' },
  { value: 'pingPong', label: '왕복' },
  { value: 'loopWithHold', label: '반복 + 멈춤' },
]

/** 기준점 3x3 그리드. 값은 이미지 로컬 비율 [0,1] 이다. */
const ANCHOR_CELLS: readonly { ax: number; ay: number; label: string }[] = [
  { ax: 0, ay: 0, label: '왼쪽 위' },
  { ax: 0.5, ay: 0, label: '가운데 위' },
  { ax: 1, ay: 0, label: '오른쪽 위' },
  { ax: 0, ay: 0.5, label: '왼쪽 가운데' },
  { ax: 0.5, ay: 0.5, label: '정중앙' },
  { ax: 1, ay: 0.5, label: '오른쪽 가운데' },
  { ax: 0, ay: 1, label: '왼쪽 아래' },
  { ax: 0.5, ay: 1, label: '가운데 아래' },
  { ax: 1, ay: 1, label: '오른쪽 아래' },
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

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.001

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
    setCanvasSize(cw, ch)
  }

  function changeWidth(w: number): void {
    commitSize(w, ratioLocked ? w / (ratioRef.current || 1) : canvas.h)
  }

  function changeHeight(h: number): void {
    commitSize(ratioLocked ? h * (ratioRef.current || 1) : canvas.w, h)
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
          />
          <NumberField
            label="높이"
            value={canvas.h}
            min={CANVAS_MIN}
            max={CANVAS_MAX}
            suffix="px"
            ariaLabel="캔버스 높이(px)"
            onChange={changeHeight}
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
  const frame = useUiStore((s) => s.playheadFrame)

  /**
   * 한 번의 편집이 쓰는 프레임. 편집 세션이 열려 있을 때만 값이 있다.
   *
   * NumberField 는 글자 하나마다 onChange 를 쏜다. 재생 중이면 그 사이 재생 헤드가
   * 움직여서 "12" 를 치는 동안 서로 다른 프레임에 키가 두 개 생긴다.
   * 그래서 편집이 시작되면 재생을 멈추고 그 순간의 프레임을 고정한다.
   * 스크럽이 재생을 멈추는 것과 같은 관습이다 (Timeline.onPointerDown).
   */
  const editFrameRef = useRef<number | null>(null)

  function beginEdit(): number {
    const ui = useUiStore.getState()
    if (ui.playing) ui.setPlaying(false)
    if (editFrameRef.current === null) editFrameRef.current = ui.playheadFrame
    return editFrameRef.current
  }

  function endEdit(): void {
    editFrameRef.current = null
  }

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
            기준점
          </span>
          <div className="mm-anchor-grid" role="group" aria-labelledby="mm-anchor-label">
            {ANCHOR_CELLS.map((cell) => {
              const active = near(ax, cell.ax) && near(ay, cell.ay)
              return (
                <button
                  key={cell.label}
                  type="button"
                  className="mm-anchor-cell"
                  aria-pressed={active}
                  title={cell.label}
                  aria-label={`기준점 ${cell.label}`}
                  onClick={() => setLayerAnchor(layer.id, cell.ax, cell.ay)}
                >
                  <span className="mm-anchor-dot" />
                </button>
              )
            })}
          </div>
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
            {/* 레이어 고유 속성: 혼합, 깊이감, 부모, 캔버스 채움, 오버스캔 진단 */}
            <LayerProperties layer={layer} />
            {/* 이펙트 스택. 글리치와 자글자글이 여기 쌓인다 */}
            <EffectStack layer={layer} />
            {/* 배경 제거와 크롭 */}
            <PrepPanel />
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
