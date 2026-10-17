import type { Bucket, History, ModelFamily, Range, RepoHistory, Usage } from '../types'

export const FAMILIES: readonly ModelFamily[] = ['opus', 'sonnet', 'haiku', 'fable', 'other']

export const FAMILY_COLOR: Record<ModelFamily, string> = {
  opus: '#a593ff',
  sonnet: '#4fd1ff',
  haiku: '#3ee0a0',
  fable: '#ffb547',
  other: '#8e9bb6',
}

export const FAMILY_LABEL: Record<ModelFamily, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  other: 'Other',
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const HISTORY_DAYS = 760

/** Bucket key of a model id: family plus version ("opus-5-5"), the bare family without a version, "other" when unknown. */
export function modelKey(model: string | null): string {
  const m = (model ?? '').toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
  const f = familyOf(m)
  if (f === 'other') return 'other'
  const hit = m.split(f)[1]?.match(/^-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/) ?? m.match(new RegExp(`claude-(\\d{1,2})(?:-(\\d{1,2}))?-${f}`))
  return hit ? [f, hit[1], hit[2]].filter(Boolean).join('-') : f
}

export function familyOf(model: string | null): ModelFamily {
  const m = (model ?? '').toLowerCase()
  for (const f of FAMILIES) if (f !== 'other' && m.includes(f)) return f
  return 'other'
}

export function modelLabel(model: string | null): string {
  if (!model) return 'Unknown model'
  const f = familyOf(model)
  if (f === 'other') return model
  const version = modelKey(model).slice(f.length + 1).replace('-', '.')
  return version ? `${FAMILY_LABEL[f]} ${version}` : FAMILY_LABEL[f]
}

export function effortLevel(effort: string | null): number {
  if (!effort) return 0
  const i = (EFFORTS as readonly string[]).indexOf(effort)
  return i < 0 ? 0 : i + 1
}

const pad = (n: number) => String(n).padStart(2, '0')

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function hourKey(ms: number): string {
  const d = new Date(ms)
  return `${dayKey(d)}T${pad(d.getHours())}`
}

export function addUsage(into: Bucket, key: string, u: Usage): void {
  const cur = into[key] ?? []
  into[key] = Array.from({ length: Math.max(cur.length, u.length) }, (_, i) => (cur[i] ?? 0) + (u[i] ?? 0))
}

/** USD columns of a Usage: total, uncached input, output, cache writes, cache reads. */
export const USD = { total: 3, input: 4, output: 5, write: 6, read: 7 } as const

export function bucketTotals(b: Bucket | undefined): { tokens: number; usd: number } {
  let tokens = 0
  let usd = 0
  for (const u of Object.values(b ?? {})) {
    tokens += (u[0] ?? 0) + (u[1] ?? 0)
    usd += u[USD.total] ?? 0
  }
  return { tokens, usd }
}

export function tokensByFamily(b: Bucket): Record<ModelFamily, number> {
  const out = zeroFamilies()
  for (const [key, u] of Object.entries(b)) out[familyOf(key)] += (u[0] ?? 0) + (u[1] ?? 0)
  return out
}

export function mergeHistory(base: History, delta: History, nowMs: number): History {
  const out: History = { ...base }
  for (const [k, bucket] of Object.entries(delta)) {
    const merged: Bucket = { ...(out[k] ?? {}) }
    for (const [key, u] of Object.entries(bucket)) addUsage(merged, key, u)
    out[k] = merged
  }
  const cutoff = dayKey(new Date(nowMs - HISTORY_DAYS * 86_400_000))
  for (const k of Object.keys(out)) if (k.slice(0, 10) < cutoff) delete out[k]
  return out
}

export type Point = {
  label: string
  full: string
  isFuture: boolean
  byFamily: Record<ModelFamily, number>
  cacheRead: number
  usd: number
  usdByFamily: Record<ModelFamily, number>
  tokensByModel: Record<string, number>
  usdByModel: Record<string, number>
  /** Tokens and USD by kind: input incl. cache writes, output, cache reads. */
  kinds: { inputTokens: number; outputTokens: number; readTokens: number; inputUsd: number; outputUsd: number; readUsd: number }
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const zeroFamilies = (): Record<ModelFamily, number> => ({ opus: 0, sonnet: 0, haiku: 0, fable: 0, other: 0 })

function emptyPoint(label: string, full: string, isFuture: boolean): Point {
  return {
    label,
    full,
    isFuture,
    byFamily: zeroFamilies(),
    cacheRead: 0,
    usd: 0,
    usdByFamily: zeroFamilies(),
    tokensByModel: {},
    usdByModel: {},
    kinds: { inputTokens: 0, outputTokens: 0, readTokens: 0, inputUsd: 0, outputUsd: 0, readUsd: 0 },
  }
}

function addBucket(p: Point, b: Bucket | undefined): void {
  if (!b) return
  for (const [key, u] of Object.entries(b)) {
    const f = familyOf(key)
    const at = (i: number) => u[i] ?? 0
    p.byFamily[f] += at(0) + at(1)
    p.tokensByModel[key] = (p.tokensByModel[key] ?? 0) + at(0) + at(1)
    p.usdByModel[key] = (p.usdByModel[key] ?? 0) + at(USD.total)
    p.cacheRead += at(2)
    p.usd += at(USD.total)
    p.usdByFamily[f] += at(USD.total)
    p.kinds.inputTokens += at(0)
    p.kinds.outputTokens += at(1)
    p.kinds.readTokens += at(2)
    p.kinds.inputUsd += at(USD.input) + at(USD.write)
    p.kinds.outputUsd += at(USD.output)
    p.kinds.readUsd += at(USD.read)
  }
}

function dayPoint(history: History, d: Date, label: string): Point {
  const key = dayKey(d)
  const p = emptyPoint(label, `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`, false)
  for (let h = 0; h < 24; h++) addBucket(p, history[`${key}T${pad(h)}`])
  return p
}

/** The points a range draws, plus the same-length period before it for comparison. */
export function series(history: History, range: Range, nowMs: number): { points: Point[]; previousTotal: number } {
  const now = new Date(nowMs)
  if (range === 'day') {
    const key = dayKey(now)
    const points = Array.from({ length: 24 }, (_, h) => {
      const p = emptyPoint(pad(h), `${pad(h)}:00–${pad((h + 1) % 24)}:00`, h > now.getHours())
      addBucket(p, history[`${key}T${pad(h)}`])
      return p
    })
    const yesterday = new Date(nowMs - 86_400_000)
    return { points, previousTotal: total(dayPoint(history, yesterday, '')) }
  }
  if (range === 'year') return yearSeries(history, now)
  const n = range === 'week' ? 7 : 30
  const at = (back: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12)
  const points = Array.from({ length: n }, (_, i) => {
    const d = at(n - 1 - i)
    return dayPoint(history, d, n === 7 ? DOW[d.getDay()]! : String(d.getDate()))
  })
  let previousTotal = 0
  for (let i = 0; i < n; i++) previousTotal += total(dayPoint(history, at(n + i), ''))
  return { points, previousTotal }
}

function monthPoint(history: History, year: number, month: number, label: string, isFuture: boolean): Point {
  const prefix = `${year}-${pad(month + 1)}-`
  const p = emptyPoint(label, `${MONTHS[month]} ${year}`, isFuture)
  for (const [k, b] of Object.entries(history)) if (k.startsWith(prefix)) addBucket(p, b)
  return p
}

/** Twelve calendar months ending with the current one, plus the twelve before them for comparison. */
function yearSeries(history: History, now: Date): { points: Point[]; previousTotal: number } {
  const at = (back: number) => new Date(now.getFullYear(), now.getMonth() - back, 1)
  const points = Array.from({ length: 12 }, (_, i) => {
    const d = at(11 - i)
    return monthPoint(history, d.getFullYear(), d.getMonth(), MONTHS[d.getMonth()]!, false)
  })
  let previousTotal = 0
  for (let i = 12; i < 24; i++) {
    const d = at(i)
    previousTotal += total(monthPoint(history, d.getFullYear(), d.getMonth(), '', false))
  }
  return { points, previousTotal }
}

export function total(p: Point): number {
  let t = 0
  for (const f of FAMILIES) t += p.byFamily[f]
  return t
}

export function fmt(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
  return `$${n.toFixed(2)}`
}

export function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const ARG_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'] as const

export function describeTool(tool: string, input: Record<string, unknown>): string {
  const name = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
  for (const k of ARG_KEYS) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) {
      const arg = v.replace(/\s+/g, ' ').trim()
      const short = k === 'file_path' || k === 'path' ? arg.split('/').slice(-2).join('/') : arg
      return `${name} ${short.length > 80 ? short.slice(0, 79) + '…' : short}`
    }
  }
  return name
}

export const NO_PROJECT = 'No project folder'

/** "a=b, c=d" into a map; malformed pairs are skipped. */
export function parseAliases(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of text.split(',')) {
    const [from, to] = pair.split('=').map(x => x.trim())
    if (from && to) out[from] = to
  }
  return out
}

/**
 * Maps a repository folder to its project: an alias first; the desktop app's folder-less sessions together;
 * otherwise the longest other known repo it extends with a hyphen (aws-iac-acme-app -> acme-app).
 */
export function projectResolver(repos: readonly string[], aliases: Record<string, string>): (repo: string | null) => string {
  const known = [...new Set(repos)]
  const memo = new Map<string, string>()
  return repo => {
    const r = repo ?? NO_PROJECT
    const hit = memo.get(r)
    if (hit !== undefined) return hit
    let name = aliases[r]
    if (!name) {
      if (/^scratch-\d{4}-\d{2}-\d{2}/.test(r) || r === 'unknown') name = NO_PROJECT
      else {
        const base = known
          .filter(k => k !== r && k.length >= 3 && (r.endsWith(`-${k}`) || r.startsWith(`${k}-`)))
          .sort((a, b) => b.length - a.length)[0]
        name = base ?? r
      }
    }
    memo.set(r, name)
    return name
  }
}

export type ProjectHistory = { hist: History; sessions: Record<string, Set<string>> }

export function mergeProjects(repos: RepoHistory, resolve: (repo: string) => string): Map<string, ProjectHistory> {
  const out = new Map<string, ProjectHistory>()
  for (const [repo, data] of Object.entries(repos)) {
    const name = resolve(repo)
    const into = out.get(name) ?? { hist: {}, sessions: {} }
    for (const [key, bucket] of Object.entries(data.hist)) {
      const slot: Bucket = (into.hist[key] = { ...(into.hist[key] ?? {}) })
      for (const [k, u] of Object.entries(bucket)) addUsage(slot, k, u)
    }
    for (const [day, ids] of Object.entries(data.sessions)) {
      const set = (into.sessions[day] ??= new Set())
      for (const id of ids) set.add(id)
    }
    out.set(name, into)
  }
  return out
}

/** Distinct sessions active in the period a range covers. */
export const RANGE_DAYS: Record<Range, number> = { day: 1, week: 7, month: 30, year: 365 }

export function sessionsIn(p: ProjectHistory, range: Range, nowMs: number): number {
  const days = RANGE_DAYS[range]
  const now = new Date(nowMs)
  const ids = new Set<string>()
  for (let back = 0; back < days; back++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12)
    for (const id of p.sessions[dayKey(d)] ?? []) ids.add(id)
  }
  return ids.size
}
