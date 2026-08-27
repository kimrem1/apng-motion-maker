/**
 * 「모션 속도」 와 「모션 옮기기」 두 섹션.
 *
 * 둘을 한 파일에 두는 이유는 사용자가 같은 질문에서 도착하기 때문이다.
 * "이 오브제의 움직임을 어떻게 할까" 다. 하나는 그 움직임의 템포를 바꾸고,
 * 하나는 그 움직임을 다른 오브제에 준다.
 *
 * 규칙은 하나도 여기 두지 않는다. 무엇이 옮겨지는지는 motions/transfer.ts,
 * 배수가 어떻게 도는지는 core/evaluate.ts 가 정한다. 이 파일은 화면만 만든다.
 */

import { useState } from 'react'

import { MOTION_REPEAT_MAX, MOTION_REPEAT_MIN, type Layer } from '@/core/types.ts'
import { effectiveRepeat } from '@/core/evaluate.ts'
import {
  ALL_MOTION_PARTS,
  bundleIsEmpty,
  describeBundle,
  extractMotion,
  type MotionParts,
} from '@/motions/transfer.ts'
import { useDocumentStore } from '@/state/document.ts'
import { SelectField, ToggleField } from '@/ui/widgets/Field.tsx'

// ---------------------------------------------------------------------------
// 모션 속도
// ---------------------------------------------------------------------------

/**
 * 고를 수 있는 배수.
 *
 * 1~12 를 전부 늘어놓으면 셀렉트가 길어지고 7배와 8배의 차이를 사람이 구별하지
 * 못한다. 배가 되는 자리만 남기고 그 사이를 성기게 채운다.
 */
const REPEAT_CHOICES = [1, 2, 3, 4, 6, 8, MOTION_REPEAT_MAX] as const

export function MotionSpeedSection({ layer }: { layer: Layer }) {
  const setLayerMotionRepeat = useDocumentStore((s) => s.setLayerMotionRepeat)
  const durationFrames = useDocumentStore((s) => s.doc.timeline.durationFrames)
  const fps = useDocumentStore((s) => s.doc.timeline.fps)

  const stored = layer.motionRepeat ?? MOTION_REPEAT_MIN
  // 문서 길이가 짧으면 고른 값을 다 못 쓴다. 화면에는 실제로 도는 값을 보여 준다.
  const actual = effectiveRepeat(layer, durationFrames)
  const capped = actual < stored
  const hasMotion = layer.tracks.length > 0 || layer.modifiers.length > 0
  const cap = Math.floor(durationFrames / 2)

  const sec = fps > 0 ? durationFrames / fps : 0
  const cycleSec = actual > 0 ? sec / actual : sec

  return (
    <section className="mm-section" aria-labelledby="mm-sec-motion-speed">
      <h2 className="mm-section-title" id="mm-sec-motion-speed">
        모션 속도
      </h2>
      <div className="mm-stack">
        <SelectField
          label="이 오브제만 빠르게"
          value={String(stored)}
          options={REPEAT_CHOICES.filter((r) => r === 1 || r <= Math.max(1, cap)).map((r) => ({
            value: String(r),
            label: r === 1 ? '보통 (1배)' : `${r}배`,
          }))}
          disabled={layer.locked || cap < 2}
          ariaLabel="이 레이어의 모션 배수"
          hint={
            cap < 2
              ? '전체 길이가 너무 짧아 더 쪼갤 수 없습니다.'
              : !hasMotion
                ? '이 오브제에 걸린 움직임이 아직 없습니다. 왼쪽에서 움직임을 먼저 고르세요.'
                : stored > 1
                  ? `한 바퀴가 ${cycleSec.toFixed(2)}초입니다. 전체 길이 ${sec.toFixed(2)}초와 초당 프레임은 그대로입니다.`
                  : '위쪽 속도 슬라이더는 전체 길이를 바꿉니다. 이 값은 전체 길이를 그대로 두고 이 오브제만 빠르게 돌립니다.'
          }
          onChange={(v) => setLayerMotionRepeat(layer.id, Number(v))}
        />
        {capped ? (
          <p className="mm-field-hint" role="status">
            전체 길이가 {durationFrames}프레임뿐이라 실제로는 {actual}배로 돕니다. 한 바퀴는 최소
            두 프레임이 있어야 합니다.
          </p>
        ) : null}
        {stored > 1 ? (
          <p className="mm-field-hint">
            타임라인과 그래프에는 한 바퀴만 그려집니다. 재생과 내보내기는 {actual}번 돕니다.
            반복 재생의 이음새가 끊기지 않도록 정수 배로만 돌립니다.
          </p>
        ) : null}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 모션 옮기기
// ---------------------------------------------------------------------------

const PART_LABEL: Record<keyof MotionParts, string> = {
  tracks: '움직임 (키프레임 · 흔들림 · 속도)',
  effects: '효과',
  shaping: '가리기 · 등장 · 기준점',
}

export function MotionTransferSection({ layer }: { layer: Layer }) {
  const layers = useDocumentStore((s) => s.doc.layers)
  const transferMotion = useDocumentStore((s) => s.transferMotion)

  const [targetId, setTargetId] = useState('')
  const [parts, setParts] = useState<MotionParts>(ALL_MOTION_PARTS)
  const [notice, setNotice] = useState<string | null>(null)

  const bundle = extractMotion(layer)
  const summary = describeBundle(bundle, parts)
  const empty = bundleIsEmpty(bundle, parts)
  const noPart = !parts.tracks && !parts.effects && !parts.shaping

  const others = layers.filter((l) => l.id !== layer.id)
  const target = others.find((l) => l.id === targetId) ?? null
  const targetIsFolder = target?.type === 'group'
  const targetLocked = target?.locked === true

  const blocked = target === null || targetLocked || empty || noPart

  function send(move: boolean): void {
    if (target === null) return
    const report = transferMotion({
      fromLayerId: layer.id,
      toLayerIds: [target.id],
      parts,
      move,
    })
    if (report.moved === 0) {
      setNotice('보낼 것이 없습니다.')
      return
    }
    setNotice(
      move
        ? `'${target.name}' 로 옮겼습니다. 이 오브제에서는 빠졌습니다. Ctrl+Z 로 되돌릴 수 있습니다.`
        : `'${target.name}' 에 넣었습니다. 이 오브제의 모션은 그대로입니다.`,
    )
    /*
     * 선택은 옮기지 않는다.
     *
     * 옮기면 이 섹션이 대상 레이어용으로 다시 만들어지면서(key 가 레이어 id 다)
     * 방금 띄운 안내가 그 자리에서 사라진다. 화면에는 두 오브제가 함께 움직이는
     * 미리보기가 이미 떠 있으므로 결과는 그쪽에서 바로 보인다.
     */
  }

  return (
    <section className="mm-section" aria-labelledby="mm-sec-motion-transfer">
      <h2 className="mm-section-title" id="mm-sec-motion-transfer">
        모션 옮기기
      </h2>
      <div className="mm-stack">
        {others.length === 0 ? (
          <p className="mm-field-hint">
            보낼 곳이 없습니다. 오브제를 하나 더 넣으면 이 오브제의 움직임을 그대로 줄 수 있습니다.
          </p>
        ) : (
          <>
            <SelectField
              label="보낼 곳"
              value={targetId}
              options={[
                { value: '', label: '오브제를 고르세요' },
                ...others.map((l) => ({
                  value: l.id,
                  label: l.type === 'group' ? `${l.name} (폴더)` : l.name,
                })),
              ]}
              ariaLabel="모션을 보낼 오브제"
              onChange={(v) => {
                setTargetId(v)
                setNotice(null)
              }}
            />

            {(Object.keys(PART_LABEL) as (keyof MotionParts)[]).map((key) => (
              <ToggleField
                key={key}
                label={PART_LABEL[key]}
                checked={parts[key]}
                onChange={(v) => {
                  setParts((prev) => ({ ...prev, [key]: v }))
                  setNotice(null)
                }}
                ariaLabel={`${PART_LABEL[key]} 보내기`}
              />
            ))}

            <p className="mm-field-hint">
              {noPart
                ? '보낼 갈래를 하나 이상 골라 주세요.'
                : empty
                  ? '이 오브제에는 고른 갈래에 해당하는 것이 없습니다.'
                  : `보낼 것: ${summary.join(' · ')}`}
            </p>

            <div className="mm-btn-row">
              <button
                type="button"
                className="mm-btn"
                disabled={blocked}
                title={
                  targetLocked
                    ? '잠긴 레이어입니다. 자물쇠를 풀면 바꿀 수 있습니다.'
                    : '이 오브제의 모션을 그대로 두고 사본을 보냅니다'
                }
                onClick={() => send(false)}
              >
                복사해서 넣기
              </button>
              <button
                type="button"
                className="mm-btn"
                disabled={blocked}
                title={
                  targetLocked
                    ? '잠긴 레이어입니다. 자물쇠를 풀면 바꿀 수 있습니다.'
                    : '이 오브제에서 빼고 저쪽으로 옮깁니다'
                }
                onClick={() => send(true)}
              >
                옮기기 (여기서 빼기)
              </button>
            </div>

            {notice ? (
              <p className="mm-callout" role="status">
                {notice}
              </p>
            ) : null}

            <p className="mm-field-hint">
              이름 · 크기 · 맞춤 · 보이는 구간 · 담기 배율은 따라가지 않습니다. 받은 쪽의 모션은
              통째로 대체되고, 그때부터 사용자가 직접 만든 모션으로 취급되므로 EASY 의 세기와 속도
              슬라이더는 원본 오브제에만 걸립니다.
            </p>
            {targetIsFolder ? (
              <p className="mm-field-hint">
                폴더에는 그릴 그림이 없어 효과와 가리기는 보내지 않습니다. 움직임은 그대로 걸리고,
                폴더 안에 든 오브제가 함께 따라 움직입니다.
              </p>
            ) : null}
            {layer.text && target && !target.text ? (
              <p className="mm-field-hint">
                글자 등장을 이미지나 도형에 걸면 한 글자씩이 아니라 그림 통째로 들어옵니다.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  )
}
