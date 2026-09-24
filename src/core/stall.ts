/**
 * Detect a model that announced work instead of doing it.
 *
 * This exists because of a specific failure mode, not a hypothetical one. A
 * small local model given a broad request ("show me the whole project") will
 * produce a detailed plan in its reasoning, write a cheerful "here is what I am
 * about to do — one moment please" in its reply, and then stop with
 * `finish_reason: stop` having called no tools at all. Observed verbatim from
 * gemma4:e2b:
 *
 *   reasoning: "I will start by using `glob` to list potential files…"
 *   text:      "好的，我将首先列出项目中的所有文件和目录，然后逐一读取它们
 *               的内容。请稍候。"
 *   tool calls: 0
 *
 * The loop cannot treat that as a finished turn — the user gets a promise and
 * no work. But it also cannot treat every text-only reply as unfinished, or a
 * genuine "here is the answer" would loop forever. So the test is narrow: the
 * reply must read as a *forward-looking* statement with no results in it.
 *
 * The signals are deliberately lexical rather than semantic. A 5B model is
 * unreliable at judging intent, and asking it to grade its own output costs a
 * round trip that a regex does for free. False positives are cheap here —
 * being nudged once to continue is a minor annoyance, while the false negative
 * is a user staring at a reply that never arrives.
 */

/** Phrases that promise action is coming rather than reporting it happened. */
const FORWARD_LOOKING = [
  // English
  /\bi (?:will|'ll|shall|am going to|am about to)\s+(?:start|begin|first|now|go ahead|proceed|list|read|look|check|search|examine|scan|explore|fetch)/i,
  /\blet me\s+(?:start|begin|first|go ahead|proceed|list|read|look|check|search|examine|scan|explore|fetch)/i,
  /\b(?:one|a)\s+moment\b/i,
  /\bplease\s+(?:wait|hold)\b/i,
  /\bstarting\s+(?:now|with)\b/i,
  /\b(?:i am|i'm)\s+going\s+to\b/i,
  /\bnext,?\s+i\s+(?:will|shall|am going to)\b/i,
  /\bstay\s+tuned\b/i,
  /\bhang\s+on\b/i,
  // Chinese — the same move, phrased as 我将/我会/首先/接下来 + 动作
  /我(?:将|会|要|打算|马上|立刻)(?:先|开始|首先|接下来|现在)?/,
  /(?:首先|接下来|下一步|随后|然后)(?:我)?(?:会|将|要|先)?/,
  /请稍(?:候|等)/,
  /稍(?:候|等)(?:一下|片刻)?/,
  /正在(?:读取|查找|扫描|搜索|整理|准备)/,
  /让我(?:先|来|开始|看看|找找|查查)/,
]

/** Phrases that mean the model actually delivered something. */
const REPORTING = [
  /\bhere (?:is|are|is the|are the)\b/i,
  /\bi (?:have|'ve)\s+(?:read|listed|found|checked|examined|scanned|reviewed|gathered|collected)/i,
  /\bthe (?:files?|structure|contents?|results?|project)\s+(?:is|are|contains?|includes?)\b/i,
  /\bsummary\b/i,
  /\bconclusion\b/i,
  /\bin\s+summary\b/i,
  /以下(?:是|为)/,
  /(?:如下|如上)所示/,
  /共(?:有|计|\s*\d)/,
  /总结/,
  /结论/,
  /我已经/,
  /(?:目录|结构|内容)(?:如下|是)：/,
]

export interface StalledTurnInput {
  /** The assistant's visible text for the step. */
  text: string
  /** Its reasoning text, which often states the plan before the text does. */
  reasoning: string
}

export interface StallVerdict {
  stalled: boolean
  /** Why it was judged stalled, for the log and for the correction prompt. */
  reason?: string
}

/**
 * Strip fenced code blocks out of a reply before matching.
 *
 * Only fenced blocks, and only in the visible text. Two different concerns get
 * conflated if this is too aggressive:
 *
 * - A fenced block is where a *documented example* lives (`glob("**\/*.ts")`),
 *   so it should not count as the model saying it will call the tool.
 * - An inline backtick mention is how a model names the tool it intends to
 *   call, and gemma4 writes exactly `glob` that way — stripping it would throw
 *   away the single strongest signal available.
 *
 * So: fenced blocks go, inline spans stay.
 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ')
}

/**
 * Judge whether a tool-free step is a promise rather than a result.
 *
 * Both halves must hold: something forward-looking must be present, and nothing
 * that looks like a delivered result may be. Requiring both is what keeps a
 * finished answer ("the project contains 12 modules: …") from being mistaken
 * for a stall.
 */
export function detectStall(input: StalledTurnInput): StallVerdict {
  const text = input.text.trim()
  if (text.length === 0) return { stalled: false }

  const haystack = stripCode(text)
  const reasoning = stripCode(input.reasoning)

  const forward = FORWARD_LOOKING.find((p) => p.test(haystack))
  if (!forward) return { stalled: false }

  // A reply that reports as well as promises is treated as finished: the user
  // has something to read, and continuing risks piling on unwanted work.
  const reports = REPORTING.some((p) => p.test(haystack))
  if (reports) return { stalled: false }

  // Very short replies are the giveaway — "好的，请稍候。" carries no content at
  // all. A long reply that reads as forward-looking is more likely to be a real
  // explanation that happens to contain "接下来".
  if (text.length > 400) return { stalled: false }

  // The reasoning usually names a tool it intends to call. If it does, that is
  // the strongest single signal available, and it makes the verdict concrete
  // enough to quote back to the model.
  const mentioned = /\b(glob|grep|read|write|edit|bash|list_dir)\b/.exec(reasoning)?.[1]

  return {
    stalled: true,
    reason: mentioned
      ? `模型说要开始（提到了 ${mentioned}）但没有真的调用工具，就把这轮结束了`
      : '模型只给出了"马上开始"的说法，没有调用任何工具',
  }
}

/**
 * The message injected when a stall is detected.
 *
 * Shaped as a correction, not a question: a small model asked "would you like
 * to continue?" will often answer "yes" and stop again. Telling it plainly that
 * the tool call was missing, and that saying it is about to start is not the
 * same as starting, has the best chance of producing an actual call.
 */
export function buildStallCorrection(verdict: StallVerdict): string {
  return [
    '[system] Your previous reply described what you were about to do, but you',
    'did not actually call any tool, so no work happened.',
    verdict.reason ? `Detected: ${verdict.reason}` : '',
    '',
    'Telling the user you are about to start is not starting. Announcements and',
    'plans do not do anything on their own.',
    '',
    'Act now: emit the tool call immediately, with no preamble. Do not describe',
    'the call you are about to make — make it.',
    '',
    'If the task genuinely cannot be done with the tools you have, say which part',
    'is blocked and why, instead of promising to begin.',
  ].filter((line) => line !== '').join('\n')
}

/**
 * Detect a model that denies having filesystem access it actually has.
 *
 * The second observed failure mode, and the more damaging of the two because it
 * looks like a legitimate answer. Verbatim from a session log, with `glob`,
 * `read`, `grep` and `bash` all registered and working:
 *
 *   user:      "当前目录下有什么"
 *   assistant: "我再次重申，作为一个 AI 模型，我**无法直接访问您本地计算机的
 *                硬盘或文件系统**…请您使用系统命令（如 dir 或 ls）获取该目录
 *                下的文件列表，然后将结果告诉我。"
 *   tool calls: 0
 *
 * The user then ran the command themselves and pasted the output back. The model
 * had the tool the whole time.
 *
 * Two things make this self-reinforcing and worth an explicit override rather
 * than just a better prompt:
 *
 * 1. The refusal is now IN the transcript. On the next turn the model reads its
 *    own "I cannot access the filesystem" as established fact, and repeats it
 *    with more conviction ("再次重申"). A system prompt alone cannot outvote the
 *    conversation, so the correction has to name the earlier refusal and revoke
 *    it.
 * 2. Delegating to the user ("请您运行 dir") reads as helpful, so nothing in the
 *    transcript marks it as an error.
 */
const DENIAL = [
  // Chinese: cannot access / read / see the filesystem or disk
  /无法(?:直接)?(?:访问|读取|查看|浏览|打开|获取)/,
  /不能(?:直接)?(?:访问|读取|查看|浏览|打开)/,
  /没能(?:访问|读取|查看)/,
  /没有(?:被授予)?(?:权限|访问权|授权)/,
  /未被授予/,
  /不(?:具备|拥有)(?:访问|读取|浏览)(?:权限|能力)/,
  /我(?:只|仅)(?:能|可以|能够)(?:访问|操作|读取)(?:的)?(?:是|范围)/,
  /(?:超出|不在)(?:我(?:的)?)?(?:工作目录|权限)(?:范围|之外)/,
  // Delegating the work back to the user is the actionable tell.
  /请(?:您|你)(?:自己)?(?:使用|运行|执行|通过)/,
  /(?:您|你)(?:可以|需要|请)(?:自己)?(?:运行|执行|使用)\s*(?:`)?(?:dir|ls|powershell|cmd|Get-ChildItem)/i,
  /将(?:结果|列表|输出)(?:告诉我|提供给我|发给我)/,
  // English
  /\bi (?:cannot|can't|am unable to|do not have|don't have)\b[^.]{0,60}\b(?:access|read|see|browse|open|list)\b/i,
  /\bno (?:filesystem|file system|disk) access\b/i,
  /\bnot (?:been )?(?:granted|given|allowed)\b[^.]{0,40}\b(?:access|permission)\b/i,
  /\byou (?:can|need to|should|will need to)\b[^.]{0,40}\b(?:run|execute|use)\b[^.]{0,40}\b(?:command|dir|ls|powershell|cmd|terminal|shell)\b/i,
  /\bplease (?:run|execute|use)\b[^.]{0,40}\b(?:command|dir|ls|powershell|cmd|terminal)\b/i,
  /\b(cannot|can't|unable to) access (?:your|the) (?:local )?(?:file ?system|files|disk|drive)\b/i,
]

/** A path the user mentioned, so the correction can name the exact call. */
const PATH_IN_TEXT = /(?:[A-Za-z]:[\\/][^\s`"'）)，,。；;]*|\/(?:[\w.-]+\/)+[\w.-]*)/

export interface DenialVerdict {
  denied: boolean
  reason?: string
  /** The path the turn was about, when one is visible in the text. */
  path?: string
}

/**
 * Judge whether a tool-free step is a false "I can't" rather than an answer.
 *
 * Like `detectStall`, this is deliberately lexical. A small model is a poor
 * judge of its own capabilities — asking it to check would cost a round trip
 * and likely produce another denial — while the phrasing of a refusal is highly
 * stereotyped and easy to match.
 */
export function detectCapabilityDenial(input: StalledTurnInput): DenialVerdict {
  const text = input.text.trim()
  if (text.length === 0) return { denied: false }

  const haystack = stripCode(text)
  const match = DENIAL.find((p) => p.test(haystack))
  if (!match) return { denied: false }

  const path = PATH_IN_TEXT.exec(haystack)?.[0]

  return {
    denied: true,
    path,
    reason: path
      ? `模型声称无权访问文件系统，但它手里就有 read/glob/grep/bash（本轮涉及的路径：${path}）`
      : '模型声称无权访问文件系统，但它手里就有 read/glob/grep/bash',
  }
}

/**
 * The message injected when a false denial is detected.
 *
 * It has to do four things a plain prompt cannot, because by this point the
 * model's own refusal is already in the transcript acting as evidence:
 *
 *  1. State the capability facts.
 *  2. Explicitly revoke the earlier refusal — "you said this before, it was
 *     wrong" — or the model treats its own prior message as authoritative.
 *  3. Carry a concrete tool call, so the next message can be the call itself.
 *  4. Forbid handing the work back to the user, which is the specific behaviour
 *     being corrected.
 *
 * `cwd` is included because the model's stated reason for refusing is usually a
 * belief that it may only touch the working directory.
 */
export function buildCapabilityCorrection(verdict: DenialVerdict, cwd: string): string {
  const target = verdict.path
  return [
    '[system] Your last reply claimed you cannot access the filesystem. That is',
    'false, and it is the specific thing you must stop doing.',
    '',
    'The facts:',
    `- You have real tools available right now: read, glob, grep, edit, write, bash.`,
    `- They read the actual disk. ${cwd ? `The working directory is ${cwd}.` : ''}`,
    '- The working directory is only the default for relative paths. It is NOT a',
    '  sandbox. Absolute paths elsewhere on this machine work too.',
    '- Writing outside the working directory asks the user to approve. That is a',
    '  prompt for them, not a refusal for you.',
    '',
    'If you said earlier in this conversation that you cannot read files, ignore',
    'that: those statements were wrong. Do not repeat them, and do not treat them',
    'as established facts.',
    '',
    'Never ask the user to run a command for you. Running it yourself is the whole',
    'point of having the tool. Never say "please run dir/ls and tell me the result".',
    '',
    target
      ? `Act now, with no preamble. To list "${target}", emit either:`
      : 'Act now, with no preamble. To list a directory, emit either:',
    target
      ? `  glob  { "pattern": "**/*", "path": "${target}" }`
      : '  glob  { "pattern": "**/*", "path": "<the directory>" }',
    'or',
    target
      ? `  bash  { "command": "dir /b \\"${target}\\"" }`
      : '  bash  { "command": "dir /b \\"<the directory>\\"" }',
    '',
    'Emit the call instead of describing it. If the tool returns an error, report',
    'that error verbatim — an error is a result, and it is not a reason to claim',
    'you lack access.',
  ].filter((line) => line !== '').join('\n')
}

/**
 * Phrases that assert the workspace has ALREADY been inspected.
 *
 * The third way a tool-less step goes wrong, and the one that misled the user
 * across several rounds. Observed live, 18 turns / ~22K tokens into one session:
 * the model stopped calling tools entirely and answered "根据文件结构来看…" —
 * reciting from the transcript rather than reading anything. Worse, it attributed
 * a directory from a DIFFERENT project, discussed earlier in the same session, to
 * the current one, because that stale result was still sitting in the history.
 *
 * `detectStall` catches the opposite lie: a promise to look. This catches the
 * claim of work already done. Both are a text-only step with no tool call, and
 * only the second survives a long reply — which is exactly how it slipped past.
 *
 * Consulted only on a turn with zero tool calls, which is what makes these
 * phrases conclusive rather than merely suspicious.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /根据(文件|项目|目录|代码|源)[^\n]{0,8}(结构|内容|来看|看|分析)/,
  /根据我对[^\n]{0,24}的分析/,
  /我(已|已经)(查看|分析|阅读|检查|浏览|扫描)/,
  /正如我(之前|前面|刚才)[^\n]{0,6}(所)?(分析|说|提到|查看)/,
  /(全面的|完整的|全文)?(文件|目录|项目)扫描/,
  /从代码(中)?(可以)?(看出|看到)/,
  /根据(刚才|上面|之前|前面)的(文件|结果|内容|信息|输出)/,
  /based on the (file|project|code|directory|structure)/i,
  /I (have )?(examined|analysed|analyzed|reviewed|scanned) the/i,
  /according to the (file|code|project|directory)/i,
  /as I (analysed|analyzed|examined|mentioned) (earlier|before)/i,
  /I (previously|earlier) (listed|read|examined|checked)/i,
]

/**
 * A Windows drive path, or a path-looking token, in the user's own words.
 *
 * A request that names a location cannot be answered from memory: whatever is
 * there has to be read first. If no tool ran, the answer is a guess.
 */
const PATH_HINT = /(?:^|[\s"'`（(])(?:[A-Za-z]:[\\/]|\/[\w.-]+\/|\.\.?[\\/])/

export function detectUnbackedClaim(input: {
  text: string
  reasoning: string
  userText: string
}): { claimed: boolean; reason: string } {
  const haystack = `${input.reasoning}\n${input.text}`
  for (const pattern of CLAIM_PATTERNS) {
    const match = pattern.exec(haystack)
    if (match) {
      return {
        claimed: true,
        reason: `说了「${match[0].replace(/\s+/g, ' ').slice(0, 24)}」，但这一轮没有调用任何工具`,
      }
    }
  }

  if (PATH_HINT.test(input.userText)) {
    return {
      claimed: true,
      reason: '用户给了具体路径，但这一轮没有调用任何工具去读它',
    }
  }

  return { claimed: false, reason: '' }
}

/**
 * The correction for a claim that nothing backs.
 *
 * Names the specific thing that was said, then lists the three calls that would
 * make it true. Without the second half a small model tends to apologise and
 * claim again on the very next step.
 */
export function buildClaimCorrection(claim: { reason: string }): string {
  return [
    '停下。你这一轮没有调用任何工具，所以你现在并不掌握任何文件内容。',
    `你刚才写的是：${claim.reason}`,
    '',
    '不要根据之前的对话复述文件里有什么。那些内容可能属于别的目录，也可能早就变了。',
    '先调用工具，再照着结果回答：',
    '  - 看目录结构：list  { "path": "<目录>" }',
    '  - 看某个文件：read  { "path": "<文件>" }',
    '  - 找关键词：  grep  { "pattern": "<关键词>", "path": "<目录>" }',
    '',
    '如果你要回答的东西还没看过，就先去看了再回答——不要用"根据文件结构"这类说法',
    '掩盖没有看过这件事。也不要反过来要求用户提供文件内容：你自己就能读。',
  ].join('\n')
}


