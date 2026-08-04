/**
 * 라벨 + 컨트롤을 묶는 공통 폼 위젯.
 *
 * 드래그 스크러버는 아직 없다. label htmlFor + id 연결만 정확히 지킨다.
 * 숫자 입력은 편집 중 로컬 문자열을 들고 있다가 유효한 값일 때만 스토어에 쓴다.
 * 그래야 "1" 을 지우고 "12" 를 치는 중간 상태에서 NaN 이 스토어로 들어가지 않는다.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'

/** 소수점 잡음을 제거한 표시용 문자열. */
export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '0'
  const factor = 10 ** digits
  return String(Math.round(value * factor) / factor)
}

interface FieldProps {
  /** 내부 컨트롤의 id. label htmlFor 와 연결된다. */
  htmlId: string
  label: string
  hint?: string
  inline?: boolean
  children: ReactNode
}

export function Field({ htmlId, label, hint, inline = false, children }: FieldProps) {
  return (
    <div className={inline ? 'mm-field mm-field-inline' : 'mm-field'}>
      <label className="mm-field-label" htmlFor={htmlId}>
        {label}
      </label>
      <div className="mm-field-control">{children}</div>
      {hint ? (
        <p className="mm-field-hint" id={`${htmlId}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 숫자
// ---------------------------------------------------------------------------

export interface NumberFieldProps {
  label: string
  value: number
  onChange(next: number): void
  min?: number
  max?: number
  step?: number
  /** 단위 표시. 값 자체에는 영향을 주지 않는다. */
  suffix?: string
  disabled?: boolean
  hint?: string
  /** 라벨이 짧아 문맥이 부족할 때 보강한다. */
  ariaLabel?: string
  /**
   * 편집 세션의 시작과 끝 (포커스 / 블러).
   *
   * onChange 는 글자 하나마다 온다. 한 번의 편집을 하나로 묶어야 하는 쪽
   * (예: 재생 중 인스펙터 편집이 매 프레임 다른 키를 만드는 문제) 이 쓴다.
   */
  onEditStart?(): void
  onEditEnd?(): void
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
  hint,
  ariaLabel,
  onEditStart,
  onEditEnd,
}: NumberFieldProps) {
  const id = useId()
  const [draft, setDraft] = useState(() => formatNumber(value))
  const [editing, setEditing] = useState(false)

  // 편집 중이 아닐 때만 외부 값을 반영한다. 타이핑 중 커서가 튀는 것을 막는다.
  useEffect(() => {
    if (!editing) setDraft(formatNumber(value))
  }, [value, editing])

  return (
    <Field htmlId={id} label={label} hint={hint}>
      <span className="mm-input-wrap">
        <input
          id={id}
          className="mm-input"
          type="number"
          inputMode="decimal"
          value={draft}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onFocus={() => {
            setEditing(true)
            onEditStart?.()
          }}
          onBlur={() => {
            setEditing(false)
            setDraft(formatNumber(value))
            onEditEnd?.()
          }}
          onKeyDown={(e) => {
            // number 입력은 Enter 로 블러되지 않는다. 편집이 끝날 때만 확정하는 쪽
            // (캔버스 폭/높이)에서 Enter 를 눌러도 아무 일이 안 일어나 보인다.
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onChange={(e) => {
            const raw = e.target.value
            setDraft(raw)
            if (raw.trim() === '') return
            const parsed = Number(raw)
            // NaN 가드. 여기서 막지 않으면 문서 상태가 즉시 오염된다.
            if (!Number.isFinite(parsed)) return
            onChange(parsed)
          }}
        />
        {suffix ? (
          <span className="mm-input-suffix" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
      </span>
    </Field>
  )
}

// ---------------------------------------------------------------------------
// 셀렉트
// ---------------------------------------------------------------------------

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export interface SelectFieldProps<T extends string> {
  label: string
  value: T
  options: readonly SelectOption<T>[]
  onChange(next: T): void
  disabled?: boolean
  hint?: string
  ariaLabel?: string
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  hint,
  ariaLabel,
}: SelectFieldProps<T>) {
  const id = useId()
  return (
    <Field htmlId={id} label={label} hint={hint}>
      <select
        id={id}
        className="mm-select"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

// ---------------------------------------------------------------------------
// 텍스트
// ---------------------------------------------------------------------------

export interface TextFieldProps {
  label: string
  value: string
  onChange(next: string): void
  placeholder?: string
  disabled?: boolean
  hint?: string
  ariaLabel?: string
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
  hint,
  ariaLabel,
}: TextFieldProps) {
  const id = useId()
  return (
    <Field htmlId={id} label={label} hint={hint}>
      <input
        id={id}
        className="mm-input"
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  )
}

// ---------------------------------------------------------------------------
// 토글
// ---------------------------------------------------------------------------

export interface ToggleFieldProps {
  label: string
  checked: boolean
  onChange(next: boolean): void
  disabled?: boolean
  ariaLabel?: string
}

export function ToggleField({
  label,
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}: ToggleFieldProps) {
  const id = useId()
  return (
    <div className="mm-field mm-field-toggle">
      <input
        id={id}
        className="mm-checkbox"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label className="mm-field-label" htmlFor={id}>
        {label}
      </label>
    </div>
  )
}
