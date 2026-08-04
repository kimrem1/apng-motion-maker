/**
 * 결과 확인 패널.
 *
 * 이건 선택 사항이 아니다. 다운로드가 끝이면 사용자는 검증을 못 한다.
 * GIF 딜레이 클램프, NETSCAPE 루프 해석, Safari 의 APNG num_plays 준수 여부가
 * 전부 미검증인데 그 비용을 사용자가 떠안는 구조는 안 된다.
 *
 * 그래서 생성된 Blob 을 그대로 img 에 물려 **브라우저가 실제로 재생하게 한다.**
 * 이것이 미검증 브라우저 동작에 대한 유일한 안전망이다.
 */

import { useEffect, useRef, useState } from 'react'

import type { ExportSettings } from '@/export/pipeline.ts'
import { formatBytes } from '@/export/estimate.ts'
import { isWebpSupported } from '@/export/webp/encoder.ts'
import { WEBP_QUALITY_DEFAULT } from './exportSettings.ts'
import type { ExportResult } from './useExport.ts'

// showSaveFilePicker 는 아직 표준 lib.dom 에 없다. 필요한 부분만 좁게 선언한다.
interface WritableLike {
  write(data: Blob): Promise<void>
  close(): Promise<void>
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>
}
type SaveFilePicker = (options: {
  suggestedName?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}) => Promise<FileHandleLike>

type PreviewBackground = 'checker' | 'white' | 'black' | 'gray'

const BACKGROUNDS: readonly { id: PreviewBackground; label: string }[] = [
  { id: 'white', label: '흰' },
  { id: 'black', label: '검' },
  { id: 'gray', label: '회' },
  { id: 'checker', label: '체커' },
]

/** 한 단계 줄이는 배율. 너무 작게 줄이면 되돌릴 방법이 버튼에 없다. */
const SHRINK_RATIO = 0.75
const MIN_EXPORT_PX = 64

/**
 * 포맷별 안내.
 *
 * 셋 다 확장자만 봐서는 정지 이미지와 구별되지 않는다는 공통 문제가 있다.
 * 다만 사용자가 겪는 증상이 달라 문구를 따로 쓴다.
 * - APNG: 확장자가 .png 라 "안 움직이는 파일" 로 오해받는다.
 * - WebP: 오래된 프로그램이 아예 열지 못한다.
 * - GIF: 열리기는 하는데 반투명이 사라져 가장자리가 거칠어진다.
 */
const FORMAT_NOTE: Record<string, string> = {
  png: '움직이는 PNG입니다. 확장자가 .png 라 정지 이미지처럼 보이지만, 파일을 브라우저에 끌어다 놓으면 움직입니다.',
  webp: 'WebP 입니다. 요즘 브라우저와 대부분의 SNS 에서 바로 움직입니다. 다만 오래된 이미지 뷰어는 열지 못할 수 있습니다.',
  gif: 'GIF 입니다. 어디서나 열리는 대신 반투명이 사라지고 색이 줄어 있습니다. 위 배경 스위처를 흰색과 검은색으로 바꿔 가장자리를 확인해 주세요.',
}

export interface ResultPanelProps {
  result: ExportResult
  /** 재인코딩 중이면 버튼을 잠근다. */
  busy: boolean
  /**
   * 이 결과를 만든 뒤 문서가 바뀌었는가.
   * true 면 화면의 미리보기와 파일이 지금 문서와 다르다. 저장을 잠근다.
   */
  stale: boolean
  /** 같은 설정으로 지금 문서를 다시 인코딩한다. */
  onRemake(): void
  /** 설정만 바꿔 다시 내보낸다. 문서는 건드리지 않는다. */
  onReencode(next: ExportSettings): void
  /** fps 낮추기는 문서(timeline)를 바꾸는 동작이라 호출자에게 맡긴다. */
  onLowerFps(): void
  canLowerFps: boolean
  lowerFpsLabel: string
}

export function ResultPanel({
  result,
  busy,
  stale,
  onRemake,
  onReencode,
  onLowerFps,
  canLowerFps,
  lowerFpsLabel,
}: ResultPanelProps) {
  const [background, setBackground] = useState<PreviewBackground>('checker')
  const [fileName, setFileName] = useState(result.fileName)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const linkRef = useRef<HTMLAnchorElement | null>(null)

  // 결과가 바뀌면 이름도 새 기본값으로 되돌린다. 크기가 바뀌면 파일명도 바뀌어야 한다.
  useEffect(() => {
    setFileName(result.fileName)
    setSaveError(null)
  }, [result.fileName])

  /**
   * ObjectURL 은 명시적으로 해제하지 않으면 문서가 살아 있는 동안 Blob 을 붙잡는다.
   * 재인코딩을 몇 번만 반복해도 수십 MB 가 샌다. 생성한 곳에서 반드시 revoke 한다.
   */
  useEffect(() => {
    const next = URL.createObjectURL(result.blob)
    setUrl(next)
    return () => {
      URL.revokeObjectURL(next)
    }
  }, [result.blob])

  const isApng = result.settings.format === 'apng'
  const isGif = result.settings.format === 'gif'
  const isWebp = result.settings.format === 'webp'
  const webpUsable = isWebpSupported()
  const canShrink = Math.min(result.width, result.height) * SHRINK_RATIO >= MIN_EXPORT_PX
  const formatNote = FORMAT_NOTE[result.extension]

  const handleShrink = (): void => {
    onReencode({
      ...result.settings,
      width: Math.max(MIN_EXPORT_PX, Math.round(result.width * SHRINK_RATIO)),
      height: Math.max(MIN_EXPORT_PX, Math.round(result.height * SHRINK_RATIO)),
    })
  }

  const handleToGif = (): void => {
    onReencode({ ...result.settings, format: 'gif', maxColors: 128, dither: 0.5 })
  }

  /**
   * GIF 로 갈 때와 달리 WebP 는 알파를 8비트로 유지한다.
   * 그래서 transparent 를 건드리지 않고 품질만 기본값으로 되돌린다.
   * 디더는 팔레트가 있는 GIF 전용이라 0 으로 내린다. 남겨 두면 무의미한 노이즈만 는다.
   */
  const handleToWebp = (): void => {
    onReencode({
      ...result.settings,
      format: 'webp',
      dither: 0,
      quality: WEBP_QUALITY_DEFAULT,
      lossless: false,
    })
  }

  const handleSave = async (): Promise<void> => {
    setSaveError(null)
    const name = fileName.trim().length > 0 ? fileName.trim() : result.fileName
    const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker

    if (picker) {
      try {
        const handle = await picker({
          suggestedName: name,
          types: [
            {
              description: isApng ? '움직이는 PNG' : isWebp ? '움직이는 WebP' : 'GIF 이미지',
              accept: { [result.mime]: [`.${result.extension}`] },
            },
          ],
        })
        const writable = await handle.createWritable()
        await writable.write(result.blob)
        await writable.close()
        return
      } catch (err) {
        // 사용자가 저장 창을 닫은 것은 실패가 아니다.
        if (err instanceof Error && err.name === 'AbortError') return
        // 그 외에는 조용히 폴백한다. 여기서 멈추면 저장할 방법이 사라진다.
      }
    }

    const link = linkRef.current
    if (!link || !url) {
      setSaveError('저장에 실패했습니다. 미리보기 이미지를 오른쪽 클릭해 저장해 주세요.')
      return
    }
    link.href = url
    link.download = name
    link.click()
  }

  return (
    <div className="mm-result">
      <div className="mm-result-preview">
        <div className="mm-result-bgbar" role="group" aria-label="미리보기 배경">
          {BACKGROUNDS.map((bg) => (
            <button
              key={bg.id}
              type="button"
              className="mm-bg-chip"
              data-bg={bg.id}
              aria-pressed={background === bg.id}
              onClick={() => setBackground(bg.id)}
            >
              {bg.label}
            </button>
          ))}
        </div>

        {/*
          체커보드만 보여주면 흰 배경 앱에 올렸을 때 반투명 가장자리의 검은 테두리를
          사전에 발견할 수 없다. 배경 스위처는 투명 결과물에서 필수다.
        */}
        <div
          className={
            background === 'checker' ? 'mm-result-stage mm-checker' : 'mm-result-stage'
          }
          data-bg={background}
        >
          {url ? <img className="mm-result-img" src={url} alt="내보낸 결과 미리보기" /> : null}
        </div>

        <p className="mm-note">
          이 미리보기는 브라우저가 실제 파일을 재생한 결과입니다. 여기서 움직이지 않으면 이
          브라우저가 그 포맷을 재생하지 못하는 것입니다.
        </p>
      </div>

      <div className="mm-result-meta">
        <label className="mm-field-label" htmlFor="mm-export-filename">
          파일 이름
        </label>
        <input
          id="mm-export-filename"
          className="mm-input"
          type="text"
          value={fileName}
          spellCheck={false}
          onChange={(e) => setFileName(e.target.value)}
        />
        <p className="mm-field-hint">
          {result.presetName.length > 0
            ? `원본명_${result.presetName}_${result.width} 규칙으로 지었습니다. 바꿔도 됩니다.`
            : '원본명_크기 규칙으로 지었습니다. 바꿔도 됩니다.'}
        </p>

        <dl className="mm-result-facts">
          <div>
            <dt>용량</dt>
            <dd>{formatBytes(result.byteLength)}</dd>
          </div>
          <div>
            <dt>크기</dt>
            <dd>
              {result.width} x {result.height}
            </dd>
          </div>
          <div>
            <dt>프레임</dt>
            <dd>{result.frameCount}장</dd>
          </div>
          <div>
            <dt>속도</dt>
            <dd>{result.fps}fps</dd>
          </div>
          <div>
            <dt>반복</dt>
            <dd>{result.loopLabel}</dd>
          </div>
        </dl>

        {formatNote ? <p className="mm-callout">{formatNote}</p> : null}

        {/*
          인코더가 조용히 바꾼 것. 무손실을 못 만들었거나 알파를 버린 경우다.
          여기 안 띄우면 사용자는 다른 앱에서 열어 보기 전까지 알 수 없다.
          role 은 alert 가 아니라 status 다. 낡음 배너가 이미 alert 라 겹쳐 읽힌다.
        */}
        {result.warnings && result.warnings.length > 0 ? (
          <div className="mm-callout is-warn" role="status">
            {result.warnings.map((w) => (
              <p key={w.code}>{w.message}</p>
            ))}
          </div>
        ) : null}

        <div className="mm-result-actions">
          <p className="mm-field-label">마음에 안 드나요?</p>
          <div className="mm-btn-row">
            <button
              type="button"
              className="mm-btn"
              disabled={busy || !canLowerFps}
              title={canLowerFps ? lowerFpsLabel : '더 낮출 수 있는 속도가 없습니다'}
              onClick={onLowerFps}
            >
              fps 낮추기
            </button>
            <button
              type="button"
              className="mm-btn"
              disabled={busy || !canShrink}
              title={canShrink ? '긴 변을 4분의 3으로 줄입니다' : '더 줄일 수 없습니다'}
              onClick={handleShrink}
            >
              크기 줄이기
            </button>
            <button
              type="button"
              className="mm-btn"
              disabled={busy || isWebp || !webpUsable}
              title={
                isWebp
                  ? '이미 WebP 입니다'
                  : webpUsable
                    ? '반투명을 그대로 유지하면서 파일이 가장 작아집니다'
                    : '이 브라우저에서는 WebP 를 만들 수 없습니다'
              }
              onClick={handleToWebp}
            >
              WebP로
            </button>
            <button
              type="button"
              className="mm-btn"
              disabled={busy || isGif}
              title={isGif ? '이미 GIF 입니다' : '어디서나 열리는 대신 색과 투명이 줄어듭니다'}
              onClick={handleToGif}
            >
              GIF로
            </button>
          </div>
        </div>

        {/*
          결과를 만든 뒤 문서가 바뀌면 이 파일은 이미 화면의 작업물이 아니다.
          경고만 띄우고 저장을 열어 두면 사용자는 옛 파일을 받고도 모른다.
        */}
        {stale ? (
          <div className="mm-callout is-warn" role="alert">
            <p>문서가 변경되었습니다. 이 파일은 변경 전 내용입니다. 다시 만들어야 합니다.</p>
            <div className="mm-btn-row">
              <button type="button" className="mm-btn" disabled={busy} onClick={onRemake}>
                다시 만들기
              </button>
            </div>
          </div>
        ) : null}

        {saveError ? (
          <p className="mm-error" role="alert">
            {saveError}
          </p>
        ) : null}

        <button
          type="button"
          className="mm-btn mm-btn-primary mm-btn-block"
          disabled={busy || stale}
          title={stale ? '문서가 바뀌었습니다. 다시 만든 뒤에 저장할 수 있습니다.' : undefined}
          onClick={() => {
            void handleSave()
          }}
        >
          저장
        </button>

        {/* showSaveFilePicker 가 없는 브라우저용 폴백. 화면에는 보이지 않는다. */}
        <a ref={linkRef} className="mm-visually-hidden" aria-hidden="true" tabIndex={-1} href="#">
          저장
        </a>
      </div>
    </div>
  )
}

export default ResultPanel
