/**
 * The default tool set.
 *
 * Registration order determines the order tools appear in the model's prompt.
 * Read-before-write tools come first because a small local model picks tools
 * roughly in the order it sees them, and reading before editing is the habit
 * that prevents most damage.
 */

import { bashTool } from './bash.js'
import { editTool, globTool, grepTool, readTool, writeTool } from './files.js'
import { listTool } from './list.js'
import { ToolRegistry } from './types.js'

/** Tools that mutate state and are therefore approval candidates. */
export const MUTATING_TOOLS = ['write', 'edit', 'bash'] as const

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readTool)
  // Discovery by shape before discovery by name: `list` answers "what is here"
  // and `glob` answers "where is the file called X", and a small model reaches
  // for whichever it saw first.
  registry.register(listTool)
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(editTool)
  registry.register(writeTool)
  registry.register(bashTool)
  return registry
}

export * from './types.js'
export { resolveToolPath, PathError } from './paths.js'
