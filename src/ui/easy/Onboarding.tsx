/**
 * 온보딩 STEP 0.
 *
 * 랜딩이 곧 에디터다. 이미지가 없을 때 EASY 화면 전체를 이 안내가 차지한다.
 *
 * 여기서 지켜야 하는 것은 클릭 수다. 파일 선택 OS 다이얼로그는 클릭 계산에서
 * 빠지지 않으므로 드래그앤드롭과 Ctrl+V 를 1급 경로로 올리고, 샘플 3종을 실질적인
 * 0클릭 진입로로 둔다.
 *
 * 샘플은 외부 파일을 받을 수 없으므로 캔버스에 직접 그려서 ImageBitmap 을 만든다.
 * 세 개 모두 투명 배경이고 가장자리에 반투명 픽셀이 있다. 그래야 첫 화면에서 이 제품이
 * 무엇을 잘하는지(알파를 그대로 살린 스티커) 바로 보인다. 불투명한 사각 그림을 샘플로
 * 주면 GIF 로도 되는 결과만 보게 된다.
 *
 * 드롭과 Ctrl+V 는 여기서 다루지 않는다. 앱 루트가 useImageDrop 으로 이미 전역에서
 * 받고 있고(App.tsx), 여기서 훅을 한 번 더 걸면 붙여넣기 한 번에 이미지가 두 장
 * 들어온다. 이 컴포넌트는 그 경로가 있다는 사실을 안내만 한다.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { importImageFile, toErrorMessage } from '@/imageprep/index.ts'
import { useDocumentStore } from '@/state/document.ts'
import { applyShapeScene } from '@/state/shapeActions.ts'
import { useShapeUiStore } from '@/state/shapeUi.ts'
import { useUiStore } from '@/state/ui.ts'

import './easy.css'

/**
 * 이미지 없이 시작하는 도형 세트.
 *
 * 전부 늘어놓지 않는다. 첫 화면에서 필요한 것은 "고르는 일" 이 아니라
 * "무엇이든 하나 움직이는 것을 보는 일" 이다. 성격이 뚜렷하게 다른 셋만 둔다.
 */
const SHAPE_STARTERS: readonly { sceneId: string; label: string }[] = [
  { sceneId: 'pulse.ripple', label: '물결 파동' },
  { sceneId: 'bars.equalizer', label: '음악 막대' },
  { sceneId: 'accent.pop', label: '쫀득 팝' },
]

// ---------------------------------------------------------------------------
// 샘플 그리기
// ---------------------------------------------------------------------------

/** 샘플 원본 크기. 캔버스 상한(CANVAS_MAX) 아래이고 512 내보내기에서 축소가 없다. */
const SAMPLE_PX = 512

/**
 * 비트맵 생성 옵션은 imageprep/decode.ts 의 고정 옵션과 같아야 한다.
 * premultiplyAlpha 를 'none' 으로 두지 않으면 셰이더가 rgb * a 를 한 번 더 곱해
 * 반투명 가장자리가 어두워진다. 샘플만 다른 규칙을 쓰면 그 사실을 아무도 모른다.
 */
const SAMPLE_BITMAP_OPTIONS: ImageBitmapOptions = {
  colorSpaceConversion: 'none',
  premultiplyAlpha: 'none',
}

const SAMPLE_FONT =
  'bold 176px Pretendard, "Pretendard Variable", system-ui, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif'

type Pt = [number, number]

/**
 * 꼭짓점이 둥근 다각형.
 * 같은 색으로 lineJoin: round 스트로크를 두르고 채우면 반지름만큼 둥근 모서리가 된다.
 * arcTo 를 꼭짓점마다 계산하는 것보다 짧고, 결과가 캐릭터에 어울린다.
 */
function fillRoundedPolygon(
  ctx: CanvasRenderingContext2D,
  points: readonly Pt[],
  radius: number,
  fill: string | CanvasGradient,
): void {
  ctx.beginPath()
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p[0], p[1])
    else ctx.lineTo(p[0], p[1])
  })
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.strokeStyle = fill
  ctx.lineJoin = 'round'
  ctx.lineWidth = radius * 2
  ctx.stroke()
  ctx.fill()
}

/** ctx.roundRect 는 브라우저 지원 폭이 좁다. arcTo 로 직접 그린다. */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 둥근 캐릭터 얼굴. 귀 끝과 수염이 알파 가장자리를 만든다. */
function drawCat(ctx: CanvasRenderingContext2D): void {
  const cx = 256
  const cy = 292
  const r = 146

  const fur = ctx.createLinearGradient(0, cy - r - 60, 0, cy + r)
  fur.addColorStop(0, '#ffdda8')
  fur.addColorStop(1, '#f39a52')

  ctx.save()
  ctx.shadowColor = 'rgba(22, 20, 40, 0.34)'
  ctx.shadowBlur = 30
  ctx.shadowOffsetY = 12

  // 귀를 먼저 그린다. 머리가 나중에 덮어야 이음새가 안 보인다.
  for (const s of [-1, 1]) {
    fillRoundedPolygon(
      ctx,
      [
        [cx + s * 66, cy - 172],
        [cx + s * 152, cy - 112],
        [cx + s * 102, cy - 28],
      ],
      14,
      fur,
    )
  }

  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = fur
  ctx.fill()
  ctx.restore()

  // 귀 안쪽
  for (const s of [-1, 1]) {
    fillRoundedPolygon(
      ctx,
      [
        [cx + s * 84, cy - 150],
        [cx + s * 128, cy - 112],
        [cx + s * 98, cy - 62],
      ],
      8,
      'rgba(255, 150, 172, 0.92)',
    )
  }

  // 볼. 가운데만 불투명하고 바깥으로 갈수록 알파가 0 이 된다.
  for (const s of [-1, 1]) {
    const blush = ctx.createRadialGradient(cx + s * 96, cy + 36, 0, cx + s * 96, cy + 36, 38)
    blush.addColorStop(0, 'rgba(255, 118, 140, 0.5)')
    blush.addColorStop(1, 'rgba(255, 118, 140, 0)')
    ctx.fillStyle = blush
    ctx.beginPath()
    ctx.arc(cx + s * 96, cy + 36, 38, 0, Math.PI * 2)
    ctx.fill()
  }

  // 눈
  const eyeY = cy - 8
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.ellipse(cx + s * 54, eyeY, 20, 27, 0, 0, Math.PI * 2)
    ctx.fillStyle = '#2b2e44'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx + s * 54 - 7, eyeY - 10, 7.5, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.94)'
    ctx.fill()
  }

  // 코
  fillRoundedPolygon(
    ctx,
    [
      [cx - 15, cy + 40],
      [cx + 15, cy + 40],
      [cx, cy + 58],
    ],
    6,
    '#ff7d95',
  )

  // 입. 코 끝에서 만나는 반원 두 개가 'ω' 를 만든다.
  ctx.strokeStyle = '#2b2e44'
  ctx.lineWidth = 6
  ctx.lineCap = 'round'
  for (const s of [-1, 1]) {
    ctx.beginPath()
    ctx.arc(cx + s * 20, cy + 58, 20, 0, Math.PI)
    ctx.stroke()
  }

  // 수염. 얇고 반투명해서 가장자리 알파가 잘 드러난다.
  ctx.strokeStyle = 'rgba(43, 46, 68, 0.5)'
  ctx.lineWidth = 5
  for (const s of [-1, 1]) {
    for (const dy of [-22, 4, 30]) {
      ctx.beginPath()
      ctx.moveTo(cx + s * 92, cy + 26 + dy * 0.5)
      ctx.quadraticCurveTo(cx + s * 150, cy + 16 + dy, cx + s * 196, cy + 6 + dy * 1.4)
      ctx.stroke()
    }
  }
}

/** 로고 마크. 바깥 광륜이 완전 투명으로 끝난다. */
function drawLogo(ctx: CanvasRenderingContext2D): void {
  const halo = ctx.createRadialGradient(256, 256, 128, 256, 256, 246)
  halo.addColorStop(0, 'rgba(86, 132, 255, 0.34)')
  halo.addColorStop(1, 'rgba(86, 132, 255, 0)')
  ctx.fillStyle = halo
  ctx.fillRect(0, 0, SAMPLE_PX, SAMPLE_PX)

  const face = ctx.createLinearGradient(128, 128, 384, 384)
  face.addColorStop(0, '#84b4ff')
  face.addColorStop(1, '#2f4ae8')

  ctx.save()
  ctx.shadowColor = 'rgba(18, 30, 78, 0.45)'
  ctx.shadowBlur = 34
  ctx.shadowOffsetY = 14
  roundRectPath(ctx, 128, 128, 256, 256, 76)
  ctx.fillStyle = face
  ctx.fill()
  ctx.restore()

  // 안쪽 하이라이트. 위에서 아래로 알파가 사라진다.
  const gloss = ctx.createLinearGradient(0, 128, 0, 300)
  gloss.addColorStop(0, 'rgba(255, 255, 255, 0.28)')
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)')
  roundRectPath(ctx, 128, 128, 256, 256, 76)
  ctx.fillStyle = gloss
  ctx.fill()

  ctx.beginPath()
  ctx.moveTo(188, 340)
  ctx.lineTo(188, 186)
  ctx.lineTo(256, 264)
  ctx.lineTo(324, 186)
  ctx.lineTo(324, 340)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)'
  ctx.lineWidth = 26
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke()
}

/** 한글 글자. 획 끝의 안티에일리어싱이 그대로 알파로 남는다. */
function drawText(ctx: CanvasRenderingContext2D): void {
  const ink = ctx.createLinearGradient(0, 150, 0, 380)
  ink.addColorStop(0, '#ffe6a6')
  ink.addColorStop(1, '#ff7a59')

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = SAMPLE_FONT

  ctx.save()
  ctx.shadowColor = 'rgba(18, 20, 40, 0.42)'
  ctx.shadowBlur = 26
  ctx.shadowOffsetY = 12
  ctx.lineJoin = 'round'
  ctx.lineWidth = 24
  ctx.strokeStyle = 'rgba(28, 30, 48, 0.94)'
  ctx.strokeText('안녕', 256, 262)
  ctx.restore()

  ctx.fillStyle = ink
  ctx.fillText('안녕', 256, 262)
}

interface SampleDef {
  id: 'cat' | 'logo' | 'text'
  /** 버튼에 보이는 이름 */
  label: string
  /** 레이어와 파일명에 쓰는 이름 */
  assetName: string
  hint: string
  draw(ctx: CanvasRenderingContext2D): void
}

const SAMPLES: readonly SampleDef[] = [
  { id: 'cat', label: '고양이', assetName: '샘플_고양이', hint: '투명 배경 캐릭터', draw: drawCat },
  { id: 'logo', label: '로고', assetName: '샘플_로고', hint: '광륜이 있는 마크', draw: drawLogo },
  { id: 'text', label: '글자', assetName: '샘플_글자', hint: '한글 글자', draw: drawText },
]

/** 그림 그리기 전에 폰트를 기다린다. 실패해도 대체 폰트로 계속 그린다. */
async function waitForFonts(): Promise<void> {
  try {
    await document.fonts.ready
  } catch {
    // 폰트 로딩 상태를 알 수 없는 브라우저. 시스템 폰트로 그린다.
  }
}

async function createSampleBitmap(def: SampleDef): Promise<ImageBitmap> {
  const canvas = document.createElement('canvas')
  canvas.width = SAMPLE_PX
  canvas.height = SAMPLE_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('이 브라우저에서는 샘플 그림을 만들 수 없습니다.')

  if (def.id === 'text') await waitForFonts()
  def.draw(ctx)

  return createImageBitmap(canvas, SAMPLE_BITMAP_OPTIONS)
}

// ---------------------------------------------------------------------------
// 아이콘
// ---------------------------------------------------------------------------

function IconLock() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function IconImage() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6.5" r="1.2" fill="currentColor" />
      <path d="M3 11l3-3 2.5 2.5L11 8l2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// 샘플 버튼
// ---------------------------------------------------------------------------

interface SampleButtonProps {
  def: SampleDef
  disabled: boolean
  onPick(def: SampleDef): void
}

/** 썸네일은 같은 그리기 함수를 축소해서 쓴다. 버튼 그림과 실제 결과가 다르면 안 된다. */
function SampleButton({ def, disabled, onPick }: SampleButtonProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = 72
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.scale(size / SAMPLE_PX, size / SAMPLE_PX)
    def.draw(ctx)
    ctx.restore()
  }, [def])

  return (
    <button
      type="button"
      className="mm-onb-sample"
      disabled={disabled}
      onClick={() => onPick(def)}
      title={def.hint}
    >
      <canvas ref={canvasRef} className="mm-onb-thumb mm-checker" aria-hidden="true" />
      <span>{def.label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// 온보딩
// ---------------------------------------------------------------------------

export function Onboarding() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /** 이미지가 들어오면 곧바로 재생 상태로 둔다. STEP 1 은 이미 움직이는 화면이다. */
  const commit = useCallback((name: string, bitmap: ImageBitmap, hasAlpha: boolean) => {
    const { layerId } = useDocumentStore.getState().addImage({ name, bitmap, hasAlpha })
    useUiStore.getState().selectLayer(layerId)
    useUiStore.getState().setPlaying(true)
  }, [])

  const pickSample = useCallback(
    (def: SampleDef) => {
      setBusy(true)
      setError(null)
      createSampleBitmap(def)
        .then((bitmap) => {
          commit(def.assetName, bitmap, true)
        })
        .catch((err: unknown) => {
          if (!aliveRef.current) return
          setError(toErrorMessage(err))
        })
        .finally(() => {
          // 성공하면 이 컴포넌트는 이미 사라진 뒤다. 살아 있을 때만 상태를 만진다.
          if (aliveRef.current) setBusy(false)
        })
    },
    [commit],
  )

  const pickFile = useCallback(
    (file: File) => {
      setBusy(true)
      setError(null)
      importImageFile(file)
        .then((imported) => {
          commit(imported.name, imported.bitmap, imported.hasAlpha)
        })
        .catch((err: unknown) => {
          if (!aliveRef.current) return
          setError(`${file.name || '이미지'}: ${toErrorMessage(err)}`)
        })
        .finally(() => {
          if (aliveRef.current) setBusy(false)
        })
    },
    [commit],
  )

  return (
    <div className="mm-onb">
      <div className="mm-onb-card">
        <p className="mm-onb-title">이미지를 여기에 놓으세요</p>
        <p className="mm-onb-or">또는</p>

        <button
          type="button"
          className="mm-btn mm-btn-primary mm-onb-pick"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          <IconImage />
          이미지 고르기
        </button>

        {/* 파일 입력은 화면에서 감추되 접근성 트리에서도 제외한다. 버튼이 대신 연다. */}
        <input
          ref={inputRef}
          type="file"
          className="mm-visually-hidden"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            // 같은 파일을 다시 골라도 change 가 오도록 값을 비운다.
            e.target.value = ''
            if (file) pickFile(file)
          }}
        />

        <p className="mm-onb-formats">
          PNG, JPG, WebP, GIF <span aria-hidden="true">/</span>{' '}
          <span className="mm-onb-kbd">Ctrl</span> <span className="mm-onb-kbd">V</span> 로
          붙여넣어도 됩니다
        </p>
      </div>

      <div className="mm-onb-samples">
        <p className="mm-onb-formats">바로 해보기</p>
        <div className="mm-onb-samples-row">
          {SAMPLES.map((def) => (
            <SampleButton key={def.id} def={def} disabled={busy} onPick={pickSample} />
          ))}
        </div>
        <p className="mm-easy-note">
          샘플도 투명 배경입니다. 파일을 고르지 않아도 바로 만들어 볼 수 있어요.
        </p>
      </div>

      {/*
        이미지 없이 시작하는 길.
        도형 레이어는 에셋이 없어도 되는 유일한 레이어라, 이 버튼 하나가 "이미지가
        있어야 시작할 수 있다" 는 전제를 없앤다. 넣고 나면 나머지 화면은 완전히 같다.
      */}
      <div className="mm-onb-samples">
        <p className="mm-onb-formats">이미지 없이 도형으로 시작</p>
        <div className="mm-onb-samples-row">
          {SHAPE_STARTERS.map((starter) => (
            <button
              key={starter.sceneId}
              type="button"
              className="mm-btn"
              disabled={busy}
              onClick={() => {
                applyShapeScene(starter.sceneId)
                useShapeUiStore.getState().setTab('shape')
                // 이미지 경로와 같다. 넣자마자 움직이는 것을 보여 준다.
                useUiStore.getState().setPlaying(true)
              }}
            >
              {starter.label}
            </button>
          ))}
        </div>
        <p className="mm-easy-note">
          도형만으로도 바로 내보낼 수 있습니다. 왼쪽 <strong>도형</strong> 탭에 24가지가
          더 있습니다.
        </p>
      </div>

      <p className="mm-onb-privacy">
        <IconLock />
        이미지는 기기 밖으로 나가지 않습니다. 모든 처리가 이 브라우저 안에서 끝납니다.
      </p>

      {error ? (
        <p className="mm-error" role="alert">
          {error}
        </p>
      ) : null}

      <p className="mm-visually-hidden" role="status">
        {busy ? '이미지를 준비하는 중입니다' : ''}
      </p>
    </div>
  )
}

export default Onboarding
