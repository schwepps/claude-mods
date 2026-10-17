import { describe, expect, test } from 'claude-code/testing'

import { FABLE, HAIKU, OPUS, SONNET, route, spawn, step, turn, world } from './harness'

describe('conversation flows', () => {
  test('detour to haiku, a follow-up stays, an unclear prompt asks the classifier and returns home', async ($, on) => {
    const w = world(on, { classifier: { answer: 'opus' } })

    await turn($, 't1', 'git status')
    await turn($, 't2', 'yes')
    await turn($, 't3', 'hmm, any thoughts on how this module is named?')

    expect(w.models).toEqual([HAIKU, HAIKU, OPUS])
    expect(w.classifierCalls).toBe(1)
  })

  test('a subagent report handed back mid-task keeps the turn on its model, without asking the classifier', async ($, on) => {
    const w = world(on, { classifier: { answer: 'haiku' } })

    await turn($, 't1', 'Design the architecture for the sync engine and weigh the trade-offs')
    await turn($, 't2', '<agent-message from="a1">\n[Subagent hand-back] found three call sites, details follow at length</agent-message>')

    expect(w.models).toEqual([OPUS, OPUS])
    expect(w.classifierCalls).toBe(0)
  })

  test('a correction undoes the detour and holds home for two more turns', async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'git status')
    await turn($, 't2', "that's wrong, try again")
    await turn($, 't3', 'git status')
    await turn($, 't4', 'git status')
    await turn($, 't5', 'git status')

    expect(w.models).toEqual([HAIKU, OPUS, OPUS, OPUS, HAIKU])
  })

  test('a correction on the home model escalates to fable', async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'Design the architecture for the sync engine and weigh the trade-offs')
    await turn($, 't2', 'still failing, same error')

    expect(w.models).toEqual([OPUS, FABLE])
  })

  test('fableMode manual keeps a correction on opus', { options: { fableMode: 'manual' } }, async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'Design the architecture for the sync engine and weigh the trade-offs')
    await turn($, 't2', 'still failing, same error')

    expect(w.models).toEqual([OPUS, OPUS])
  })
})

describe('effort', () => {
  test('haiku detours think at low effort, the home model keeps the session effort', async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'git status')
    await turn($, 't2', 'Design the architecture for the sync engine and weigh the trade-offs')
    await turn($, 't3', '::haiku clean the build folder', { commands: ['fail 1', 'fail 2', 'fail 3'] })

    expect(w.models).toEqual([HAIKU, OPUS, HAIKU, OPUS])
    expect(w.efforts).toEqual(['low', 'high', 'low', 'high'])
  })

  test('haikuEffort inherit keeps the session effort on detours', { options: { haikuEffort: 'inherit' } }, async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'git status')

    expect(w.efforts).toEqual(['high'])
  })

  test('sonnet detours and pins keep the session effort', async ($, on) => {
    const w = world(on)

    await turn($, 't0', '::sonnet')
    await turn($, 't1', 'git status')

    expect(w.efforts).toEqual(['high'])
  })
})

describe('mid-turn quality guard', () => {
  test('three failed tool calls on a downgraded model return the rest of the turn to home', async ($, on) => {
    const w = world(on)

    await turn($, 't1', '::haiku clean the build folder', { commands: ['fail 1', 'fail 2', 'fail 3'] })

    expect(w.models).toEqual([HAIKU, OPUS])
    expect(w.toasts.join()).toContain('back to opus')
  })

  test('a success between failures resets the count', async ($, on) => {
    const w = world(on)

    await turn($, 't1', '::haiku clean the build folder', { commands: ['fail 1', 'ls', 'fail 2', 'fail 3'] })

    expect(w.models).toEqual([HAIKU, HAIKU])
    expect(w.toasts).toEqual([])
  })

  test('failures on the home model never escalate', async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'Investigate the root cause of the crash', { commands: ['fail 1', 'fail 2', 'fail 3', 'fail 4'] })

    expect(w.models).toEqual([OPUS, OPUS])
    expect(w.toasts).toEqual([])
  })
})

describe('engine edge cases', () => {
  test('a fallback model the engine picks mid-turn is passed through', async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'git status', { laterSteps: [SONNET] })

    expect(w.models).toEqual([HAIKU, SONNET])
  })

  test('a /model change makes the new model home', async ($, on) => {
    const w = world(on, { classifier: { fails: 'unanswered' } })

    await turn($, 't1', 'git status')
    await turn($, 't2', 'what about the other one then', { model: SONNET })

    expect(w.models).toEqual([HAIKU, SONNET])
  })

  test('an unknown model id is never rewritten', async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'git status', { model: 'corp-gateway-default' })

    expect(w.models).toEqual(['corp-gateway-default'])
  })

  test('a step with no plan, after a reload mid-turn, is passed through', async ($, on) => {
    const w = world(on)

    await step($, 'orphan', 3, OPUS)

    expect(w.models).toEqual([OPUS])
  })
})

describe('context and cache economics', () => {
  test('a long context keeps haiku out of the main loop', async ($, on) => {
    const w = world(on, { context: 300_000, sessionTokens: 300_000 })

    await turn($, 't1', 'Design the architecture for the sync engine and weigh the trade-offs')
    await turn($, 't2', 'git status')

    expect(w.models).toEqual([OPUS, OPUS])
  })

  test('after compaction the smaller context makes the detour worth it again', async ($, on) => {
    const w = world(on, { context: 300_000, sessionTokens: 300_000 })

    await turn($, 't1', 'Design the architecture for the sync engine and weigh the trade-offs')
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'long history', toolUses: [] }] })
    w.set({ context: 30_000, sessionTokens: 30_000 })
    await turn($, 't2', 'git status')

    expect(w.models).toEqual([OPUS, HAIKU])
  })
})

describe('pins, overrides and /clear', () => {
  test('a pin survives /clear, ::auto removes it', async ($, on) => {
    const w = world(on)

    const pinned = await turn($, 't0', '::sonnet')
    expect(pinned.drop).toContain('pinned to sonnet')
    await turn($, 't1', 'git status')
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
    await turn($, 't2', 'Design the architecture for the sync engine and weigh the trade-offs')
    const unpinned = await turn($, 't3', '::auto')
    expect(unpinned.drop).toContain('automatic')
    await turn($, 't4', 'git status')

    expect(w.models).toEqual([SONNET, SONNET, HAIKU])
  })

  test('overrides are case-insensitive and last one turn', async ($, on) => {
    const w = world(on)

    await turn($, 't1', '::FABLE Investigate the root cause of the crash')
    await turn($, 't2', 'Investigate the root cause of the crash')

    expect(w.models).toEqual([FABLE, OPUS])
  })

  test('an override typed into a running turn does not leak into the next turn', async ($, on) => {
    const w = world(on)

    await $.turn.start({ turnId: 't1', text: 'Investigate the root cause of the crash' })
    await step($, 't1', 0)
    const folded = await $.prompt.submit({ text: '::haiku also check the logs', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
    await step($, 't1', 1)
    await turn($, 't2', 'Investigate the root cause of the crash')

    expect(folded.text).toBe('also check the logs')
    expect(w.models).toEqual([OPUS, OPUS, OPUS])
  })

  test('/route pins and unpins too', async ($, on) => {
    const w = world(on)

    expect((await route($, 'haiku')).text).toContain('pinned to haiku')
    await turn($, 't1', 'Design the architecture for the sync engine and weigh the trade-offs')
    await route($, 'auto')
    await turn($, 't2', 'Design the architecture for the sync engine and weigh the trade-offs')

    expect(w.models).toEqual([HAIKU, OPUS])
  })
})

describe('classifier', () => {
  test('a classifier that fails or throws leaves the turn on home', async ($, on) => {
    const w = world(on, { classifier: { fails: 'unanswered' } })

    await turn($, 't1', 'hmm, any thoughts on how this module is named?')
    w.set({ classifier: { fails: 'throws' } })
    await turn($, 't2', 'and what about the folder layout we discussed?')

    expect(w.models).toEqual([OPUS, OPUS])
    expect(w.classifierCalls).toBe(2)
  })

  test('the classifier is not asked when it cannot change the outcome', { options: { minTier: 'opus' } }, async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'hmm, any thoughts on how this module is named?')

    expect(w.classifierCalls).toBe(0)
  })

  test('the classifier can be switched off', { options: { classifier: false } }, async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'hmm, any thoughts on how this module is named?')

    expect(w.classifierCalls).toBe(0)
    expect(w.models).toEqual([OPUS])
  })
})

describe('modes and floors', () => {
  test('mainLoop off leaves every turn alone', { options: { mainLoop: 'off' } }, async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'git status')

    expect(w.models).toEqual([OPUS])
  })

  test('minTier sonnet never sends a turn to haiku', { options: { minTier: 'sonnet' } }, async ($, on) => {
    const w = world(on, { context: 8_000, sessionTokens: 8_000 })

    await turn($, 't1', 'git status')

    expect(w.models).not.toContain(HAIKU)
  })

  test('custom model ids are used for the tiers', { options: { haikuModel: 'anthropic.claude-haiku-5-5' } }, async ($, on) => {
    const w = world(on)

    await turn($, 't1', 'git status')

    expect(w.models).toEqual(['anthropic.claude-haiku-5-5'])
  })
})

describe('subagents', () => {
  test('each agent type gets its model; explicit, fork and foreign agents are left alone', async ($, on) => {
    const w = world(on, { classifier: { answer: 'sonnet' } })

    await spawn($, 'Explore', 'Find where the config is loaded')
    await spawn($, 'general-purpose', 'Investigate the root cause of the deadlock in the worker pool')
    await spawn($, 'general-purpose', 'Implement the CSV export function and write tests for it')
    await spawn($, 'general-purpose', 'Tidy things up a bit around here please, whatever makes sense')
    await spawn($, 'general-purpose', 'Summarise the README', 'haiku')
    await spawn($, 'fork', 'continue in parallel')
    await spawn($, 'telegram-crm:extractor', 'extract contacts')

    expect(w.spawned).toEqual([HAIKU, OPUS, SONNET, SONNET, 'haiku', undefined, undefined])
    expect(w.classifierCalls).toBe(2)
  })

  test('a coding subagent is never sent below sonnet by the classifier', async ($, on) => {
    const w = world(on, { classifier: { answer: 'haiku' } })

    await spawn($, 'general-purpose', 'Implement subtract(a, b) in calc.py next to add')
    await spawn($, 'general-purpose', 'Tidy things up a bit around here please, whatever makes sense')

    expect(w.spawned).toEqual([SONNET, HAIKU])
  })

  test('subagents off, or an unknown parent model, leaves spawns alone', { options: { subagents: 'off' } }, async ($, on) => {
    const w = world(on)

    await spawn($, 'Explore', 'Find where the config is loaded')

    expect(w.spawned).toEqual([undefined])
  })

  test('main-loop and subagent steps running at once are both accounted', async ($, on) => {
    const w = world(on, { classifier: { answer: 'sonnet' } })

    await spawn($, 'general-purpose', 'Implement the CSV export function and write tests for it')
    await $.prompt.submit({ text: 'git status', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ turnId: 't1', text: 'git status' })
    await Promise.all([step($, 't1', 0, OPUS), step($, 'sub-1', 0, SONNET, 'agent-1'), step($, 'sub-1', 1, SONNET, 'agent-1')])

    const status = (await route($)).text
    expect(w.models).toEqual([HAIKU])
    expect(w.subagentModels).toEqual([SONNET, SONNET])
    expect(status).toContain('main-loop requests: haiku 1')
    expect(status).toContain('subagents: haiku 0, sonnet 1')
    expect(status).toMatch(/saved \$0\.\d{3} \(\d+%\)/)
  })
})

describe('reporting', () => {
  test('/route and /route log read cleanly', async ($, on) => {
    const w = world(on)

    expect((await route($, 'log')).text).toContain('no decisions yet')
    await turn($, 't1', 'git status')
    await turn($, 't2', 'Design the architecture for the sync engine and weigh the trade-offs')

    const status = (await route($)).text
    const log = (await route($, 'log')).text
    expect(status).not.toMatch(/NaN|undefined|\$-0/)
    expect(log).toContain('opus → haiku')
    expect(log).toContain('haiku → opus')
    expect(w.statuses.filter(Boolean).every(s => !/\$-0|NaN/.test(s ?? ''))).toBe(true)
  })
})

describe('prices', () => {
  test('/route shows the built-in prices and their age', async ($, on) => {
    const w = world(on)
    await w.clock.set(Date.parse('2026-10-20T00:00:00Z'))

    const status = (await route($)).text

    expect(status).toContain('built-in, as of 2026-10-06, 14 days old')
    expect(status).toContain('opus 4/20/0.2')
    expect(status).not.toContain('⚠')
  })

  test('stale prices warn at session start and in /route', async ($, on) => {
    const w = world(on)
    await w.clock.set(Date.parse('2027-03-01T00:00:00Z'))

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

    expect(w.toasts.join()).toContain('days old')
    expect((await route($)).text).toContain('⚠ prices are 146 days old')
  })

  test(
    'prices from settings drive the routing and are labelled',
    { options: { prices: 'haiku=4/20/0.2', pricesAsOf: '2026-10-10' } },
    async ($, on) => {
      const w = world(on)
      await w.clock.set(Date.parse('2026-10-20T00:00:00Z'))

      await turn($, 't1', 'Design the architecture for the sync engine and weigh the trade-offs')
      await turn($, 't2', 'git status')

      expect(w.models).toEqual([OPUS, OPUS])
      expect((await route($)).text).toContain('from your settings, as of 2026-10-10, 10 days old): haiku 4/20/0.2')
    },
  )

  test('a malformed price line or a missing date is reported', { options: { prices: 'opus=4/20' } }, async ($, on) => {
    const w = world(on)

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

    const status = (await route($)).text
    expect(status).toContain('⚠ ignored price entry "opus=4/20"')
    expect(status).toContain('⚠ set pricesAsOf')
    expect(w.toasts.length).toBe(1)
  })
})
