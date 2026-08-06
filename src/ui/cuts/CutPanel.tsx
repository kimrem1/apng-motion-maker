/**
 * 컷 패널.
 *
 * 컷은 타임라인을 나눈 구간이다(core/cuts.ts). 여기서 하는 일은 네 가지다.
 *   컷 추가 / 삭제 / 순서 바꾸기
 *   컷 길이와 전환(겹침) 정하기
 *   고른 레이어를 그 컷에 넣기
 *   컷 머리로 재생 헤드 옮기기
 *
 * 컷을 만들어도 레이어를 넣기 전까지는 아무 그림도 바뀌지 않는다. 길이만 늘어난다.
 * 그래야 "컷을 하나 눌렀더니 화면이 사라졌다" 가 안 생긴다.
 */

import { useState } from 'react'

import { useDocumentStore } from '@/state/document.ts'
import { useLayerUiStore } from '@/state/layerUi.ts'
import { useUiStore } from '@/state/ui.ts'
import {
  addCut,
  assignToCut,
  clearCutAssignment,
  cutRangesOf,
  moveCut,
  removeCut,
  setCutCross,
  setCutFrames,
  setCutName,
} from '@/state/cutActions.ts'
import { NumberField, TextField } from '@/ui/widgets/Field.tsx'
import './cuts.css'

export function CutPanel() {
  const doc = useDocumentStore((s) => s.doc)
  const selectedIds = useLayerUiStore((s) => s.selectedLayerIds)
  const setPlayheadFrame = useUiStore((s) => s.setPlayheadFrame)

  const [notice, setNotice] = useState<string | null>(null)
  const ranges = cutRangesOf(doc)
  const fps = doc.timeline.fps

  /** 이 컷에 들어 있는 레이어 수. 배정을 눈으로 확인할 수 있어야 한다. */
  function countIn(start: number, end: number): number {
    return doc.layers.filter((l) => l.inFrame === start && l.outFrame === end).length
  }

  return (
    <div className="mm-cut-panel">
      <div className="mm-cut-head">
        <button type="button" className="mm-btn mm-btn-primary" onClick={() => addCut()}>
          컷 추가
        </button>
        <span className="mm-cut-total">
          전체 {doc.timeline.durationFrames}프레임 · {(doc.timeline.durationFrames / fps).toFixed(2)}초
        </span>
      </div>

      <p className="mm-cut-hint">
        컷을 만든 다음 레이어를 골라 <b>이 컷에 넣기</b> 를 누르세요. 넣기 전에는 모든 컷에서
        계속 보입니다.
      </p>

      <ol className="mm-cut-list">
        {ranges.map((range, i) => {
          const cut = (doc.cuts ?? [])[i]
          const frames = cut?.frames ?? range.end - range.start + 1
          /*
           * 엔진이 실제로 쓰는 값을 보여 준다. 원본 스펙이 아니다.
           *
           * cutRanges 는 첫 컷의 겹침을 0 으로 본다(앞에 겹칠 것이 없다). 그런데
           * 패널만 doc.cuts[i].crossFrames 를 그대로 읽어서, 겹침 5 를 넣어 둔 컷을
           * 맨 위로 올리면 화면에는 5 로 남고 구간 계산과 [이 컷에 넣기] 는 0 으로
           * 돌았다. 게다가 첫 컷의 그 칸은 비활성이라 0 으로 되돌릴 수단도 없었다.
           */
          const cross = range.crossFrames
          const inCut = countIn(range.start, range.end)

          return (
            <li key={range.id} className="mm-cut-item">
              <div className="mm-cut-item-head">
                <span className="mm-cut-index">{i + 1}</span>
                <TextField
                  label="이름"
                  value={range.name}
                  ariaLabel={`${i + 1}번 컷 이름`}
                  onChange={(name) => setCutName(range.id, name)}
                />
                <span className="mm-cut-actions">
                  <button
                    type="button"
                    className="mm-icon-btn"
                    title="위로"
                    aria-label={`${i + 1}번 컷 앞으로`}
                    disabled={i === 0}
                    onClick={() => moveCut(range.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="mm-icon-btn"
                    title="아래로"
                    aria-label={`${i + 1}번 컷 뒤로`}
                    disabled={i === ranges.length - 1}
                    onClick={() => moveCut(range.id, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="mm-icon-btn"
                    title="삭제"
                    aria-label={`${i + 1}번 컷 삭제`}
                    disabled={ranges.length <= 1}
                    onClick={() => removeCut(range.id)}
                  >
                    ×
                  </button>
                </span>
              </div>

              <div className="mm-row-2">
                <NumberField
                  label="길이"
                  value={frames}
                  min={2}
                  suffix="프레임"
                  ariaLabel={`${i + 1}번 컷 길이(프레임)`}
                  onChange={(v) => setCutFrames(range.id, v)}
                />
                <NumberField
                  label="앞 컷과 겹침"
                  value={cross}
                  min={0}
                  max={Math.max(0, frames - 1)}
                  suffix="프레임"
                  disabled={i === 0}
                  hint={i === 0 ? undefined : '0 이면 딱 잘리고, 크면 서서히 섞입니다'}
                  ariaLabel={`${i + 1}번 컷 전환 겹침(프레임)`}
                  onChange={(v) => setCutCross(range.id, v)}
                />
              </div>

              <div className="mm-cut-foot">
                <button
                  type="button"
                  className="mm-btn"
                  onClick={() => setPlayheadFrame(range.start)}
                >
                  {range.start} ~ {range.end} 로 이동
                </button>
                <button
                  type="button"
                  className="mm-btn"
                  disabled={selectedIds.length === 0}
                  onClick={() => {
                    const n = assignToCut(range.id)
                    setNotice(n > 0 ? `${n}장을 ${range.name} 에 넣었습니다.` : null)
                  }}
                >
                  이 컷에 넣기
                </button>
                <span className="mm-cut-count">{inCut}장</span>
              </div>
            </li>
          )
        })}
      </ol>

      <button
        type="button"
        className="mm-btn mm-btn-block"
        disabled={selectedIds.length === 0}
        onClick={() => {
          const n = clearCutAssignment()
          setNotice(n > 0 ? `${n}장의 구간을 해제했습니다.` : null)
        }}
      >
        고른 레이어를 모든 컷에서 보이게
      </button>

      {notice ? (
        <p className="mm-cut-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  )
}

export default CutPanel
