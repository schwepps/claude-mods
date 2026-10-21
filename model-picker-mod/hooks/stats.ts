import type { EngineInterface } from 'claude-code'

import type { DecisionEntry } from '../types'
import { TIERS } from './policy'
import type { Tier } from './policy'

type $ = EngineInterface

export type SpendByTier = Record<Tier, number>

export type SessionSpend = { label: string; spend: SpendByTier }

export type DayStats = {
  actual: number
  baseline: number
  overhead: number
  main: Record<Tier, number>
  subagents: Record<Tier, number>
  spend: SpendByTier
  sessions: Record<string, SessionSpend>
  switches: number
  escalations: number
}

export const LOG_SIZE = 100
export const STATS_DAYS = 30
const DAY_MS = 86_400_000
const SESSIONS_SHOWN = 10
const LABEL_LENGTH = 60
const SESSION_ID_LENGTH = 8

export const emptyCounts = (): Record<Tier, number> => ({ haiku: 0, sonnet: 0, opus: 0, fable: 0 })

export const emptyDay = (): DayStats => ({
  actual: 0,
  baseline: 0,
  overhead: 0,
  main: emptyCounts(),
  subagents: emptyCounts(),
  spend: emptyCounts(),
  sessions: {},
  switches: 0,
  escalations: 0,
})

/** A stored day, filled out with fields added after it was written. */
export function normalizeDay(stored: Partial<DayStats> | undefined): DayStats {
  return { ...emptyDay(), ...stored }
}

export const dayKey = (ms: number) => `stats:${new Date(ms).toISOString().slice(0, 10)}`

export const shortSession = (id: string) => id.slice(0, SESSION_ID_LENGTH)

export function money(usd: number): string {
  const abs = Math.abs(usd)
  const text = `$${abs.toFixed(abs < 1 ? 3 : 2)}`
  return usd <= -0.0005 ? `-${text}` : text
}

// Main-loop and subagent steps run concurrently; $.store has no versioning, so writes queue here.
let storeQueue: Promise<unknown> = Promise.resolve()

export function serially<T>(work: () => Promise<T>): Promise<T> {
  const run = storeQueue.then(work, work)
  storeQueue = run.catch(() => undefined)
  return run
}

export async function readDay($: $, ms: number): Promise<DayStats> {
  return normalizeDay((await $.store.get(dayKey(ms))) as Partial<DayStats> | undefined)
}

export function bumpDay($: $, fn: (d: DayStats) => void) {
  return serially(async () => {
    const now = await $.clock.now()
    const day = await readDay($, now)
    fn(day)
    await $.store.set(dayKey(now), day)
  })
}

export function logDecision($: $, entry: DecisionEntry) {
  return serially(async () => {
    const log = ((await $.store.get('log')) as DecisionEntry[] | undefined) ?? []
    await $.store.set('log', [...log, entry].slice(-LOG_SIZE))
  })
}

export function addSpend(day: DayStats, session: string, label: string, tier: Tier, usd: number) {
  day.spend[tier] += usd
  const record = day.sessions[session] ?? { label: '', spend: emptyCounts() }
  record.spend[tier] += usd
  if (record.label === '' && label !== '') record.label = label.slice(0, LABEL_LENGTH)
  day.sessions[session] = record
}

export const totalOf = (spend: SpendByTier) => TIERS.reduce((sum, t) => sum + spend[t], 0)

/** `haiku $0.001 · opus $0.120`, tiers with no spend left out. */
export function describeSpend(spend: SpendByTier): string {
  const parts = TIERS.filter(t => spend[t] > 0).map(t => `${t} ${money(spend[t])}`)
  return parts.length > 0 ? parts.join(' · ') : 'none'
}

export async function lastDays($: $, now: number, count: number): Promise<DayStats[]> {
  const days: DayStats[] = []
  for (let i = 0; i < count; i++) {
    const stored = await $.store.get(dayKey(now - i * DAY_MS))
    if (stored) days.push(normalizeDay(stored as Partial<DayStats>))
  }
  return days
}

export function sumSpend(days: DayStats[]): SpendByTier {
  const spend = emptyCounts()
  for (const day of days) for (const t of TIERS) spend[t] += day.spend[t]
  return spend
}

export function describeSessions(days: DayStats[]): string {
  const merged: Record<string, SessionSpend> = {}
  for (const day of days) {
    for (const [id, s] of Object.entries(day.sessions)) {
      const into = merged[id] ?? { label: '', spend: emptyCounts() }
      for (const t of TIERS) into.spend[t] += s.spend[t]
      if (into.label === '') into.label = s.label
      merged[id] = into
    }
  }
  const rows = Object.entries(merged)
    .sort(([, a], [, b]) => totalOf(b.spend) - totalOf(a.spend))
    .slice(0, SESSIONS_SHOWN)
  if (rows.length === 0) return 'Model router: no session spend recorded yet.'
  const lines = rows.map(([id, s]) => {
    const label = s.label ? `  “${s.label}”` : ''
    return `  ${shortSession(id).padEnd(SESSION_ID_LENGTH)}  ${money(totalOf(s.spend)).padStart(8)}  ${describeSpend(s.spend)}${label}`
  })
  return ['Sessions, last 7 days (estimated at API list prices, most expensive first):', ...lines].join('\n')
}
