import { describe, expect, mock, test } from 'claude-code/testing'

import { UI_REV } from '../hooks/register'
import { NO_PROJECT, familyOf, mergeHistory, modelKey, modelLabel, parseAliases, projectResolver, series, total } from '../hooks/data'

const NOW = new Date(2026, 9, 14, 15, 30).getTime()

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object') return Object.values(node as Record<string, unknown>).map(textOf).join(' ')
  return ''
}

const PANE = {
  plugin: 'agent-ops',
  component: 'Pane',
  requestId: 'agent-ops',
  props: {
    title: 'Agent Ops',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

describe('model names', () => {
  test('families and labels come from the model id', () => {
    expect(familyOf('claude-opus-5-5')).toBe('opus')
    expect(familyOf('claude-haiku-5-5')).toBe('haiku')
    expect(familyOf('gpt-x')).toBe('other')
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelLabel('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(modelLabel(null)).toBe('Unknown model')
  })

  test('buckets are keyed by version so older models stay separate', () => {
    expect(modelKey('claude-opus-5-5')).toBe('opus-5-5')
    expect(modelKey('claude-opus-5')).toBe('opus-5')
    expect(modelKey('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
    expect(modelKey('claude-3-5-sonnet-20241022')).toBe('sonnet-3-5')
    expect(modelKey('claude-fable-5-1[1m]')).toBe('fable-5-1')
    expect(modelKey('opus')).toBe('opus')
    expect(modelKey('<synthetic>')).toBe('other')
    expect(modelLabel('opus-5-5')).toBe('Opus 5.5')
    expect(familyOf('opus-5-5')).toBe('opus')
  })
})

describe('projects', () => {
  test('related repos merge into the repo they extend, folder-less sessions together, aliases first', () => {
    const repos = ['acme-app', 'aws-iac-acme-app', 'billing-api', 'aws-iac-billing-api', 'notes', 'scratch-2026-10-14-60e031']
    const resolve = projectResolver(repos, parseAliases('notes = communication, broken'))
    expect(resolve('aws-iac-acme-app')).toBe('acme-app')
    expect(resolve('aws-iac-billing-api')).toBe('billing-api')
    expect(resolve('acme-app')).toBe('acme-app')
    expect(resolve('scratch-2026-10-14-60e031')).toBe(NO_PROJECT)
    expect(resolve('notes')).toBe('communication')
    expect(resolve(null)).toBe(NO_PROJECT)
  })
})

describe('history', () => {
  test('merging adds usage per hour and drops entries past the retention window', () => {
    const merged = mergeHistory(
      { '2026-10-14T09': { opus: [100, 10, 5] }, '2023-01-01T00': { haiku: [1, 1, 1] } },
      { '2026-10-14T09': { opus: [50, 5, 0], sonnet: [20, 2, 0] } },
      NOW,
    )
    expect(merged['2026-10-14T09']).toEqual({ opus: [150, 15, 5], sonnet: [20, 2, 0] })
    expect(merged['2023-01-01T00']).toBeUndefined()
  })

  test('versions of one family merge per key and still fold into the family totals', () => {
    const merged = mergeHistory(
      { '2026-10-14T09': { 'opus-5': [100, 10, 0, 1.0] } },
      { '2026-10-14T09': { 'opus-5': [50, 5, 0, 0.5], 'opus-5-5': [20, 2, 0, 0.2] } },
      NOW,
    )
    expect(merged['2026-10-14T09']).toEqual({ 'opus-5': [150, 15, 0, 1.5], 'opus-5-5': [20, 2, 0, 0.2] })
    const day = series(merged, 'day', NOW).points[9]!
    expect(day.byFamily.opus).toBe(187)
    expect(Math.round(day.usdByModel['opus-5']! * 10)).toBe(15)
    expect(Math.round(day.usdByModel['opus-5-5']! * 10)).toBe(2)
  })

  test('the year range draws twelve months and keeps history older than the month view reaches', () => {
    const h = { '2026-10-14T09': { 'opus-5-5': [100, 0, 0] }, '2026-03-02T12': { 'opus-5': [40, 0, 0] }, '2025-10-20T12': { 'sonnet-4-5': [7, 0, 0] } }
    const s = series(h, 'year', NOW)
    expect(s.points).toHaveLength(12)
    expect(total(s.points[11]!)).toBe(100)
    expect(total(s.points[4]!)).toBe(40)
    expect(s.previousTotal).toBe(7)
  })

  test('the week range sums each day and compares with the week before', () => {
    const h = { '2026-10-14T09': { opus: [100, 20, 0] }, '2026-10-13T22': { haiku: [30, 0, 0] }, '2026-10-05T10': { opus: [60, 0, 0] } } as const
    const s = series(JSON.parse(JSON.stringify(h)), 'week', NOW)
    expect(s.points).toHaveLength(7)
    expect(total(s.points[6]!)).toBe(120)
    expect(total(s.points[5]!)).toBe(30)
    expect(s.previousTotal).toBe(60)
  })

  test('the day range marks hours after now as future', () => {
    const s = series({}, 'day', NOW)
    expect(s.points[15]!.isFuture).toBe(false)
    expect(s.points[16]!.isFuture).toBe(true)
  })
})

test('the pane draws on terminal and desktop, and the tabs and ranges switch the view', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await clock.advance(2000)
    expect(textOf(await ui.drawn({ in: `dash-top-${UI_REV}` }))).toMatch(/AGENT\/OPS/)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `tab-usage-${UI_REV}` })
    await clock.advance(2000)
    expect(textOf(await ui.drawn({ in: `dash-usage-${UI_REV}` }))).toMatch(/AVG PER HOUR/)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `range-week-${UI_REV}` })
    await clock.advance(2000)
    expect(textOf(await ui.drawn({ in: `dash-usage-${UI_REV}` }))).toMatch(/AVG PER DAY/)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `range-day-${UI_REV}` })
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `tab-agents-${UI_REV}` })
    await ui.unmount()
  }
})

test('this session and other sessions show up as live cards, usage and economics come from the scan', { options: { planMonthlyUsd: 200 } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.id', () => ({ value: 'this-session' }))
  on('session.cwd', () => ({ value: '/home/u/work/acme-app/.claude/worktrees/brave-otter-1a2b3c' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Find auth call sites', type: 'Explore', status: 'running' as const }],
  }))
  const scanned = {
    agents: [
      {
        id: 'other:main', name: 'Build T42 dashboard page', type: 'session', session: null, project: 'acme-app · feat/t42',
        status: 'waiting', model: 'claude-opus-5-5', effort: 'medium', tokensIn: 300000, tokensOut: 84000, cacheRead: 0, costUsd: 13.93,
        progress: { done: 3, total: 5 }, steps: 40, activity: 'Bash git push', startedAt: NOW - 60000, lastAt: NOW, repo: 'aws-iac-acme-app',
      },
    ],
    hist: { '2026-10-14T15': { 'haiku-5-5': [1200, 300, 9000] }, '2026-10-14T14': { 'opus-5-5': [1000, 500, 100000, 12.5, 0.1, 2.4, 2.0, 8.0] } },
    selfUsd: 3.25,
    pricing: [{ model: 'claude-sonnet-5-5', as: 'sonnet-5', tokens: 1000 }, { model: 'claude-opus-6', as: null, tokens: 2500 }],
    projects: {
      'acme-app': { hist: { '2026-10-14T14': { 'opus-5-5': [1000, 500, 100000, 12.5, 0.1, 2.4, 2.0, 8.0] } }, sessions: { '2026-10-14': ['other'] } },
      'aws-iac-acme-app': { hist: { '2026-10-14T15': { 'haiku-5-5': [1200, 300, 9000] } }, sessions: { '2026-10-14': ['other', 'infra'] } },
      notes: { hist: { '2026-10-13T12': { 'opus-4-5': [10, 10, 10, 1.0, 0, 0.5, 0.25, 0.25] } }, sessions: { '2026-10-13': ['notes1'] } },
    },
    at: NOW,
  }
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(scanned), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'x'.repeat(400) }
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-haiku-5-5', input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
    }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1, agentId: 'a1' })) void _
  await clock.advance(3000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await clock.advance(3000)
    await ui.advance(3000)
    const cards = textOf(await ui.drawn({ in: `dash-agents-${UI_REV}` }))
    expect(cards).toMatch(/\$13\.93/)
    expect(cards).toMatch(/\$3\.25/)
    expect(cards).toMatch(/Find auth call sites/)
    expect(cards).toMatch(/Haiku 5\.5/)
    expect(cards).toMatch(/Build T42 dashboard page/)
    expect(cards).toMatch(/Opus 5\.5/)
    expect(cards).toMatch(/60%/)
    expect(cards).toMatch(/▲ Waiting \d+s/)
    expect(cards).toMatch(/1 waiting \d+s/)
    expect(cards).toMatch(/acme-app/)
    expect(cards).toMatch(/2 sessions · 1 running · 1 waiting/)
    expect(cards).toMatch(/\$12\.50 today/)
    expect(textOf(await ui.drawn({ in: `proj-1-${UI_REV}` }))).toMatch(/acme-app {2}● 2/)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `tab-usage-${UI_REV}` })
    await clock.advance(3000)
    await ui.advance(3000)
    const usage = textOf(await ui.drawn({ in: `dash-usage-${UI_REV}` }))
    expect(usage).toMatch(/109\.0k/)
    expect(usage).toMatch(/Opus/)
    expect(usage).not.toMatch(/Fable|Sonnet/)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `tab-economics-${UI_REV}` })
    await clock.advance(3000)
    await ui.advance(3000)
    const econ = textOf(await ui.drawn({ in: `dash-economics-${UI_REV}` }))
    expect(econ).toMatch(/\$12\.50/)
    expect(econ).toMatch(/Opus 5\.5/)
    expect(econ).toMatch(/Sonnet 5\.5 \(claude-sonnet-5-5\) has no price row; priced as Sonnet 5/)
    expect(econ).toMatch(/claude-opus-6 has no price row; its 2\.5k tokens are counted at \$0/)
    expect(econ).toMatch(/\$8\.00/)
    expect(econ).toMatch(/Cache reads are 97% of tokens but 64% of the cost/)
    expect(econ).toMatch(/1\.9×/)
    expect(econ).toMatch(/\$5\.83 saved/)
    expect(econ).toMatch(/COST BY PROJECT/)
    expect(econ).toMatch(/acme-app is 100% of the cost/)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `proj-1-${UI_REV}` })
    await clock.advance(1000)
    await ui.advance(3000)
    const scoped = textOf(await ui.drawn({ in: `dash-economics-${UI_REV}` }))
    expect(scoped).toMatch(/ACME-APP/)
    expect(scoped).not.toMatch(/COST BY PROJECT/)
    expect(scoped).toMatch(/SHARE OF TOTAL SPEND/)
    expect(scoped).toMatch(/100%/)
    expect(scoped).not.toMatch(/LAST 30 DAYS|VALUE FROM YOUR PLAN/)
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `proj-0-${UI_REV}` })
    await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: `tab-agents-${UI_REV}` })
    await ui.unmount()
  }
})

test('a session starts without opening the pane or scanning; /agent-ops opens it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/u' })
  let opened = 0
  let scans = 0
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true as const } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.id', () => ({ value: 'this-session' }))
  on('session.cwd', () => ({ value: '/home/u/work/app' }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => {
    scans += 1
    return { value: { exitCode: 0, stdout: JSON.stringify({ agents: [], hist: {}, projects: {}, selfUsd: 0, at: NOW }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  expect(opened).toBe(0)
  expect(scans).toBe(0)
  await $.command.run({ command: 'agent-ops', args: '' })
  await clock.advance(10)
  expect(opened).toBe(1)
  expect(scans).toBe(1)
  await clock.advance(6_000)
  expect(scans).toBe(3)
})
