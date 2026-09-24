/**
 * Inline-math fallback.
 *
 * The trace: the model answered "输入食材 $\rightarrow$ AI 智能创作", and the
 * renderer — plain text, no KaTeX — showed the raw dollars and backslashes to
 * the user. The prompt now forbids LaTeX outright, but a rule in the prompt is
 * a rule a 5B model will sometimes break; the renderer needs a fallback that
 * does the right thing with what arrives anyway.
 *
 * Rather than a LaTeX evaluator, this maps the handful of commands that
 * actually show up in prose (arrows, comparisons, operators, Greek letters)
 * onto Unicode and strips the `$…$` delimiters. Anything it does not fully
 * understand is left EXACTLY as it was: silently mangling an expression the
 * user asked about is worse than showing it raw.
 *
 * Lives in `shared` so both the renderer and the core checks import the same
 * mapping — two copies of a symbol table drift, and a drifted one renders
 * differently from what the tests pinned down.
 */

/** `\command` → its Unicode replacement. Only what is listed is ever replaced. */
const LATEX_COMMANDS: Readonly<Record<string, string>> = {
  // Arrows — the common case in flow descriptions.
  rightarrow: '→', to: '→', longrightarrow: '⟶',
  leftarrow: '←', longleftarrow: '⟵',
  leftrightarrow: '↔', Rightarrow: '⇒', Leftrightarrow: '⇔',
  // Comparison and arithmetic.
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓',
  leq: '≤', le: '≤', geq: '≥', ge: '≥',
  neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼',
  // Big operators and friends.
  infty: '∞', sum: '∑', prod: '∏', sqrt: '√', partial: '∂', int: '∫',
  // Greek letters that turn up in formulas and variable names.
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω',
  Delta: 'Δ', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω', Theta: 'Θ', Lambda: 'Λ',
  // Delimiter sizing — the delimiter itself is already in the text.
  left: '', right: '',
}

/** `$…$` on one line, short enough that prose cannot be swallowed. */
const INLINE_MATH = /\$([^$\n]{1,80})\$/g

/**
 * Simplify `$…$` inline math into plain text where every command is known.
 *
 * Money and other incidental dollars are deliberately untouched: a body with
 * no backslash is not math ("门票 $5"), and a body containing an unknown
 * command is left raw rather than half-translated.
 */
export function simplifyInlineMath(text: string): string {
  return text.replace(INLINE_MATH, (whole, body) => {
    const simplified = simplifyMathBody(String(body))
    return simplified === null ? whole : simplified
  })
}

/**
 * One math body → plain text, or `null` to keep the original.
 *
 * Known commands become their Unicode symbol, `{}`/`^`/`_` scaffolding is
 * dropped, spacing commands vanish. A single unknown `\command` means bail:
 * the point is to never show the user a wrong expression, only a prettier
 * version of a correct one.
 */
function simplifyMathBody(body: string): string | null {
  const trimmed = body.trim()
  if (!trimmed.includes('\\')) return null
  if (trimmed.length === 0) return null

  // Strip spacing commands first: `\,` `\;` `\!` `\ ` have no letters, so the
  // command regex below would miss them.
  let out = trimmed.replace(/\\[,;! ]/g, '')

  let sawUnknown = false
  out = out.replace(/\\([a-zA-Z]+)/g, (_, command: string) => {
    const mapped = LATEX_COMMANDS[command]
    if (mapped === undefined) {
      sawUnknown = true
      return `\\${command}`
    }
    return mapped
  })
  if (sawUnknown) return null

  // `^{2}` and `_{n}` scaffolding: keep the content, drop the braces and the
  // marker. Sub/superscript position is lost, but the characters survive —
  // and `e^{i\pi}` becomes `e^iπ` instead of `e^{i\pi}`.
  out = out.replace(/[{}]/g, '')
  if (out.includes('\\')) return null
  out = out.trim()
  return out.length > 0 ? out : null
}
