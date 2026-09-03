/**
 * 접근 게이트의 비밀번호 파생 함수.
 *
 * 단발 SHA-256 은 GPU 로 초당 수십억 번을 돌릴 수 있어서, 번들에 실린 해시만
 * 뽑아 가면 짧은 비밀번호는 금방 맞춰진다. PBKDF2 로 60만 번 반복하면 한 번
 * 추측하는 데 걸리는 비용이 그만큼 곱해져 같은 공격이 수십만 배 느려진다.
 * 사용자 입장에서는 로그인 한 번에 1초 안쪽이라 체감이 거의 없다.
 *
 * 브라우저(crypto.subtle)와 Node(crypto.pbkdf2Sync)가 같은 값을 내야 하므로
 * 매개변수를 여기 한 곳에만 둔다. 테스트가 둘의 일치를 확인한다.
 */

export const GATE_SALT = 'mm-gate:v2'
export const GATE_ITERATIONS = 600_000
const KEY_BITS = 256

export async function deriveGateHash(password: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(GATE_SALT), iterations: GATE_ITERATIONS },
    key,
    KEY_BITS,
  )
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
