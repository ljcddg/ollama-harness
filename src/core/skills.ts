/**
 * Project skills: ready-made procedures the model can load on demand.
 *
 * Modelled on DeepSeek Harness's `skills` subsystem, cut down to what this
 * harness needs. The idea that matters for a small local model is not the
 * registry — it is that competence can live OUTSIDE the weights. Asked to
 * "create a Spring Boot project", gemma4:e2b wrote four Java files and no build
 * file (session 67c03b60). No amount of extra prompting fixes that reliably; a
 * short checklist it can load does.
 *
 * A skill is a Markdown file under a `.SKILL` directory, found by walking up
 * from the session's working directory so a repository root works from any
 * subdirectory:
 *
 *   .SKILL/spring-boot-scaffold/SKILL.md    (a bundle)
 *   .SKILL/spring-boot-scaffold.md          (a flat file)
 *
 * The NAME comes from the path, never from frontmatter. One source of truth, and
 * it deletes a whole class of "the file says one thing and the directory another"
 * bug. Frontmatter supplies the DESCRIPTION, which is all the router ever sees.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

/** Directory name searched for, upward from the working directory. */
export const SKILL_DIR = '.SKILL'

/** Skill names are kebab-case, so a name is also a safe file name. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillSummary {
  /** Kebab-case identifier, taken from the file or directory name. */
  name: string
  /** One-line routing text from frontmatter. The only field the catalog shows. */
  description: string
  /** Absolute path, so the model can `read` further if the body is not enough. */
  path: string
}

/** A skill with its instruction body loaded. */
export interface SkillDefinition extends SkillSummary {
  /** The instructions, with the frontmatter block removed. */
  content: string
}

/**
 * A file that looks like a skill but cannot be used, and the reason.
 *
 * Collected rather than dropped: a skill the user wrote but that never appears
 * in the catalog is exactly the kind of silent failure this harness keeps
 * removing. The prompt names it, so a typo in frontmatter surfaces in one turn
 * instead of in a "why is my skill ignored" session.
 */
export interface SkillProblem {
  path: string
  reason: string
}

export interface SkillCatalog {
  /** The `.SKILL` directory the skills were read from, or null when absent. */
  root: string | null
  skills: SkillSummary[]
  problems: SkillProblem[]
}

/** The nearest ancestor of `startDir` that holds a `.SKILL` directory, or null. */
export async function findSkillRoot(startDir: string): Promise<string | null> {
  let dir = resolve(startDir)
  // Bounded like every other walk in this codebase: a pathological path cannot
  // turn one tool call into an unbounded scan.
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(dir, SKILL_DIR)
    const info = await stat(candidate).catch(() => null)
    if (info?.isDirectory()) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Split a leading `---` frontmatter block from the body.
 *
 * A deliberately tiny parser (flat `key: value` lines, optional surrounding
 * quotes). Skills are authored by hand and read by humans; anything richer would
 * invite YAML edge cases into the prompt-assembly path for no gain. Keys are
 * lowercased so `Description:` and `description:` both work — an easy typo that
 * would otherwise make a skill silently unloadable.
 */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return { fields: {}, body: text }

  const fields: Record<string, string> = {}
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i
      break
    }
    const line = lines[i] ?? ''
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim().toLowerCase()
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) fields[key] = value
  }
  if (end === -1) return { fields: {}, body: text }
  return { fields, body: lines.slice(end + 1).join('\n').trim() }
}

/**
 * Read one candidate file.
 *
 * Returns null when the file is simply not a skill, which is different from a
 * file that MEANS to be one and cannot be used — that returns a problem, because
 * a skill silently missing from the catalog is the failure mode worth shouting
 * about.
 *
 * The distinction is the frontmatter block. A bundle's `SKILL.md` is a
 * declaration by its name alone (`required`), while a flat `.md` file only counts
 * when it opens with `---`. That is what lets `.SKILL/README.md` document the
 * format without being reported as a malformed skill called "README".
 */
async function readSkill(
  path: string,
  name: string,
  required: boolean,
): Promise<SkillSummary | SkillProblem | null> {
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (raw === null) return required ? { path, reason: 'the file could not be read' } : null

  const { fields, body } = parseFrontmatter(raw)
  if (!required && Object.keys(fields).length === 0) return null

  if (!NAME_PATTERN.test(name)) {
    return { path, reason: `"${name}" is not kebab-case (lowercase words joined by single dashes)` }
  }
  const description = (fields['description'] ?? '').trim()
  if (description.length === 0) {
    // Without a description there is nothing to route on, so the skill would be
    // invisible — better to say so than to list a nameless line.
    return { path, reason: 'no `description` in the frontmatter, so there is nothing to route on' }
  }
  if (body.length === 0) {
    return { path, reason: 'the file has a description but no instructions under the frontmatter' }
  }
  return { name, description, path }
}

function isProblem(value: SkillSummary | SkillProblem | null): value is SkillProblem {
  return value !== null && 'reason' in value
}

/**
 * Every skill under a `.SKILL` root.
 *
 * Two layouts, both read in one pass: a directory bundle (`<name>/SKILL.md`) and a
 * flat file (`<name>.md`). A bundle wins a name clash, because it is the shape a
 * skill with supporting files needs.
 */
export async function listSkills(root: string): Promise<{ skills: SkillSummary[]; problems: SkillProblem[] }> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null)
  if (entries === null) return { skills: [], problems: [] }

  const found: SkillSummary[] = []
  const problems: SkillProblem[] = []

  for (const entry of entries) {
    let path: string
    let name: string
    let required: boolean
    if (entry.isDirectory()) {
      name = entry.name
      path = join(root, entry.name, 'SKILL.md')
      const info = await stat(path).catch(() => null)
      // A directory without SKILL.md is not an error — it may hold anything.
      if (!info?.isFile()) continue
      required = true
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      name = basename(entry.name, extname(entry.name))
      path = join(root, entry.name)
      required = false
    } else {
      continue
    }
    const result = await readSkill(path, name, required)
    if (isProblem(result)) problems.push(result)
    else if (result !== null) found.push(result)
  }

  // Bundles first, so a bundle wins its name against a flat file, then by name.
  found.sort((a, b) => {
    const aBundle = basename(a.path).toLowerCase() === 'skill.md' ? 0 : 1
    const bBundle = basename(b.path).toLowerCase() === 'skill.md' ? 0 : 1
    if (aBundle !== bBundle) return aBundle - bBundle
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  const deduped: SkillSummary[] = []
  for (const skill of found) {
    if (!deduped.some((kept) => kept.name === skill.name)) deduped.push(skill)
  }
  problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { skills: deduped, problems }
}

/** Discover the catalog for one working directory. Never throws. */
export async function discoverSkills(cwd: string): Promise<SkillCatalog> {
  const root = await findSkillRoot(cwd)
  if (root === null) return { root: null, skills: [], problems: [] }
  const { skills, problems } = await listSkills(root)
  return { root, skills, problems }
}

/** Load one skill's body by name, or null when it is not there any more. */
export async function loadSkill(cwd: string, name: string): Promise<SkillDefinition | null> {
  const root = await findSkillRoot(cwd)
  if (root === null) return null
  const { skills } = await listSkills(root)
  const summary = skills.find((skill) => skill.name === name)
  if (summary === undefined) return null
  const raw = await readFile(summary.path, 'utf8').catch(() => null)
  if (raw === null) return null
  return { ...summary, content: parseFrontmatter(raw).body }
}

/**
 * The prompt section listing what is loadable, or null when there is nothing to
 * say.
 *
 * Only names and descriptions — never bodies, never absolute paths. The catalog
 * is in EVERY request, so its cost is paid on every step; the body is only worth
 * its tokens once the model has decided the skill applies.
 */
export function formatSkillCatalog(catalog: SkillCatalog): string | null {
  if (catalog.skills.length === 0 && catalog.problems.length === 0) return null

  const lines: string[] = [
    '# Skills',
    '',
    'Ready-made procedures for specific kinds of work. When one of these matches what',
    'you are about to do, load it with the `skill` tool BEFORE you start — it names the',
    'steps and the files the result needs, which is the part that gets missed.',
    'These are part of the project, so follow them over your own habits.',
    '',
  ]
  for (const skill of catalog.skills) {
    lines.push(`- ${skill.name}: ${skill.description}`)
  }
  if (catalog.problems.length > 0) {
    lines.push('')
    lines.push('These look like skills but cannot be used — fix them if they should be loadable:')
    for (const problem of catalog.problems) {
      lines.push(`- ${problem.path}: ${problem.reason}`)
    }
  }
  return lines.join('\n')
}
