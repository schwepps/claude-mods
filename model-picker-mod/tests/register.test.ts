import { expect, test } from 'claude-code/testing'

import { HAIKU, OPUS, SONNET, route, spawn, turn, world } from './harness'

test('a git prompt detours to haiku and a design prompt returns to the home model', async ($, on) => {
  const w = world(on)

  await turn($, 't1', 'git status')
  await turn($, 't2', 'Design the architecture for the plugin system and weigh the trade-offs')

  expect(w.models).toEqual([HAIKU, OPUS])
})

test('shadow mode logs but never changes the model', { options: { mainLoop: 'shadow' } }, async ($, on) => {
  const w = world(on)

  await turn($, 't1', 'git status')

  expect(w.models).toEqual([OPUS])
  expect((await route($, 'log')).text).toContain('opus → haiku (shadow)')
})

test('::sonnet alone pins the session and is not sent to the model', async ($, on) => {
  const w = world(on)

  const dropped = await turn($, 't0', '::sonnet')
  expect(dropped.drop).toContain('pinned to sonnet')

  await turn($, 't1', 'Design the architecture for the plugin system')
  expect(w.models).toEqual([SONNET])
})

test('an inline override applies to one turn and is stripped from the prompt', async ($, on) => {
  const w = world(on)

  const entered = await turn($, 't1', '::haiku explain this regex')

  expect(entered.text).toBe('explain this regex')
  expect(w.models).toEqual([HAIKU])
})

test('Explore subagents are spawned on haiku', async ($, on) => {
  const w = world(on)

  await spawn($, 'Explore', 'Find where the config is loaded')

  expect(w.spawned).toEqual([HAIKU])
})
