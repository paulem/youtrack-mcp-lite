/**
 * YouTrack MCP server.
 *
 * Seven tools read issues; seven write to them. The write surface is deliberately
 * small: create, comment, edit text, attach a file, and YouTrack's own command
 * language for everything that is a field, a tag, or a link. Nothing deletes an issue.
 */

import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

import packageJson from '../package.json' with { type: 'json' }
import {
  renderAttachmentList,
  renderComments,
  renderIssue,
  renderIssueList,
  renderLinks,
  renderProjects,
  renderTextAttachment,
  renderUser,
} from './format.ts'
import { registerPrompts } from './prompts.ts'
import {
  addComment,
  applyCommand,
  createIssue,
  deleteComment,
  downloadAttachment,
  findProject,
  getAttachments,
  getComments,
  getCurrentUser,
  getIssue,
  getIssueSummary,
  getLinks,
  listProjects,
  searchIssues,
  updateComment,
  updateIssue,
  uploadAttachment,
  YouTrackError,
} from './youtrack.ts'

/** Beyond this, a base64 image costs more context than it is worth. */
const MAX_IMAGE_BYTES = 4_000_000
/**
 * Text attachments are clamped rather than refused. Kept deliberately tight: a 29 KB
 * log already costs ~7k tokens, so this ceiling is roughly 6k — the point of this
 * server is context economy, and one attachment should not undo it.
 */
const MAX_TEXT_BYTES = 24_000

const TEXTUAL_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|sql))/

interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** The host was never reached: DNS, routing, or a refused connection. */
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * Something answered but its certificate chain did not verify. Two very different causes
 * look identical from here: the instance really does serve a private or incomplete
 * chain, or something else in the path — a VPN gateway, a captive portal, an inspecting
 * proxy — answered in its place. Both are worth naming, because refusing the handshake
 * is exactly what keeps the token from reaching whatever answered.
 */
const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

function networkHint(code?: string): string {
  if (code && UNREACHABLE_CODES.has(code)) {
    return '\n\nYouTrack was not reachable — check YOUTRACK_URL, and whether this instance needs a VPN.'
  }

  if (code && TLS_CODES.has(code)) {
    return (
      '\n\nTLS verification failed. Either the instance serves a private or incomplete certificate chain ' +
      '— point NODE_EXTRA_CA_CERTS at the missing CA — or something other than YouTrack answered, ' +
      'which is what a dropped VPN looks like.'
    )
  }

  return ''
}

/** Maps the statuses YouTrack actually returns onto what the caller can do about them. */
function statusHint(status: number): string {
  if (status === 401) return ' (the token is invalid, expired, or revoked)'
  if (status === 403) return ' (the token lacks read or write permission for this project or resource)'
  if (status === 404) return ' (check the issue ID or your access rights)'
  return ''
}

/** `fetch` reports only "fetch failed"; the actionable code sits down the cause chain. */
function rootCause(error: unknown): { code?: string; message: string } {
  let current = error as { code?: string; message?: string; cause?: unknown } | undefined
  let code: string | undefined
  let message = 'unknown error'

  while (current) {
    if (current.code) code = current.code
    if (current.message) message = current.message
    current = current.cause as typeof current
  }

  return { code, message }
}

/** Turns thrown errors into a readable tool error instead of a protocol failure. */
async function run(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof YouTrackError) {
      return errorResult(`YouTrack error: ${error.message}${statusHint(error.status)}`)
    }

    const { code, message } = rootCause(error)
    return errorResult(`Error: ${message}${code ? ` (${code})` : ''}${networkHint(code)}`)
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
/** Adds something new; calling twice adds it twice. */
const additive = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
/** Replaces or removes something that exists. */
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }

const ISSUE_ID = z.string().describe('Readable issue ID, e.g. "PROJ-123"')
const COMMENT_ID = z.string().describe('Comment ID as shown by get_issue_comments, e.g. "4-123"')

function createServer(): McpServer {
  const server = new McpServer({ name: 'youtrack-onprem-mcp', version: packageJson.version })

  server.registerTool(
    'search_issues',
    {
      description:
        'Search YouTrack issues using YouTrack query syntax and return a one-line summary per match. ' +
        'Examples: "project: PROJ State: Open", "assignee: me #Unresolved", "created: {This week}", ' +
        '"project: PROJ sort by: updated desc". Use this to find issue IDs, then get_issue for full detail. ' +
        'Sort with "sort by: <field> asc|desc" — the newer "order by" spelling is not recognised by the ' +
        'YouTrack versions this server targets, and degrades the query into a text search that quietly ' +
        'returns almost nothing.',
      inputSchema: z.object({
        query: z.string().describe('YouTrack search query, e.g. "project: PROJ State: Open"'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max issues to return'),
      }),
      annotations: { title: 'Search issues', ...readOnly },
    },
    async ({ query, limit }) => run(async () => textResult(renderIssueList(await searchIssues(query, limit)))),
  )

  server.registerTool(
    'get_issue',
    {
      description:
        'Get one issue by its readable ID (e.g. "PROJ-123") with summary, description, custom fields ' +
        '(State, Priority, Assignee, …) and timestamps. Does not include comments or attachments.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
      }),
      annotations: { title: 'Get issue', ...readOnly },
    },
    async ({ issue_id }) => run(async () => textResult(renderIssue(await getIssue(issue_id)))),
  )

  server.registerTool(
    'get_issue_comments',
    {
      description: 'Get the comment thread for an issue, oldest first, each with author and timestamp.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
        limit: z.number().int().min(1).max(200).default(50).describe('Max comments to return'),
      }),
      annotations: { title: 'Get issue comments', ...readOnly },
    },
    async ({ issue_id, limit }) => run(async () => textResult(renderComments(await getComments(issue_id, limit)))),
  )

  server.registerTool(
    'get_issue_links',
    {
      description:
        'Get issues linked to this one (relates to, depends on, duplicates, subtask of, …), grouped by link type.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
      }),
      annotations: { title: 'Get issue links', ...readOnly },
    },
    async ({ issue_id }) => run(async () => textResult(renderLinks(await getLinks(issue_id)))),
  )

  server.registerTool(
    'get_attachment_content',
    {
      description:
        'Read an issue attachment. Omit `name` to list what is attached; pass `name` to fetch one. ' +
        'Images are returned as viewable images, text files as text. Other binaries return metadata only.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
        name: z.string().optional().describe('Attachment file name; omit to list available attachments'),
      }),
      annotations: { title: 'Get attachment', ...readOnly },
    },
    async ({ issue_id, name }) =>
      run(async () => {
        const attachments = await getAttachments(issue_id)
        if (!name) return textResult(renderAttachmentList(attachments))

        const match =
          attachments.find((a) => a.name === name) ??
          attachments.find((a) => a.name.toLowerCase() === name.toLowerCase())

        if (!match) {
          return errorResult(`No attachment named "${name}".\n\nAvailable:\n${renderAttachmentList(attachments)}`)
        }

        const mime = match.mimeType ?? 'application/octet-stream'
        const sizeKb = Math.round(match.size / 1024)

        if (mime.startsWith('image/')) {
          if (match.size > MAX_IMAGE_BYTES) {
            return textResult(`Image "${match.name}" is ${sizeKb} KB, too large to inline (limit ${MAX_IMAGE_BYTES / 1_000_000} MB).`)
          }
          const { bytes } = await downloadAttachment(match.url)
          return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: mime }] }
        }

        if (TEXTUAL_MIME.test(mime)) {
          const { bytes } = await downloadAttachment(match.url)
          return textResult(`${match.name} (${mime}):\n\n${renderTextAttachment(bytes, MAX_TEXT_BYTES)}`)
        }

        return textResult(
          `"${match.name}" is ${mime}, ${sizeKb} KB — binary content is not returned. Download it from YouTrack directly if needed.`,
        )
      }),
  )

  server.registerTool(
    'list_projects',
    {
      description: 'List YouTrack projects as "shortName  full name". Use the short name in search queries.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100).describe('Max projects to return'),
      }),
      annotations: { title: 'List projects', ...readOnly },
    },
    async ({ limit }) => run(async () => textResult(renderProjects(await listProjects(limit)))),
  )

  server.registerTool(
    'get_current_user',
    {
      description: 'Get the account this server authenticates as. Useful to resolve "me" in queries.',
      inputSchema: z.object({}),
      annotations: { title: 'Get current user', ...readOnly },
    },
    async () => run(async () => textResult(renderUser(await getCurrentUser()))),
  )

  server.registerTool(
    'create_issue',
    {
      description:
        'Create an issue in a project. Sets summary and description only; set State, Priority, Assignee, ' +
        'Type and other fields afterwards with apply_command. Returns the new issue ID.',
      inputSchema: z.object({
        project: z.string().describe('Project short name, e.g. "PROJ" (see list_projects)'),
        summary: z.string().min(1).describe('Issue title'),
        description: z.string().optional().describe('Issue body, Markdown'),
      }),
      annotations: { title: 'Create issue', ...additive },
    },
    async ({ project, summary, description }) =>
      run(async () => {
        const found = await findProject(project)
        if (!found) return errorResult(`No project with short name "${project}". Call list_projects to see what exists.`)
        return textResult(`Created:\n${renderIssueList([await createIssue(found.id, summary, description)])}`)
      }),
  )

  server.registerTool(
    'update_issue',
    {
      description:
        'Replace the summary and/or description of an issue. The text given replaces the whole field, so read ' +
        'the issue first and send the complete new text. For State, Assignee, Priority and other fields use apply_command.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
        summary: z.string().min(1).optional().describe('New title'),
        description: z.string().optional().describe('New body, Markdown; replaces the existing description entirely'),
      }),
      annotations: { title: 'Update issue text', ...destructive },
    },
    async ({ issue_id, summary, description }) =>
      run(async () => {
        if (summary === undefined && description === undefined) return errorResult('Nothing to update: give summary and/or description.')
        return textResult(renderIssueList([await updateIssue(issue_id, { summary, description })]))
      }),
  )

  server.registerTool(
    'apply_command',
    {
      description:
        'Apply a YouTrack command to one or more issues — the same syntax as the command box in the web UI. ' +
        'Examples: "State In Progress", "State Fixed assignee me", "Priority Critical Type Bug", "tag urgent", ' +
        '"relates to PROJ-45", "subtask of PROJ-10", "remove relates to PROJ-45". Several clauses combine in ' +
        'one command. Values with spaces need no quoting. Returns each issue\'s refreshed one-line summary.',
      inputSchema: z.object({
        issue_ids: z.array(ISSUE_ID).min(1).max(50).describe('Issues to apply the command to; usually one'),
        command: z.string().min(1).describe('YouTrack command, e.g. "State In Progress assignee me"'),
        comment: z.string().optional().describe('Comment to add alongside the change'),
      }),
      // A comment or a tag accumulates on every call, so a retry is not free
      annotations: { title: 'Apply command', ...destructive, idempotentHint: false },
    },
    async ({ issue_ids, command, comment }) =>
      run(async () => {
        await applyCommand(issue_ids, command, comment)
        const issues = await Promise.all(issue_ids.map((id) => getIssueSummary(id)))
        return textResult(renderIssueList(issues))
      }),
  )

  server.registerTool(
    'add_issue_comment',
    {
      description: 'Add a comment to an issue.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
        text: z.string().min(1).describe('Comment body, Markdown'),
      }),
      annotations: { title: 'Add comment', ...additive },
    },
    async ({ issue_id, text }) => run(async () => textResult(renderComments([await addComment(issue_id, text)]))),
  )

  server.registerTool(
    'update_issue_comment',
    {
      description:
        'Replace the text of an existing comment. Only your own comments unless the account has the ' +
        '"Update Not Own Comment" permission.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
        comment_id: COMMENT_ID,
        text: z.string().min(1).describe('New comment body, Markdown; replaces the existing text entirely'),
      }),
      annotations: { title: 'Update comment', ...destructive },
    },
    async ({ issue_id, comment_id, text }) =>
      run(async () => textResult(renderComments([await updateComment(issue_id, comment_id, text)]))),
  )

  server.registerTool(
    'delete_issue_comment',
    {
      description: 'Delete a comment the way the web UI does: it is hidden and an admin can restore it.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
        comment_id: COMMENT_ID,
      }),
      annotations: { title: 'Delete comment', ...destructive },
    },
    async ({ issue_id, comment_id }) =>
      run(async () => {
        await deleteComment(issue_id, comment_id)
        return textResult(`Deleted comment ${comment_id} on ${issue_id}.`)
      }),
  )

  server.registerTool(
    'add_attachment',
    {
      description:
        'Attach a local file to an issue. The path must be absolute; the file is read from this machine and ' +
        'uploaded as-is.',
      inputSchema: z.object({
        issue_id: ISSUE_ID,
        path: z.string().describe('Absolute path to the file, e.g. "/Users/me/screenshot.png"'),
      }),
      annotations: { title: 'Add attachment', ...additive },
    },
    async ({ issue_id, path }) =>
      run(async () => {
        if (!isAbsolute(path)) return errorResult(`Path must be absolute, got "${path}".`)

        const info = await stat(path).catch(() => null)
        if (!info?.isFile()) return errorResult(`No file at "${path}".`)

        const uploaded = await uploadAttachment(issue_id, path)
        return textResult(`Attached to ${issue_id}:\n${renderAttachmentList([uploaded])}`)
      }),
  )

  registerPrompts(server)

  return server
}

serveStdio(createServer)
