import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const OPUS = 'claude-opus-5-5'
export const SONNET = 'claude-sonnet-5-5'
export const HAIKU = 'claude-haiku-5-5'
export const FABLE = 'claude-fable-5-1'

export type ClassifierBehaviour = { answer: string } | { fails: 'unanswered' | 'throws' }

export type World = {
  clock: MockClock
  models: string[]
  efforts: (string | number | undefined)[]
  subagentModels: string[]
  spawned: (string | undefined)[]
  toasts: string[]
  statuses: (string | undefined)[]
  classifierCalls: number
  set: (next: Partial<WorldKnobs>) => void
}

export type WorldKnobs = {
  context: number
  sessionTokens: number
  classifier: ClassifierBehaviour
  sessionId: string
}

export function world(on: On, initial: Partial<WorldKnobs> = {}): World {
  let knobs: WorldKnobs = { context: 40_000, sessionTokens: 40_000, classifier: { answer: 'opus' }, sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', ...initial }
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    models: [],
    efforts: [],
    subagentModels: [],
    spawned: [],
    toasts: [],
    statuses: [],
    classifierCalls: 0,
    set: next => {
      knobs = { ...knobs, ...next }
    },
  }
  mock.store(on)
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'route' } }))
  on('command.run', () => ({ text: '' }))
  on('model.complete', () => {
    w.classifierCalls += 1
    const c = knobs.classifier
    if ('fails' in c && c.fails === 'throws') throw new Error('classifier down')
    const usage = { input_tokens: 300, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if ('fails' in c) return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage } }
    return { value: { isAnswered: true as const, text: c.answer, usage } }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: knobs.sessionTokens, window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.id', () => ({ value: knobs.sessionId }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.call', ($, e) =>
    String((e as { command?: string }).command ?? '').includes('fail')
      ? { result: 'exit 1', isError: true as const, text: 'command failed' }
      : { result: 'ok', text: 'ok' },
  )
  on('agent.spawn', ($, e) => {
    w.spawned.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: `agent-${w.spawned.length}` }
  })
  on('turn.step', async function* ($, e) {
    ;(e.agentId === undefined ? w.models : w.subagentModels).push(e.model)
    if (e.agentId === undefined) w.efforts.push(e.effort)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: 50,
        output_tokens: 800,
        cache_read_input_tokens: knobs.context - 1_050,
        cache_creation_input_tokens: 1_000,
        model: e.model,
      },
    }
  })
  return w
}

export async function step($: Engine, turnId: string, index: number, model = OPUS, agentId?: string) {
  const stream = $.turn.step({ turnId, index, model, effort: 'high', messageCount: 4, ...(agentId ? { agentId } : {}) })
  for await (const _chunk of stream) {
  }
  return stream.result
}

export type TurnScript = {
  model?: string
  /** Bash commands run after the first step; a command containing "fail" errors. */
  commands?: string[]
  /** Models the engine names for the steps after the first. */
  laterSteps?: string[]
}

export async function turn($: Engine, turnId: string, text: string, script: TurnScript = {}) {
  const home = script.model ?? OPUS
  const submitted = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  if (submitted.drop !== undefined) return submitted
  await $.turn.start({ turnId, text: submitted.text })
  await step($, turnId, 0, home)
  for (const command of script.commands ?? []) {
    await $.tool.call({ tool: 'Bash', command })
  }
  let index = 1
  for (const model of script.laterSteps ?? (script.commands?.length ? [home] : [])) {
    await step($, turnId, index++, model)
  }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 1000, isAborted: false, reason: 'answer' })
  return submitted
}

export function route($: Engine, args = '') {
  return $.command.run({
    command: 'route',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 160 },
  })
}

export function spawn($: Engine, subagentType: string, prompt: string, model?: string, parentModel = OPUS) {
  return $.agent.spawn({
    tool_use_id: `tu-${subagentType}`,
    prompt,
    description: prompt.slice(0, 30),
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel,
    background: false,
    fork: subagentType === 'fork',
    ...(model ? { model } : {}),
  })
}
