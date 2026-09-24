/**
 * The skill loader.
 *
 * The catalog in the system prompt says WHAT exists; this tool is how the model
 * reads one. Keeping them separate is the whole economy of the feature: names and
 * descriptions ride in every request because they are cheap, and a body costs its
 * tokens only once the model has decided it applies.
 */

import { discoverSkills, loadSkill, SKILL_DIR } from '../skills.js'
import type { Tool, ToolResult } from './types.js'

export const skillTool: Tool = {
  name: 'skill',
  description:
    'Load the full instructions of one skill by name. Your instructions list the skills ' +
    `available in this project (from its ${SKILL_DIR} directory). Load one when the work ` +
    'matches its description, and follow it — it records how this project does that job, ' +
    'including the files and steps that are easy to forget. Load it before you start, not ' +
    'after something goes wrong.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The skill name exactly as your instructions list it, e.g. "spring-boot-scaffold".',
      },
    },
    required: ['name'],
  },
  preview: (args) => `Load skill ${String(args.name ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (name.length === 0) {
      return { content: 'name must be a non-empty skill name.', isError: true }
    }

    const skill = await loadSkill(ctx.cwd, name)
    if (skill === null) {
      // Name what IS available. "not found" on its own sends a small model into a
      // retry loop with a near-miss spelling; the list ends that in one step.
      const catalog = await discoverSkills(ctx.cwd)
      const available = catalog.skills.map((entry) => entry.name)
      const where = catalog.root ?? `no ${SKILL_DIR} directory was found in or above ${ctx.cwd}`
      const hint =
        available.length > 0
          ? `Available: ${available.join(', ')}.`
          : `Nothing is loadable from ${where}. Carry on without it and say so if it mattered.`
      return { content: `No skill named "${name}". ${hint}`, isError: true }
    }

    return { content: `<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>` }
  },
}
