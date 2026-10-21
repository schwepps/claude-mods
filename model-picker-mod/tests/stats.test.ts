import { describe, expect, test } from 'claude-code/testing'

import { emptyDay, normalizeDay } from '../hooks/stats'

describe('normalizeDay', () => {
  test('a day stored before spend tracking reads with empty spend and sessions', () => {
    const old = {
      actual: 1.5,
      baseline: 2,
      overhead: 0.01,
      main: { haiku: 1, sonnet: 0, opus: 3, fable: 0 },
      subagents: { haiku: 0, sonnet: 1, opus: 0, fable: 0 },
      switches: 1,
      escalations: 0,
    }
    const day = normalizeDay(old)
    expect(day.actual).toBe(1.5)
    expect(day.main.opus).toBe(3)
    expect(day.spend).toEqual({ haiku: 0, sonnet: 0, opus: 0, fable: 0 })
    expect(day.sessions).toEqual({})
  })

  test('nothing stored reads as an empty day', () => {
    expect(normalizeDay(undefined)).toEqual(emptyDay())
  })
})
