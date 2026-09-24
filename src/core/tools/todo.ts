/**
 * The task-list tool.
 *
 * Why a model needs to be handed a list it wrote itself: asked to "create a
 * Spring Boot project", a small model wrote four Java files and two pages and
 * stopped — no `pom.xml`, no config — and nothing in the harness noticed
 * (session 67c03b60). The parts it had planned were fine; the missing ones were
 * never enumerated anywhere, so there was nothing to be short of.
 *
 * The list is replaced WHOLESALE on every call, like the todo list in DeepSeek
 * Harness. That shape is the point: a partial update needs stable ids and
 * per-item edits, which a small model gets wrong, whereas "send it again, with
 * the current statuses" is one call it can always make.
 *
 * No new event type is needed to persist it — `tool/start` and `tool/end` are
 * already in the log, and `deriveTodos` reads the list back out of them.
 */

import type { TodoItem, TodoStatus } from '../../shared/session.js'
import { parseTodos } from '../../shared/session.js'
import type { Tool, ToolResult } from './types.js'

/**
 * The marker the model both reads and writes.
 *
 * ASCII, not glyphs: the model imitates whatever it sees, and a `✔`/`◻` pair is a
 * font dependency on the renderer side and an imitation risk on the model side.
 * `[x]` is the convention every model has already seen in a README.
 */
const MARK: Record<TodoStatus, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
}

/** Render a list the same way the tool asks for it, so the model can imitate it. */
export function formatTodos(todos: readonly TodoItem[]): string {
  const done = todos.filter((todo) => todo.status === 'completed').length
  const open = todos.length - done
  const body = todos.map((todo, i) => `- ${MARK[todo.status]} ${i + 1}. ${todo.content}`).join('\n')
  const tail =
    open === 0
      ? 'Every item is completed.'
      : `${open} of ${todos.length} still open. Do not describe the job as finished while an item is ` +
        'open — do the work, then send the list again. If an item turned out to be unnecessary, ' +
        'send a list without it rather than leaving it open.'
  return `Task list (${done}/${todos.length} completed)\n${body}\n\n${tail}`
}

export const todoTool: Tool = {
  name: 'todo',
  description:
    'Record the plan for a multi-step job, and keep it current while you work. ' +
    'Send the WHOLE list every time: it replaces the previous one. ' +
    'Use it whenever a job takes several steps — scaffolding a project, a change across ' +
    'several files, anything you would otherwise do from memory. Write every step before you ' +
    'start (a project skeleton includes its build file and its config), mark one item ' +
    'in_progress as you work on it, and mark it completed only once you have actually checked it. ' +
    'Finishing a turn with an open item means the job is not finished.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete list, in order. Replaces the previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'One imperative step, e.g. "write pom.xml".' },
            status: {
              type: 'string',
              description: 'One of: pending, in_progress, completed.',
            },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  preview: (args) => {
    const todos = parseTodos(args.todos)
    if (todos === null) return 'Todo'
    const done = todos.filter((todo) => todo.status === 'completed').length
    return `Todo (${done}/${todos.length} completed)`
  },

  async execute(args): Promise<ToolResult> {
    const todos = parseTodos(args.todos)
    if (todos === null) {
      return {
        content:
          'Could not read the list. Send `todos` as an array of `{ "content": "...", "status": "..." }`, ' +
          'where status is one of pending, in_progress, completed.',
        isError: true,
      }
    }
    if (todos.length === 0) {
      return { content: 'The task list is now empty.' }
    }
    return { content: formatTodos(todos) }
  },
}
