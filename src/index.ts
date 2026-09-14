/**
 * Read-only YouTrack MCP server.
 *
 * Exposes only the seven operations that browsing and reading issues actually need.
 * Nothing here mutates YouTrack — there is no create, update, comment, or delete path.
 */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

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
  downloadAttachment,
  getAttachments,
  getComments,
  getCurrentUser,
  getIssue,
  getLinks,
  listProjects,
  searchIssues,
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
  if (status === 403) return ' (the token lacks read permission for this project or resource)'
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
      return {
        content: [{ type: 'text', text: `YouTrack error: ${error.message}${statusHint(error.status)}` }],
        isError: true,
      }
    }

    const { code, message } = rootCause(error)

    return {
      content: [{ type: 'text', text: `Error: ${message}${code ? ` (${code})` : ''}${networkHint(code)}` }],
      isError: true,
    }
  }
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }

function createServer(): McpServer {
  const server = new McpServer({ name: 'youtrack', version: '1.0.0' })

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
        issue_id: z.string().describe('Readable issue ID, e.g. "PROJ-123"'),
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
        issue_id: z.string().describe('Readable issue ID, e.g. "PROJ-123"'),
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
        issue_id: z.string().describe('Readable issue ID, e.g. "PROJ-123"'),
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
        issue_id: z.string().describe('Readable issue ID, e.g. "PROJ-123"'),
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
          return {
            content: [
              { type: 'text', text: `No attachment named "${name}".\n\nAvailable:\n${renderAttachmentList(attachments)}` },
            ],
            isError: true,
          }
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

  registerPrompts(server)

  return server
}

serveStdio(createServer)
