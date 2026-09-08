/**
 * Prompts exposed as slash commands (`/mcp__youtrack__<name>`).
 *
 * Prompts cost nothing in context — unlike tool schemas, they are fetched only when
 * invoked. Each one packages a multi-tool workflow that would otherwise be retyped.
 *
 * Only YouTrack's named date periods are used ({This week}, {Today}, …) rather than
 * hand-rolled relative-date arithmetic, so the emitted queries stay valid.
 */

import { completable, type McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'

import { listProjects } from './youtrack.ts'

const PERIODS = ['Today', 'Yesterday', 'This week', 'Last week', 'This month'] as const

/** Autocompletes project short names; falls back to no suggestions if the API is unreachable. */
async function completeProject(value: string): Promise<string[]> {
  try {
    const projects = await listProjects(200)
    return projects
      .map((p) => p.shortName)
      .filter((name) => name.toLowerCase().startsWith(value.toLowerCase()))
      .slice(0, 50)
  } catch {
    return []
  }
}

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] }
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'issue',
    {
      title: 'Issue, in full',
      description: 'Everything about one issue: fields, comment thread, linked issues, attachments',
      argsSchema: z.object({
        id: z.string().describe('Readable issue ID, e.g. PROJ-123'),
      }),
    },
    ({ id }) =>
      userMessage(
        `Give me the full picture of YouTrack issue ${id}.\n\n` +
          `Call get_issue, get_issue_comments, and get_issue_links for ${id}. ` +
          `Also call get_attachment_content with no name to see what is attached, and fetch any image ` +
          `that the description or comments actually refer to.\n\n` +
          `Then summarise:\n` +
          `- what the issue is, and its current state and assignee\n` +
          `- what has been decided or is blocking, drawn from the comments rather than restating them\n` +
          `- related issues and why they are linked\n\n` +
          `Lead with the summary. Do not paste the raw comment thread back to me.`,
      ),
  )

  server.registerPrompt(
    'my_open',
    {
      title: 'My open issues',
      description: 'Your unresolved issues, grouped by project, staleness called out',
      argsSchema: z.object({}),
    },
    () =>
      userMessage(
        `Show my open YouTrack issues.\n\n` +
          `Call search_issues with the query "assignee: me #Unresolved sort by: updated desc" and a limit of 100.\n\n` +
          `Group the results by project. Within each group keep the most recently updated first. ` +
          `Call out anything that looks stalled — sitting in an in-progress state, or untouched for weeks. ` +
          `If there are none, say so plainly rather than padding the answer.`,
      ),
  )

  server.registerPrompt(
    'recent',
    {
      title: 'Recent project activity',
      description: 'What moved in a project over a given period',
      // `completable` marks the schema object it is handed, and Zod's `.describe()`
      // returns a clone — so describing afterwards silently drops the completer and the
      // argument stops offering suggestions. Describe first, always
      argsSchema: z.object({
        project: completable(z.string().describe('Project short name, e.g. PROJ'), completeProject),
        period: completable(
          z.string().describe(`One of: ${PERIODS.join(', ')} (default: This week)`),
          (value) => PERIODS.filter((p) => p.toLowerCase().startsWith(value.toLowerCase())),
        ).optional(),
      }),
    },
    ({ project, period }) => {
      const window = period && PERIODS.includes(period as (typeof PERIODS)[number]) ? period : 'This week'
      return userMessage(
        `Summarise what moved in YouTrack project ${project} during {${window}}.\n\n` +
          `Call search_issues with "project: ${project} updated: {${window}} sort by: updated desc" and a limit of 100.\n\n` +
          `Report what actually changed: what was resolved, what is newly in progress, and what is stuck. ` +
          `Group by state rather than listing issues one by one. If the query returns nothing, say the project ` +
          `was quiet in that window instead of widening the search on your own.`,
      )
    },
  )

  server.registerPrompt(
    'search',
    {
      title: 'Search issues',
      description: 'Search in plain language; the query is translated to YouTrack syntax',
      argsSchema: z.object({
        request: z.string().describe('What to look for, in plain language'),
      }),
    },
    ({ request }) =>
      userMessage(
        `Find YouTrack issues matching: ${request}\n\n` +
          `Translate that into YouTrack query syntax and call search_issues. Useful building blocks: ` +
          `"project: X", "assignee: me", "#Unresolved", "#Resolved", "State: {In Progress}", ` +
          `"updated: {This week}", "created: {Today}", "has: attachments", "sort by: updated desc".\n\n` +
          `Show me the query you used, then the results. If nothing matches, loosen one constraint and say which.`,
      ),
  )
}
