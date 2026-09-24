/**
 * Tool contract.
 *
 * A tool is three things: a name, a JSON Schema for its arguments, and an
 * `execute` that turns parsed arguments into a string result. Everything the
 * model sees about a tool comes from the schema — so the schema IS the prompt.
 *
 * Tools receive a `ToolRunContext` rather than reaching for globals: that is
 * what lets the same tool body run against different working directories, and
 * what makes a tool unit-testable without spawning Electron.
 */

import type { ToolCallId, ToolDefinition } from '../../shared/message.js'

export interface ToolRunContext {
  /** Absolute working directory. Tools MUST NOT escape it without asking. */
  cwd: string
  /** Abort signal shared with the step; long operations must observe it. */
  signal: AbortSignal
  callId: ToolCallId
  /**
   * Ask the user to confirm. Only wired when the tool is on the approval list;
   * a tool may also call it unconditionally for genuinely destructive actions.
   */
  requestApproval(message: string): Promise<boolean>
}

export interface ToolResult {
  /** Model-facing text. Keep it information-dense; it costs tokens every step. */
  content: string
  isError?: boolean
  /**
   * When true the loop stops after this call instead of asking the model again.
   * Used by tools that end the turn by definition.
   */
  concludesTurn?: boolean
}

export interface Tool {
  name: string
  description: string
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>
  /**
   * One-line preview shown in the approval prompt. Defaults to the tool name
   * plus a compact argument dump.
   */
  preview?(args: Record<string, unknown>): string
}

/** Convert a tool to the definition the model receives. */
export function toDefinition(tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  definitions(): ToolDefinition[] {
    return this.list().map(toDefinition)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }
}

/** Validate a value against a minimal JSON Schema subset. Returns an error string or null. */
export function validateArgs(
  schema: Record<string, unknown>,
  args: unknown,
): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return 'arguments must be a JSON object'
  }
  const properties = (schema.properties ?? {}) as Record<string, unknown>
  const required = (schema.required ?? []) as string[]
  const record = args as Record<string, unknown>

  for (const key of required) {
    if (!(key in record) || record[key] === undefined) {
      return `missing required argument "${key}"`
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const propSchema = properties[key] as { type?: string } | undefined
    if (!propSchema?.type) continue
    const actual = Array.isArray(value) ? 'array' : typeof value
    if (propSchema.type === 'integer' || propSchema.type === 'number') {
      if (typeof value !== 'number') return `argument "${key}" must be a number`
      continue
    }
    if (propSchema.type !== actual) {
      return `argument "${key}" must be ${propSchema.type}, got ${actual}`
    }
  }
  return null
}
