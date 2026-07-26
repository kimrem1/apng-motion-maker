/** #rgb / #rrggbb / #rrggbbaa 를 [0,1] RGBA 로 (straight alpha). */
export function parseHexColor(hex: string): [number, number, number, number] {
  const s = hex.trim().replace(/^#/, '')
  const n = (h: string): number => parseInt(h, 16) / 255

  if (s.length === 3 || s.length === 4) {
    const r = n(s[0]! + s[0]!)
    const g = n(s[1]! + s[1]!)
    const b = n(s[2]! + s[2]!)
    const a = s.length === 4 ? n(s[3]! + s[3]!) : 1
    return [r, g, b, a]
  }
  if (s.length === 6 || s.length === 8) {
    const r = n(s.slice(0, 2))
    const g = n(s.slice(2, 4))
    const b = n(s.slice(4, 6))
    const a = s.length === 8 ? n(s.slice(6, 8)) : 1
    return [r, g, b, a]
  }
  return [0, 0, 0, 0]
}

/** 내부 파이프라인은 premultiplied 다 (gl.ts 참조). */
export function premultiply(
  c: readonly [number, number, number, number],
): [number, number, number, number] {
  return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
}
