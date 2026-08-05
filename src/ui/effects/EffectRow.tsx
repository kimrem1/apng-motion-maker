/**
 * 이펙트 스택의 한 줄.
 *
 * 접힌 상태에서 보이는 것은 다섯이다.
 *   손잡이 / 켜기 끄기 / 이름 / 배지 / 삭제
 * 펼치면 레지스트리의 파라미터 명세로 컨트롤을 자동 생성한다. 이펙트마다 손으로
 * 폼을 짜면 이펙트를 하나 늘릴 때마다 UI 를 고쳐야 하고, 그러면 곧 안 늘리게 된다.
 *
 * 값은 전부 숫자다
 *
 * EffectInstance.params 는 number 이거나 Track 이다 (core/types.ts). 문자열이 없다.
 * 그래서 select 는 선택지의 번호를, boolean 은 0/1 을, 색은 0xRRGGBB 정수를 저장한다.
 * 이 변환은 전부 이 파일 안에서만 한다. 문서에는 항상 숫자로 쓴다.
 * 이미 트랙이 걸린 파라미터는 컨트롤을 잠근다. 숫자를 덮어쓰면 키프레임이 통째로 날아간다.
 */

import { useId, type PointerEvent as ReactPointerEvent } from 'react'

import type { EffectInstance, EffectParam } from '@/core/types.ts'
import type { EffectCategory, EffectDef, EffectParamSpec } from '@/effects/types.ts'
import { EFFECT_BY_ID } from '@/effects/registry.ts'

// ---------------------------------------------------------------------------
// 레지스트리 -> 화면 모델
// ---------------------------------------------------------------------------
//
// 레지스트리에서 가져오는 것은 EFFECT_BY_ID / EFFECT_DEFS / byStage /
// EFFECT_CATEGORY_LABELS 넷뿐이다. 등급 접기나 기본값 읽기 같은 파생값은
// EffectDef 필드에서 여기서 직접 만든다. 레지스트리의 보조 함수에 기대면
// 카탈로그를 재편할 때 UI 까지 함께 깨진다.

/** 카드에 띄우는 용량 등급. 레지스트리의 네 단계를 세 배지로 접는다. */
export type EffectCost = 'light' | 'normal' | 'heavy'

export type ControlKind = 'number' | 'range' | 'select' | 'boolean' | 'color'

export interface EffectControl {
  key: string
  label: string
  kind: ControlKind
  min: number
  max: number
  step: number
  unit?: string
  /** select 전용. 문서에는 value(정수)가 저장된다. */
  options: { value: number; label: string }[]
  default: number
}

export interface EffectView {
  id: string
  label: string
  hint: string
  category: EffectCategory
  cost: EffectCost
  /** 투명 배경을 오염시킬 수 있는가. */
  alphaRisk: boolean
  controls: EffectControl[]
}

export const COST_LABELS: Record<EffectCost, string> = {
  light: '가벼움',
  normal: '보통',
  heavy: '무거움',
}

function costOf(def: EffectDef): EffectCost {
  switch (def.cost) {
    case 'free':
    case 'low':
      return 'light'
    case 'mid':
    case 'medium':
      return 'normal'
    case 'high':
    default:
      return 'heavy'
  }
}

/** 카테고리는 생략될 수 있다. 그때는 스테이지에서 유도한다. */
function categoryOf(def: EffectDef): EffectCategory {
  if (def.category) return def.category
  if (def.stage === 'A') return 'warp'
  if (def.stage === 'B') return 'glitch'
  return 'color'
}

/** 문서에 들어갈 기본값은 항상 숫자다. 스펙이 불리언이나 문자열로 적혀 있어도 받아 준다. */
function defaultNumberOf(spec: EffectParamSpec): number {
  const raw = spec.default
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  if (typeof raw === 'boolean') return raw ? 1 : 0
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 컨트롤 종류를 정한다.
 *
 * 선언된 타입이 먼저다. EffectParamSpec.type 에는 color 가 있다(effects/types.ts).
 * key 이름 정규식으로만 색을 판별하면 하프톤의 '바탕색'(key: paper, type: 'color')이
 * 컬러 피커가 아니라 0~1 짜리 숫자 입력으로 뜬다. 0xffffff 를 0~1 상자에 넣어 놓고
 * 사용자가 무엇을 할 수 있는지 생각하면 그것은 고장이다.
 *
 * key 정규식은 폴백으로만 남긴다. 타입을 안 적고 이름만 color 로 끝내는 카탈로그가
 * 아직 있을 수 있고, 그쪽을 숫자 입력으로 되돌리면 같은 사고가 반대편에서 난다.
 *
 * range 는 위아래가 모두 정해진 숫자다. 이펙트 파라미터는 거의 다 여기 속하고,
 * 경계가 있는 값은 슬라이더가 숫자 입력보다 훨씬 빨리 맞춰진다.
 */
function kindOf(spec: EffectParamSpec): ControlKind {
  if (spec.type === 'color') return 'color'
  if (spec.type === 'boolean') return 'boolean'
  if (spec.type === 'select') return 'select'
  if (/color$/i.test(spec.key)) return 'color'
  return spec.min !== undefined && spec.max !== undefined ? 'range' : 'number'
}

function optionsOf(spec: EffectParamSpec): { value: number; label: string }[] {
  return (spec.options ?? []).map((opt, index) => {
    const parsed = Number(opt.value)
    return { value: Number.isFinite(parsed) ? parsed : index, label: opt.label }
  })
}

function toControl(spec: EffectParamSpec): EffectControl {
  const kind = kindOf(spec)
  const control: EffectControl = {
    key: spec.key,
    label: spec.label,
    kind,
    min: spec.min ?? 0,
    // 색은 0xRRGGBB 정수 하나다. 상한을 1 로 두면 흰 바탕색이 검게 잘린다.
    max: spec.max ?? (kind === 'color' ? 0xffffff : 1),
    step: spec.step ?? (kind === 'boolean' || kind === 'color' ? 1 : 0.01),
    options: optionsOf(spec),
    default: defaultNumberOf(spec),
  }
  if (spec.unit) control.unit = spec.unit
  return control
}

export function normalizeEffectDef(def: EffectDef): EffectView {
  return {
    id: def.id,
    label: def.label,
    hint: def.hint,
    category: categoryOf(def),
    cost: costOf(def),
    // 알파를 보존하지 않는 이펙트는 투명 배경을 오염시킬 수 있다.
    alphaRisk: !def.preservesAlpha,
    controls: def.params.map(toControl),
  }
}

/**
 * 저장된 문서가 이 버전이 모르는 이펙트를 들고 있을 수 있다.
 * 그때는 null 을 돌려주고 행만 남긴다. 문서를 못 여는 것보다 낫고,
 * 지우지 않으면 다음 버전에서 그대로 살아난다.
 */
export function lookupEffect(type: string): EffectView | null {
  const def = EFFECT_BY_ID.get(type)
  return def ? normalizeEffectDef(def) : null
}

// ---------------------------------------------------------------------------
// 값 변환
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

function toHex(value: number): string {
  const n = clamp(Math.round(value), 0, 0xffffff)
  return `#${n.toString(16).padStart(6, '0')}`
}

function fromHex(hex: string): number {
  const parsed = Number.parseInt(hex.replace('#', ''), 16)
  return Number.isFinite(parsed) ? clamp(parsed, 0, 0xffffff) : 0
}

/** 트랙이 걸린 파라미터는 숫자로 못 읽는다. 그 사실을 그대로 돌려준다. */
function readParam(param: EffectParam | undefined, fallback: number): { value: number; keyed: boolean } {
  if (typeof param === 'number' && Number.isFinite(param)) return { value: param, keyed: false }
  if (param && typeof param === 'object') return { value: fallback, keyed: true }
  return { value: fallback, keyed: false }
}

// ---------------------------------------------------------------------------
// 아이콘 (인라인 SVG)
// ---------------------------------------------------------------------------

function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <circle cx="6" cy="4" r="1.2" />
        <circle cx="10" cy="4" r="1.2" />
        <circle cx="6" cy="8" r="1.2" />
        <circle cx="10" cy="8" r="1.2" />
        <circle cx="6" cy="12" r="1.2" />
        <circle cx="10" cy="12" r="1.2" />
      </g>
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      style={{ transform: open ? 'rotate(90deg)' : 'none' }}
    >
      <path d="M6 3.5 11 8l-5 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 파라미터 컨트롤
// ---------------------------------------------------------------------------

interface ControlProps {
  control: EffectControl
  param: EffectParam | undefined
  disabled: boolean
  onChange(value: number): void
}

function ParamControl({ control, param, disabled, onChange }: ControlProps) {
  const id = useId()
  const { value, keyed } = readParam(param, control.default)
  const locked = disabled || keyed

  const hint = keyed ? '키프레임이 걸려 있어 여기서는 바꿀 수 없습니다. 타임라인에서 조절하세요.' : undefined
  const lockTitle = keyed ? '키프레임이 걸린 값입니다.' : undefined

  return (
    <div className="mm-fx-param">
      <label className="mm-field-label" htmlFor={id}>
        {control.label}
      </label>

      <div className="mm-fx-param-control">
        {control.kind === 'boolean' ? (
          <input
            id={id}
            className="mm-checkbox"
            type="checkbox"
            checked={value >= 0.5}
            disabled={locked}
            title={lockTitle}
            onChange={(e) => onChange(e.target.checked ? 1 : 0)}
          />
        ) : null}

        {control.kind === 'select' ? (
          <select
            id={id}
            className="mm-select"
            value={String(value)}
            disabled={locked}
            title={lockTitle}
            onChange={(e) => onChange(Number(e.target.value))}
          >
            {control.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : null}

        {control.kind === 'color' ? (
          <span className="mm-fx-color-row">
            <span className="mm-fx-color-text">{toHex(value)}</span>
            <input
              id={id}
              className="mm-color"
              type="color"
              value={toHex(value)}
              disabled={locked}
              title={lockTitle}
              onChange={(e) => onChange(fromHex(e.target.value))}
            />
          </span>
        ) : null}

        {control.kind === 'range' ? (
          <span className="mm-fx-range-row">
            <input
              id={id}
              className="mm-fx-range"
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={value}
              disabled={locked}
              title={lockTitle}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <output className="mm-fx-range-value" htmlFor={id}>
              {Math.round(value * 100) / 100}
              {control.unit ?? ''}
            </output>
          </span>
        ) : null}

        {control.kind === 'number' ? (
          <span className="mm-input-wrap">
            <input
              id={id}
              className="mm-input"
              type="number"
              inputMode="decimal"
              min={control.min}
              max={control.max}
              step={control.step}
              value={value}
              disabled={locked}
              title={lockTitle}
              onChange={(e) => {
                const next = Number(e.target.value)
                if (Number.isFinite(next)) onChange(next)
              }}
            />
            {control.unit ? (
              <span className="mm-input-suffix" aria-hidden="true">
                {control.unit}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      {hint ? <p className="mm-field-hint">{hint}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 행
// ---------------------------------------------------------------------------

export interface EffectRowProps {
  effect: EffectInstance
  index: number
  total: number
  expanded: boolean
  /** 캔버스 배경이 투명한가. 알파 경고 배지는 이때만 뜬다. */
  transparentCanvas: boolean
  /** 문서 액션이 없으면 읽기 전용이다. 이유는 title 로 밝힌다. */
  readOnlyReason?: string
  dragging: boolean
  onToggleExpand(): void
  onToggleEnabled(next: boolean): void
  onRemove(): void
  onMove(direction: -1 | 1): void
  onParam(key: string, value: number): void
  onSeed(seed: number): void
  onHold(hold: number): void
  onGripPointerDown(e: ReactPointerEvent<HTMLElement>): void
  onGripPointerMove(e: ReactPointerEvent<HTMLElement>): void
  onGripPointerUp(e: ReactPointerEvent<HTMLElement>, commit: boolean): void
}

export function EffectRow(props: EffectRowProps) {
  const { effect, index, total, expanded, transparentCanvas, readOnlyReason, dragging } = props
  const def = lookupEffect(effect.type)
  const bodyId = useId()

  const locked = readOnlyReason !== undefined
  // 경고는 투명 배경일 때만 뜬다. 단색 배경에서는 알파가 오염돼도 보이지 않는다.
  const alphaWarn = transparentCanvas && def?.alphaRisk === true
  const cost = def?.cost ?? 'normal'

  const rowClass = [
    'mm-fx-row',
    effect.enabled ? '' : 'is-off',
    expanded ? 'is-open' : '',
    dragging ? 'is-dragging-row' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li className={rowClass} data-effect-id={effect.id}>
      <div className="mm-fx-head">
        <span
          className="mm-fx-grip"
          role="button"
          tabIndex={-1}
          aria-hidden="true"
          title={locked ? readOnlyReason : '끌어서 순서 바꾸기'}
          onPointerDown={locked ? undefined : props.onGripPointerDown}
          onPointerMove={locked ? undefined : props.onGripPointerMove}
          onPointerUp={locked ? undefined : (e) => props.onGripPointerUp(e, true)}
          onPointerCancel={locked ? undefined : (e) => props.onGripPointerUp(e, false)}
        >
          <GripIcon />
        </span>

        <input
          className="mm-checkbox"
          type="checkbox"
          checked={effect.enabled}
          disabled={locked}
          title={readOnlyReason}
          aria-label={`${def?.label ?? effect.type} 켜기`}
          onChange={(e) => props.onToggleEnabled(e.target.checked)}
        />

        <button
          type="button"
          className="mm-fx-name"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={props.onToggleExpand}
        >
          <ChevronIcon open={expanded} />
          <span className="mm-fx-name-text">{def?.label ?? '알 수 없는 효과'}</span>
        </button>

        <span className="mm-fx-badges">
          <span className={`mm-badge is-cost-${cost}`}>{COST_LABELS[cost]}</span>
          {alphaWarn ? (
            <span
              className="mm-badge is-warn"
              title="투명한 배경이 이 효과 때문에 뿌옇게 남을 수 있습니다. 배경을 단색으로 두면 문제가 없습니다."
            >
              배경 번짐
            </span>
          ) : null}
          {effect.requiresHistory ? (
            <span className="mm-badge is-warn" title="앞 프레임을 참고하는 효과라 내보내기가 느려집니다.">
              순차 처리
            </span>
          ) : null}
        </span>

        {/* 키보드 사용자를 위한 순서 이동. 손잡이 드래그와 같은 일을 한다. */}
        <span className="mm-fx-order">
          <button
            type="button"
            className="mm-icon-btn"
            disabled={locked || index === 0}
            title={locked ? readOnlyReason : '위로'}
            aria-label={`${def?.label ?? effect.type} 위로 옮기기`}
            onClick={() => props.onMove(-1)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="M4 10 8 6l4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            className="mm-icon-btn"
            disabled={locked || index === total - 1}
            title={locked ? readOnlyReason : '아래로'}
            aria-label={`${def?.label ?? effect.type} 아래로 옮기기`}
            onClick={() => props.onMove(1)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
              <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </span>

        <button
          type="button"
          className="mm-icon-btn is-danger"
          disabled={locked}
          title={locked ? readOnlyReason : '삭제'}
          aria-label={`${def?.label ?? effect.type} 삭제`}
          onClick={props.onRemove}
        >
          <TrashIcon />
        </button>
      </div>

      {expanded ? (
        <div className="mm-fx-body" id={bodyId}>
          {def === null ? (
            <p className="mm-fx-note">
              이 효과를 지금 버전에서 알아보지 못했습니다. 지우지 않으면 다음 버전에서 그대로 살아납니다.
            </p>
          ) : (
            <>
              {def.hint ? <p className="mm-fx-hint">{def.hint}</p> : null}

              {def.controls.map((control) => (
                <ParamControl
                  key={control.key}
                  control={control}
                  param={effect.params[control.key]}
                  disabled={locked || !effect.enabled}
                  onChange={(v) => props.onParam(control.key, v)}
                />
              ))}

              {/* 공통 노브. 어떤 이펙트든 패턴과 박자는 바꿀 수 있어야 한다. */}
              <div className="mm-fx-param">
                <label className="mm-field-label" htmlFor={`${bodyId}-hold`}>
                  몇 프레임마다
                </label>
                <div className="mm-fx-param-control">
                  <span className="mm-input-wrap">
                    <input
                      id={`${bodyId}-hold`}
                      className="mm-input"
                      type="number"
                      min={1}
                      max={12}
                      step={1}
                      value={effect.holdFrames}
                      disabled={locked || !effect.enabled}
                      title={readOnlyReason}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        if (Number.isFinite(next)) props.onHold(next)
                      }}
                    />
                    <span className="mm-input-suffix" aria-hidden="true">
                      프레임
                    </span>
                  </span>
                </div>
                <p className="mm-field-hint">
                  값이 클수록 그림이 툭툭 끊겨 보이고 파일도 가벼워집니다.
                </p>
              </div>

              <div className="mm-fx-param">
                <span className="mm-field-label">무늬 바꾸기</span>
                <div className="mm-fx-param-control">
                  <button
                    type="button"
                    className="mm-btn"
                    disabled={locked || !effect.enabled}
                    title={readOnlyReason}
                    // 시드는 결정론이라 같은 값이면 언제나 같은 무늬다.
                    // 1씩 올려 다음 무늬로 넘어간다. 무작위로 뽑으면 되돌아갈 수 없다.
                    onClick={() => props.onSeed(effect.seed + 1)}
                  >
                    다른 무늬로
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  )
}

export default EffectRow
