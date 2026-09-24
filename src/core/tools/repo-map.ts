/**
 * L0 deterministic project map.
 *
 * Why this exists: the trace that motivated it. Asked about a Maven +
 * Vue project, the model ran one `list`, looked at the directory names,
 * and wrote "frontend-vue/: 似乎是前端部分" — a GUESS, delivered as fact,
 * that survived the self-review gate because the reviewer had the same
 * empty yardstick. The information needed to say "frontend-vue: Vue 3 +
 * Vite, 39 files, axios + element-plus + pinia" was sitting in plain
 * sight inside pom.xml, package.json and the Java annotations, none of
 * which a 5B model will reliably go read on its own.
 *
 * So, Aider-style: the harness extracts the facts offline — parse the
 * build files, scan the source for well-known annotations, count the
 * files by extension — and hands the model a map that contains no
 * "似乎". Everything here is deterministic: no model calls, no vector
 * index, no network. What it reports is either in a file or it is absent.
 *
 * The parsers are pure and exported so the assertions in check-core can
 * pin the extraction rules down; the walk is bounded so a huge tree
 * cannot wedge a `list` call.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { NOISE_DIRS } from './files.js'

/** Total filesystem entries the source walk will touch. */
const MAX_WALK_ENTRIES = 20_000
/** How deep the source walk descends. Java package nesting is shallow in practice. */
const MAX_WALK_DEPTH = 8
/** Java files actually READ (parsing only needs the header region of each). */
const MAX_JAVA_READ = 300
/** Per-file read cap; annotations and the class name live near the top. */
const MAX_SOURCE_BYTES = 96_000
/** Subprojects described individually. */
const MAX_SUBPROJECTS = 8
/** Names listed inline before the list is elided to a count. */
const MAX_NAMES = 5

// ---------------------------------------------------------------------------
// pom.xml
// ---------------------------------------------------------------------------

export interface PomFacts {
  artifactId: string
  parentArtifactId?: string
  parentVersion?: string
  packaging: string
  modules: string[]
  /** `groupId:artifactId` entries, in file order, deduplicated, non-test. */
  dependencies: string[]
}

/** Read one XML tag's text out of a block. Whitespace-trimmed, empty if absent. */
function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block)
  return m ? m[1]! : ''
}

export function parsePomXml(xml: string): PomFacts {
  // The parent block is cut out before reading the project's own
  // artifactId/version, otherwise the FIRST <artifactId> in the file is the
  // parent's — a silent off-by-one that would name every project after its
  // parent framework.
  const parentMatch = /<parent>([\s\S]*?)<\/parent>/.exec(xml)
  const parentBlock = parentMatch ? parentMatch[1]! : ''
  const body = parentMatch
    ? xml.slice(0, parentMatch.index) + xml.slice(parentMatch.index + parentMatch[0].length)
    : xml

  const modules: string[] = []
  for (const m of xml.matchAll(/<module>([^<]+)<\/module>/g)) modules.push(m[1]!.trim())

  const dependencies: string[] = []
  for (const m of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = m[1]!
    const scope = tag(block, 'scope')
    if (scope === 'test' || scope === 'provided' || scope === 'system') continue
    const g = tag(block, 'groupId')
    const a = tag(block, 'artifactId')
    if (!g || !a) continue
    const key = `${g}:${a}`
    if (!dependencies.includes(key)) dependencies.push(key)
  }

  return {
    artifactId: tag(body, 'artifactId'),
    parentArtifactId: tag(parentBlock, 'artifactId') || undefined,
    parentVersion: tag(parentBlock, 'version') || undefined,
    packaging: tag(body, 'packaging') || 'jar',
    modules,
    dependencies,
  }
}

// ---------------------------------------------------------------------------
// package.json
// ---------------------------------------------------------------------------

export interface PackageJsonFacts {
  name: string
  /** e.g. ['Vue 3', 'Vite', 'Electron'] — only what a dependency proves. */
  frameworks: string[]
  /** Notable dependencies by bare name, for the map line. */
  notableDeps: string[]
}

/** Dependency name → label. Order matters: it is the display order. */
const JS_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ['vue', 'Vue'],
  ['react', 'React'],
  ['@angular/core', 'Angular'],
  ['@dcloudio/uni-app', 'uni-app'],
  ['vite', 'Vite'],
  ['webpack', 'webpack'],
  ['next', 'Next.js'],
  ['nuxt', 'Nuxt'],
  ['electron', 'Electron'],
  ['express', 'Express'],
  ['koa', 'Koa'],
  ['@nestjs/core', 'NestJS'],
]

const JS_NOTABLE = [
  'axios', 'pinia', 'vuex', 'vue-router', 'react-router-dom', 'element-plus',
  'ant-design-vue', 'vant', 'tailwindcss', 'sass', 'less', 'typescript',
  'eslint', 'vitest', 'jest', 'echarts', 'wangeditor', 'marked',
]

/** First integer in a semver-ish range ('^3.4.0' → '3'). Empty when absent. */
function majorOf(range: unknown): string {
  if (typeof range !== 'string') return ''
  const m = /(\d+)/.exec(range)
  return m ? m[1]! : ''
}

export function parsePackageJson(raw: string): PackageJsonFacts {
  let parsed: {
    name?: unknown
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return { name: '', frameworks: [], notableDeps: [] }
  }

  const deps: Record<string, unknown> = {
    ...(parsed.dependencies ?? {}),
    ...(parsed.devDependencies ?? {}),
  }

  const frameworks: string[] = []
  for (const [depName, label] of JS_FRAMEWORKS) {
    if (!(depName in deps)) continue
    const major = depName === 'vue' || depName === 'react' ? majorOf(deps[depName]) : ''
    frameworks.push(major ? `${label} ${major}` : label)
  }

  const notableDeps = JS_NOTABLE.filter((name) => name in deps)

  return {
    name: typeof parsed.name === 'string' ? parsed.name : '',
    frameworks,
    notableDeps,
  }
}

// ---------------------------------------------------------------------------
// Java source
// ---------------------------------------------------------------------------

export interface JavaSourceFacts {
  packageName: string
  className: string
  kind: 'class' | 'interface' | 'enum' | 'record' | ''
  /** Well-known annotations present, sorted. Unknown @Foo are ignored. */
  annotations: string[]
  hasMain: boolean
}

/**
 * Only annotations that say what a class IS. Collecting every @Foo would hand
 * the model @Override sixty times; the map wants "this is a controller".
 */
const JAVA_ANNOTATIONS = new Set([
  'SpringBootApplication', 'RestController', 'Controller', 'ControllerAdvice',
  'RestControllerAdvice', 'Service', 'Component', 'Repository', 'Entity',
  'Mapper', 'Configuration', 'FeignClient', 'Transactional',
])

export function parseJavaSource(src: string): JavaSourceFacts {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(src)?.[1] ?? ''

  const decl =
    /(?:^|\n)\s*(?:@\w+(?:\s*\([^)]*\))?\s+)*(?:(?:public|abstract|final|static)\s+)*(class|interface|enum|record)\s+(\w+)/.exec(
      src,
    )

  const annotations = new Set<string>()
  for (const m of src.matchAll(/@([\w.]+\.)*(\w+)\s*[(\s\n]/g)) {
    if (JAVA_ANNOTATIONS.has(m[2]!)) annotations.add(m[2]!)
  }

  const hasMain = /\bstatic\s+[\w<>\[\],.\s]+?\bmain\s*\(/.test(src)

  const kind = decl?.[1]
  return {
    packageName: pkg,
    className: decl?.[2] ?? '',
    kind:
      kind === 'class' || kind === 'interface' || kind === 'enum' || kind === 'record'
        ? kind
        : '',
    annotations: [...annotations].sort(),
    hasMain,
  }
}

// ---------------------------------------------------------------------------
// Project-level facts
// ---------------------------------------------------------------------------

export interface JavaProjectFacts {
  type: 'java'
  dir: string
  build: 'maven' | 'gradle'
  artifactId?: string
  parent?: string
  packaging?: string
  /** Spring Boot version when the parent pom (or a dependency) proves it. */
  springBoot?: string
  keyDeps: string[]
  modules: string[]
  javaFiles: number
  entryPoints: string[]
  controllers: string[]
  services: string[]
  componentCount: number
  entityCount: number
  mapperCount: number
  configCount: number
}

export interface JsProjectFacts {
  type: 'js'
  dir: string
  name: string
  frameworks: string[]
  notableDeps: string[]
  vueFiles: number
  tsFiles: number
  jsFiles: number
}

export interface ProjectMap {
  root: string
  readmeTitle?: string
  projects: Array<JavaProjectFacts | JsProjectFacts>
}

const JAVA_KEY_DEP =
  /spring-boot|mybatis|pagehelper|druid|mysql|mariadb|postgres|redis|kafka|netty|dubbo|shardingsphere|sa-token|shiro|spring-security|jjwt|knife4j|springdoc|swagger|hutool|easyexcel|poi|minio|aliyun-sdk|tencentcloud|xxl-job|elasticsearch|rabbitmq|spring-cloud|nacos|openfeign|feign|lombok/

/** Dependencies worth naming in the map, bare artifactId, capped. */
function javaKeyDeps(dependencies: readonly string[]): string[] {
  const out: string[] = []
  for (const dep of dependencies) {
    const artifact = dep.slice(dep.indexOf(':') + 1)
    if (JAVA_KEY_DEP.test(artifact) && !out.includes(artifact)) out.push(artifact)
    if (out.length >= 8) break
  }
  return out
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir, { withFileTypes: false })
  } catch {
    return []
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

interface WalkOutput {
  javaFiles: string[]
  vueFiles: number
  tsFiles: number
  jsFiles: number
}

/** Bounded walk collecting the counts the map states. Skips noise directories. */
async function walkProject(
  dir: string,
  signal: AbortSignal,
  budget: { left: number },
  out: WalkOutput,
  level: number,
): Promise<void> {
  if (level > MAX_WALK_DEPTH || signal.aborted || budget.left <= 0) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (signal.aborted || budget.left <= 0) return
    if (entry.isDirectory()) {
      if (NOISE_DIRS.has(entry.name)) continue
      budget.left--
      await walkProject(join(dir, entry.name), signal, budget, out, level + 1)
      continue
    }
    if (!entry.isFile()) continue
    budget.left--
    const name = entry.name.toLowerCase()
    if (name.endsWith('.java')) {
      if (out.javaFiles.length < MAX_JAVA_READ) out.javaFiles.push(join(dir, entry.name))
    } else if (name.endsWith('.vue')) out.vueFiles++
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.tsFiles++
    else if (name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.mjs')) out.jsFiles++
  }
}

async function readSmall(path: string): Promise<string> {
  try {
    const buffer = await readFile(path)
    return buffer.subarray(0, MAX_SOURCE_BYTES).toString('utf8')
  } catch {
    return ''
  }
}

/** Collect the source-level facts for one Java project directory. */
async function collectJavaFacts(
  dir: string,
  label: string,
  build: 'maven' | 'gradle',
  signal: AbortSignal,
): Promise<JavaProjectFacts> {
  const facts: JavaProjectFacts = {
    type: 'java',
    dir: label,
    build,
    keyDeps: [],
    modules: [],
    javaFiles: 0,
    entryPoints: [],
    controllers: [],
    services: [],
    componentCount: 0,
    entityCount: 0,
    mapperCount: 0,
    configCount: 0,
  }

  if (build === 'maven') {
    const pom = parsePomXml(await readSmall(join(dir, 'pom.xml')))
    facts.artifactId = pom.artifactId || undefined
    facts.packaging = pom.packaging
    facts.modules = pom.modules
    if (pom.parentArtifactId) {
      facts.parent = pom.parentVersion
        ? `${pom.parentArtifactId} ${pom.parentVersion}`
        : pom.parentArtifactId
      if (/spring-boot-starter-parent/.test(pom.parentArtifactId)) {
        facts.springBoot = pom.parentVersion
      }
    }
    facts.keyDeps = javaKeyDeps(pom.dependencies)
    if (!facts.springBoot && pom.dependencies.some((d) => /spring-boot/.test(d))) {
      facts.springBoot = 'present (version managed elsewhere)'
    }
  } else {
    const gradle = await readSmall(join(dir, 'build.gradle'))
    const gradleKts = await readSmall(join(dir, 'build.gradle.kts'))
    const text = gradle || gradleKts
    if (/org\.springframework\.boot/.test(text)) {
      facts.springBoot = 'present (version not parsed from gradle)'
    }
    const deps: string[] = []
    for (const m of text.matchAll(/['"]([\w.-]+:[\w.-]+:[\w.\[\]-]+)['"]/g)) {
      deps.push(m[1]!)
    }
    facts.keyDeps = javaKeyDeps(deps)
  }

  // A multi-module parent (packaging pom / has <module>s) owns no sources;
  // walking it would double-count every module's files below it.
  const isParentOnly =
    (facts.packaging === 'pom' || (facts.modules?.length ?? 0) > 0)
  if (isParentOnly) {
    // Still count Java files so "0 Java files" is never claimed by omission.
    const out: WalkOutput = { javaFiles: [], vueFiles: 0, tsFiles: 0, jsFiles: 0 }
    await walkProject(dir, signal, { left: MAX_WALK_ENTRIES }, out, 0)
    facts.javaFiles = out.javaFiles.length
    return facts
  }

  const out: WalkOutput = { javaFiles: [], vueFiles: 0, tsFiles: 0, jsFiles: 0 }
  await walkProject(dir, signal, { left: MAX_WALK_ENTRIES }, out, 0)
  facts.javaFiles = out.javaFiles.length

  let readCount = 0
  for (const path of out.javaFiles) {
    if (signal.aborted || readCount >= MAX_JAVA_READ) break
    readCount++
    const src = parseJavaSource(await readSmall(path))
    if (src.className.length === 0) continue

    if (src.annotations.includes('SpringBootApplication')) {
      facts.entryPoints.push(src.className)
    } else if (src.hasMain && facts.entryPoints.length === 0) {
      facts.entryPoints.push(src.className)
    }
    if (src.annotations.includes('RestController') || src.annotations.includes('Controller')) {
      if (facts.controllers.length < MAX_NAMES + 3) facts.controllers.push(src.className)
    }
    if (src.annotations.includes('Service')) {
      if (facts.services.length < MAX_NAMES + 3) facts.services.push(src.className)
    }
    if (src.annotations.includes('Component')) facts.componentCount++
    if (src.annotations.includes('Entity')) facts.entityCount++
    if (src.annotations.includes('Mapper')) facts.mapperCount++
    if (src.annotations.includes('Configuration')) facts.configCount++
  }

  return facts
}

async function collectJsFacts(
  dir: string,
  label: string,
  signal: AbortSignal,
): Promise<JsProjectFacts> {
  const parsed = parsePackageJson(await readSmall(join(dir, 'package.json')))
  const out: WalkOutput = { javaFiles: [], vueFiles: 0, tsFiles: 0, jsFiles: 0 }
  await walkProject(dir, signal, { left: MAX_WALK_ENTRIES }, out, 0)
  return {
    type: 'js',
    dir: label,
    name: parsed.name,
    frameworks: parsed.frameworks,
    notableDeps: parsed.notableDeps,
    vueFiles: out.vueFiles,
    tsFiles: out.tsFiles,
    jsFiles: out.jsFiles,
  }
}

/** First heading (or first non-empty line) of a README, capped to one line. */
async function readReadmeTitle(dir: string): Promise<string | undefined> {
  const names = await safeReaddir(dir)
  const readme = names.find(
    (n) => /^readme(\.|$)/i.test(n) && /\.(md|txt|markdown)$/i.test(n),
  )
  if (!readme) return undefined
  const text = (await readSmall(join(dir, readme))).slice(0, 4096)
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^#+\s*/, '').replace(/[=]+\s*$/, '').trim()
    if (trimmed.length > 0) return trimmed.slice(0, 80)
  }
  return undefined
}

/**
 * Build the project map for a directory, or `null` when the directory holds
 * no project (no build file at the root or in any direct subdirectory).
 */
export async function buildProjectMap(
  absolute: string,
  signal: AbortSignal,
): Promise<ProjectMap | null> {
  if (signal.aborted) return null

  const rootNames = await safeReaddir(absolute)
  const lower = new Set(rootNames.map((n) => n.toLowerCase()))
  const projects: Array<JavaProjectFacts | JsProjectFacts> = []

  const rootLabel = basename(absolute) || absolute

  if (lower.has('pom.xml')) {
    projects.push(await collectJavaFacts(absolute, rootLabel, 'maven', signal))
  } else if (lower.has('build.gradle') || lower.has('build.gradle.kts')) {
    projects.push(await collectJavaFacts(absolute, rootLabel, 'gradle', signal))
  }
  if (lower.has('package.json')) {
    projects.push(await collectJsFacts(absolute, rootLabel, signal))
  }

  // Direct subdirectories that are themselves projects (a Vue frontend next to
  // a Java backend, or Maven modules) get their own facts rather than being
  // waved at as "似乎是个前端".
  for (const name of rootNames.sort()) {
    if (projects.length >= MAX_SUBPROJECTS || signal.aborted) break
    if (NOISE_DIRS.has(name)) continue
    const child = join(absolute, name)
    if (!(await isDirectory(child))) continue
    const childNames = await safeReaddir(child)
    const childLower = new Set(childNames.map((n) => n.toLowerCase()))
    if (childLower.has('pom.xml')) {
      projects.push(await collectJavaFacts(child, name, 'maven', signal))
    } else if (childLower.has('build.gradle') || childLower.has('build.gradle.kts')) {
      projects.push(await collectJavaFacts(child, name, 'gradle', signal))
    } else if (childLower.has('package.json')) {
      projects.push(await collectJsFacts(child, name, signal))
    }
  }

  if (projects.length === 0) return null
  const readmeTitle = await readReadmeTitle(absolute)
  return { root: rootLabel, readmeTitle, projects }
}

/** `A, B, C` or `A, B, … (N total)` — elide rather than enumerate. */
function nameList(names: readonly string[]): string {
  if (names.length <= MAX_NAMES) return names.join(', ')
  return `${names.slice(0, MAX_NAMES).join(', ')}, … (${names.length} total)`
}

/**
 * Render the map as the lines `list` appends to its overview.
 *
 * The header states what the section is, because the failure it replaces was
 * a guess delivered with confidence: every line below is backed by a file the
 * harness actually read, and saying so is what lets the model cite it as fact.
 */
export function formatProjectMap(map: ProjectMap): string[] {
  const lines: string[] = [
    'Project map (extracted from build files and source code — facts, not guesses):',
  ]

  for (const project of map.projects) {
    if (project.type === 'java') {
      const head: string[] = [`${project.dir} — ${project.build === 'maven' ? 'Maven' : 'Gradle'} Java project`]
      if (project.artifactId) head.push(`artifactId: ${project.artifactId}`)
      if (project.parent) head.push(`parent: ${project.parent}`)
      if (project.packaging && project.packaging !== 'jar' && project.packaging !== 'war') {
        head.push(`packaging: ${project.packaging}`)
      }
      lines.push(`- ${head.join('; ')}`)

      const detail: string[] = []
      if (project.springBoot) detail.push(`Spring Boot ${project.springBoot}`)
      if (project.modules.length > 0) detail.push(`modules: ${nameList(project.modules)}`)
      if (project.keyDeps.length > 0) detail.push(`key deps: ${project.keyDeps.join(', ')}`)
      if (detail.length > 0) lines.push(`    - ${detail.join('; ')}`)

      const src: string[] = [`${project.javaFiles} Java files`]
      if (project.entryPoints.length > 0) {
        src.push(`entry: ${nameList(project.entryPoints)} (@SpringBootApplication)`)
      }
      if (project.controllers.length > 0) {
        src.push(`${project.controllers.length} @RestController (${nameList(project.controllers)})`)
      }
      if (project.services.length > 0) src.push(`${project.services.length} @Service`)
      if (project.componentCount > 0) src.push(`${project.componentCount} @Component`)
      if (project.entityCount > 0) src.push(`${project.entityCount} @Entity`)
      if (project.mapperCount > 0) src.push(`${project.mapperCount} @Mapper`)
      if (project.configCount > 0) src.push(`${project.configCount} @Configuration`)
      lines.push(`    - ${src.join('; ')}`)
    } else {
      const head = project.frameworks.length > 0
        ? project.frameworks.join(' + ')
        : 'npm project (no known framework detected)'
      const nameSuffix = project.name && project.name !== project.dir ? ` ("${project.name}")` : ''
      lines.push(`- ${project.dir} — ${head}${nameSuffix}`)

      const counts: string[] = []
      if (project.vueFiles > 0) counts.push(`${project.vueFiles} .vue`)
      if (project.tsFiles > 0) counts.push(`${project.tsFiles} .ts`)
      if (project.jsFiles > 0) counts.push(`${project.jsFiles} .js`)
      const detail: string[] = []
      if (counts.length > 0) detail.push(counts.join(', '))
      if (project.notableDeps.length > 0) detail.push(`deps: ${project.notableDeps.join(', ')}`)
      if (detail.length > 0) lines.push(`    - ${detail.join('; ')}`)
    }
  }

  if (map.readmeTitle) lines.push(`- README title: ${map.readmeTitle}`)
  return lines
}
