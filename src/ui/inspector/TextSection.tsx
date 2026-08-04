/**
 * 인스펙터의 글자 섹션.
 *
 * ShapeSection 과 같은 자리다. 값 규칙은 core/text.ts 와 core/charAnim.ts 한 곳에만
 * 있고 여기서는 입력만 받는다.
 *
 * 글자 생김새만 다룬다. 어느 쪽에서 어떤 순서로 들어오는지는 CharAnimSection 이
 * 맡는다. 그쪽은 글자 레이어와 오브제 레이어가 함께 쓰기 때문에 따로 있다.
 */

import { useRef, useState, useSyncExternalStore } from 'react'

import { toHex6 } from '@/core/shape.ts'
import { TEXT_ALIGN_LABELS, TEXT_LIMITS } from '@/core/text.ts'
import { type Layer, type TextAlign } from '@/core/types.ts'
import { useDocumentStore } from '@/state/document.ts'
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

export function TextSection({ layer }: { layer: Layer }) {
  const setTextSpec = useDocumentStore((s) => s.setTextSpec)

  // 올린 글꼴이 들어오면 목록을 다시 그린다.
  useSyncExternalStore(subscribeFonts, getFontsRevision)
  const fonts = allFontChoices()

  const fileRef = useRef<HTMLInputElement | null>(null)
  const [fontError, setFontError] = useState<string | null>(null)

  const text = layer.text
  if (!text) return null

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
    </>
  )
}

export default TextSection
