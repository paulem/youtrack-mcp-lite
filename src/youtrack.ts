/**
 * Minimal read-only YouTrack REST client.
 *
 * Every request pins an explicit `fields=` selector. YouTrack returns only what is
 * asked for, so the selectors below are the main lever on how much context a tool
 * result costs — widening one is never free.
 */

export interface YouTrackUser {
  login: string
  fullName?: string
  email?: string
}

export interface CustomField {
  name: string
  value: unknown
}

export interface Issue {
  idReadable: string
  summary: string
  description?: string | null
  created?: number
  updated?: number
  resolved?: number | null
  project?: { shortName?: string }
  reporter?: YouTrackUser | null
  customFields?: CustomField[]
}

export interface Comment {
  id: string
  text?: string | null
  created?: number
  author?: YouTrackUser | null
}

export interface IssueLink {
  direction: string
  linkType?: { name?: string; sourceToTarget?: string; targetToSource?: string }
  issues?: { idReadable: string; summary?: string }[]
}

export interface Attachment {
  id: string
  name: string
  size: number
  mimeType?: string
  url: string
}

export interface Project {
  shortName: string
  name: string
}

const CF_VALUE = 'name,login,fullName,text,presentation,minutes'

export const ISSUE_LIST_FIELDS = `idReadable,summary,project(shortName),customFields(name,value(${CF_VALUE}))`
export const ISSUE_FIELDS = `idReadable,summary,description,created,updated,resolved,project(shortName),reporter(login,fullName),customFields(name,value(${CF_VALUE}))`
export const COMMENT_FIELDS = 'id,text,created,author(login,fullName)'
export const LINK_FIELDS = 'direction,linkType(name,sourceToTarget,targetToSource),issues(idReadable,summary)'
export const ATTACHMENT_FIELDS = 'id,name,size,mimeType,url'
export const PROJECT_FIELDS = 'shortName,name'

interface Config {
  /** Origin plus context path, no trailing slash. */
  baseUrl: string
  origin: string
  /** `''` at the domain root, `/youtrack` on a context-path install. */
  basePath: string
  token: string
}

let cached: Config | null = null

function config(): Config {
  if (cached) return cached

  const raw = process.env.YOUTRACK_URL?.trim()
  const token = process.env.YOUTRACK_API_TOKEN
  if (!raw) throw new Error('YOUTRACK_URL is not set')
  if (!token) throw new Error('YOUTRACK_API_TOKEN is not set')

  // A bare hostname is what people paste out of a browser bar; assume TLS rather than
  // failing on it
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    throw new Error(`YOUTRACK_URL is not a valid URL: ${raw}`)
  }

  // A self-hosted instance may sit at a subdomain root or under a context path of any
  // depth (https://example.com/youtrack) — the deployment's choice, not YouTrack's
  const basePath = parsed.pathname.replace(/\/+$/, '')

  cached = { baseUrl: `${parsed.origin}${basePath}`, origin: parsed.origin, basePath, token }
  return cached
}

/**
 * Resolves an API path against the configured instance.
 *
 * Attachment URLs are handed back by YouTrack rather than built here, and whether one
 * already carries the instance's context path is not something the payload guarantees.
 * A path that does is resolved against the origin, so the prefix is not doubled.
 */
function resolveUrl(path: string): URL {
  const { baseUrl, origin, basePath } = config()

  if (/^https?:\/\//i.test(path)) return new URL(path)
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) return new URL(`${origin}${path}`)

  return new URL(`${baseUrl}${path}`)
}

/** Raised for non-2xx responses so tool handlers can report a clean message. */
export class YouTrackError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'YouTrackError'
    this.status = status
  }
}

async function request(path: string, params: Record<string, string | number | undefined>): Promise<Response> {
  const { origin, token } = config()
  const url = resolveUrl(path)

  // Attachment URLs come from YouTrack's own payload, so an absolute one pointing
  // elsewhere would carry the bearer token off-instance
  if (url.origin !== origin) {
    throw new Error(`Refusing to send credentials to ${url.origin}`)
  }

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })

  if (!res.ok) {
    // YouTrack puts a human-readable reason in the body; keep it short for context
    const body = await res.text().catch(() => '')
    throw new YouTrackError(res.status, `HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`)
  }

  return res
}

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const res = await request(path, params)
  return (await res.json()) as T
}

export async function searchIssues(query: string, limit: number): Promise<Issue[]> {
  return get<Issue[]>('/api/issues', { query, $top: limit, fields: ISSUE_LIST_FIELDS })
}

export async function getIssue(id: string): Promise<Issue> {
  return get<Issue>(`/api/issues/${encodeURIComponent(id)}`, { fields: ISSUE_FIELDS })
}

export async function getComments(id: string, limit: number): Promise<Comment[]> {
  return get<Comment[]>(`/api/issues/${encodeURIComponent(id)}/comments`, { $top: limit, fields: COMMENT_FIELDS })
}

export async function getLinks(id: string): Promise<IssueLink[]> {
  return get<IssueLink[]>(`/api/issues/${encodeURIComponent(id)}/links`, { fields: LINK_FIELDS })
}

export async function getAttachments(id: string): Promise<Attachment[]> {
  return get<Attachment[]>(`/api/issues/${encodeURIComponent(id)}/attachments`, { fields: ATTACHMENT_FIELDS })
}

/** Downloads raw attachment bytes. `url` is the pre-signed relative path YouTrack returns. */
export async function downloadAttachment(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await request(url, {})
  const bytes = Buffer.from(await res.arrayBuffer())
  return { bytes, contentType: res.headers.get('content-type') ?? 'application/octet-stream' }
}

export async function getCurrentUser(): Promise<YouTrackUser> {
  return get<YouTrackUser>('/api/users/me', { fields: 'login,fullName,email' })
}

export async function listProjects(limit: number): Promise<Project[]> {
  return get<Project[]>('/api/admin/projects', { $top: limit, fields: PROJECT_FIELDS })
}
