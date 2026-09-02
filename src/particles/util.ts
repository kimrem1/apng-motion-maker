/** 엔진 내부 공용 헬퍼. 시간이나 난수를 섞지 않아 같은 입력이면 언제나 같은 값이다. */

export const TAU = Math.PI * 2

export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
export const lerp = (a: number, b: number, f: number): number => a + (b - a) * f
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}
export const num = (v: unknown, d: number): number =>
  typeof v === 'number' && isFinite(v) ? v : d

// 빠른 사인(룩업) — 물그물처럼 픽셀 단위로 수십만 번 호출되는 곳에서만 쓴다
const SINN = 8192
const SINT = new Float32Array(SINN)
for (let i = 0; i < SINN; i++) SINT[i] = Math.sin((i / SINN) * TAU)
export const fsin = (x: number): number => SINT[((x * (SINN / TAU)) | 0) & (SINN - 1)]!

/** '#rrggbb' → [r,g,b] 0..255. 깨진 입력은 0 채널로 눙쳐 그리기를 멈추지 않는다. */
export function hexToRgb(h: string): [number, number, number] {
  const s = (typeof h === 'string' && h ? h : '#ffffff').replace('#', '')
  return [
    parseInt(s.slice(0, 2), 16) || 0,
    parseInt(s.slice(2, 4), 16) || 0,
    parseInt(s.slice(4, 6), 16) || 0,
  ]
}
