/**
 *.mmproj 프로젝트 파일 포맷.
 *
 * zip 안에 project.json 하나와 assets/<id>.png 를 담는다.
 * base64 인라인은 1.33배 팽창하므로 쓰지 않는다.
 *
 * 압축 레벨을 항목마다 다르게 준다. PNG 는 이미 DEFLATE 로 압축된 바이트라
 * 다시 압축하면 CPU 만 쓰고 크기는 거의 그대로다(오히려 몇 바이트 늘기도 한다).
 * 그래서 에셋은 STORE(레벨 0), project.json 만 DEFLATE(레벨 9) 다.
 *
 * 이 파일은 DOM 을 참조하지 않는다. 워커와 테스트에서 그대로 쓴다.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'

import type { MotionProject } from '@/core/types.ts'

import { migrateProject } from './migrate.ts'

export const PROJECT_EXT = 'mmproj'

/** zip 이므로 실제 MIME 은 application/zip 이다. 확장자로 종류를 구분한다. */
export const PROJECT_MIME = 'application/zip'

/** zip 안의 문서 엔트리 이름. */
export const DOC_ENTRY = 'project.json'

const ASSET_PREFIX = 'assets/'
const ASSET_SUFFIX = '.png'

/**
 * 고정 타임스탬프.
 *
 * 같은 문서는 언제 저장해도 같은 바이트가 나와야 "바뀐 게 없다"를 파일 비교로 알 수 있다.
 * zip 의 DOS 날짜는 1980년이 하한이라 0(1970) 을 넣으면 fflate 가 던진다.
 */
const FIXED_MTIME = new Date(2000, 0, 1)

export interface ProjectBundle {
  doc: MotionProject
  /** assetId -> PNG 바이트 */
  assets: Map<string, Uint8Array>
}

export interface ReadProjectResult {
  bundle: ProjectBundle
  warnings: string[]
}

/** 파일 자체를 열 수 없을 때만 던진다. 문서 내용 문제는 경고로 낮춘다. */
export class ProjectFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProjectFormatError'
  }
}

/**
 * assetId 를 zip 엔트리 이름으로 바꾼다.
 *
 * id 는 지금 'a1' 같은 안전한 문자열이지만, 언젠가 사용자 입력이나 UUID 가 들어와도
 * 경로 구분자나 비ASCII 문자로 zip 이 깨지지 않도록 인코딩해 둔다. 역변환이 가능해야 하므로
 * 되돌릴 수 없는 치환(sanitize) 이 아니라 encodeURIComponent 를 쓴다.
 */
function assetEntryName(id: string): string {
  return `${ASSET_PREFIX}${encodeURIComponent(id)}${ASSET_SUFFIX}`
}

function assetIdFromEntry(name: string): string | null {
  if (!name.startsWith(ASSET_PREFIX)) return null
  if (!name.endsWith(ASSET_SUFFIX)) return null
  const raw = name.slice(ASSET_PREFIX.length, name.length - ASSET_SUFFIX.length)
  if (raw.length === 0 || raw.includes('/')) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    // 인코딩이 깨진 이름이라도 버리지 않는다. 이름 그대로를 id 로 본다.
    return raw
  }
}

/** 확장자를 보정한다. 사용자가 지운 채 저장하면 다시 열 때 형식을 못 찾는다. */
export function ensureProjectExtension(name: string): string {
  const trimmed = name.trim()
  const base = trimmed.length > 0 ? trimmed : '무제'
  return base.toLowerCase().endsWith(`.${PROJECT_EXT}`) ? base : `${base}.${PROJECT_EXT}`
}

/** zip 서명 확인. 다른 파일을 끌어다 놓았을 때 엉뚱한 오류 대신 이유를 말해 준다. */
export function looksLikeProjectFile(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

export function serializeProject(bundle: ProjectBundle): Uint8Array {
  const files: Zippable = {}

  // 문서는 텍스트라 압축이 잘 든다. 여기만 DEFLATE 를 건다.
  files[DOC_ENTRY] = [strToU8(JSON.stringify(bundle.doc)), { level: 9, mtime: FIXED_MTIME }]

  for (const [id, bytes] of bundle.assets) {
    if (id.length === 0) continue
    // PNG 는 STORE. 재압축은 CPU 만 먹고 크기가 줄지 않는다.
    files[assetEntryName(id)] = [bytes, { level: 0, mtime: FIXED_MTIME }]
  }

  return zipSync(files, { mtime: FIXED_MTIME })
}

/**
 * 열기의 정본 경로. 경고까지 돌려준다.
 *
 * 문서가 손상되어도 던지지 않는다. 손상된 project.json 은 migrate 가 최대한 복구하고,
 * 복구가 불가능해도 에셋은 살아서 돌아온다. 파일을 못 열면 그 작업은 사라지기 때문이다.
 */
export function readProjectBundle(bytes: Uint8Array): ReadProjectResult {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (err) {
    throw new ProjectFormatError(
      looksLikeProjectFile(bytes)
        ? '프로젝트 파일이 손상되어 열 수 없습니다.'
        : `${PROJECT_EXT} 프로젝트 파일이 아닙니다.`,
      { cause: err },
    )
  }

  const warnings: string[] = []
  const docBytes = entries[DOC_ENTRY]
  let raw: unknown = null
  if (docBytes) {
    // 문자열 그대로 넘긴다. JSON 파싱 실패까지 migrate 한 곳에서 복구한다.
    raw = strFromU8(docBytes)
  } else {
    warnings.push('프로젝트 정보(project.json)가 없어 빈 문서로 엽니다.')
  }

  const migrated = migrateProject(raw)
  warnings.push(...migrated.warnings)

  const assets = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(entries)) {
    if (name === DOC_ENTRY) continue
    // 디렉터리 엔트리는 길이 0 이다.
    if (name.endsWith('/')) continue
    const id = assetIdFromEntry(name)
    if (!id) continue
    assets.set(id, data)
  }

  const missing = migrated.doc.assets.filter((a) => !assets.has(a.id))
  if (missing.length > 0) {
    warnings.push(`이미지 ${missing.length}개를 파일에서 찾지 못했습니다. 해당 레이어는 비어 보입니다.`)
  }

  return { bundle: { doc: migrated.doc, assets }, warnings }
}

/**
 * 경고가 필요 없을 때 쓰는 짧은 형태.
 * 사용자에게 열기 결과를 보여줘야 한다면 readProjectBundle 을 써라.
 */
export function deserializeProject(bytes: Uint8Array): ProjectBundle {
  return readProjectBundle(bytes).bundle
}
