/**
 * 레이어 고유 속성 조각.
 *
 * 인스펙터에 끼워 넣는 <section> 하나다. 자체 패널이 아니다.
 * 여기 있는 것들은 "이 레이어가 다른 레이어들과 어떤 관계인가" 에 해당한다.
 * 위치/크기/회전 같은 트랙 값은 기존 Inspector 의 레이어 섹션이 계속 담당한다.
 *
 * 오버스캔 표시 원칙: 원인이 아니라 처방을 말한다.
 * "실제 배율 1.2 -> 1.34 (자동 보정됨)" 같은 문구는 쓰지 않는다.
 * core/overscan.ts 의 diagnose() 가 이미 그 원칙으로 문구를 만들어 주므로 그대로 쓴다.
 */

import { useId, useMemo, useState } from 'react'

import type { Layer } from '@/core/types.ts'
import { resolveLayerTransformWithParents } from '@/core/evaluate.ts'
import { clipBaseIndexes } from '@/core/clip.ts'
import { folderChain } from '@/core/group.ts'
import { diagnose, isContainTarget, solveLayerContain, solveLayerOverscan } from '@/core/overscan.ts'
import { layerIntrinsicSize } from '@/core/shape.ts'
import { useDocumentStore } from '@/state/document.ts'
import {
  formatNumber,
  SelectField,
  ToggleField,
  type SelectOption,
} from '@/ui/widgets/Field.tsx'
import {
  BLEND_OPTIONS,
  FRAME_FIT_OPTIONS,
  PARALLAX_MAX,
  PARALLAX_MIN,
  canParent,
  frameFitOf,
  setFrameFit,
  setLayerBlend,
  setLayerParallax,
  setLayerClip,
  setLayerFolder,
  setLayerParent,
} from './layerDocActions.ts'
import './layers.css'

const NO_PARENT = ''
const NO_FOLDER = ''

export interface LayerPropertiesProps {
  layer: Layer
}

export function LayerProperties({ layer }: LayerPropertiesProps) {
  const doc = useDocumentStore((s) => s.doc)
  const setBackgroundType = useDocumentStore((s) => s.setBackgroundType)

  const depthId = useId()
  const depthHintId = useId()

  /** 어느 레이어에 대해 배경 채우기를 눌렀는지. 레이어를 바꾸면 안내가 자동으로 사라진다. */
  const [bgNoteFor, setBgNoteFor] = useState<string | null>(null)

  const asset = useMemo(
    () => (layer.assetId ? doc.assets.find((a) => a.id === layer.assetId) : undefined),
    [doc.assets, layer.assetId],
  )

  /**
   * 오버스캔 진단.
   * 240 샘플 x 트랙 수를 도는 계산이라 프레임마다 부르면 안 된다(overscan.ts 주석).
   * 선택된 레이어 하나에 대해, 문서가 바뀔 때만 다시 푼다.
   */
  const diag = useMemo(() => {
    if (!asset) return null
    const need = solveLayerOverscan(doc, layer, asset.naturalW, asset.naturalH)
    return diagnose(need, Math.max(asset.naturalW, asset.naturalH))
  }, [doc, layer, asset])

  /**
   * 담기가 실제로 얼마나 줄였는가.
   *
   * 사용자에게 배율을 그대로 보여 주는 것이 여기서는 옳다. 오버스캔 진단과 반대다.
   * 오버스캔은 눈에 안 보이는 보정이라 처방만 말하면 되지만, 담기는 그림이 눈에
   * 띄게 작아진다. 왜 작아졌는지 말해 주지 않으면 사용자는 자기가 뭘 잘못 눌렀다고
   * 생각하고 되돌릴 방법을 찾지 못한다.
   */
  const contain = useMemo(() => {
    // 도형에는 에셋이 없지만 담기 솔버는 정상 동작한다. 자연 크기는 한 곳에서 온다.
    const size = layerIntrinsicSize(layer, () =>
      asset ? { width: asset.naturalW, height: asset.naturalH } : undefined,
    )
    if (!size || !isContainTarget(layer)) return null
    const need = solveLayerContain(doc, layer, size.width, size.height)
    if (need.correction >= 1) return null
    return { percent: Math.round(need.correction * 100), clipped: need.clipped }
  }, [doc, layer, asset])

  /** 순환을 만드는 후보는 목록에서 아예 뺀다. 고를 수 없어야 실수도 없다. */
  const parentOptions = useMemo<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = [{ value: NO_PARENT, label: '없음' }]
    // 목록과 같은 순서(위가 앞)로 보여 준다.
    for (const candidate of [...doc.layers].reverse()) {
      if (candidate.id === layer.id) continue
      if (!canParent(doc, layer.id, candidate.id)) continue
      options.push({ value: candidate.id, label: candidate.name })
    }
    return options
  }, [doc, layer.id])

  /**
   * 담을 수 있는 폴더 목록.
   *
   * 자기 자신과 자기 자손은 뺀다. 넣으면 사슬이 자기에게 돌아와 아무도 안 그려진다.
   */
  const folderOptions = useMemo<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = [{ value: NO_FOLDER, label: '없음 (최상위)' }]
    for (const candidate of [...doc.layers].reverse()) {
      if (candidate.type !== 'group') continue
      if (candidate.id === layer.id) continue
      if (folderChain(doc.layers, candidate).some((f) => f.id === layer.id)) continue
      options.push({ value: candidate.id, label: candidate.name })
    }
    return options
  }, [doc.layers, layer.id])

  /**
   * 움직이는 폴더 안인가. 채우기가 꺼지는 조건과 같은 규칙이어야 한다
   * (core/overscan.ts solveLayerOverscan). 여기서는 첫 프레임과 중간, 끝만 본다.
   * 안내 문구용이라 표본이 촘촘할 필요가 없다.
   */
  const insideMovingFolder = useMemo(() => {
    if (!layer.folderId || !layer.fillsCanvas) return false
    const last = Math.max(0, doc.timeline.durationFrames - 1)
    for (const f of [0, Math.floor(last / 2), last]) {
      for (const folder of folderChain(doc.layers, layer)) {
        const t = resolveLayerTransformWithParents(doc, folder, f)
        if (
          t.translateX !== 0 ||
          t.translateY !== 0 ||
          t.rotate !== 0 ||
          t.skewX !== 0 ||
          t.skewY !== 0 ||
          t.scaleX !== 1 ||
          t.scaleY !== 1
        ) {
          return true
        }
      }
    }
    return false
  }, [doc, layer])

  /**
   * 자르기의 밑판이 될 레이어. 없으면 자르기를 켜도 아무 일도 일어나지 않는다.
   * 판정 규칙은 core/clip.ts 한 곳에만 있다. 여기서 다시 짜면 화면과 그림이 어긋난다.
   */
  const clipBase = useMemo(() => {
    const ordered = [...doc.layers].sort((a, b) => a.z - b.z)
    const index = ordered.findIndex((l) => l.id === layer.id)
    if (index < 0) return null
    const probe = ordered.map((l, i) => ({
      layerId: l.id,
      // 지금 레이어는 켜져 있다고 보고 묻는다. 꺼져 있어도 "켜면 무엇에 잘리는지" 를
      // 미리 알려 줘야 사용자가 순서를 맞출 수 있다.
      clipToBelow: i === index ? true : l.clipToBelow,
      ...(l.folderId === undefined ? {} : { folderId: l.folderId }),
      isFolder: l.type === 'group',
      visible: l.visible,
    }))
    const base = clipBaseIndexes(probe)[index] ?? -1
    return base >= 0 ? (ordered[base] ?? null) : null
  }, [doc.layers, layer.id])

  const frameFit = frameFitOf(layer)
  const hasParent = layer.parentId !== null
  // fillsCanvas 를 켜도 맞춤이 contain/none 이면 솔버가 돌지 않는다 (overscan.isSolverTarget).
  const fitIgnoresFill = layer.fit === 'contain' || layer.fit === 'none'

  function applyBackgroundFill(): void {
    // blurExtend 렌더가 아직 없다. 단색으로 대신 켜고 그 사실을 그대로 말한다.
    setBackgroundType('solid')
    setBgNoteFor(layer.id)
  }

  return (
    <section className="mm-section mm-lyr-props" aria-labelledby="mm-sec-layer-props">
      <h2 className="mm-section-title" id="mm-sec-layer-props">
        레이어 관계
      </h2>

      <div className="mm-stack">
        {/* ------------------------------------------------------------- */}
        {/* 어느 폴더에 담겨 있는가. 폴더의 움직임이 통째로 얹힌다.        */}
        {/* ------------------------------------------------------------- */}
        {folderOptions.length > 1 ? (
          <SelectField
            label="폴더"
            value={layer.folderId ?? NO_FOLDER}
            options={folderOptions}
            ariaLabel="이 레이어가 담긴 폴더"
            hint="폴더의 움직임이 안에 든 레이어에 그대로 얹힙니다."
            onChange={(v) => setLayerFolder([layer.id], v === NO_FOLDER ? null : v)}
          />
        ) : null}
        {/* ------------------------------------------------------------- */}
        {/* 아래 레이어 모양으로 자르기. 폴더는 자를 그림이 없다.          */}
        {/* ------------------------------------------------------------- */}
        {layer.type === 'group' ? null : (
          <>
            <ToggleField
              label="아래 모양으로 자르기"
              checked={layer.clipToBelow === true}
              ariaLabel="아래 레이어 모양으로 자르기"
              onChange={(v) => setLayerClip([layer.id], v)}
            />
            <p className="mm-lyr-note">
              {clipBase
                ? `바로 아래 「${clipBase.name}」 이 그린 자리에만 보입니다.`
                : '바로 아래에 기준이 될 레이어가 없습니다. 순서를 바꾸거나 아래에 한 장을 놓으세요.'}
            </p>
          </>
        )}

        {insideMovingFolder ? (
          <p className="mm-lyr-note">
            움직이는 폴더 안에서는 채우기가 동작하지 않습니다. 폴더가 그룹째로 움직이면
            한 장만 보고 푼 배율이 맞지 않기 때문입니다.
          </p>
        ) : null}

        {/* ------------------------------------------------------------- */}
        {/* 모션이 프레임을 벗어날 때 무엇을 지킬 것인가. 셋은 배타다. */}
        {/* ------------------------------------------------------------- */}
        <SelectField
          label="프레임을 벗어나면"
          value={frameFit}
          options={FRAME_FIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          ariaLabel="모션이 프레임을 벗어날 때의 처리"
          hint={FRAME_FIT_OPTIONS.find((o) => o.value === frameFit)?.hint}
          onChange={(v) => setFrameFit(layer.id, v)}
        />

        {layer.motionExitsFrame && frameFit === 'contain' ? (
          <p className="mm-lyr-note">
            지금 모션은 화면 밖으로 나가는 것이 목적이라 담기를 적용하지 않습니다.
          </p>
        ) : null}
        {contain ? (
          <p className="mm-lyr-note" role="status">
            {contain.clipped
              ? `움직임이 프레임을 크게 벗어나 ${contain.percent}% 까지 줄였지만 여전히 일부가 잘립니다. 움직임을 줄이거나 캔버스를 넓혀 보세요.`
              : `움직임이 프레임을 벗어나서 ${contain.percent}% 로 줄여 담았습니다.`}
          </p>
        ) : null}
        {frameFit === 'cover' && fitIgnoresFill ? (
          <p className="mm-lyr-note">
            지금 맞춤이 &lsquo;전체 보이기&rsquo; 또는 &lsquo;원본 크기&rsquo;라 여백을 채우지
            않습니다. 채우려면 맞춤을 &lsquo;꽉 채우기&rsquo;로 바꾸세요.
          </p>
        ) : null}

        {/* ------------------------------------------------------------- */}
        {/* 오버스캔 진단 */}
        {/* ------------------------------------------------------------- */}
        {diag && diag.level !== 'ok' ? (
          <div className={`mm-lyr-diag is-${diag.level}`}>
            <p className="mm-lyr-diag-head">
              <span className="mm-lyr-diag-badge" aria-hidden="true">
                {diag.level === 'warn' ? '!' : 'i'}
              </span>
              <span className="mm-lyr-diag-label">
                {diag.level === 'warn' ? '원본이 조금 작습니다' : '가장자리 주의'}
              </span>
            </p>
            <p className="mm-lyr-diag-text">{diag.message}</p>

            {diag.suggestBackgroundFill ? (
              <button type="button" className="mm-btn" onClick={applyBackgroundFill}>
                배경으로 채우기
              </button>
            ) : null}

            {bgNoteFor === layer.id ? (
              <p className="mm-lyr-note" role="status">
                배경을 단색으로 켰습니다. 흐린 배경 채우기는 아직 준비 중이라 단색으로 대신했어요.
                색은 인스펙터의 캔버스 섹션에서 바꿀 수 있습니다.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ------------------------------------------------------------- */}
        {/* 기준 레이어 + 깊이감 */}
        {/* ------------------------------------------------------------- */}
        <SelectField
          label="기준 레이어"
          value={layer.parentId ?? NO_PARENT}
          options={parentOptions}
          ariaLabel="움직임을 따라갈 기준 레이어"
          hint="고른 레이어의 움직임을 따라갑니다. 회전과 크기는 따라가지 않습니다."
          onChange={(v) => setLayerParent(layer.id, v === NO_PARENT ? null : v)}
        />

        <div className="mm-field">
          <label className="mm-field-label" htmlFor={depthId}>
            깊이감
          </label>
          <div className="mm-lyr-range-row">
            <input
              id={depthId}
              className="mm-lyr-range"
              type="range"
              min={PARALLAX_MIN}
              max={PARALLAX_MAX}
              step={0.05}
              value={layer.parallaxFactor}
              disabled={!hasParent}
              aria-describedby={depthHintId}
              aria-valuetext={`${formatNumber(layer.parallaxFactor, 2)}배`}
              onChange={(e) => setLayerParallax(layer.id, Number(e.target.value))}
            />
            <output className="mm-lyr-range-value" htmlFor={depthId}>
              {formatNumber(layer.parallaxFactor, 2)}
            </output>
          </div>
          <p className="mm-field-hint" id={depthHintId}>
            {hasParent
              ? '1이면 기준 레이어와 똑같이 움직입니다. 1보다 크면 더 많이 움직여 앞쪽에 있는 것처럼 보이고, 0에 가까울수록 멀리 있는 것처럼 보입니다.'
              : '먼저 기준 레이어를 고르세요. 기준이 없으면 깊이감은 아무 일도 하지 않습니다.'}
          </p>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* 합성 모드 */}
        {/* ------------------------------------------------------------- */}
        {/*
         * 렌더러가 W3C 분리형 혼합 공식으로 실제 합성한다.
         * '보통' 외의 모드는 오프스크린 두 장을 번갈아 쓰므로 패스가 두 번 더 든다.
         * 프리뷰와 내보내기 모두 같은 경로다.
         */}
        <SelectField
          label="합성 모드"
          value={layer.blend}
          options={BLEND_OPTIONS}
          ariaLabel="아래 레이어와 섞는 방식"
          hint="아래 레이어와 색을 섞는 방식입니다. 맨 아래 레이어에는 효과가 없습니다."
          onChange={(v) => setLayerBlend(layer.id, v)}
        />
      </div>
    </section>
  )
}

export default LayerProperties
