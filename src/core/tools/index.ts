/**
 * The default tool set.
 *
 * Registration order determines the order tools appear in the model's prompt.
 * Read-before-write tools come first because a small local model picks tools
 * roughly in the order it sees them, and reading before editing is the habit
 * that prevents most damage.
 */

import { bashTool } from './bash.js'
import { deleteTool } from './delete.js'
import { editTool, globTool, grepTool, readTool, writeTool } from './files.js'
import { listTool } from './list.js'
import { createSearchTool, type SearchToolDeps } from './search.js'
import { skillTool } from './skill.js'
import { todoTool } from './todo.js'
import { createWebTool } from './web.js'
import { ToolRegistry } from './types.js'

/**
 * Tools that mutate state and are therefore approval candidates.
 *
 * `delete` is deliberately absent: it asks for approval on every call from
 * inside its own body, because the prompt has to name the path and say
 * whether it is a directory. Listing it here as well would ask the user
 * twice for the same file.
 */
export const MUTATING_TOOLS = ['write', 'edit', 'bash'] as const

/** Live capabilities the tool set can be wired to. */
export interface RegistryDeps {
  /**
   * Provider access for semantic search. When absent the tool is not
   * registered: a search tool that cannot reach an embedding model is a
   * dead entry in the prompt that still costs every step its tokens.
   */
  search?: SearchToolDeps
}

export function createDefaultRegistry(deps?: RegistryDeps): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(readTool)
  // Discovery by shape before discovery by name: `list` answers "what is here"
  // and `glob` answers "where is the file called X", and a small model reaches
  // for whichever it saw first.
  registry.register(listTool)
  registry.register(globTool)
  registry.register(grepTool)
  // Meaning-based lookup after grep: it covers the gap grep cannot (a Chinese
  // question with English identifiers), so it reads as the supplement it is.
  if (deps?.search) registry.register(createSearchTool(deps.search))
  // Always registered: unlike search it needs no model, and an offline machine
  // gets a clean "could not reach the internet" rather than a missing tool.
  registry.register(createWebTool())
  // Preparation sits above the writers on purpose. The failure these exist for is
  // a multi-file job that starts writing before the whole shape is enumerated — a
  // Spring Boot project with four Java files and no build file — and a small model
  // picks tools roughly in the order it sees them. A skill goes first because it
  // may BE that enumeration; the plan follows it.
  registry.register(skillTool)
  registry.register(todoTool)
  registry.register(editTool)
  registry.register(writeTool)
  // Placed directly above `bash` because it competes with it: the habit this
  // tool exists to break is reaching for `del`/`rm`, and a small model picks
  // tools roughly in the order it sees them. A shell delete is permanent and
  // silent; this one is recoverable and reports what happened to the file.
  registry.register(deleteTool)
  registry.register(bashTool)
  return registry
}

export * from './types.js'
export { resolveToolPath, PathError } from './paths.js'
