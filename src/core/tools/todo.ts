/**
 * The task-list tool.
 *
 * Why a model needs to be handed back the plan it wrote: asked to "create a
 * Spring Boot project", a small model wrote four Java files and two pages and
 * stopped — no `pom.xml`, no configuration — and nothing in the harness noticed
 * (session 67c03b60). The steps it had decided on were fine. The missing ones
 * were never written down anywhere, so there was nothing to come up short of.
 *
 * Shaped after `dsh-tool-todo` in DeepSeek Harness, including where it differs
 * from the obvious approach:
 *
 * - The list is REPLACED wholesale on every call. A partial update needs stable
 *   ids and per-entry edits, which a small model gets wrong; "send it again with
 *   the current statuses" is one call it can always make.
 * - Validation is strict and loud, and the rejected shapes are named. The list is
 *   written to the log, so a silently repaired one would stop being a record of
 *   what the model decided.
 * - The result is a count line, not the list. The list is state, and state lives
 *   in the `todo/write` event where the main process and the UI can both fold it.
 */

import type { TodoItem } from '../../shared/session.js'
import { parseTodos } from '../../shared/session.js'
import type { Tool, ToolResult, ToolRunContext } from './types.js'

const HEAD =
  'Record and update the task list for the current work. Send the ENTIRE list on every call — ' +
  'it REPLACES the previous list (there are no partial updates and no per-entry edits). Use it ' +
  'to plan multi-step work and to show progress: write one entry per concrete step before you ' +
  'start. List every part the result needs, including the parts nobody asked for by name — a ' +
  'project skeleton is not finished without its build file and its configuration. '

const ACTIVE =
  'Keep AT MOST ONE entry `in_progress` at a time; while work remains, exactly one entry should ' +
  'be `in_progress`. '

const TAIL =
  'Mark an entry `completed` the moment it is done (do not batch the completions), and leave no ' +
  '`in_progress` entry behind once all the work is done. Skip the list entirely for a trivial ' +
  'single-step task. Statuses: `pending` (not started), `in_progress` (being worked on now), ' +
  '`completed` (finished).'

const DESCRIPTION = HEAD + ACTIVE + TAIL

/** The counts line the model reads back, mirroring DeepSeek Harness's wording. */
export function formatTodoCounts(todos: readonly TodoItem[]): string {
  const count = (status: TodoItem['status']): number => todos.filter((t) => t.status === status).length
  return (
    `Updated todo list: ${count('pending')} pending, ` +
    `${count('in_progress')} in progress, ${count('completed')} completed.`
  )
}

export const todoTool: Tool = {
  name: 'todo_write',
  description: DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The COMPLETE task list, replacing any previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the task is — a short imperative line.' },
            status: {
              type: 'string',
              description: 'pending (not started) | in_progress (now) | completed (done).',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  preview: (args) => {
    const parsed = parseTodos(args.todos)
    if (!parsed.ok) return 'Update todo list'
    const done = parsed.todos.filter((t) => t.status === 'completed').length
    return `Update todo list (${done}/${parsed.todos.length} completed)`
  },

  async execute(args, ctx: ToolRunContext): Promise<ToolResult> {
    const parsed = parseTodos(args.todos)
    if (!parsed.ok) {
      // No event is recorded on a rejected call, so a failed update can never
      // erase the list a successful one wrote.
      return { content: `Error: ${parsed.error}`, isError: true }
    }
    ctx.emit?.({ type: 'todo/write', data: { todos: parsed.todos } })
    return { content: formatTodoCounts(parsed.todos) }
  },
}
