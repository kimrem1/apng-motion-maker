/**
 * 지인 전용 비밀번호 게이트.
 *
 * 사이트는 GitHub Pages 정적 호스팅이라 서버가 없다. 그래서 이 잠금은
 * **클라이언트 측**이다. 번들을 읽을 줄 아는 사람은 우회할 수 있으므로 보안
 * 장치가 아니라 "주소를 우연히 알게 된 사람을 돌려보내는 문" 이다. 지인만
 * 쓰게 하려는 목적에는 이 수준이 맞고, 진짜 인증이 필요해지면 호스팅을
 * 옮겨야 한다.
 *
 * 평문 비밀번호는 번들에 싣지 않는다. 소금(SALT)을 붙인 SHA-256 해시만 싣고,
 * 입력값을 같은 방식으로 해시해 비교한다. 통과하면 localStorage 에 해시를
 * 남겨 같은 브라우저에서는 다시 묻지 않는다.
 *
 * 개발 서버(npm run dev)에서는 게이트를 걸지 않는다. 빌드 결과를 서비스하는
 * 로컬 실행기(scripts/launch.ps1)와 배포 사이트에서만 잠긴다.
 *
 * 비밀번호를 바꾸려면 아래 명령으로 새 해시를 만들어 PASS_HASH 를 갈아끼운다.
 *
 *   node -e "const c=require('crypto');console.log(c.createHash('sha256').update('mm-gate:새비밀번호').digest('hex'))"
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

/** 해시 앞에 붙이는 소금. PASS_HASH 를 만들 때도 같은 값을 붙여야 한다. */
const SALT = 'mm-gate:'
/** sha256(SALT + 비밀번호) 의 16진수. 현재 비밀번호는 별도로 전달한다. */
const PASS_HASH = 'cc606558b774959915331860903b5d3a54d39d985c00e19de55a31b30d96c66d'
/** 통과 기록. 값이 PASS_HASH 와 같으면 다시 묻지 않는다. */
const UNLOCK_KEY = 'mm.access.v1'

const GATE_CSS = `
.mm-gate {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100dvh;
  padding: var(--sp-5);
  background: var(--bg);
}

.mm-gate-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  width: min(360px, 100%);
  padding: var(--sp-6);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  background: var(--surface);
}

.mm-gate-title {
  color: var(--text);
  font-size: var(--fs-lg);
  font-weight: 700;
  letter-spacing: 0.04em;
}

.mm-gate-sub {
  color: var(--text-muted);
  font-size: var(--fs-sm);
  line-height: 1.6;
}

.mm-gate-input {
  min-height: 36px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-md);
}

.mm-gate-input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.mm-gate-submit {
  min-height: 36px;
  border: 1px solid var(--accent);
  border-radius: var(--r-md);
  background: var(--accent-soft);
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 700;
  cursor: pointer;
}

.mm-gate-error {
  margin: 0;
  color: var(--danger);
  font-size: var(--fs-xs);
}
`

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function readUnlocked(): boolean {
  try {
    return window.localStorage.getItem(UNLOCK_KEY) === PASS_HASH
  } catch {
    // 프라이빗 모드 등으로 막히면 매번 묻는다.
    return false
  }
}

export function AccessGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean>(() => import.meta.env.DEV || readUnlocked())
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 통과 순간이 아니라 상태로 남긴다. 다른 탭에서 풀었으면 여기서도 풀린다.
  useEffect(() => {
    if (unlocked) return
    const onStorage = (e: StorageEvent): void => {
      if (e.key === UNLOCK_KEY && e.newValue === PASS_HASH) setUnlocked(true)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [unlocked])

  if (unlocked) return <>{children}</>

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      // crypto.subtle 은 https 와 localhost 에서만 있다. 배포(https)와 로컬
      // 실행기(localhost) 모두 해당하므로 없으면 환경이 잘못된 것이다.
      if (!('crypto' in window) || !crypto.subtle) {
        setError('이 브라우저 환경에서는 잠금을 확인할 수 없습니다. https 로 접속하세요.')
        return
      }
      const hash = await sha256Hex(SALT + value)
      if (hash !== PASS_HASH) {
        setError('비밀번호가 맞지 않습니다.')
        return
      }
      try {
        window.localStorage.setItem(UNLOCK_KEY, hash)
      } catch {
        // 저장을 못 해도 이번 세션은 연다.
      }
      setUnlocked(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mm-gate">
      <style href="mm-gate" precedence="default">
        {GATE_CSS}
      </style>
      <form className="mm-gate-card" onSubmit={onSubmit}>
        <span className="mm-gate-title">
          MOTION<span aria-hidden="true"> </span>MAKER
        </span>
        <label className="mm-gate-sub" htmlFor="mm-gate-pass">
          초대받은 분만 쓸 수 있습니다. 비밀번호를 입력하세요.
        </label>
        <input
          id="mm-gate-pass"
          className="mm-gate-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
        />
        {error ? (
          <p className="mm-gate-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="mm-gate-submit" disabled={busy || value.length === 0}>
          들어가기
        </button>
      </form>
    </div>
  )
}

export default AccessGate
