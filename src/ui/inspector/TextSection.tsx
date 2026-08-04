/**
 * 인스펙터의 글자 섹션.
 *
 * ShapeSection 과 같은 자리다. 값 규칙은 core/text.ts 와 core/charAnim.ts 한 곳에만
 * 있고 여기서는 입력만 받는다.
 *
 * 두 덩어리다.
 *   글자     : 내용 / 글꼴 / 크기 / 굵기 / 자간 / 행간 / 정렬 / 색 / 테두리
 *   글자 등장 : 어느 쪽에서 어떤 순서로 들어오는가 (진행률은 charIn 트랙이 민다)
 */

import { useRef, useState, useSyncExternalStore } from 'react'

import { CHAR_EASE_LABELS, CHAR_IN_LABELS, CHAR_ORDER_LABELS } from '@/core/charAnim.ts'
import { toHex6 } from '@/core/shape.ts'
import { TEXT_ALIGN_LABELS, TEXT_LIMITS } from '@/core/text.ts'
import {
  CHAR_EASE_LIST,
  CHAR_IN_MODE_LIST,
  type CharEase,
  type CharInMode,
  type CharOrder,
  type Layer,
  type TextAlign,
} from '@/core/types.ts'
import { isAnimated, readStaticValue, useDocumentStore } from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'
import { AnimateToggle } from '@/ui/inspector/AnimateToggle.tsx'
import { allFontChoices, getFontsRevision, loadFontFile, subscribeFonts } from '@/ui/text/fonts.ts'
import { NumberField, SelectField, ToggleField } from '@/ui/widgets/Field.tsx'

const ALIGN_OPTIONS = (['left', 'center', 'right'] as TextAlign[]).map((value) => ({
  value,
  label: TEXT_ALIGN_LABELS[value],
}))

const WEIGHT_OPTIONS = [300, 400, 500, 700, 800, 900].map((w) => ({
  value: String(w),
  label: w === 400 ? '보통' : w === 700 ? '굵게' : String(w),
}))

const CHAR_MODE_OPTIONS = CHAR_IN_MODE_LIST.map((value) => ({
  value,
  label: CHAR_IN_LABELS[value],
}))

const CHAR_EASE_OPTIONS = CHAR_EASE_LIST.map((value: CharEase) => ({
  value,
  label: CHAR_EASE_LABELS[value],
}))

const CHAR_ORDER_OPTIONS = (
  ['forward', 'backward', 'center', 'edges', 'random'] as CharOrder[]
).map((value) => ({ value, label: CHAR_ORDER_LABELS[value] }))

export function TextSection({ layer }: { layer: Layer }) {
  const setTextSpec = useDocumentStore((s) => s.setTextSpec)
  const setLayerCharAnim = useDocumentStore((s) => s.setLayerCharAnim)
  const setStaticValue = useDocumentStore((s) => s.setStaticValue)
  const setValueAtFrame = useDocumentStore((s) => s.setValueAtFrame)
  const frame = useUiStore((s) => s.playheadFrame)

  // 올린 글꼴이 들어오면 목록을 다시 그린다.
  useSyncExternalStore(subscribeFonts, getFontsRevision)
  const fonts = allFontChoices()

  const fileRef = useRef<HTMLInputElement | null>(null)
  const [fontError, setFontError] = useState<string | null>(null)

  const text = layer.text
  if (!text) return null

  const anim = layer.charAnim
  const mode: CharInMode = anim?.mode ?? 'none'
  const animOn = mode !== 'none'

  /*
   * 진행률. 가리기와 같은 자리다.
   *
   * 방향을 고르면 스토어가 0 -> 1 트랙을 만들어 주므로 보통은 손댈 일이 없다.
   * 여기 있는 이유는 "지금 이 프레임에서 얼마나 들어왔는가" 를 눈으로 확인하고,
   * 그래프 에디터로 넘어가기 전에 손으로 찍을 수 있어야 하기 때문이다.
   */
  const progress = readStaticValue(layer, 'charIn', frame) ?? 1
  const progressPercent = Math.round(progress * 100)

  function writeProgress(value: number): void {
    if (isAnimated(layer, 'charIn')) setValueAtFrame(layer.id, 'charIn', frame, value)
    else setStaticValue(layer.id, 'charIn', value)
  }

  /*
   * 글꼴 목록에 지금 값이 없을 수 있다. 올린 글꼴을 쓰던 프로젝트를 글꼴 없이 열면
   * 그렇다. 그때 select 가 첫 항목으로 튀면 사용자가 고른 값이 조용히 바뀐다.
   * 지금 값을 목록에 임시로 넣어 둔다.
   */
  const known = fonts.some((f) => f.family === text.fontFamily)
  const fontOptions = [
    ...(known ? [] : [{ value: text.fontFamily, label: '이 프로젝트의 글꼴 (없음)' }]),
    ...fonts.map((f) => ({ value: f.family, label: f.label })),
  ]

  async function handleFont(file: File | undefined): Promise<void> {
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    setFontError(null)
    const result = await loadFontFile(file)
    if (!result.ok || !result.family) {
      setFontError(result.message ?? '글꼴을 읽지 못했습니다.')
      return
    }
    setTextSpec(layer.id, { fontFamily: result.family })
  }

  return (
    <>
      <section className="mm-section" aria-labelledby="mm-sec-text">
        <h2 className="mm-section-title" id="mm-sec-text">
          글자
        </h2>
        <div className="mm-stack">
          <div className="mm-field">
            <label className="mm-field-label" htmlFor="mm-text-content">
              내용
            </label>
            <div className="mm-field-control">
              <textarea
                id="mm-text-content"
                className="mm-input"
                rows={2}
                value={text.content}
                maxLength={TEXT_LIMITS.chars}
                onChange={(e) => setTextSpec(layer.id, { content: e.target.value })}
              />
            </div>
            <p className="mm-field-hint">줄바꿈으로 여러 줄을 만듭니다.</p>
          </div>

          <SelectField
            label="글꼴"
            value={text.fontFamily}
            options={fontOptions}
            ariaLabel="글꼴"
            onChange={(family) => setTextSpec(layer.id, { fontFamily: family })}
          />

          <div className="mm-field">
            <button type="button" className="mm-btn mm-btn-block" onClick={() => fileRef.current?.click()}>
              글꼴 파일 올리기
            </button>
            <p className="mm-field-hint">
              ttf / otf 를 올리면 그 글꼴로 그립니다. 올린 글꼴은 이번 세션에만 남습니다.
            </p>
            <input
              ref={fileRef}
              className="mm-visually-hidden"
              type="file"
              accept=".ttf,.otf,.woff,.woff2,font/*"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                void handleFont(e.target.files?.[0])
              }}
            />
            {fontError ? (
              <p className="mm-field-hint" role="alert">
                {fontError}
              </p>
            ) : null}
          </div>

          <div className="mm-row-2">
            <NumberField
              label="크기"
              value={text.fontSize}
              min={TEXT_LIMITS.fontSize.min}
              max={TEXT_LIMITS.fontSize.max}
              suffix="px"
              ariaLabel="글자 크기(px)"
              onChange={(v) => setTextSpec(layer.id, { fontSize: v })}
            />
            <SelectField
              label="굵기"
              value={String(text.weight)}
              options={WEIGHT_OPTIONS}
              ariaLabel="글자 굵기"
              onChange={(v) => setTextSpec(layer.id, { weight: Number(v) })}
            />
          </div>

          <div className="mm-row-2">
            <NumberField
              label="자간"
              value={text.letterSpacing}
              min={TEXT_LIMITS.letterSpacing.min}
              max={TEXT_LIMITS.letterSpacing.max}
              suffix="px"
              ariaLabel="자간(px)"
              onChange={(v) => setTextSpec(layer.id, { letterSpacing: v })}
            />
            <NumberField
              label="행간"
              value={text.lineHeight}
              min={TEXT_LIMITS.lineHeight.min}
              max={TEXT_LIMITS.lineHeight.max}
              step={0.05}
              ariaLabel="행간 배수"
              onChange={(v) => setTextSpec(layer.id, { lineHeight: v })}
            />
          </div>

          <SelectField
            label="정렬"
            value={text.align}
            options={ALIGN_OPTIONS}
            ariaLabel="글자 정렬"
            onChange={(v) => setTextSpec(layer.id, { align: v })}
          />

          <ToggleField
            label="기울임"
            checked={text.italic}
            onChange={(v) => setTextSpec(layer.id, { italic: v })}
          />

          <div className="mm-field mm-field-inline">
            <label className="mm-field-label" htmlFor="mm-text-color">
              색
            </label>
            <div className="mm-field-control mm-color-row">
              <span className="mm-field-hint">{toHex6(text.color)}</span>
              <input
                id="mm-text-color"
                className="mm-color"
                type="color"
                value={toHex6(text.color)}
                aria-label="글자 색"
                onChange={(e) => setTextSpec(layer.id, { color: `${e.target.value}ff` })}
              />
            </div>
          </div>

          <NumberField
            label="테두리 두께"
            value={text.strokeWidth}
            min={TEXT_LIMITS.strokeWidth.min}
            max={TEXT_LIMITS.strokeWidth.max}
            suffix="px"
            ariaLabel="글자 테두리 두께(px)"
            onChange={(v) => setTextSpec(layer.id, { strokeWidth: v })}
          />

          {text.strokeWidth > 0 ? (
            <div className="mm-field mm-field-inline">
              <label className="mm-field-label" htmlFor="mm-text-stroke">
                테두리 색
              </label>
              <div className="mm-field-control mm-color-row">
                <span className="mm-field-hint">{toHex6(text.strokeColor)}</span>
                <input
                  id="mm-text-stroke"
                  className="mm-color"
                  type="color"
                  value={toHex6(text.strokeColor)}
                  aria-label="글자 테두리 색"
                  onChange={(e) => setTextSpec(layer.id, { strokeColor: `${e.target.value}ff` })}
                />
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="mm-section" aria-labelledby="mm-sec-charin">
        <h2 className="mm-section-title" id="mm-sec-charin">
          글자 등장
        </h2>
        <div className="mm-stack">
          <SelectField
            label="들어오는 모양"
            value={mode}
            options={CHAR_MODE_OPTIONS}
            ariaLabel="글자가 들어오는 모양"
            onChange={(v) => setLayerCharAnim(layer.id, { mode: v })}
          />

          {animOn ? (
            <>
              <SelectField
                label="속도 곡선"
                value={anim?.ease ?? 'back'}
                options={CHAR_EASE_OPTIONS}
                hint="글자 하나가 제자리까지 가는 속도입니다. 지나쳤다 돌아오면 쫀득해집니다."
                ariaLabel="글자 하나의 속도 곡선"
                onChange={(v) => setLayerCharAnim(layer.id, { ease: v })}
              />
              <NumberField
                label="도착 흔들림"
                value={anim?.jitter ?? 0.15}
                min={0}
                max={1}
                step={0.05}
                hint="0 이면 기계처럼 균일합니다. 조금 흔들어야 사람이 만든 것처럼 보입니다."
                ariaLabel="글자마다 도착 시간을 흔드는 정도"
                onChange={(v) => setLayerCharAnim(layer.id, { jitter: v })}
              />
              <SelectField
                label="순서"
                value={anim?.order ?? 'forward'}
                options={CHAR_ORDER_OPTIONS}
                ariaLabel="글자가 들어오는 순서"
                onChange={(v) => setLayerCharAnim(layer.id, { order: v })}
              />
              <NumberField
                label="글자 시간차"
                value={anim?.stagger ?? 0.5}
                min={0}
                max={1}
                step={0.05}
                ariaLabel="글자 사이 시간차"
                onChange={(v) => setLayerCharAnim(layer.id, { stagger: v })}
              />
              <NumberField
                label="출발 거리"
                value={anim?.distance ?? 1.2}
                min={0}
                max={8}
                step={0.1}
                ariaLabel="출발 거리(글자 크기 배수)"
                onChange={(v) => setLayerCharAnim(layer.id, { distance: v })}
              />
              <NumberField
                label="출발 각도"
                value={anim?.rotate ?? 0}
                min={-1440}
                max={1440}
                step={15}
                suffix="도"
                ariaLabel="출발 각도(도)"
                onChange={(v) => setLayerCharAnim(layer.id, { rotate: v })}
              />
              <NumberField
                label="출발 배율"
                value={anim?.scale ?? 1}
                min={0}
                max={12}
                step={0.1}
                ariaLabel="출발 배율"
                onChange={(v) => setLayerCharAnim(layer.id, { scale: v })}
              />
              <NumberField
                label="무작위 시드"
                value={anim?.seed ?? 1}
                min={0}
                max={9999}
                step={1}
                ariaLabel="무작위 방향과 순서의 시드"
                onChange={(v) => setLayerCharAnim(layer.id, { seed: v })}
              />
              <div className="mm-anim-row">
                <AnimateToggle layerId={layer.id} prop="charIn" frame={frame} label="글자 등장" />
                <NumberField
                  label="진행률"
                  value={progressPercent}
                  min={0}
                  max={100}
                  step={1}
                  suffix="%"
                  hint="0 이면 출발점, 100 이면 전부 제자리입니다. 방향을 고르면 자동으로 0에서 100까지 흐릅니다."
                  ariaLabel="글자 등장 진행률"
                  onChange={(v) => writeProgress(Math.min(1, Math.max(0, v / 100)))}
                />
              </div>
            </>
          ) : null}
        </div>
      </section>
    </>
  )
}

export default TextSection
