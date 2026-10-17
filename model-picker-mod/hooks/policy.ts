import type { CacheMark, Tier } from '../types'

export type { CacheMark, Tier }

export const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']

export type Confidence = 'high' | 'low'

export type Classification = {
  tier: Tier | 'home' | 'current'
  confidence: Confidence
  kind: 'override' | 'continuation' | 'correction' | 'heuristic' | 'classifier' | 'default'
  reason: string
}

export type Settings = {
  mainLoop: 'auto' | 'shadow' | 'off'
  subagents: 'auto' | 'off'
  fableMode: 'manual' | 'escalation' | 'auto'
  minTier: Tier
  classifier: boolean
  models: Record<Tier, string>
  cacheTtlMs: number
  cacheWriteMultiplier: number
  horizonTurns: number
  haikuEffort: 'low' | 'medium' | 'inherit'
  prices: Prices
  pricesAsOf: string
  priceProblems: string[]
}

export type Price = { input: number; output: number; cacheRead: number }
export type Prices = Record<Tier, Price>

// USD per million tokens, Anthropic first-party list prices. The `prices` setting overrides them.
export const DEFAULT_PRICES: Prices = {
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2 },
  opus: { input: 4, output: 20, cacheRead: 0.2 },
  fable: { input: 10, output: 50, cacheRead: 0.25 },
}
export const DEFAULT_PRICES_AS_OF = '2026-10-06'
export const STALE_PRICE_DAYS = 90

const PRICE_ENTRY = /^(haiku|sonnet|opus|fable)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)\s*\/\s*([\d.]+)$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Reads `haiku=0.1/0.5/0.01; opus=4/20/0.2` (input/output/cache read per MTok); tiers left out keep the defaults. */
export function parsePrices(text: string): { prices: Prices; problems: string[] } {
  const prices: Prices = { ...DEFAULT_PRICES }
  const problems: string[] = []
  for (const raw of text.split(/[;,\n]/)) {
    const entry = raw.trim()
    if (entry === '') continue
    const m = PRICE_ENTRY.exec(entry)
    const values = m ? [m[2], m[3], m[4]].map(Number) : []
    if (!m?.[1] || values.some(v => !Number.isFinite(v) || v <= 0)) {
      problems.push(`ignored price entry "${entry}" (expected tier=input/output/cacheRead)`)
      continue
    }
    const [input = 0, output = 0, cacheRead = 0] = values
    prices[m[1].toLowerCase() as Tier] = { input, output, cacheRead }
  }
  return { prices, problems }
}

/** Days since `asOf`, a YYYY-MM-DD date; null when it does not parse. */
export function priceAgeDays(asOf: string, now: number): number | null {
  if (!DATE.test(asOf)) return null
  const at = Date.parse(`${asOf}T00:00:00Z`)
  return Number.isNaN(at) ? null : Math.floor((now - at) / 86_400_000)
}

// Haiku 5.5 bills prompts over 100K tokens at 5x.
const HAIKU_LONG_PROMPT = 100_000

export const rank = (tier: Tier) => TIERS.indexOf(tier)
export const maxTier = (a: Tier, b: Tier) => (rank(a) >= rank(b) ? a : b)
export const nextTier = (tier: Tier): Tier => TIERS[Math.min(rank(tier) + 1, TIERS.length - 1)] ?? tier

export function tierOf(model: string | undefined): Tier | null {
  if (!model) return null
  const id = model.toLowerCase()
  if (id.includes('haiku')) return 'haiku'
  if (id.includes('sonnet')) return 'sonnet'
  if (id.includes('opus')) return 'opus'
  if (id.includes('fable') || id.includes('mythos')) return 'fable'
  return null
}

export function priceFor(tier: Tier, promptTokens: number, prices: Prices = DEFAULT_PRICES): Price {
  const p = prices[tier]
  if (tier === 'haiku' && promptTokens > HAIKU_LONG_PROMPT) {
    return { input: p.input * 5, output: p.output * 5, cacheRead: p.cacheRead * 5 }
  }
  return p
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const contextOf = (u: Usage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

export function costOf(tier: Tier, u: Usage, writeMultiplier: number, prices: Prices = DEFAULT_PRICES): number {
  const p = priceFor(tier, contextOf(u), prices)
  return (
    (u.input_tokens * p.input +
      u.cache_creation_input_tokens * p.input * writeMultiplier +
      u.cache_read_input_tokens * p.cacheRead +
      u.output_tokens * p.output) /
    1e6
  )
}

/**
 * What the home model would have paid for a step that ran on another tier,
 * assuming its cache was warm up to the previous step's context.
 */
export function baselineCostOf(
  home: Tier,
  u: Usage,
  previousContext: number,
  writeMultiplier: number,
  prices: Prices = DEFAULT_PRICES,
): number {
  if (previousContext === 0) return costOf(home, u, writeMultiplier, prices)
  const context = contextOf(u)
  const fresh = Math.max(0, context - previousContext)
  const p = priceFor(home, context, prices)
  return (
    ((context - fresh) * p.cacheRead + fresh * p.input * writeMultiplier + u.output_tokens * p.output) /
    1e6
  )
}

const OVERRIDE = /^\s*::(haiku|sonnet|opus|fable|auto)\b\s*/i

export function parseOverride(text: string): { tier: Tier | 'auto' | null; rest: string } {
  const m = OVERRIDE.exec(text)
  if (!m?.[1]) return { tier: null, rest: text }
  return { tier: m[1].toLowerCase() as Tier | 'auto', rest: text.slice(m[0].length) }
}

const ACK = String.raw`(y|yes|yep|yeah|ok|okay|sure|go|go ahead|go on|do it|continue|proceed|lgtm|ship it|approved?|sounds good|perfect|great|thanks|thank you|\d{1,2}|option \d{1,2}|[a-d])`
const CONTINUATION = new RegExp(String.raw`^\s*${ACK}([\s,.!]+${ACK})*[\s.!]*$`, 'i')

const DELIVERY = /^\s*<(agent-message|task-notification|teammate-message|channel-message)\b/i

const CORRECTION =
  /\b(still (fails?|failing|broken|wrong|not working)|(doesn'?t|didn'?t|does not|did not) work|not working|that'?s (wrong|not right|incorrect|not what)|you broke|regress(ed|ion)|same error|try again|wrong (answer|approach|file)|not what i (asked|wanted|meant))\b/i

type Rule = { pattern: RegExp; tier: Tier; weight: number; label: string }

const RULES: Rule[] = [
  { pattern: /\b(architect(ure)?|system design|design (a|the|our) |trade-?offs?)\b/i, tier: 'opus', weight: 3, label: 'design' },
  { pattern: /\b(race condition|deadlock|concurren|memory leak|heisenbug|flaky|non-?deterministic)\w*/i, tier: 'opus', weight: 3, label: 'hard debugging' },
  { pattern: /\b(security|vulnerab\w*|threat model|auth(n|z|entication|orization)?\b.*\b(bypass|flaw)|injection|xss|csrf)\b/i, tier: 'opus', weight: 3, label: 'security' },
  { pattern: /\b(root cause|investigate|why (does|is|do|did|are)|figure out why)\b/i, tier: 'opus', weight: 2, label: 'investigation' },
  { pattern: /\b(migrat(e|ion)|refactor (the|across|entire|whole|all)|rewrite (the|this) (module|service|system))\b/i, tier: 'opus', weight: 2, label: 'large change' },
  { pattern: /\b(plan|spec|proposal|strategy|algorithm|prove|optimi[sz]e|performance (issue|problem|regression))\b/i, tier: 'opus', weight: 2, label: 'reasoning' },
  { pattern: /\b(implement|build|add (a |an )?(feature|endpoint|function|method|field|flag|option|component|test)|write (a |the )?tests?|fix (the|this|a) (bug|error|issue|test))\b/i, tier: 'sonnet', weight: 2, label: 'implementation' },
  { pattern: /\b(update|change|modify|extend|wire|hook up)\b/i, tier: 'sonnet', weight: 1, label: 'edit' },
  { pattern: /^\s*(what('?s| is| are| does)|define|show me|list|print|where is|which file)\b/i, tier: 'haiku', weight: 2, label: 'lookup' },
  { pattern: /\b(rename|typo|reformat|format (the|this)|sort imports|add (a )?comment|bump (the )?version|update (the )?changelog)\b/i, tier: 'haiku', weight: 3, label: 'mechanical edit' },
  { pattern: /\bgit (status|log|diff|add|commit|push|pull|stash|checkout|branch)\b|^\s*commit\b|\bcommit (this|these|the changes|it)\b/i, tier: 'haiku', weight: 3, label: 'git op' },
  { pattern: /^\s*(run|rerun|re-run) (the )?(tests?|build|lint|linter|formatter)\s*[.!]*\s*$/i, tier: 'haiku', weight: 3, label: 'run command' },
]

const LONG_PROMPT = 1500

export function classifyPrompt(text: string): Classification {
  const trimmed = text.trim()
  if (trimmed === '') {
    return { tier: 'current', confidence: 'high', kind: 'continuation', reason: 'no new prompt' }
  }
  if (DELIVERY.test(trimmed)) {
    return { tier: 'current', confidence: 'high', kind: 'continuation', reason: 'report from a subagent or task' }
  }
  if (CONTINUATION.test(trimmed)) {
    return { tier: 'current', confidence: 'high', kind: 'continuation', reason: 'short follow-up' }
  }
  if (CORRECTION.test(trimmed)) {
    return { tier: 'current', confidence: 'high', kind: 'correction', reason: 'previous answer rejected' }
  }

  const score: Record<Tier, number> = { haiku: 0, sonnet: 0, opus: 0, fable: 0 }
  const labels: string[] = []
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      score[rule.tier] += rule.weight
      labels.push(rule.label)
    }
  }
  if (trimmed.length > LONG_PROMPT) {
    score.opus += 2
    labels.push('long prompt')
  }
  if ((trimmed.match(/```/g) ?? []).length >= 4) {
    score.opus += 1
    labels.push('multiple code blocks')
  }

  const reason = labels.join(', ')
  if (score.opus >= 2) {
    const isFable = score.opus >= 6
    return { tier: isFable ? 'fable' : 'opus', confidence: 'high', kind: 'heuristic', reason }
  }
  if (score.haiku >= 2 && score.sonnet === 0 && score.opus === 0 && trimmed.length < 400) {
    return { tier: 'haiku', confidence: 'high', kind: 'heuristic', reason }
  }
  if (score.sonnet >= 2 && score.opus === 0) {
    return { tier: 'sonnet', confidence: 'low', kind: 'heuristic', reason }
  }
  return { tier: 'home', confidence: 'low', kind: 'default', reason: reason || 'no clear signal' }
}

export const CLASSIFIER_SYSTEM =
  'You route requests made to a coding agent to the least capable model that will still handle them at full quality. ' +
  'Answer with exactly one word.\n' +
  'haiku: trivial and mechanical — a lookup, a git operation, a rename, formatting, a short factual question.\n' +
  'sonnet: a standard, well-scoped task — implement a function, write tests, a bounded bug fix, an edit across a few files.\n' +
  'opus: hard or open-ended — architecture, hard debugging, security, a large refactor, ambiguous requirements, planning.'

export function classifierPrompt(text: string): string {
  return `<request>\n${text.slice(0, 4000)}\n</request>\nOne word: haiku, sonnet or opus.`
}

/** The classifier may raise a turn the keyword rules saw as implementation work, never drop it below sonnet. */
export function withClassifier(heuristic: Classification, answer: Tier | null): Classification {
  if (answer === null) return heuristic
  const tier = heuristic.tier === 'sonnet' && answer === 'haiku' ? 'sonnet' : answer
  return { tier, confidence: 'high', kind: 'classifier', reason: `classifier: ${answer}` }
}

export function parseClassifierAnswer(answer: string): Tier | null {
  const m = /\b(haiku|sonnet|opus)\b/i.exec(answer)
  return m?.[1] ? (m[1].toLowerCase() as Tier) : null
}

export type CostInputs = {
  now: number
  context: number
  stepsPerTurn: number
  outputPerTurn: number
  growthPerTurn: number
  tierCache: Partial<Record<Tier, CacheMark>>
  settings: Pick<Settings, 'cacheTtlMs' | 'cacheWriteMultiplier' | 'horizonTurns'>
  prices?: Prices
}

function warmTokens(tier: Tier, c: CostInputs): number {
  const mark = c.tierCache[tier]
  if (!mark || c.now - mark.at > c.settings.cacheTtlMs) return 0
  return Math.min(c.context, mark.context)
}

function turnCost(tier: Tier, c: CostInputs, isFirst: boolean): number {
  const p = priceFor(tier, c.context, c.prices)
  const w = c.settings.cacheWriteMultiplier
  const cold = isFirst ? c.context - warmTokens(tier, c) : c.growthPerTurn
  const warm = c.context - cold
  const laterSteps = Math.max(0, c.stepsPerTurn - 1) * c.context
  return (cold * p.input * w + warm * p.cacheRead + laterSteps * p.cacheRead + c.outputPerTurn * p.output) / 1e6
}

export function horizonCost(tier: Tier, c: CostInputs): number {
  let total = turnCost(tier, c, true)
  for (let i = 1; i < c.settings.horizonTurns; i++) total += turnCost(tier, c, false)
  return total
}

/** Cost of rewriting the detour's new tokens into the home model's cache on the way back. */
export function returnCost(home: Tier, c: CostInputs): number {
  const p = priceFor(home, c.context, c.prices)
  return (c.settings.horizonTurns * c.growthPerTurn * p.input * c.settings.cacheWriteMultiplier) / 1e6
}

const SWITCH_MARGIN = 1.15

// Claude Code assumes a 200K window for Haiku 5.5 (it does not know the model yet) and Haiku bills past 100K at 5x.
const HAIKU_MAIN_LOOP_MAX_CONTEXT = 120_000

export type Decision = {
  tier: Tier
  from: Tier
  reason: string
  stayCost?: number
  switchCost?: number
}

export type MainInputs = {
  classification: Classification
  home: Tier
  current: Tier
  pin: Tier | null
  boost: Tier | null
  cost: CostInputs
  settings: Pick<Settings, 'fableMode' | 'minTier'>
}

function clamp(tier: Tier, s: Pick<Settings, 'fableMode' | 'minTier'>, allowFable: boolean): Tier {
  let t = maxTier(tier, s.minTier)
  if (t === 'fable' && !allowFable) t = 'opus'
  return t
}

export function decideMain(i: MainInputs): Decision {
  const { classification: c, home, current, settings } = i
  const from = current

  if (i.pin) return { tier: i.pin, from, reason: `pinned to ${i.pin}` }
  if (c.kind === 'override' && c.tier !== 'home' && c.tier !== 'current') {
    return { tier: c.tier, from, reason: `::${c.tier} override` }
  }

  if (c.kind === 'correction') {
    const up = rank(current) < rank(home) ? home : nextTier(current)
    const allow = settings.fableMode !== 'manual'
    return { tier: clamp(up, settings, allow), from, reason: `escalated: ${c.reason}` }
  }

  let wanted: Tier =
    c.tier === 'current' ? current : c.tier === 'home' ? home : c.tier
  let reason = c.reason
  if (c.confidence === 'low') wanted = maxTier(wanted, home)

  if (i.boost && rank(i.boost) > rank(wanted)) {
    wanted = i.boost
    reason = `holding escalation (${reason})`
  }

  wanted = clamp(wanted, settings, settings.fableMode === 'auto' || i.boost === 'fable' || current === 'fable')

  if (wanted === 'haiku' && i.cost.context > HAIKU_MAIN_LOOP_MAX_CONTEXT) {
    wanted = maxTier('sonnet', settings.minTier)
    reason = `${reason}; context too long for haiku`
  }

  if (rank(wanted) > rank(current)) return { tier: wanted, from, reason }
  if (wanted === current) return { tier: current, from, reason }
  if (rank(wanted) >= rank(home)) return { tier: wanted, from, reason: `back toward ${home}: ${reason}` }

  const stayCost = horizonCost(current, i.cost)
  const switchCost = horizonCost(wanted, i.cost) + returnCost(home, i.cost)
  if (switchCost * SWITCH_MARGIN < stayCost) {
    return { tier: wanted, from, reason, stayCost, switchCost }
  }
  return {
    tier: current,
    from,
    reason: `kept ${current}: switching to ${wanted} costs more than it saves with this context`,
    stayCost,
    switchCost,
  }
}

const SUBAGENT_TIERS: Record<string, Tier> = {
  'Explore': 'haiku',
  'claude-code-guide': 'haiku',
  'statusline-setup': 'haiku',
  'Plan': 'opus',
}

export type SubagentInputs = {
  subagentType: string
  prompt: string
  explicitModel?: string
  classification?: Classification
  settings: Pick<Settings, 'fableMode' | 'minTier'>
}

export function decideSubagent(i: SubagentInputs): { tier: Tier; reason: string } | null {
  const { subagentType: type, settings } = i
  if (type === 'fork') return null

  const explicit = tierOf(i.explicitModel)
  if (explicit) {
    if (explicit === 'fable' && settings.fableMode !== 'auto') {
      return { tier: 'opus', reason: 'fable requested by the model; capped by fableMode' }
    }
    return null
  }

  const known = SUBAGENT_TIERS[type]
  if (known) return { tier: clamp(known, settings, false), reason: `${type} agent` }

  if (/security/i.test(type)) return { tier: clamp('opus', settings, false), reason: 'security agent' }
  if (/review|architect/i.test(type)) return { tier: clamp('sonnet', settings, false), reason: 'review agent' }

  const isGeneral = type === 'general-purpose' || type === 'claude'
  if (!isGeneral) return null

  const c = i.classification ?? classifyPrompt(i.prompt)
  if (c.tier === 'opus' || c.tier === 'fable') {
    return { tier: clamp(c.tier, settings, settings.fableMode === 'auto'), reason: `task: ${c.reason}` }
  }
  if (c.tier === 'haiku' && c.confidence === 'high') {
    return { tier: clamp('haiku', settings, false), reason: `task: ${c.reason}` }
  }
  return { tier: clamp('sonnet', settings, false), reason: `scoped task (${c.reason})` }
}
