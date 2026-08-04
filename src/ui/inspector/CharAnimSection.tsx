/**
 * 인스펙터의 등장 섹션.
 *
 * **글자 레이어와 오브제(이미지 / 도형) 레이어가 같은 화면을 쓴다.** 규칙이 한 벌
 * 이기 때문이다 (core/charAnim.ts). 오브제는 "글자가 한 개짜리 글 상자" 로 계산되고,
 * 그래서 글자가 여럿일 때만 뜻이 있는 항목(순서 / 시간차 / 흔들림)은 오브제에서
 * 숨긴다. 보여 주고 아무 일도 안 하는 노브가 가장 나쁘다.
 *
 * 모양은 여기서 정하고 시간은 `charIn` 트랙이 민다. 트랙을 직접 만지는 것은
 * 「등장 시간」 두 칸뿐이고, 나머지는 charAnim 을 고친다.
 */

import {
  CHAR_ANIM_LIMITS,
  CHAR_EASE_LABELS,
  CHAR_IN_OBJECT_MODES,
  CHAR_ORDER_LABELS,
  charInLabel,
} from '@/core/charAnim.ts'
import {
  CHAR_EASE_LIST,
  CHAR_IN_MODE_LIST,
  type CharEase,
  type CharInMode,
  type CharOrder,
  type Layer,
} from '@/core/types.ts'
import {
  charInSpanOf,
  isAnimated,
  readStaticValue,
  useDocumentStore,
} from '@/state/document.ts'
import { useUiStore } from '@/state/ui.ts'
import { AnimateToggle } from '@/ui/inspector/AnimateToggle.tsx'
import { NumberField, SelectField } from '@/ui/widgets/Field.tsx'

const CHAR_EASE_OPTIONS = CHAR_EASE_LIST.map((value: CharEase) => ({
  value,
  label: CHAR_EASE_LABELS[value],
}))

const CHAR_ORDER_OPTIONS = (
  ['forward', 'backward', 'center', 'edges', 'random'] as CharOrder[]
).map((value) => ({ value, label: CHAR_ORDER_LABELS[value] }))

function modeOptions(forText: boolean): { value: CharInMode; label: string }[] {
  const list = forText ? CHAR_IN_MODE_LIST : CHAR_IN_OBJECT_MODES
  return list.map((value) => ({ value, label: charInLabel(value, forText) }))
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function CharAnimSection({ layer }: { layer: Layer }) {
  const setLayerCharAnim = useDocumentStore((s) => s.setLayerCharAnim)
  const setCharInSpan = useDocumentStore((s) => s.setCharInSpan)
  const setStaticValue = useDocumentStore((s) => s.setStaticValue)
  const setValueAtFrame = useDocumentStore((s) => s.setValueAtFrame)
  const fps = useDocumentStore((s) => s.doc.timeline.fps)
  const durationFrames = useDocumentStore((s) => s.doc.timeline.durationFrames)
  const frame = useUiStore((s) => s.playheadFrame)

  const forText = layer.text !== undefined
  const anim = layer.charAnim
  const mode: CharInMode = anim?.mode ?? 'none'
  const animOn = mode !== 'none'
  const title = forText ? '글자 등장' : '오브제 등장'
  const sectionId = forText ? 'mm-sec-charin' : 'mm-sec-objin'

  /*
   * 진행률. 가리기와 같은 자리다.
   *
   * 모양을 고르면 스토어가 0 -> 1 트랙을 만들어 주므로 보통은 손댈 일이 없다.
   * 여기 있는 이유는 "지금 이 프레임에서 얼마나 들어왔는가" 를 눈으로 확인하고,
   * 그래프 에디터로 넘어가기 전에 손으로 찍을 수 있어야 하기 때문이다.
   */
  const progress = readStaticValue(layer, 'charIn', frame)
  const progressPercent = Math.round(progress * 100)

  const span = charInSpanOf(layer, durationFrames)
  const safeFps = fps > 0 ? fps : 25
  const toSec = (frames: number): number => Math.round((frames / safeFps) * 100) / 100
  const toFrames = (sec: number): number => Math.round(sec * safeFps)
  const lastFrame = Math.max(1, durationFrames - 1)

  function writeProgress(value: number): void {
    const ui = useUiStore.getState()
    if (ui.playing) ui.setPlaying(false)
    if (isAnimated(layer, 'charIn')) setValueAtFrame(layer.id, 'charIn', ui.playheadFrame, value)
    else setStaticValue(layer.id, 'charIn', value)
  }

  return (
    <section className="mm-section" aria-labelledby={sectionId}>
      <h2 className="mm-section-title" id={sectionId}>
        {title}
      </h2>
      <div className="mm-stack">
        <SelectField
          label="들어오는 모양"
          value={mode}
          options={modeOptions(forText)}
          ariaLabel={forText ? '글자가 들어오는 모양' : '오브제가 들어오는 모양'}
          onChange={(v) => setLayerCharAnim(layer.id, { mode: v })}
        />

        {animOn ? (
          <>
            <SelectField
              label="속도 곡선"
              value={anim?.ease ?? 'back'}
              options={CHAR_EASE_OPTIONS}
              hint={
                forText
                  ? '글자 하나가 제자리까지 가는 속도입니다. 지나쳤다 돌아오면 쫀득해집니다.'
                  : '제자리까지 가는 속도입니다. 지나쳤다 돌아오면 쫀득해집니다.'
              }
              ariaLabel="제자리까지 가는 속도 곡선"
              onChange={(v) => setLayerCharAnim(layer.id, { ease: v })}
            />

            {/*
              시간차와 흔들림과 순서는 글자가 여럿일 때만 뜻이 있다. 오브제는 언제나
              한 개라 계산이 이 값들을 그냥 통과시킨다 (charAnim.ts charProgress).
            */}
            {forText ? (
              <>
                <NumberField
                  label="도착 흔들림"
                  value={anim?.jitter ?? 0.15}
                  min={CHAR_ANIM_LIMITS.jitter.min}
                  max={CHAR_ANIM_LIMITS.jitter.max}
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
                  min={CHAR_ANIM_LIMITS.stagger.min}
                  max={CHAR_ANIM_LIMITS.stagger.max}
                  step={0.05}
                  ariaLabel="글자 사이 시간차"
                  onChange={(v) => setLayerCharAnim(layer.id, { stagger: v })}
                />
              </>
            ) : null}

            <NumberField
              label="출발 거리"
              value={anim?.distance ?? 1.2}
              min={CHAR_ANIM_LIMITS.distance.min}
              max={CHAR_ANIM_LIMITS.distance.max}
              step={0.1}
              hint={forText ? '글자 크기의 배수입니다.' : '제 크기의 배수입니다. 1 이 넘으면 화면 밖에서 들어옵니다.'}
              ariaLabel="출발 거리(크기 배수)"
              onChange={(v) => setLayerCharAnim(layer.id, { distance: v })}
            />
            <NumberField
              label="출발 각도"
              value={anim?.rotate ?? 0}
              min={CHAR_ANIM_LIMITS.rotate.min}
              max={CHAR_ANIM_LIMITS.rotate.max}
              step={15}
              suffix="도"
              ariaLabel="출발 각도(도)"
              onChange={(v) => setLayerCharAnim(layer.id, { rotate: v })}
            />
            <NumberField
              label="출발 배율"
              value={anim?.scale ?? 1}
              min={CHAR_ANIM_LIMITS.scale.min}
              max={CHAR_ANIM_LIMITS.scale.max}
              step={0.1}
              ariaLabel="출발 배율"
              onChange={(v) => setLayerCharAnim(layer.id, { scale: v })}
            />

            {/*
              시드는 방향이나 순서를 무작위로 뽑을 때만 쓰인다. 그 외에는 아무리
              돌려도 화면이 안 바뀌므로 숨긴다.
            */}
            {mode === 'scatter' || anim?.order === 'random' ? (
              <NumberField
                label="무작위 시드"
                value={anim?.seed ?? 1}
                min={0}
                max={9999}
                step={1}
                hint="같은 시드면 언제나 같은 방향으로 흩어집니다."
                ariaLabel="무작위 방향과 순서의 시드"
                onChange={(v) => setLayerCharAnim(layer.id, { seed: v })}
              />
            ) : null}

            {/*
              속도 조절.
              길이를 줄이면 같은 모션이 그만큼 빨라진다. 곡선은 여기가 아니라
              「속도 곡선」이 정하므로, 이 두 칸은 순수하게 시간만 다룬다.
            */}
            <div className="mm-row-2">
              <NumberField
                label="시작"
                value={toSec(span.start)}
                min={0}
                max={toSec(Math.max(0, lastFrame - 1))}
                step={0.05}
                suffix="초"
                ariaLabel="등장이 시작하는 시각(초)"
                onChange={(v) => setCharInSpan(layer.id, toFrames(v), span.frames)}
              />
              <NumberField
                label="걸리는 시간"
                value={toSec(span.frames)}
                min={toSec(1)}
                max={toSec(lastFrame)}
                step={0.05}
                suffix="초"
                hint="짧게 할수록 빠르게 들어옵니다."
                ariaLabel="등장에 걸리는 시간(초)"
                onChange={(v) => setCharInSpan(layer.id, span.start, toFrames(v))}
              />
            </div>

            <div className="mm-anim-row">
              <AnimateToggle layerId={layer.id} prop="charIn" frame={frame} label="등장" />
              <NumberField
                label="진행률"
                value={progressPercent}
                min={0}
                max={100}
                step={1}
                suffix="%"
                hint="0 이면 출발점, 100 이면 제자리입니다. 모양을 고르면 자동으로 0에서 100까지 흐릅니다."
                ariaLabel="등장 진행률"
                onChange={(v) => writeProgress(clamp(v / 100, 0, 1))}
              />
            </div>
          </>
        ) : (
          <p className="mm-field-hint">
            {forText
              ? '한 글자씩 차례로 들어오게 합니다. 모양을 고르면 설정이 나타납니다.'
              : '이 오브제가 화면 밖이나 제자리에서 등장하게 합니다. 모양을 고르면 설정이 나타납니다.'}
          </p>
        )}
      </div>
    </section>
  )
}

export default CharAnimSection
