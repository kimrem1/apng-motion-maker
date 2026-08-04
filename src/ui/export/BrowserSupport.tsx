/**
 * 브라우저 지원 진단 패널.
 *
 * 문서만으로는 답할 수 없는 항목이 세 개 있다.
 *
 *   - GIF NETSCAPE2.0 의 루프 카운트 N 을 리더가 "N회 재생" 으로 읽는지
 *     "N회 추가 반복" 으로 읽는지
 *   - Safari 가 APNG acTL num_plays 를 지키는지
 *   - WebP 애니메이션을 이 브라우저가 재생하는지
 *
 * 이 셋은 문서로 확인할 수 없다. 명세가 모호하거나 구현이 갈리기 때문이다.
 * 그래서 **이 파일이 직접 잰다.** 8x8 짜리 진단용 파일 세 개를 그 자리에서 인코딩해
 * 이 브라우저의 디코더에 먹이고, 돌아온 숫자를 화면에 남긴다.
 *
 * 콘솔이 아니라 화면에 남기는 것이 핵심이다. 사용자가 "내 브라우저에서 3번 반복이
 * 4번으로 재생된다" 를 직접 읽을 수 있어야 이 장치가 의미를 갖는다.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { encodeApng } from '@/export/apng/encoder.ts'
import { encodeGif } from '@/export/gif/encoder.ts'
import { encodeWebp, isWebpSupported } from '@/export/webp/encoder.ts'

// ---------------------------------------------------------------------------
// 진단용 표본
// ---------------------------------------------------------------------------

/** 진단 파일 한 변. 작을수록 좋지만 GIF 양자화가 표본을 필요로 해 8px 로 둔다. */
const PROBE_SIZE = 8

/** 프레임 지연(ms). 20ms 미만은 브라우저가 100ms 로 클램프하므로 넉넉히 잡는다. */
const PROBE_DELAY_MS = 100

/**
 * 진단 파일에 적어 넣는 루프 횟수.
 *
 * 3 인 이유가 있다. 1 은 확장 자체가 생략되고, 2 는 "총 재생 횟수" 해석과
 * "추가 반복 횟수" 해석의 차이가 1 이라 헷갈린다. 3 이면 돌아온 값이
 * 3 인지 2 인지로 두 해석이 깔끔하게 갈린다.
 */
const PROBE_LOOP_COUNT = 3

function solidFrame(r: number, g: number, b: number): Uint8Array {
  const px = PROBE_SIZE * PROBE_SIZE
  const rgba = new Uint8Array(px * 4)
  for (let i = 0; i < px; i += 1) {
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

/** 1프레임은 빨강, 2프레임은 파랑. 픽셀 하나만 읽어도 프레임이 넘어갔는지 알 수 있다. */
const FRAME_A = solidFrame(255, 0, 0)
const FRAME_B = solidFrame(0, 0, 255)

// ---------------------------------------------------------------------------
// ImageDecoder (WebCodecs) 최소 선언
// ---------------------------------------------------------------------------

/**
 * lib.dom 의 ImageDecoder 타입은 브라우저와 TS 버전에 따라 있기도 없기도 하다.
 * 여기서 쓰는 부분만 좁게 선언하고 globalThis 에서 꺼낸다.
 */
interface DecoderTrackLike {
  animated: boolean
  frameCount: number
  /** WebCodecs 정의상 **첫 재생을 제외한 반복 횟수**다. 무한이면 Infinity. */
  repetitionCount: number
}
interface DecoderTrackListLike {
  ready: Promise<void>
  selectedTrack: DecoderTrackLike | null
}
interface ImageDecoderLike {
  completed: Promise<void>
  tracks: DecoderTrackListLike
  close(): void
}
interface ImageDecoderCtor {
  new (init: { data: BufferSource; type: string }): ImageDecoderLike
}

function getImageDecoder(): ImageDecoderCtor | null {
  const ctor = (globalThis as unknown as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder
  return typeof ctor === 'function' ? ctor : null
}

interface TrackReading {
  animated: boolean
  frameCount: number
  repetitionCount: number
}

async function readTrack(bytes: Uint8Array, mime: string): Promise<TrackReading | null> {
  const Ctor = getImageDecoder()
  if (!Ctor) return null

  // Uint8Array 뷰를 그대로 넘기면 SharedArrayBuffer 백킹일 때 타입이 맞지 않는다.
  const data = bytes.slice().buffer as ArrayBuffer
  let decoder: ImageDecoderLike | null = null
  try {
    decoder = new Ctor({ data, type: mime })
    await decoder.tracks.ready
    await decoder.completed
    const track = decoder.tracks.selectedTrack
    if (!track) return null
    return {
      animated: track.animated,
      frameCount: track.frameCount,
      repetitionCount: track.repetitionCount,
    }
  } catch {
    // 이 브라우저가 그 포맷을 못 읽는다. 실패 자체가 결과다.
    return null
  } finally {
    try {
      decoder?.close()
    } catch {
      // close 가 두 번 불리는 것은 문제가 아니다.
    }
  }
}

// ---------------------------------------------------------------------------
// 눈으로 재는 폴백 (ImageDecoder 가 없는 브라우저)
// ---------------------------------------------------------------------------

/**
 * 화면에 실제로 붙어 있는 img 를 두 시각에 캔버스로 떠서 픽셀을 비교한다.
 *
 * **화면에 붙어 있어야 한다.** 떼어 낸 img 는 브라우저가 애니메이션을 진행시키지
 * 않아 언제 그려도 1프레임만 나온다. 그래서 이 패널은 진단 이미지를 숨기지 않고
 * 그대로 보여 준다. 사용자도 같은 것을 눈으로 본다.
 */
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** blob URL 이라도 디코드는 비동기다. 다 실릴 때까지 짧게 기다린다. */
async function waitForImage(img: HTMLImageElement, timeoutMs = 800): Promise<boolean> {
  const step = 40
  for (let waited = 0; waited < timeoutMs; waited += step) {
    if (img.complete && img.naturalWidth > 0) return true
    await wait(step)
  }
  return img.complete && img.naturalWidth > 0
}

async function probeByPixel(img: HTMLImageElement | null): Promise<boolean | null> {
  if (!img) return null
  if (!(await waitForImage(img))) return null

  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  const sample = (): string => {
    ctx.clearRect(0, 0, 1, 1)
    // 좌상단 1px 만 확대해 그린다. 프레임 전체가 단색이라 이걸로 충분하다.
    ctx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return `${d[0]},${d[1]},${d[2]}`
  }

  // 프레임당 100ms 다. 30ms 와 180ms 는 각각 1프레임과 2프레임 한가운데에 놓인다.
  await wait(30)
  const first = sample()
  await wait(150)
  const second = sample()
  return first !== second
}

// ---------------------------------------------------------------------------
// 결과 모델
// ---------------------------------------------------------------------------

type Verdict = 'ok' | 'warn' | 'fail' | 'unknown'

interface ProbeRow {
  id: string
  title: string
  verdict: Verdict
  /** 한 문장 결론 */
  headline: string
  /** 어떻게 쟀는지와 원시 수치. 결론을 의심할 수 있게 남긴다. */
  detail: string
}

const VERDICT_LABEL: Record<Verdict, string> = {
  ok: '됨',
  warn: '주의',
  fail: '안 됨',
  unknown: '확인 불가',
}

function loopSentence(kind: 'gif' | 'apng', written: number, measured: number): ProbeRow {
  const where = kind === 'gif' ? 'GIF NETSCAPE2.0' : 'APNG acTL num_plays'
  const base = {
    id: kind === 'gif' ? 'gif-loop' : 'apng-loop',
    title: kind === 'gif' ? 'GIF 반복 횟수 해석' : 'APNG 반복 횟수 해석',
  }

  if (!Number.isFinite(measured)) {
    return {
      ...base,
      verdict: 'warn',
      headline: `${written}회로 적었는데 이 브라우저는 무한 반복으로 읽습니다.`,
      detail: `${where} 에 ${written} 을 기록했지만 디코더가 돌려준 반복 횟수는 무한입니다. 이 브라우저에서는 "N번 반복" 설정이 지켜지지 않습니다.`,
    }
  }

  // WebCodecs 의 repetitionCount 는 첫 재생을 뺀 반복 횟수다.
  const totalPlays = measured + 1

  if (measured === written) {
    return {
      ...base,
      verdict: 'warn',
      headline: `${written}회로 적으면 이 브라우저는 총 ${totalPlays}번 재생합니다.`,
      detail: `${where} 에 ${written} 을 기록했고 디코더가 돌려준 반복 횟수도 ${measured} 입니다. 즉 파일에 적힌 숫자를 "첫 재생 뒤 추가 반복 횟수" 로 읽습니다. 한 번 더 재생됩니다.`,
    }
  }

  if (measured === written - 1) {
    return {
      ...base,
      verdict: 'ok',
      headline: `${written}회로 적으면 이 브라우저는 정확히 ${totalPlays}번 재생합니다.`,
      detail: `${where} 에 ${written} 을 기록했고 디코더가 돌려준 반복 횟수는 ${measured} 입니다. 즉 파일에 적힌 숫자를 "총 재생 횟수" 로 읽습니다. 설정한 대로 나옵니다.`,
    }
  }

  return {
    ...base,
    verdict: 'unknown',
    headline: `${written}회로 적었을 때 이 브라우저가 읽은 값은 ${measured} 입니다.`,
    detail: `${where} 에 ${written} 을 기록했는데 디코더는 ${measured} 를 돌려줬습니다. 두 해석 중 어느 쪽도 아닙니다. 저장 전에 결과 미리보기로 직접 확인해 주세요.`,
  }
}

function animationRow(
  id: string,
  title: string,
  formatName: string,
  reading: TrackReading | null,
  pixel: boolean | null,
): ProbeRow {
  if (reading) {
    const animated = reading.animated && reading.frameCount > 1
    return {
      id,
      title,
      verdict: animated ? 'ok' : 'fail',
      headline: animated
        ? `${formatName} 애니메이션이 이 브라우저에서 재생됩니다.`
        : `${formatName} 애니메이션이 이 브라우저에서 움직이지 않습니다. 첫 장면만 보입니다.`,
      detail: `2프레임짜리 ${formatName} 을 만들어 디코더에 넣었습니다. 읽어 낸 프레임 수 ${reading.frameCount}, 애니메이션 표시 ${reading.animated ? '있음' : '없음'}.`,
    }
  }

  if (pixel === true) {
    return {
      id,
      title,
      verdict: 'ok',
      headline: `${formatName} 애니메이션이 이 브라우저에서 재생됩니다.`,
      detail: `이 브라우저에는 ImageDecoder 가 없어 화면의 진단 이미지를 두 시각에 떠서 비교했습니다. 색이 바뀌었으므로 실제로 움직입니다.`,
    }
  }
  if (pixel === false) {
    return {
      id,
      title,
      verdict: 'fail',
      headline: `${formatName} 애니메이션이 이 브라우저에서 움직이지 않습니다.`,
      detail: `이 브라우저에는 ImageDecoder 가 없어 화면의 진단 이미지를 두 시각에 떠서 비교했습니다. 150ms 뒤에도 색이 같아 정지 이미지로 취급된 것으로 보입니다.`,
    }
  }

  return {
    id,
    title,
    verdict: 'unknown',
    headline: `${formatName} 애니메이션 지원 여부를 확인하지 못했습니다.`,
    detail: '디코더도 캔버스 측정도 답을 주지 않았습니다. 오른쪽 진단 이미지가 깜빡이는지 직접 봐 주세요.',
  }
}

// ---------------------------------------------------------------------------
// 컴포넌트
// ---------------------------------------------------------------------------

interface ProbeUrls {
  apng: string | null
  gif: string | null
  webp: string | null
}

type RunState = 'idle' | 'running' | 'done' | 'error'

export function BrowserSupport() {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<RunState>('idle')
  const [rows, setRows] = useState<ProbeRow[]>([])
  const [urls, setUrls] = useState<ProbeUrls>({ apng: null, gif: null, webp: null })
  const [errorText, setErrorText] = useState<string | null>(null)

  const apngImgRef = useRef<HTMLImageElement | null>(null)
  const webpImgRef = useRef<HTMLImageElement | null>(null)
  const aliveRef = useRef(true)
  /** 만들어 둔 objectURL. 언마운트와 재실행 때 반드시 해제한다. */
  const urlBagRef = useRef<string[]>([])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      for (const u of urlBagRef.current) URL.revokeObjectURL(u)
      urlBagRef.current = []
    }
  }, [])

  const run = useCallback(async () => {
    setState('running')
    setErrorText(null)
    setRows([])

    /**
     * 이전 실행이 남긴 URL 은 **새 URL 을 화면에 붙인 뒤에** 놓아 준다.
     * 먼저 revoke 하면 그 사이 렌더에서 img 가 죽은 URL 을 가리켜 깨진 이미지가 번쩍인다.
     */
    const stale = urlBagRef.current
    urlBagRef.current = []

    try {
      const frames2 = [FRAME_A, FRAME_B]

      const apngBytes = await encodeApng(
        frames2.map((rgba) => ({ rgba, delayNum: 1, delayDen: 1000 / PROBE_DELAY_MS })),
        { width: PROBE_SIZE, height: PROBE_SIZE, numPlays: PROBE_LOOP_COUNT },
      )
      const gifBytes = await encodeGif(
        frames2.map((rgba) => ({ rgba, delayMs: PROBE_DELAY_MS })),
        {
          width: PROBE_SIZE,
          height: PROBE_SIZE,
          // encodeGif 는 '재생 횟수' 를 받고 NETSCAPE 값은 그보다 1 작다.
          // 이 진단은 "파일에 PROBE_LOOP_COUNT 를 적었을 때" 를 재는 것이므로 1 을 더한다.
          loopCount: PROBE_LOOP_COUNT + 1,
          maxColors: 64,
          transparent: false,
          dither: 0,
        },
      )

      const webpUsable = isWebpSupported()
      const webpBytes = webpUsable
        ? await encodeWebp(
            frames2.map((rgba) => ({ rgba, durationMs: PROBE_DELAY_MS })),
            {
              width: PROBE_SIZE,
              height: PROBE_SIZE,
              loopCount: PROBE_LOOP_COUNT,
              // encodeWebp 의 quality 는 0~1 이다. 진단 파일은 색 비교가 목적이라 무손실로 뽑는다.
              quality: 1,
              lossless: true,
            },
          )
        : null

      if (!aliveRef.current) {
        for (const u of stale) URL.revokeObjectURL(u)
        return
      }

      const makeUrl = (bytes: Uint8Array, mime: string): string => {
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }))
        urlBagRef.current.push(url)
        return url
      }

      setUrls({
        apng: makeUrl(apngBytes, 'image/png'),
        gif: makeUrl(gifBytes, 'image/gif'),
        webp: webpBytes ? makeUrl(webpBytes, 'image/webp') : null,
      })
      for (const u of stale) URL.revokeObjectURL(u)

      const apngRead = await readTrack(apngBytes, 'image/png')
      const gifRead = await readTrack(gifBytes, 'image/gif')
      const webpRead = webpBytes ? await readTrack(webpBytes, 'image/webp') : null

      // 디코더가 없으면 화면에 붙은 img 로 잰다. img 가 그려질 틈을 한 번 준다.
      let apngPixel: boolean | null = null
      let webpPixel: boolean | null = null
      if (!getImageDecoder()) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve())
        })
        apngPixel = await probeByPixel(apngImgRef.current)
        webpPixel = webpBytes ? await probeByPixel(webpImgRef.current) : null
      }

      if (!aliveRef.current) return

      const next: ProbeRow[] = [
        animationRow('apng-anim', 'APNG 재생', 'APNG (움직이는 PNG)', apngRead, apngPixel),
        webpUsable
          ? animationRow('webp-anim', 'WebP 재생', 'WebP', webpRead, webpPixel)
          : {
              id: 'webp-anim',
              title: 'WebP 재생',
              verdict: 'fail' as Verdict,
              headline: '이 브라우저에서는 WebP 로 내보낼 수 없습니다.',
              detail:
                'WebP 인코더를 이 환경에서 초기화하지 못했습니다. 웹사이트용으로는 GIF 를 대신 쓰세요.',
            },
        gifRead
          ? loopSentence('gif', PROBE_LOOP_COUNT, gifRead.repetitionCount)
          : {
              id: 'gif-loop',
              title: 'GIF 반복 횟수 해석',
              verdict: 'unknown' as Verdict,
              headline: 'GIF 반복 횟수 해석을 확인하지 못했습니다.',
              detail:
                '이 브라우저에는 ImageDecoder 가 없어 반복 횟수를 읽을 방법이 없습니다. 재생 횟수는 눈으로 세는 수밖에 없습니다.',
            },
        apngRead
          ? loopSentence('apng', PROBE_LOOP_COUNT, apngRead.repetitionCount)
          : {
              id: 'apng-loop',
              title: 'APNG 반복 횟수 해석',
              verdict: 'unknown' as Verdict,
              headline: 'APNG 반복 횟수 해석을 확인하지 못했습니다.',
              detail:
                '이 브라우저에는 ImageDecoder 가 없어 num_plays 를 읽을 방법이 없습니다. Safari 가 여기에 해당합니다.',
            },
      ]

      setRows(next)
      setState('done')
    } catch (err) {
      // 이미 해제한 URL 을 다시 해제해도 아무 일도 없다. 새는 것보다 낫다.
      for (const u of stale) URL.revokeObjectURL(u)
      if (!aliveRef.current) return
      setErrorText(err instanceof Error ? err.message : '진단에 실패했습니다.')
      setState('error')
    }
  }, [])

  // 펼칠 때 한 번만 돈다. 다이얼로그를 열 때마다 인코딩을 세 번 돌릴 이유가 없다.
  useEffect(() => {
    if (!open || state !== 'idle') return
    void run()
  }, [open, state, run])

  return (
    <details
      className="mm-support"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="mm-support-summary">
        내 브라우저는 무엇을 재생하나요?
        <span className="mm-support-sub">
          {state === 'running'
            ? '재는 중'
            : state === 'done'
              ? '측정 완료'
              : '펼치면 이 자리에서 직접 측정합니다'}
        </span>
      </summary>

      <div className="mm-support-body">
        <p className="mm-note">
          아래 결과는 다른 곳에서 받아 온 표가 아닙니다. 지금 이 브라우저에서 8픽셀짜리 진단
          파일 세 개를 만들어 직접 재생시켜 본 결과입니다.
        </p>

        <div className="mm-support-samples">
          <figure className="mm-support-sample">
            {urls.apng ? (
              <img ref={apngImgRef} src={urls.apng} width={40} height={40} alt="APNG 진단 이미지" />
            ) : (
              <span className="mm-support-blank" />
            )}
            <figcaption>APNG</figcaption>
          </figure>
          <figure className="mm-support-sample">
            {urls.gif ? (
              <img src={urls.gif} width={40} height={40} alt="GIF 진단 이미지" />
            ) : (
              <span className="mm-support-blank" />
            )}
            <figcaption>GIF</figcaption>
          </figure>
          <figure className="mm-support-sample">
            {urls.webp ? (
              <img ref={webpImgRef} src={urls.webp} width={40} height={40} alt="WebP 진단 이미지" />
            ) : (
              <span className="mm-support-blank" />
            )}
            <figcaption>WebP</figcaption>
          </figure>
          <p className="mm-support-legend">
            빨강과 파랑을 오가면 움직이는 것입니다. 한 색으로 멈춰 있으면 이 브라우저가 그 포맷을
            정지 이미지로 취급한 것입니다.
          </p>
        </div>

        {state === 'running' ? <p className="mm-note">진단 파일을 만들고 재생해 보는 중입니다.</p> : null}
        {errorText ? (
          <p className="mm-error" role="alert">
            {errorText}
          </p>
        ) : null}

        <ul className="mm-support-list">
          {rows.map((row) => (
            <li key={row.id} className="mm-support-item" data-verdict={row.verdict}>
              <p className="mm-support-head">
                <span className="mm-support-badge">{VERDICT_LABEL[row.verdict]}</span>
                <span className="mm-support-title">{row.title}</span>
              </p>
              <p className="mm-support-headline">{row.headline}</p>
              <p className="mm-support-detail">{row.detail}</p>
            </li>
          ))}
        </ul>

        {state === 'done' ? (
          <button
            type="button"
            className="mm-btn"
            onClick={() => {
              setState('idle')
            }}
          >
            다시 재기
          </button>
        ) : null}
      </div>
    </details>
  )
}

export default BrowserSupport
