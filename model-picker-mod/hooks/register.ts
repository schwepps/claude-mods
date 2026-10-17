import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { DecisionEntry, RouterSession, TurnPlan } from '../types'
import {
  CLASSIFIER_SYSTEM,
  DEFAULT_PRICES,
  DEFAULT_PRICES_AS_OF,
  STALE_PRICE_DAYS,
  TIERS,
  baselineCostOf,
  classifierPrompt,
  classifyPrompt,
  contextOf,
  costOf,
  decideMain,
  decideSubagent,
  parseClassifierAnswer,
  parseOverride,
  parsePrices,
  priceAgeDays,
  rank,
  tierOf,
  withClassifier,
} from './policy'
import type { Classification, MainInputs, Settings, Tier, Usage } from './policy'

type $ = EngineInterface

const FRESH: RouterSession = {
  pin: null,
  boost: null,
  lastTier: null,
  lastContext: 0,
  tierCache: {},
  stepsEma: 4,
  outputEma: 2000,
  growthEma: 6000,
  pendingOverride: null,
  pendingText: null,
  turn: null,
  agents: {},
  last: null,
}

const session = atom({ plugin: 'model-router', key: 'session' } as const, FRESH)

const UNKNOWN_CONTEXT = 30_000
const BOOST_TURNS = 3
const FAILURES_BEFORE_ESCALATION = 3
const EMA = 0.3
const LOG_SIZE = 100
const STATS_DAYS = 30
const MIN_CLASSIFIER_PROMPT = 20
const CLASSIFIER_TIMEOUT_MS = 5000

type DayStats = {
  actual: number
  baseline: number
  overhead: number
  main: Record<Tier, number>
  subagents: Record<Tier, number>
  switches: number
  escalations: number
}

const emptyCounts = (): Record<Tier, number> => ({ haiku: 0, sonnet: 0, opus: 0, fable: 0 })

const emptyDay = (): DayStats => ({
  actual: 0,
  baseline: 0,
  overhead: 0,
  main: emptyCounts(),
  subagents: emptyCounts(),
  switches: 0,
  escalations: 0,
})

function settingsFrom(o: PluginOptions): Settings {
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = o[key]
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  }
  const text = (key: string, fallback: string) => {
    const v = o[key]
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback
  }
  const num = (key: string, fallback: number) => {
    const v = o[key]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    mainLoop: pick('mainLoop', ['auto', 'shadow', 'off'], 'auto'),
    subagents: pick('subagents', ['auto', 'off'], 'auto'),
    fableMode: pick('fableMode', ['manual', 'escalation', 'auto'], 'escalation'),
    minTier: pick('minTier', ['haiku', 'sonnet', 'opus'], 'haiku'),
    classifier: o.classifier !== false,
    models: {
      haiku: text('haikuModel', 'claude-haiku-5-5'),
      sonnet: text('sonnetModel', 'claude-sonnet-5-5'),
      opus: text('opusModel', 'claude-opus-5-5'),
      fable: text('fableModel', 'claude-fable-5-1'),
    },
    cacheTtlMs: num('cacheTtlMinutes', 60) * 60_000,
    cacheWriteMultiplier: num('cacheWriteMultiplier', 2),
    horizonTurns: Math.round(num('horizonTurns', 3)),
    haikuEffort: pick('haikuEffort', ['low', 'medium', 'inherit'], 'low'),
    ...pricesFrom(text('prices', ''), text('pricesAsOf', '')),
  }
}

function pricesFrom(prices: string, asOf: string): Pick<Settings, 'prices' | 'pricesAsOf' | 'priceProblems'> {
  if (prices === '') return { prices: DEFAULT_PRICES, pricesAsOf: DEFAULT_PRICES_AS_OF, priceProblems: [] }
  const parsed = parsePrices(prices)
  const problems = [...parsed.problems]
  if (priceAgeDays(asOf, 0) === null) problems.push('set pricesAsOf (YYYY-MM-DD) to the date of your prices')
  return { prices: parsed.prices, pricesAsOf: asOf, priceProblems: problems }
}

/** What is wrong with the prices in use, or nothing; `now` in ms. */
function priceWarnings(settings: Settings, now: number): string[] {
  const age = priceAgeDays(settings.pricesAsOf, now)
  const stale =
    age !== null && age > STALE_PRICE_DAYS
      ? [`prices are ${age} days old (as of ${settings.pricesAsOf}): check anthropic.com/pricing and set prices + pricesAsOf`]
      : []
  return [...settings.priceProblems, ...stale]
}

function describePrices(settings: Settings, now: number): string {
  const age = priceAgeDays(settings.pricesAsOf, now)
  const source = settings.prices === DEFAULT_PRICES ? 'built-in' : 'from your settings'
  const table = TIERS.map(t => {
    const p = settings.prices[t]
    return `${t} ${p.input}/${p.output}/${p.cacheRead}`
  }).join(' · ')
  const when = age === null ? 'undated' : `as of ${settings.pricesAsOf}, ${age} days old`
  return `Prices ($/MTok input/output/cache read, ${source}, ${when}): ${table}`
}

const dayKey = (ms: number) => `stats:${new Date(ms).toISOString().slice(0, 10)}`
function money(usd: number): string {
  const abs = Math.abs(usd)
  const text = `$${abs.toFixed(abs < 1 ? 3 : 2)}`
  return usd <= -0.0005 ? `-${text}` : text
}

// Main-loop and subagent steps run concurrently; $.store has no versioning, so writes queue here.
let storeQueue: Promise<unknown> = Promise.resolve()

function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = storeQueue.then(work, work)
  storeQueue = run.catch(() => undefined)
  return run
}

function bumpDay($: $, fn: (d: DayStats) => void) {
  return serially(async () => {
    const key = dayKey(await $.clock.now())
    const day = ((await $.store.get(key)) as DayStats | undefined) ?? emptyDay()
    fn(day)
    await $.store.set(key, day)
  })
}

function logDecision($: $, entry: DecisionEntry) {
  return serially(async () => {
    const log = ((await $.store.get('log')) as DecisionEntry[] | undefined) ?? []
    await $.store.set('log', [...log, entry].slice(-LOG_SIZE))
  })
}

async function showStatus($: $, settings: Settings, tier: Tier | null, reason?: string) {
  if (settings.mainLoop === 'off' && settings.subagents === 'off') return $.ui.status(undefined)
  const day = ((await $.store.get(dayKey(await $.clock.now()))) as DayStats | undefined) ?? emptyDay()
  const saved = day.baseline - day.actual - day.overhead
  const mode = settings.mainLoop === 'shadow' ? ' (shadow)' : ''
  const head = tier ? `⇢ ${tier}${mode}` : `⇢ router${mode}`
  const why = reason ? ` · ${reason.slice(0, 32)}` : ''
  const tally = saved >= 0.005 ? ` · saved ~${money(saved)} today` : ''
  $.ui.status(`${head}${why}${tally}`)
}

async function askClassifier($: $, settings: Settings, text: string): Promise<Tier | null> {
  const r = await $.model.complete({
    model: settings.models.haiku,
    system: CLASSIFIER_SYSTEM,
    prompt: classifierPrompt(text),
    maxTokens: 8,
    effort: 'low',
    timeoutMs: CLASSIFIER_TIMEOUT_MS,
  })
  const overhead = costOf('haiku', r.usage, 1, settings.prices)
  await bumpDay($, d => {
    d.overhead += overhead
  })
  return r.isAnswered ? parseClassifierAnswer(r.text) : null
}

async function refine($: $, settings: Settings, text: string, c: Classification): Promise<Classification> {
  if (c.confidence === 'high' || !settings.classifier || text.trim().length < MIN_CLASSIFIER_PROMPT) return c
  try {
    return withClassifier(c, await askClassifier($, settings, text))
  } catch {
    return c
  }
}

/** The classifier answers haiku, sonnet or opus; skip it when none of those could move this turn. */
function classifierCanChange(inputs: Omit<MainInputs, 'classification'>, heuristic: Classification): boolean {
  if (heuristic.confidence === 'high') return false
  const without = decideMain({ ...inputs, classification: heuristic }).tier
  const answers: Tier[] = ['haiku', 'sonnet', 'opus']
  return answers.some(
    tier => decideMain({ ...inputs, classification: { tier, confidence: 'high', kind: 'classifier', reason: '' } }).tier !== without,
  )
}

async function planTurn($: $, settings: Settings, turnId: string, home: Tier): Promise<TurnPlan> {
  const s = await read($, session)
  const now = await $.clock.now()
  const text = s.pendingText?.turnId === turnId ? s.pendingText.text : ''

  const isSameHome = s.turn === null || s.turn.home === home
  const current = isSameHome ? (s.lastTier ?? home) : home
  const context = s.lastContext > 0 ? s.lastContext : ((await $.session.usage()).context.tokens ?? UNKNOWN_CONTEXT)
  const inputs: Omit<MainInputs, 'classification'> = {
    home,
    current,
    pin: s.pin,
    boost: s.boost && s.boost.turnsLeft > 0 ? s.boost.tier : null,
    settings,
    cost: {
      prices: settings.prices,
      now,
      context,
      stepsPerTurn: s.stepsEma,
      outputPerTurn: s.outputEma,
      growthPerTurn: s.growthEma,
      tierCache: s.tierCache,
      settings,
    },
  }

  let classification: Classification = s.pendingOverride
    ? { tier: s.pendingOverride, confidence: 'high', kind: 'override', reason: `::${s.pendingOverride}` }
    : classifyPrompt(text)
  if (classifierCanChange(inputs, classification)) classification = await refine($, settings, text, classification)

  const decision = decideMain({ ...inputs, classification })

  const isApplied = settings.mainLoop === 'auto'
  const tier = isApplied ? decision.tier : home
  const plan: TurnPlan = { id: turnId, home, tier, steps: 0, output: 0, failures: 0, startContext: context }
  const isEscalation = classification.kind === 'correction'
  const entry: DecisionEntry = {
    at: now,
    scope: 'main',
    from: decision.from,
    to: decision.tier,
    reason: decision.reason,
    isApplied,
    prompt: text.slice(0, 120),
    stayCost: decision.stayCost,
    switchCost: decision.switchCost,
  }
  await update($, session, cur => ({
    ...cur,
    turn: plan,
    pendingOverride: null,
    pendingText: null,
    boost: isEscalation ? { tier: decision.tier, turnsLeft: BOOST_TURNS } : cur.boost,
    last: entry,
  }))
  await logDecision($, entry)
  if (decision.tier !== decision.from && isApplied) {
    await bumpDay($, d => {
      d.switches += 1
      d.escalations += isEscalation ? 1 : 0
    })
  }
  await showStatus($, settings, decision.tier, decision.reason)
  return plan
}

async function accountMain($: $, settings: Settings, plan: TurnPlan, usage: Usage) {
  const now = await $.clock.now()
  const s = await read($, session)
  const tier = plan.tier
  const actual = costOf(tier, usage, settings.cacheWriteMultiplier, settings.prices)
  const baseline =
    tier === plan.home
      ? actual
      : baselineCostOf(plan.home, usage, s.lastContext, settings.cacheWriteMultiplier, settings.prices)
  const context = contextOf(usage)
  await update($, session, cur => ({
    ...cur,
    lastTier: tier,
    lastContext: context,
    tierCache: { ...cur.tierCache, [tier]: { at: now, context } },
    turn:
      cur.turn?.id === plan.id
        ? { ...cur.turn, steps: cur.turn.steps + 1, output: cur.turn.output + usage.output_tokens }
        : cur.turn,
  }))
  await bumpDay($, d => {
    d.actual += actual
    d.baseline += baseline
    d.main[tier] += 1
  })
}

async function accountSubagent($: $, settings: Settings, agentId: string, model: string, usage: Usage) {
  const route = (await read($, session)).agents[agentId]
  const tier = tierOf(model)
  if (!route || !tier) return
  const actual = costOf(tier, usage, settings.cacheWriteMultiplier, settings.prices)
  const baseline = costOf(route.baseline, usage, settings.cacheWriteMultiplier, settings.prices)
  await bumpDay($, d => {
    d.actual += actual
    d.baseline += baseline
  })
}

async function describe($: $, settings: Settings, arg: string): Promise<string> {
  const s = await read($, session)
  const now = await $.clock.now()
  const lines: string[] = []

  if (arg === 'log') {
    const log = ((await $.store.get('log')) as DecisionEntry[] | undefined) ?? []
    if (log.length === 0) return 'Model router: no decisions yet.'
    for (const d of log.slice(-20)) {
      const time = new Date(d.at).toISOString().slice(11, 16)
      const mark = d.isApplied ? '' : ' (shadow)'
      const prompt = d.prompt ? `  “${d.prompt}”` : ''
      lines.push(`${time} ${d.scope.padEnd(8)} ${d.from} → ${d.to}${mark}  ${d.reason}${prompt}`)
    }
    return lines.join('\n')
  }

  const escalation = s.boost ? `${s.boost.tier} for ${s.boost.turnsLeft} more turn(s)` : 'none'
  lines.push(
    `Model router: main loop ${settings.mainLoop}, subagents ${settings.subagents}, fable ${settings.fableMode}, floor ${settings.minTier}`,
    `Home model: ${s.turn?.home ?? 'not seen yet'} · last turn on: ${s.lastTier ?? '-'} · pin: ${s.pin ?? 'none'} · escalation: ${escalation}`,
  )
  if (s.last) {
    const est =
      s.last.stayCost !== undefined && s.last.switchCost !== undefined
        ? ` (next ${settings.horizonTurns} turns: stay ${money(s.last.stayCost)} vs switch ${money(s.last.switchCost)})`
        : ''
    lines.push(`Last decision: ${s.last.from} → ${s.last.to}: ${s.last.reason}${est}`)
  }

  let week = { actual: 0, baseline: 0, overhead: 0 }
  for (let i = 0; i < 7; i++) {
    const day = (await $.store.get(dayKey(now - i * 86_400_000))) as DayStats | undefined
    if (!day) continue
    if (i === 0) {
      const saved = day.baseline - day.actual - day.overhead
      const pct = day.baseline > 0 ? Math.round((saved / day.baseline) * 100) : 0
      lines.push(
        `Today (estimated at API list prices): ${money(day.actual + day.overhead)} spent, ${money(day.baseline)} without routing, saved ${money(saved)} (${pct}%)`,
        `  main-loop requests: ${TIERS.map(t => `${t} ${day.main[t]}`).join(', ')} · subagents: ${TIERS.map(t => `${t} ${day.subagents[t]}`).join(', ')}`,
        `  switches ${day.switches}, escalations ${day.escalations}, classifier ${money(day.overhead)}`,
      )
    }
    week = {
      actual: week.actual + day.actual,
      baseline: week.baseline + day.baseline,
      overhead: week.overhead + day.overhead,
    }
  }
  if (week.baseline > 0) {
    lines.push(`Last 7 days: saved ${money(week.baseline - week.actual - week.overhead)} of ${money(week.baseline)}`)
  }
  lines.push(describePrices(settings, now), ...priceWarnings(settings, now).map(w => `⚠ ${w}`))
  lines.push('Per prompt: start it with ::haiku, ::sonnet, ::opus or ::fable. Sent alone, ::opus pins and ::auto unpins.')
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'route',
      description: 'Model router: status and savings; /route haiku|sonnet|opus|fable pins, /route auto unpins, /route log',
      argumentHint: '[auto|haiku|sonnet|opus|fable|log]',
    })
    await serially(async () => {
      const cutoff = dayKey((await $.clock.now()) - STATS_DAYS * 86_400_000)
      for (const key of await $.store.keys()) {
        if (key.startsWith('stats:') && key < cutoff) await $.store.delete(key)
      }
    })
    await showStatus($, settings, null)
    const warnings = priceWarnings(settings, await $.clock.now())
    if (warnings.length > 0) $.ui.toast(`Model router: ${warnings.join('; ')}`)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    const { tier, rest } = parseOverride(e.text)
    if (tier === null) return next(e)

    if (rest.trim() === '') {
      const pin = tier === 'auto' ? null : tier
      await update($, session, s => ({ ...s, pin }))
      await showStatus($, settings, pin, pin ? 'pinned' : 'auto')
      return { drop: pin ? `Model router: pinned to ${pin} for this session.` : 'Model router: back to automatic routing.' }
    }

    const isNewTurn = e.turnId === undefined
    await update($, session, s => ({ ...s, pendingOverride: isNewTurn && tier !== 'auto' ? tier : null }))
    return next({ ...e, text: rest })
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await update($, session, s => ({ ...s, pendingText: { turnId: e.turnId, text: e.text } }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const result = yield* next(e)
      if (result.usage) await accountSubagent($, settings, e.agentId, e.model, result.usage)
      return result
    }

    const engineTier = tierOf(e.model)
    if (settings.mainLoop === 'off' || engineTier === null) return yield* next(e)

    const s = await read($, session)
    let plan = s.turn?.id === e.turnId ? s.turn : null
    if (plan === null) {
      if (e.index > 0) return yield* next(e)
      plan = await planTurn($, settings, e.turnId, engineTier)
    }
    if (engineTier !== plan.home) return yield* next(e)

    const model = plan.tier === plan.home ? e.model : settings.models[plan.tier]
    const effort =
      plan.tier === 'haiku' && e.effort !== undefined && settings.haikuEffort !== 'inherit' ? settings.haikuEffort : e.effort
    const isRewritten = model !== e.model || effort !== e.effort
    const result = yield* next(isRewritten ? { ...e, model, effort } : e)
    if (result.usage) await accountMain($, settings, plan, result.usage)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || settings.mainLoop !== 'auto') return ran

    const plan = (await read($, session)).turn
    if (!plan || rank(plan.tier) >= rank(plan.home)) return ran

    const failures = ran.isError === true ? plan.failures + 1 : 0
    const isEscalating = failures >= FAILURES_BEFORE_ESCALATION
    const tier = isEscalating ? plan.home : plan.tier
    await update($, session, cur =>
      cur.turn?.id === plan.id
        ? {
            ...cur,
            turn: { ...cur.turn, failures: isEscalating ? 0 : failures, tier },
            boost: isEscalating ? { tier, turnsLeft: BOOST_TURNS } : cur.boost,
          }
        : cur,
    )
    if (isEscalating) {
      $.ui.toast(`Model router: ${plan.tier} kept failing, back to ${tier} for the rest of this turn`)
      await bumpDay($, d => {
        d.escalations += 1
      })
      await logDecision($, {
        at: await $.clock.now(),
        scope: 'main',
        from: plan.tier,
        to: tier,
        reason: `${FAILURES_BEFORE_ESCALATION} failed tool calls in a row`,
        isApplied: true,
        prompt: '',
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await update($, session, s => {
      const plan = s.turn
      if (!plan) return s
      const growth = Math.max(0, s.lastContext - plan.startContext)
      return {
        ...s,
        stepsEma: plan.steps > 0 ? s.stepsEma * (1 - EMA) + plan.steps * EMA : s.stepsEma,
        outputEma: plan.steps > 0 ? s.outputEma * (1 - EMA) + plan.output * EMA : s.outputEma,
        growthEma: plan.steps > 0 ? s.growthEma * (1 - EMA) + growth * EMA : s.growthEma,
        boost: s.boost && s.boost.turnsLeft > 1 ? { ...s.boost, turnsLeft: s.boost.turnsLeft - 1 } : null,
      }
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, session, s => ({ ...s, tierCache: {}, lastContext: 0 }))
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, session, s => ({ ...FRESH, pin: s.pin }))
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const parent = tierOf(e.parentModel)
    if (settings.subagents === 'off' || parent === null) return next(e)

    const isGeneral = e.subagentType === 'general-purpose' || e.subagentType === 'claude'
    const classification =
      isGeneral && !e.model ? await refine($, settings, e.prompt, classifyPrompt(e.prompt)) : undefined
    const decision = decideSubagent({
      subagentType: e.subagentType,
      prompt: e.prompt,
      explicitModel: e.model,
      classification,
      settings,
    })
    if (!decision) return next(e)

    const started = await next({ ...e, model: settings.models[decision.tier] })
    if (started.deny !== undefined) return started

    const inherits = !e.model && (isGeneral || e.subagentType === 'Plan')
    const baseline = inherits ? parent : decision.tier
    const agentId = started.agentId
    if (agentId) {
      await update($, session, s => {
        const kept = Object.entries(s.agents).slice(-49)
        return { ...s, agents: { ...Object.fromEntries(kept), [agentId]: { tier: decision.tier, baseline } } }
      })
    }
    await bumpDay($, d => {
      d.subagents[decision.tier] += 1
    })
    await logDecision($, {
      at: await $.clock.now(),
      scope: 'subagent',
      from: baseline,
      to: decision.tier,
      reason: `${e.subagentType}: ${decision.reason}`,
      isApplied: true,
      prompt: e.description.slice(0, 120),
    })
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if ((TIERS as readonly string[]).includes(arg)) {
      const pin = arg as Tier
      await update($, session, s => ({ ...s, pin }))
      await showStatus($, settings, pin, 'pinned')
      return { text: `Model router: pinned to ${pin} for this session. /route auto to undo.` }
    }
    if (arg === 'auto') {
      await update($, session, s => ({ ...s, pin: null }))
      await showStatus($, settings, null)
      return { text: 'Model router: automatic routing.' }
    }
    return { text: await describe($, settings, arg) }
  })
}
