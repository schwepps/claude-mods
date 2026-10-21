import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULT_PRICES,
  baselineCostOf,
  classifyPrompt,
  costOf,
  decideMain,
  decideSubagent,
  parseClassifierAnswer,
  parseOverride,
  parsePrices,
  priceAgeDays,
  tierOf,
  userWordsOf,
  withClassifier,
} from '../hooks/policy'
import type { Classification, CostInputs, MainInputs } from '../hooks/policy'

const expectClose = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected) < 1e-12).toBe(true)

const settings = { fableMode: 'escalation', minTier: 'haiku' } as const

function cost(context: number, overrides: Partial<CostInputs> = {}): CostInputs {
  return {
    now: 10_000_000,
    context,
    stepsPerTurn: 4,
    outputPerTurn: 2000,
    growthPerTurn: 6000,
    tierCache: { opus: { at: 9_990_000, context } },
    settings: { cacheTtlMs: 3_600_000, cacheWriteMultiplier: 2, horizonTurns: 3 },
    ...overrides,
  }
}

function main(classification: Classification, over: Partial<MainInputs> = {}): MainInputs {
  return {
    classification,
    home: 'opus',
    current: 'opus',
    pin: null,
    boost: null,
    cost: cost(60_000),
    settings,
    ...over,
  }
}

const APP_MESSAGES = [
  '<system-reminder>\nThe session "L3" you started finished a turn. It reported: security migration, architecture trade-offs, no regression.\n</system-reminder>',
  '<cross-session-message from="local_1">\nReview of #218: fix the security issue in the auth flow, there is no regression\n</cross-session-message>',
  '<ci-monitor-event>"Auto-fix pull requests" is watching schwepps/app#12: 2 checks failed</ci-monitor-event>',
  '<system-reminder>Linked sessions now</system-reminder>\n<side-sessions-event>L2 finished: refactor the entire module</side-sessions-event>',
  '<artifact-view-context>Design the architecture page</artifact-view-context>',
  '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
]

describe('userWordsOf', () => {
  test('app blocks are removed and the typed words kept', () => {
    const text = '<system-reminder>\nLinked sessions now: c2 = local_1 (running)\n</system-reminder>\n\nTake fixes 1 and 2 into design'
    expect(userWordsOf(text)).toBe('Take fixes 1 and 2 into design')
  })

  test('a command keeps only what was typed after it', () => {
    const command = '<command-message>sc:flow</command-message>\n<command-name>/sc:flow</command-name>\n<command-args>start fix the typo</command-args>'
    expect(userWordsOf(command)).toBe('start fix the typo')
    expect(userWordsOf('<command-message>commit</command-message>\n<command-name>/commit</command-name>')).toBe('')
  })

  test('a command quoted inside an app block does not hide the typed words', () => {
    const text = '<system-reminder>Skills run as <command-name>/x</command-name></system-reminder>\nfix the race condition in the queue'
    expect(userWordsOf(text)).toBe('fix the race condition in the queue')
  })

  test("pasted content is the user's own material", () => {
    expect(userWordsOf('<pasted_content id="7">TypeError: x is undefined</pasted_content>\nwhy?')).toContain('TypeError: x is undefined')
  })

  test('messages from the app, other sessions and agents have no typed words', () => {
    for (const text of APP_MESSAGES) expect(userWordsOf(text)).toBe('')
  })
})

describe('classifyPrompt', () => {
  test('app messages keep the current model, whatever they say', () => {
    for (const text of APP_MESSAGES) {
      expect(classifyPrompt(text)).toMatchObject({ tier: 'current', kind: 'continuation' })
    }
  })

  test('a reminder around typed words is routed by the words alone', () => {
    const text = '<system-reminder>Plan the security architecture and migration</system-reminder>\ngit status'
    expect(classifyPrompt(text)).toMatchObject({ tier: 'haiku', confidence: 'high' })
  })

  test('mechanical requests are confidently haiku', () => {
    for (const text of ['git status', 'commit these changes', 'rename foo to bar in utils.ts', 'run the tests']) {
      expect(classifyPrompt(text)).toMatchObject({ tier: 'haiku', confidence: 'high' })
    }
  })

  test('hard requests are opus', () => {
    for (const text of [
      'There is a race condition in the job queue, find the root cause',
      'Design the architecture for multi-tenant billing and explain the trade-offs',
      'Do a security review of the auth middleware',
    ]) {
      expect(classifyPrompt(text).tier).toBe('opus')
    }
  })

  test('follow-ups keep the current model', () => {
    for (const text of ['yes', 'go ahead', 'continue', '2', 'LGTM!', 'ok, continue', 'yes, do it.', 'thanks!']) {
      expect(classifyPrompt(text)).toMatchObject({ tier: 'current', kind: 'continuation' })
    }
  })

  test('reports handed back by subagents and tasks keep the current model', () => {
    const report = '<agent-message from="a23">\n[Subagent hand-back] Investigate the root cause and design the architecture</agent-message>'
    expect(classifyPrompt(report)).toMatchObject({ tier: 'current', kind: 'continuation' })
    expect(classifyPrompt('<task-notification>build finished</task-notification>').kind).toBe('continuation')
  })

  test('a regression that is denied is not a correction', () => {
    for (const text of ['the tests pass, no regression in the export', 'not a regression, the stack was slow', 'there were no regressions']) {
      expect(classifyPrompt(text).kind).not.toBe('correction')
    }
    expect(classifyPrompt('it regressed after your change').kind).toBe('correction')
  })

  test('rejections are corrections', () => {
    expect(classifyPrompt("that's wrong, the test still fails").kind).toBe('correction')
    expect(classifyPrompt('it still not working after your change').kind).toBe('correction')
  })

  test('unclear prompts fall back to the home model with low confidence', () => {
    expect(classifyPrompt('hmm, thoughts on the onboarding copy?')).toMatchObject({ tier: 'home', confidence: 'low' })
  })

  test('a mechanical word inside a long prompt does not make it haiku', () => {
    const text = `rename the module and ${'also restructure everything '.repeat(30)}`
    expect(classifyPrompt(text).tier).not.toBe('haiku')
  })
})

describe('parsing', () => {
  test('override prefix is stripped', () => {
    expect(parseOverride('::opus explain this')).toEqual({ tier: 'opus', rest: 'explain this' })
    expect(parseOverride('::AUTO')).toEqual({ tier: 'auto', rest: '' })
    expect(parseOverride('no prefix ::opus')).toEqual({ tier: null, rest: 'no prefix ::opus' })
  })

  test('the classifier can raise implementation work but not drop it below sonnet', () => {
    const impl = classifyPrompt('Implement the CSV export function')
    expect(withClassifier(impl, 'haiku').tier).toBe('sonnet')
    expect(withClassifier(impl, 'opus').tier).toBe('opus')
    expect(withClassifier(classifyPrompt('hmm, thoughts on the name?'), 'haiku').tier).toBe('haiku')
    expect(withClassifier(impl, null)).toBe(impl)
  })

  test('classifier answers and model ids map to tiers', () => {
    expect(parseClassifierAnswer(' Sonnet.')).toBe('sonnet')
    expect(parseClassifierAnswer('unsure')).toBeNull()
    expect(tierOf('claude-opus-5-5')).toBe('opus')
    expect(tierOf('anthropic.claude-haiku-5-5')).toBe('haiku')
    expect(tierOf('claude-mythos-5-1')).toBe('fable')
    expect(tierOf('gpt-x')).toBeNull()
  })
})

describe('decideMain', () => {
  const trivial: Classification = { tier: 'haiku', confidence: 'high', kind: 'heuristic', reason: 'git op' }
  const standard: Classification = { tier: 'sonnet', confidence: 'high', kind: 'classifier', reason: 'classifier: sonnet' }

  test('a trivial turn detours from opus to haiku', () => {
    const d = decideMain(main(trivial))
    expect(d.tier).toBe('haiku')
    expect(d.switchCost!).toBeLessThan(d.stayCost!)
  })

  test('opus to sonnet is refused on a long warm context, where cache reads cost the same', () => {
    const d = decideMain(main(standard, { cost: cost(150_000) }))
    expect(d.tier).toBe('opus')
    expect(d.reason).toContain('costs more than it saves')
  })

  test('opus to sonnet is taken at the start of a session, when no cache is warm', () => {
    expect(decideMain(main(standard, { cost: cost(8_000, { growthPerTurn: 3000, tierCache: {} }) })).tier).toBe('sonnet')
  })

  test('a cold cache makes switching cheaper', () => {
    const warm = decideMain(main(standard, { cost: cost(60_000) }))
    const cold = decideMain(main(standard, { cost: cost(60_000, { tierCache: {} }) }))
    expect(warm.tier).toBe('opus')
    expect(cold.stayCost!).toBeGreaterThan(warm.stayCost!)
  })

  test('upgrades skip the cost gate', () => {
    const hard: Classification = { tier: 'opus', confidence: 'high', kind: 'heuristic', reason: 'design' }
    expect(decideMain(main(hard, { home: 'sonnet', current: 'haiku' })).tier).toBe('opus')
  })

  test('low confidence never goes below home', () => {
    const unsure: Classification = { tier: 'sonnet', confidence: 'low', kind: 'heuristic', reason: 'edit' }
    expect(decideMain(main(unsure, { current: 'haiku' })).tier).toBe('opus')
  })

  test('a correction first undoes a downgrade, then escalates one tier, fable only on a repeated correction', () => {
    const c: Classification = { tier: 'current', confidence: 'high', kind: 'correction', reason: 'rejected' }
    expect(decideMain(main(c, { current: 'haiku' })).tier).toBe('opus')
    expect(decideMain(main(c)).tier).toBe('opus')
    expect(decideMain(main(c, { boost: 'opus' })).tier).toBe('fable')
    expect(decideMain(main(c, { settings: { fableMode: 'auto', minTier: 'haiku' } })).tier).toBe('fable')
    expect(decideMain(main(c, { boost: 'opus', settings: { fableMode: 'manual', minTier: 'haiku' } })).tier).toBe('opus')
    expect(decideMain(main(c, { home: 'sonnet', current: 'sonnet' })).tier).toBe('opus')
    expect(decideMain(main(c, { settings: { fableMode: 'manual', minTier: 'haiku' } })).tier).toBe('opus')
  })

  test('a held escalation outranks a cheap classification', () => {
    expect(decideMain(main(trivial, { boost: 'fable', current: 'fable' })).tier).toBe('fable')
  })

  test('pins and overrides win, and the floor holds', () => {
    expect(decideMain(main(trivial, { pin: 'sonnet' })).tier).toBe('sonnet')
    const override: Classification = { tier: 'haiku', confidence: 'high', kind: 'override', reason: '::haiku' }
    expect(decideMain(main(override)).tier).toBe('haiku')
    expect(decideMain(main(trivial, { settings: { fableMode: 'escalation', minTier: 'sonnet' } })).tier).not.toBe('haiku')
  })

  test('a continuation stays on the current tier', () => {
    const c: Classification = { tier: 'current', confidence: 'high', kind: 'continuation', reason: 'yes' }
    expect(decideMain(main(c, { current: 'haiku' })).tier).toBe('haiku')
  })
})

describe('decideSubagent', () => {
  const sub = (subagentType: string, prompt = '', explicitModel?: string) =>
    decideSubagent({ subagentType, prompt, explicitModel, settings })

  test('search agents run on haiku, forks and unknown plugin agents are left alone', () => {
    expect(sub('Explore')?.tier).toBe('haiku')
    expect(sub('fork')).toBeNull()
    expect(sub('telegram-crm:extractor')).toBeNull()
  })

  test('general agents are sized by their task', () => {
    expect(sub('general-purpose', 'Investigate the root cause of the deadlock in the worker pool')?.tier).toBe('opus')
    expect(sub('general-purpose', 'Implement the CSV export function and write tests for it')?.tier).toBe('sonnet')
    expect(sub('general-purpose', 'git log for the last week')?.tier).toBe('haiku')
  })

  test('an explicit model is respected, but fable is capped unless fableMode is auto', () => {
    expect(sub('general-purpose', 'x', 'haiku')).toBeNull()
    expect(sub('general-purpose', 'x', 'fable')?.tier).toBe('opus')
  })

  test('security reviewers get opus', () => {
    expect(sub('sc-security-reviewer')?.tier).toBe('opus')
    expect(sub('sc-quality-reviewer')?.tier).toBe('sonnet')
  })
})

describe('costs', () => {
  const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 4000 }

  test('cost uses the tier price and cache multipliers', () => {
    expectClose(costOf('opus', usage, 2), (1000 * 4 + 4000 * 8 + 50_000 * 0.2 + 2000 * 20) / 1e6)
  })

  test('haiku bills long prompts at the higher rate', () => {
    const long = { ...usage, cache_read_input_tokens: 150_000 }
    expectClose(costOf('haiku', long, 2), (1000 * 0.5 + 4000 * 1 + 150_000 * 0.05 + 2000 * 2.5) / 1e6)
  })

  test('baseline charges only new tokens as writes', () => {
    expectClose(baselineCostOf('opus', usage, 50_000, 2), (50_000 * 0.2 + 5000 * 8 + 2000 * 20) / 1e6)
  })
})

describe('prices', () => {
  test('a price line overrides the tiers it names and keeps the rest', () => {
    const { prices, problems } = parsePrices('opus = 5/25/0.5; haiku=0.2/1/0.02')
    expect(problems).toEqual([])
    expect(prices.opus).toEqual({ input: 5, output: 25, cacheRead: 0.5 })
    expect(prices.haiku).toEqual({ input: 0.2, output: 1, cacheRead: 0.02 })
    expect(prices.sonnet).toEqual(DEFAULT_PRICES.sonnet)
  })

  test('bad entries are reported and ignored', () => {
    const { prices, problems } = parsePrices('opus=4/20; gpt=1/2/3, sonnet=0/10/0.2')
    expect(problems.length).toBe(3)
    expect(prices).toEqual(DEFAULT_PRICES)
  })

  test('price age is counted in days, undated is null', () => {
    expect(priceAgeDays('2026-10-06', Date.parse('2026-10-16T12:00:00Z'))).toBe(10)
    expect(priceAgeDays('october', 0)).toBeNull()
  })

  test('costs and the switch decision follow the prices in use', () => {
    const usage = { input_tokens: 0, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const pricey = parsePrices('haiku=4/20/0.2').prices
    expectClose(costOf('haiku', usage, 2, pricey), 20)

    const trivial: Classification = { tier: 'haiku', confidence: 'high', kind: 'heuristic', reason: 'git op' }
    expect(decideMain(main(trivial)).tier).toBe('haiku')
    expect(decideMain(main(trivial, { cost: { ...cost(60_000), prices: pricey } })).tier).toBe('opus')
  })
})
