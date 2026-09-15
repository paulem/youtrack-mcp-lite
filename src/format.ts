/**
 * Renders YouTrack payloads as compact text.
 *
 * Tool results are read by a model, not parsed by code, so plain lines beat JSON:
 * no braces, quotes, or `$type` noise, and empty fields are dropped entirely.
 */

import type { Attachment, Comment, Issue, IssueLink, Project, YouTrackUser } from './youtrack.ts'

/** Custom-field values arrive as scalars, objects, or arrays depending on field type. */
function customFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null

  if (Array.isArray(value)) {
    const parts = value.map(customFieldValue).filter((v): v is string => v !== null)
    return parts.length > 0 ? parts.join(', ') : null
  }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    // `minutes` covers period fields (estimation, spent time)
    const scalar = v.name ?? v.fullName ?? v.login ?? v.text ?? v.presentation ?? v.minutes
    return scalar === undefined || scalar === null ? null : String(scalar)
  }

  return String(value)
}

function formatDate(epochMillis?: number | null): string | null {
  if (!epochMillis) return null
  return new Date(epochMillis).toISOString().slice(0, 16).replace('T', ' ')
}

function userName(user?: YouTrackUser | null): string {
  if (!user) return 'unknown'
  return user.fullName ? `${user.fullName} (${user.login})` : user.login
}

/** One line per issue, with the fields that make a result list scannable. */
export function renderIssueList(issues: Issue[]): string {
  if (issues.length === 0) return 'No issues matched.'

  return issues
    .map((issue) => {
      const fields = new Map<string, string>()
      for (const cf of issue.customFields ?? []) {
        const value = customFieldValue(cf.value)
        if (value) fields.set(cf.name, value)
      }

      const badges = ['State', 'Priority', 'Type', 'Assignee']
        .map((name) => fields.get(name))
        .filter((v): v is string => v !== undefined)

      const suffix = badges.length > 0 ? `  [${badges.join(' · ')}]` : ''
      return `${issue.idReadable}  ${issue.summary}${suffix}`
    })
    .join('\n')
}

export function renderIssue(issue: Issue): string {
  const lines: string[] = [`# ${issue.idReadable}  ${issue.summary}`, '']

  const meta: string[] = []
  if (issue.project?.shortName) meta.push(`Project: ${issue.project.shortName}`)
  if (issue.reporter) meta.push(`Reporter: ${userName(issue.reporter)}`)

  const created = formatDate(issue.created)
  const updated = formatDate(issue.updated)
  const resolved = formatDate(issue.resolved)
  if (created) meta.push(`Created: ${created}`)
  if (updated) meta.push(`Updated: ${updated}`)
  if (resolved) meta.push(`Resolved: ${resolved}`)
  lines.push(...meta)

  const fields = (issue.customFields ?? [])
    .map((cf) => {
      const value = customFieldValue(cf.value)
      return value ? `${cf.name}: ${value}` : null
    })
    .filter((line): line is string => line !== null)

  if (fields.length > 0) lines.push('', ...fields)

  if (issue.description?.trim()) {
    lines.push('', '## Description', issue.description.trim())
  }

  return lines.join('\n')
}

export function renderComments(comments: Comment[]): string {
  if (comments.length === 0) return 'No comments.'

  return comments
    .map((comment) => {
      const when = formatDate(comment.created)
      // The ID is what the edit and delete tools address, so every read carries it
      const head = `— ${userName(comment.author)}${when ? ` · ${when}` : ''} · id ${comment.id}`
      const body = comment.text?.trim() || '(empty)'
      return `${head}\n${body}`
    })
    .join('\n\n')
}

export function renderLinks(links: IssueLink[]): string {
  const populated = links.filter((link) => (link.issues?.length ?? 0) > 0)
  if (populated.length === 0) return 'No linked issues.'

  return populated
    .map((link) => {
      // YouTrack names each side of a link separately; pick the one matching direction
      const type =
        link.direction === 'INWARD'
          ? (link.linkType?.targetToSource ?? link.linkType?.name)
          : (link.linkType?.sourceToTarget ?? link.linkType?.name)

      const issues = (link.issues ?? []).map((i) => `  ${i.idReadable}  ${i.summary ?? ''}`.trimEnd()).join('\n')
      return `${type}:\n${issues}`
    })
    .join('\n')
}

/**
 * Clamps a text attachment, keeping both ends.
 *
 * Head-only truncation is wrong for the common case: a log's opening lines are boot
 * banners while the failure sits at the end. Keeping both halves preserves the version
 * and config context *and* whatever actually went wrong.
 */
export function renderTextAttachment(bytes: Buffer, max: number): string {
  if (bytes.length <= max) return bytes.toString('utf8')

  const half = Math.floor(max / 2)
  const head = bytes.subarray(0, half).toString('utf8')
  const tail = bytes.subarray(bytes.length - half).toString('utf8')
  const omitted = Math.round((bytes.length - max) / 1024)

  return `${head}\n\n… [${omitted} KB omitted from the middle — ${Math.round(bytes.length / 1024)} KB total] …\n\n${tail}`
}

export function renderAttachmentList(attachments: Attachment[]): string {
  if (attachments.length === 0) return 'No attachments.'

  return attachments
    .map((a) => `${a.name}  (${a.mimeType ?? 'unknown'}, ${Math.round(a.size / 1024)} KB)`)
    .join('\n')
}

export function renderProjects(projects: Project[]): string {
  if (projects.length === 0) return 'No projects.'
  return projects.map((p) => `${p.shortName}  ${p.name}`).join('\n')
}

export function renderUser(user: YouTrackUser): string {
  const parts = [`Login: ${user.login}`]
  if (user.fullName) parts.push(`Name: ${user.fullName}`)
  if (user.email) parts.push(`Email: ${user.email}`)
  return parts.join('\n')
}
