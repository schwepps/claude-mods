import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, Elements, EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, AgentState, AgentsView, Bucket, CardView, EconomicsView, History, Live, PricingNote, ProjectGroupView, Range, RepoHistory, SessionView, Tab, TabView, TopView, UsageView } from '../types'
import {
  FAMILIES,
  FAMILY_COLOR,
  FAMILY_LABEL,
  RANGE_DAYS,
  addUsage,
  bucketTotals,
  dayKey,
  describeTool,
  effortLevel,
  familyOf,
  fmt,
  fmtInt,
  fmtUsd,
  mergeProjects,
  modelLabel,
  parseAliases,
  projectResolver,
  sessionsIn,
  tokensByFamily,
  USD,
  type ProjectHistory,
  series,
  total,
  type Point,
} from './data'
import { C } from './theme'

const PANE = 'agent-ops'
const MAIN = 'main'
const SPARK_N = 30
const POLL_MS = 1000
const SCAN_MS = 3000
const LINGER_MS = 60_000
const LIVE_MINUTES = '10'
/** Bumped with each change to dash.tsx or tab.tsx: a new key makes the desktop load the new module instead of keeping the mounted one. */
export const UI_REV = 'r18'

const EMPTY_LIVE: Live = { agents: [], selfUsd: 0, byModel: {}, rate: 0, peak: 0, at: 0 }
const liveAtom = atom({ plugin: 'agent-ops', key: 'live' } as const, EMPTY_LIVE)
const historyAtom = atom({ plugin: 'agent-ops', key: 'history' } as const, {})
const rangeAtom = atom({ plugin: 'agent-ops', key: 'range' } as const, 'day')
const tabAtom = atom({ plugin: 'agent-ops', key: 'tab' } as const, 'agents')
const scanErrorAtom = atom({ plugin: 'agent-ops', key: 'scanError' } as const, null)
const pricingAtom = atom({ plugin: 'agent-ops', key: 'pricing' } as const, [])
const reposAtom = atom({ plugin: 'agent-ops', key: 'repos' } as const, {})
const projectAtom = atom({ plugin: 'agent-ops', key: 'project' } as const, null)
const showAllProjectsAtom = atom({ plugin: 'agent-ops', key: 'showAllProjects' } as const, false)
const CHIP_LIMIT = 6
const BREAKDOWN_LIMIT = 6

type Track = AgentRow & {
  liveOut: number
  lastOut: number
  todo: { done: number; total: number } | null
  tasks: { created: number; done: number }
  endedAt: number | null
}

type ScannedAgent = Omit<AgentRow, 'rate' | 'spark' | 'isLocal' | 'since'> & { lastAt: number }

type ScanOutput = { agents: ScannedAgent[]; hist: History; projects: RepoHistory; selfUsd: number; pricing?: PricingNote[]; at: number }

const STATUS: Record<AgentState, { color: string; icon: string; label: string }> = {
  running: { color: C.ok, icon: '●', label: 'Running' },
  waiting: { color: C.warn, icon: '▲', label: 'Waiting' },
  idle: { color: C.idle, icon: '○', label: 'Idle' },
  done: { color: C.accent, icon: '✓', label: 'Done' },
  failed: { color: C.bad, icon: '✕', label: 'Failed' },
}

const RANGE_LABEL: Record<Range, string> = { day: 'Day', week: 'Week', month: 'Month', year: 'Year' }

type Plain = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Series = ReturnType<typeof series>
type Setter<T> = (v: T) => () => Promise<void>

const tracks = new Map<string, Track>()
const remoteSpark = new Map<string, { out: number; at: number; spark: number[]; rate: number }>()
let remote: AgentRow[] = []
let selfUsd = 0
let planMonthlyUsd = 200
let aliases: Record<string, string> = {}
let localRepo: string | null = null
let lastTickAt = 0
let peak = 0
let isTicking = false
let isScanning = false
let sessionId = ''
let lastLiveJson = ''

function mapStatus(s: AgentStatus): AgentState {
  if (s === 'completed') return 'done'
  if (s === 'failed' || s === 'killed') return 'failed'
  if (s === 'waiting') return 'waiting'
  if (s === 'idle') return 'idle'
  return 'running'
}

const progressOf = (t: Track) =>
  t.todo ?? (t.tasks.created > 0 ? { done: Math.min(t.tasks.done, t.tasks.created), total: t.tasks.created } : null)

function track(id: string, now: number): Track {
  let t = tracks.get(id)
  if (!t) {
    t = {
      id,
      name: id === MAIN ? 'This session' : 'Starting agent…',
      type: id === MAIN ? 'main' : 'agent',
      status: id === MAIN ? 'idle' : 'running',
      model: null,
      effort: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      rate: 0,
      spark: Array(SPARK_N).fill(0),
      progress: null,
      steps: 0,
      activity: id === MAIN ? 'Waiting for a prompt' : 'Starting',
      startedAt: now,
      session: null,
      project: null,
      repo: localRepo,
      isLocal: true,
      costUsd: 0,
      since: now,
      liveOut: 0,
      lastOut: 0,
      todo: null,
      tasks: { created: 0, done: 0 },
      endedAt: null,
    }
    tracks.set(id, t)
  }
  return t
}

const seenStatus = new Map<string, { status: AgentState; since: number }>()

/** Local statuses change in several hooks; the first tick that sees a new one stamps when it began. */
function statusSince(t: Track): number {
  const prev = seenStatus.get(t.id)
  if (prev && prev.status === t.status) return prev.since
  const since = lastTickAt || t.startedAt
  seenStatus.set(t.id, { status: t.status, since })
  return since
}

function localRows(): AgentRow[] {
  return [...tracks.values()].map(t => ({
    id: t.id,
    name: t.name,
    type: t.type,
    status: t.status,
    model: t.model,
    effort: t.effort,
    tokensIn: t.tokensIn,
    tokensOut: Math.round(t.tokensOut + t.liveOut),
    cacheRead: t.cacheRead,
    rate: t.rate,
    spark: t.spark,
    progress: progressOf(t),
    steps: t.steps,
    activity: t.activity,
    startedAt: t.startedAt,
    session: null,
    project: t.project,
    repo: localRepo,
    isLocal: true,
    costUsd: 0,
    since: statusSince(t),
  }))
}

function todayByModel(h: History, now: number): Bucket {
  const key = dayKey(new Date(now))
  const out: Bucket = {}
  for (const [k, b] of Object.entries(h)) {
    if (!k.startsWith(key)) continue
    for (const [key, u] of Object.entries(b)) addUsage(out, key, u)
  }
  return out
}

async function scan($: EngineInterface): Promise<void> {
  if (isScanning) return
  isScanning = true
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const r = await $.process.run(
      ['/usr/bin/env', 'python3', '-I', `${$.plugin.root}/scanner/scan.py`, `${home}/.claude/projects`, `${home}/.claude/agent-ops/state.json`, sessionId, LIVE_MINUTES],
      { timeoutMs: 120_000, env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' } },
    )
    if (r.exitCode !== 0) {
      const reason = r.stderr.trim().split('\n').pop() ?? `exit ${r.exitCode}`
      await update($, scanErrorAtom, () => `Other sessions unavailable: ${reason.slice(0, 160)}`)
      return
    }
    const out = JSON.parse(r.stdout) as ScanOutput
    selfUsd = out.selfUsd ?? 0
    remote = out.agents.map(a => {
      const prev = remoteSpark.get(a.id)
      const dt = prev ? Math.max(1, (out.at - prev.at) / 1000) : 1
      const rate = prev ? Math.max(0, (a.tokensOut - prev.out) / dt) : 0
      const sparkValues = [...(prev?.spark ?? Array(SPARK_N).fill(0)).slice(1), rate]
      remoteSpark.set(a.id, { out: a.tokensOut, at: out.at, spark: sparkValues, rate })
      const { lastAt, ...row } = a
      return { ...row, rate, spark: sparkValues, isLocal: false, since: lastAt }
    })
    const ids = new Set(out.agents.map(a => a.id))
    for (const id of remoteSpark.keys()) if (!ids.has(id)) remoteSpark.delete(id)
    await update($, historyAtom, () => out.hist)
    await update($, reposAtom, () => out.projects ?? {})
    await update($, pricingAtom, () => out.pricing ?? [])
    await update($, scanErrorAtom, () => null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await update($, scanErrorAtom, () => `Other sessions unavailable: ${msg.slice(0, 160)}`)
  } finally {
    isScanning = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    let list: AgentInfo[] = []
    try {
      list = await $.agent.list()
    } catch {
      list = []
    }
    const seen = new Set([MAIN])
    for (const a of list) {
      seen.add(a.id)
      const t = track(a.id, now)
      t.name = a.name ?? a.description ?? a.type
      t.type = a.type
      const s = mapStatus(a.status)
      if (s !== t.status) {
        t.status = s
        t.endedAt = s === 'done' || s === 'failed' ? now : null
        if (s === 'done') t.activity = 'Returned its result'
      }
    }
    for (const t of tracks.values()) {
      if (!seen.has(t.id) && t.endedAt === null) {
        t.status = 'done'
        t.endedAt = now
        t.activity = 'Returned its result'
      }
    }
    for (const [id, t] of tracks) if (t.endedAt !== null && now - t.endedAt > LINGER_MS) tracks.delete(id)

    const dt = lastTickAt ? Math.max(0.25, (now - lastTickAt) / 1000) : POLL_MS / 1000
    lastTickAt = now
    let rate = 0
    for (const t of tracks.values()) {
      const out = t.tokensOut + t.liveOut
      t.rate = Math.max(0, (out - t.lastOut) / dt)
      t.lastOut = out
      t.spark = [...t.spark.slice(1), t.rate]
      rate += t.rate
    }
    for (const r of remote) rate += r.rate
    rate = Math.round(rate)
    peak = Math.max(peak * 0.995, rate)
    const history = (await read($, historyAtom)) as History
    const body = { agents: [...localRows(), ...remote], selfUsd: Math.round(selfUsd * 100) / 100, byModel: todayByModel(history, now), rate, halfMinute: Math.floor(now / 30_000) }
    const json = JSON.stringify(body)
    if (json === lastLiveJson) return
    lastLiveJson = json
    const { halfMinute: _halfMinute, ...live } = body
    const next: Live = { ...live, peak: Math.round(peak), at: now }
    await update($, liveAtom, () => next)
  } finally {
    isTicking = false
  }
}

let pollTimer: Timer | null = null
let scanTimer: Timer | null = null

/** Polling and the transcript scan run only while the pane is open, so closed sessions cost nothing. */
function startPolling($: EngineInterface, refreshNow: boolean): void {
  if (pollTimer) return
  pollTimer = $.clock.every(POLL_MS, () => void tick($))
  scanTimer = $.clock.every(SCAN_MS, () => void scan($))
  if (!refreshNow) return
  void scan($)
  void tick($)
}

function stopPolling(): void {
  pollTimer?.cancel()
  scanTimer?.cancel()
  pollTimer = null
  scanTimer = null
}

function kpis(L: Live) {
  const up = L.agents.filter(a => a.status === 'running' || a.status === 'waiting').length
  const wait = L.agents.filter(a => a.status === 'waiting').length
  const { tokens: today, usd: costToday } = bucketTotals(L.byModel)
  const sessions = new Set(L.agents.map(a => (a.isLocal ? 'local' : a.id.split(':')[0]))).size
  return { up, wait, today, sessions, costToday }
}

function summary(S: Series, range: Range) {
  const live = S.points.filter(p => !p.isFuture)
  const sum = live.reduce((a, p) => a + total(p), 0)
  const cache = live.reduce((a, p) => a + p.cacheRead, 0)
  const peakPoint = live.reduce<Point | undefined>((m, p) => (!m || total(p) > total(m) ? p : m), undefined)
  const byFam = FAMILIES.map(f => [f, live.reduce((a, p) => a + p.byFamily[f], 0)] as const).sort((a, b) => b[1] - a[1])
  const delta = S.previousTotal > 0 ? ((sum - S.previousTotal) / S.previousTotal) * 100 : null
  const unit = range === 'day' ? 'hour' : range === 'year' ? 'month' : 'day'
  const prevName = { day: 'yesterday', week: 'the 7 days before', month: 'the 30 days before', year: 'the 12 months before' }[range]
  return { sum, cache, peakPoint, byFam, delta, unit, prevName, avg: live.length ? sum / live.length : 0 }
}

type Group = { key: string; title: string; subtitle: string; repo: string | null; agents: AgentRow[] }

const ORDER: AgentState[] = ['waiting', 'running', 'idle', 'done', 'failed']

function groups(agents: readonly AgentRow[]): Group[] {
  const local = agents.filter(a => a.isLocal)
  const bySession = new Map<string, AgentRow[]>()
  for (const a of agents) {
    if (a.isLocal) continue
    const sid = a.id.split(':')[0] ?? a.id
    bySession.set(sid, [...(bySession.get(sid) ?? []), a])
  }
  const sortRows = (rows: AgentRow[]) =>
    [...rows].sort((a, b) => {
      const am = a.type === 'session' || a.id === MAIN ? -1 : 0
      const bm = b.type === 'session' || b.id === MAIN ? -1 : 0
      return am - bm || ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.startedAt - b.startedAt
    })
  const out: Group[] = local.length ? [{ key: 'local', title: 'This session', subtitle: 'tracked live', repo: localRepo, agents: sortRows(local) }] : []
  for (const r of out[0]?.agents ?? []) if (r.id === MAIN) r.name = 'Main'
  const remoteGroups = [...bySession.entries()].map(([sid, rows]) => {
    const head = rows.find(r => r.type === 'session')
    return {
      key: sid,
      title: head?.name ?? rows[0]?.session ?? 'Other session',
      subtitle: rows[0]?.project ?? '',
      repo: rows[0]?.repo ?? null,
      agents: sortRows(rows).map(r => (r.type === 'session' ? { ...r, name: 'Main', type: 'main' } : r)),
    }
  })
  remoteGroups.sort((a, b) => {
    const rank = (g: Group) => Math.min(...g.agents.map(x => ORDER.indexOf(x.status)))
    return rank(a) - rank(b)
  })
  return [...out, ...remoteGroups]
}

function topView(L: Live): TopView {
  const k = kpis(L)
  return {
    view: 'top',
    up: k.up,
    count: L.agents.length,
    rate: L.rate,
    max: Math.max(200, Math.ceil((L.peak * 1.25) / 100) * 100),
    today: k.today,
    waiting: k.wait,
    sessions: k.sessions,
    costToday: k.costToday,
    mix: FAMILIES.map(f => ({ family: f, tokens: tokensByFamily(L.byModel)[f] })),
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function cardView(a: AgentRow, now: number): CardView {
  const isQuiet = a.status === 'idle' || a.status === 'done' || a.status === 'failed'
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    activity: a.activity,
    model: modelLabel(a.model),
    family: familyOf(a.model),
    effort: a.effort,
    effortLevel: effortLevel(a.effort),
    type: a.type,
    progress: a.progress && a.progress.total > 0 ? a.progress.done / a.progress.total : null,
    progressText: a.progress ? `${a.progress.done}/${a.progress.total} tasks` : `${a.steps} steps`,
    tokens: a.tokensIn + a.tokensOut,
    rate: Math.round(a.rate),
    spark: a.spark.map(v => Math.round(v)),
    when: a.status === 'waiting' ? ago(now - a.since) : isQuiet ? `${ago(now - a.since)} ago` : '',
  }
}

const quiet = (s: AgentState) => s === 'idle' || s === 'done' || s === 'failed'

function sessionView(g: Group, now: number, localUsd: number, project: string): SessionView {
  const cards = g.agents.map(a => cardView(a, now))
  const running = g.agents.filter(a => a.status === 'running').length
  const waiting = g.agents.filter(a => a.status === 'waiting')
  const status: AgentState = waiting.length ? 'waiting' : running ? 'running' : g.agents.some(a => a.status === 'failed') ? 'failed' : 'idle'
  const longestWait = waiting.reduce((m, a) => Math.max(m, now - a.since), 0)
  const lastActive = g.agents.reduce((m, a) => Math.max(m, a.since), 0)
  const parts = [running ? `${running} running` : '', waiting.length ? `${waiting.length} waiting ${ago(longestWait)}` : ''].filter(Boolean)
  return {
    key: g.key,
    title: g.title,
    subtitle: g.subtitle,
    status,
    summary: parts.length ? parts.join(' · ') : status === 'failed' ? 'failed' : 'idle',
    tokens: g.agents.reduce((s, a) => s + a.tokensIn + a.tokensOut, 0),
    costUsd: g.key === 'local' ? localUsd : g.agents.reduce((s, a) => s + a.costUsd, 0),
    when: status === 'idle' || status === 'failed' ? `${ago(now - lastActive)} ago` : '',
    project,
    cards,
  }
}

type Scope = {
  resolve: (repo: string | null) => string
  projects: Map<string, ProjectHistory>
  selected: string | null
}

function todayTotals(h: History | undefined, now: number): { tokens: number; usd: number } {
  return bucketTotals(todayByModel(h ?? {}, now))
}

function agentsView(L: Live, error: string | null, now: number, scope: Scope): AgentsView {
  const sessions = groups(L.agents).map(g => sessionView(g, now, L.selfUsd, scope.resolve(g.repo)))
  const active = sessions.filter(s => !quiet(s.status) || s.key === 'local')
  const byProject = new Map<string, SessionView[]>()
  for (const sv of active) byProject.set(sv.project, [...(byProject.get(sv.project) ?? []), sv])
  const rank = (list: SessionView[]) => Math.min(...list.map(x => ORDER.indexOf(x.status)))
  const lines: ProjectGroupView[] = [...byProject.entries()]
    .sort((a, b) => rank(a[1]) - rank(b[1]))
    .map(([name, list]) => {
      const agents = list.flatMap(x => x.cards)
      const running = agents.filter(c => c.status === 'running').length
      const waiting = agents.filter(c => c.status === 'waiting').length
      const today = todayTotals(scope.projects.get(name)?.hist, now)
      const parts = [`${list.length} ${list.length === 1 ? 'session' : 'sessions'}`, running ? `${running} running` : '', waiting ? `${waiting} waiting` : '']
      return { name, summary: parts.filter(Boolean).join(' · '), tokensToday: today.tokens, costToday: today.usd, sessions: list }
    })
  return {
    view: 'agents',
    error,
    groups: lines,
    showProjectLines: scope.selected === null,
    idle: sessions.filter(s => quiet(s.status) && s.key !== 'local'),
  }
}

/** The biggest few projects for a period, the rest folded into one "N more" row. */
function topProjects<T extends { name: string }>(rows: T[], weight: (r: T) => number, fold: (rest: T[]) => T): T[] {
  const sorted = [...rows].filter(r => weight(r) > 0).sort((a, b) => weight(b) - weight(a))
  if (sorted.length <= BREAKDOWN_LIMIT + 1) return sorted
  const rest = sorted.slice(BREAKDOWN_LIMIT)
  return [...sorted.slice(0, BREAKDOWN_LIMIT), fold(rest)]
}

const DAYS_PER_MONTH = 30

function pricingNotes(notes: readonly PricingNote[]): string[] {
  return [...notes]
    .sort((a, b) => b.tokens - a.tokens)
    .map(n =>
      n.as
        ? `${modelLabel(n.model)} (${n.model}) has no price row; priced as ${modelLabel(n.as)}.`
        : `${n.model} has no price row; its ${fmt(n.tokens)} tokens are counted at $0.`,
    )
}

/** Days from the first day of recorded history through today, capped at the range. */
function daysWithData(firstDay: string | null, range: Range, now: number): number {
  const days = RANGE_DAYS[range]
  if (!firstDay) return days
  const [y, m, d] = firstDay.split('-').map(Number)
  const today = new Date(now)
  const span = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(y!, m! - 1, d!).getTime()) / 86_400_000) + 1
  return Math.max(1, Math.min(days, span))
}

function economicsView(H: History, range: Range, now: number, plan: number, scope: Scope, totalCost: number, firstDay: string | null, pricing: readonly PricingNote[]): EconomicsView {
  const S = series(H, range, now)
  const live = S.points.filter(p => !p.isFuture)
  const cost = live.reduce((a, p) => a + p.usd, 0)
  const days = daysWithData(firstDay, range, now)
  const planShare = (plan / DAYS_PER_MONTH) * days
  const sum = (pick: (p: Point) => number) => live.reduce((a, p) => a + pick(p), 0)
  const byKind = [
    { label: 'Cache reads', usd: sum(p => p.kinds.readUsd), tokens: sum(p => p.kinds.readTokens) },
    { label: 'Cache writes and input', usd: sum(p => p.kinds.inputUsd), tokens: sum(p => p.kinds.inputTokens) },
    { label: 'Output', usd: sum(p => p.kinds.outputUsd), tokens: sum(p => p.kinds.outputTokens) },
  ]
  const allTokens = byKind.reduce((a, k) => a + k.tokens, 0)
  const reads = byKind[0]!
  let byProject: EconomicsView['byProject'] = null
  let projectInsight = ''
  if (scope.selected === null) {
    const rows = [...scope.projects.entries()].map(([name, ph]) => {
      const usd = series(ph.hist, range, now).points.reduce((a, p) => a + (p.isFuture ? 0 : p.usd), 0)
      const n = sessionsIn(ph, range, now)
      return { name, usd, sessions: n }
    })
    const totalSessions = rows.reduce((a, r) => a + r.sessions, 0)
    const avgPerSession = totalSessions > 0 ? cost / totalSessions : 0
    const top = topProjects(rows, r => r.usd, rest => ({
      name: `${rest.length} more`,
      usd: rest.reduce((a, r) => a + r.usd, 0),
      sessions: rest.reduce((a, r) => a + r.sessions, 0),
    }))
    byProject = top.map(r => ({
      name: r.name,
      usd: r.usd,
      share: cost > 0 ? r.usd / cost : 0,
      perSession: r.sessions > 0 ? r.usd / r.sessions : null,
      multiple: planShare > 0 ? r.usd / planShare : 0,
    }))
    const lead = byProject[0]
    const outlier = byProject
      .filter(r => r.perSession !== null && avgPerSession > 0 && r.perSession > avgPerSession * 3)
      .sort((a, b) => (b.perSession ?? 0) - (a.perSession ?? 0))[0]
    if (lead && cost > 0) projectInsight = ` ${lead.name} is ${Math.round(lead.share * 100)}% of the cost${lead.multiple >= 1 ? `, ${lead.multiple.toFixed(1)}× your plan on its own` : ''}.`
    if (outlier && outlier.perSession !== null)
      projectInsight += ` ${outlier.name} costs ${fmtUsd(outlier.perSession)} per session, ${(outlier.perSession / avgPerSession).toFixed(1)}× the average.`
  }
  const insight =
    cost > 0 && allTokens > 0
      ? `Cache reads are ${Math.round((reads.tokens / allTokens) * 100)}% of tokens but ${Math.round((reads.usd / cost) * 100)}% of the cost.${projectInsight}`
      : 'No priced usage in this period yet.'
  return {
    view: 'economics',
    range,
    rangeLabel: { day: 'today', week: 'last 7 days', month: 'last 30 days', year: 'last 12 months' }[range],
    planMonthly: plan,
    cost,
    planShare,
    coveredDays: days < RANGE_DAYS[range] ? days : null,
    pricing: pricingNotes(pricing),
    multiple: planShare > 0 ? cost / planShare : 0,
    shareOfTotal: scope.selected === null || totalCost <= 0 ? null : cost / totalCost,
    byModel: [...new Set(live.flatMap(p => Object.keys(p.usdByModel)))]
      .map(key => ({ key, label: modelLabel(key), family: familyOf(key), usd: sum(p => p.usdByModel[key] ?? 0), tokens: sum(p => p.tokensByModel[key] ?? 0) }))
      .filter(x => x.usd > 0)
      .sort((a, b) => b.usd - a.usd),
    byKind,
    insight,
    points: S.points.map(p => ({ label: p.label, full: p.full, isFuture: p.isFuture, usd: p.usd })),
    byProject,
    scope: scope.selected ?? 'all projects',
  }
}

function usageView(S: Series, range: Range, now: number, scope: Scope): UsageView {
  const sm = summary(S, range)
  const top = sm.byFam[0]
  const families = FAMILIES.filter(f => sm.byFam.some(([g, v]) => g === f && v > 0))
  const hasTop = top !== undefined && top[1] > 0
  return {
    view: 'usage',
    range,
    unit: sm.unit,
    families,
    tiles: [
      {
        label: 'TOTAL TOKENS',
        value: sm.sum,
        text: null,
        note: sm.delta === null ? `no data for ${sm.prevName}` : `${sm.delta >= 0 ? '▲' : '▼'} ${Math.abs(sm.delta).toFixed(1)}% vs ${sm.prevName}`,
        color: C.fg,
        noteColor: sm.delta === null ? C.muted : sm.delta >= 0 ? C.ok : C.bad,
      },
      { label: `AVG PER ${sm.unit.toUpperCase()}`, value: sm.avg, text: null, note: 'input + output', color: C.fg, noteColor: C.muted },
      {
        label: `PEAK ${sm.unit.toUpperCase()}`,
        value: sm.peakPoint && total(sm.peakPoint) > 0 ? total(sm.peakPoint) : null,
        text: '—',
        note: sm.peakPoint?.full ?? '',
        color: C.fg,
        noteColor: C.muted,
      },
      {
        label: 'TOP MODEL',
        value: null,
        text: hasTop ? FAMILY_LABEL[top[0]] : '—',
        note: hasTop && sm.sum > 0 ? `${Math.round((top[1] / sm.sum) * 100)}% of tokens` : 'no usage yet',
        color: hasTop ? FAMILY_COLOR[top[0]] : C.fg,
        noteColor: C.muted,
      },
      { label: 'CACHE READS', value: sm.cache, text: null, note: 'served from prompt cache', color: C.fg, noteColor: C.muted },
    ],
    points: S.points.map(p => ({ label: p.label, full: p.full, isFuture: p.isFuture, values: families.map(f => (p.isFuture ? 0 : p.byFamily[f])) })),
    byProject:
      scope.selected !== null
        ? null
        : topProjects(
            [...scope.projects.entries()].map(([name, ph]) => {
              const live = series(ph.hist, range, now).points.filter(p => !p.isFuture)
              const values = families.map(f => live.reduce((a, p) => a + p.byFamily[f], 0))
              return { name, values, total: values.reduce((a, b) => a + b, 0) }
            }),
            r => r.total,
            rest => ({
              name: `${rest.length} more`,
              values: families.map((_, i) => rest.reduce((a, r) => a + (r.values[i] ?? 0), 0)),
              total: rest.reduce((a, r) => a + r.total, 0),
            }),
          ),
  }
}

function repoOf(cwd: string): string {
  const root = cwd.split('/.claude/worktrees/')[0] ?? cwd
  return root.split('/').filter(Boolean).pop() ?? 'unknown'
}

function narrowLive(L: Live, keep: (a: AgentRow) => boolean, h: History, now: number): Live {
  const agents = L.agents.filter(keep)
  return {
    ...L,
    agents,
    selfUsd: agents.some(a => a.isLocal) ? L.selfUsd : 0,
    byModel: todayByModel(h, now),
    rate: Math.round(agents.reduce((s, a) => s + a.rate, 0)),
  }
}

function spendSince(h: History, fromKey: string): number {
  let usd = 0
  for (const [k, b] of Object.entries(h)) {
    if (k < fromKey) continue
    usd += bucketTotals(b).usd
  }
  return usd
}

/** "All projects" plus the projects with live agents or spend in the last 30 days, busiest first. */
function projectChips(L: Live, scope: Scope, now: number, showAll: boolean): TabView[] {
  const live = new Map<string, number>()
  for (const a of L.agents) {
    if (a.status !== 'running' && a.status !== 'waiting') continue
    const name = scope.resolve(a.repo)
    live.set(name, (live.get(name) ?? 0) + 1)
  }
  const from = dayKey(new Date(now - 30 * 86_400_000))
  const names = new Set([...live.keys(), ...[...scope.projects.entries()].filter(([, ph]) => spendSince(ph.hist, from) > 0).map(([n]) => n)])
  const spend = (n: string) => spendSince(scope.projects.get(n)?.hist ?? {}, from)
  const ordered = [...names].sort((a, b) => (live.get(b) ?? 0) - (live.get(a) ?? 0) || spend(b) - spend(a) || a.localeCompare(b))
  const shown = showAll ? ordered : ordered.slice(0, CHIP_LIMIT)
  if (scope.selected !== null && !shown.includes(scope.selected)) shown.push(scope.selected)
  const chips: TabView[] = [{ id: 'proj:*', label: 'All projects', isOn: scope.selected === null }]
  for (const n of shown) {
    const count = live.get(n) ?? 0
    chips.push({ id: `proj:${n}`, label: count ? `${n}  ● ${count}` : n, isOn: scope.selected === n })
  }
  if (ordered.length > CHIP_LIMIT) chips.push({ id: 'proj-more', label: showAll ? 'Fewer' : `+${ordered.length - CHIP_LIMIT} more`, isOn: false })
  return chips
}

function plainView(ui: Plain, L: Live, S: Series, range: Range, tab: Tab, setRange: Setter<Range>, setTab: Setter<Tab>, cols: number) {
  const { Box, Text, Button } = ui
  const k = kpis(L)
  const sm = summary(S, range)
  const bar = (frac: number, width: number) => {
    const n = Math.round(Math.max(0, Math.min(1, frac)) * width)
    return '█'.repeat(n) + '░'.repeat(width - n)
  }
  const ticks = '▁▂▃▄▅▆▇█'
  const sparkline = (v: readonly number[]) => {
    const m = Math.max(1, ...v)
    return v.map(x => ticks[Math.min(7, Math.floor((x / m) * 7.99))]).join('')
  }
  const barW = Math.max(6, Math.min(20, cols - 60))
  const maxFam = Math.max(1, ...sm.byFam.map(([, v]) => v))
  return (
    <Box flexDirection="column" gap={1}>
      <Box columnGap={2} flexWrap="wrap">
        <Text bold color={C.accent}>
          ◉ AGENT/OPS
        </Text>
        <Text>
          {k.up}/{L.agents.length} up · {fmtInt(L.rate)} tok/s · {fmt(k.today)} today
        </Text>
        {k.wait > 0 ? <Text color={C.warn}>▲ {k.wait} waiting</Text> : null}
      </Box>
      <Box columnGap={1}>
        <Button key={`tab-agents-${UI_REV}`} label="Agents" variant={tab === 'agents' ? 'primary' : 'secondary'} onPress={setTab('agents')} />
        <Button key={`tab-usage-${UI_REV}`} label="Usage" variant={tab === 'usage' ? 'primary' : 'secondary'} onPress={setTab('usage')} />
      </Box>
      {tab === 'agents' ? (
        <Box flexDirection="column">
          {groups(L.agents).map(g => (
            <Box key={`grp-${g.key}`} flexDirection="column">
              <Text bold color={C.accent}>
                ▸ {g.title} <Text dimColor>{g.subtitle}</Text>
              </Text>
              {g.agents.map(a => {
                const st = STATUS[a.status]
                const p = a.status === 'done' ? 1 : a.progress && a.progress.total > 0 ? a.progress.done / a.progress.total : null
                return (
                  <Box key={`row-${a.id}`} flexDirection="column">
                    <Box columnGap={1}>
                      <Text color={st.color}>{st.icon}</Text>
                      <Box width={22}>
                        <Text bold wrap="truncate-end">
                          {a.name}
                        </Text>
                      </Box>
                      <Text color={st.color}>{st.label.padEnd(8)}</Text>
                      <Text color={C.accent}>{p === null ? `${a.steps} steps`.padEnd(barW + 5) : `${bar(p, barW)} ${String(Math.round(p * 100)).padStart(3)}%`}</Text>
                      <Text color={FAMILY_COLOR[familyOf(a.model)]}>{modelLabel(a.model)}</Text>
                      {a.effort ? <Text dimColor>{a.effort}</Text> : null}
                      <Text>{fmt(a.tokensIn + a.tokensOut).padStart(7)}</Text>
                      <Text color={FAMILY_COLOR[familyOf(a.model)]}>{sparkline(a.spark.slice(-12))}</Text>
                    </Box>
                    <Text dimColor wrap="truncate-end">
                      {'  '}
                      {a.activity}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box columnGap={1} alignItems="center">
            <Text bold>Usage by model</Text>
            {(['day', 'week', 'month', 'year'] as const).map(r => (
              <Button key={`range-${r}`} label={RANGE_LABEL[r]} variant={r === range ? 'primary' : 'secondary'} onPress={setRange(r)} />
            ))}
          </Box>
          <Text>
            {fmt(sm.sum)} tokens
            {sm.delta === null ? '' : ` · ${sm.delta >= 0 ? '▲' : '▼'} ${Math.abs(sm.delta).toFixed(1)}% vs ${sm.prevName}`} · cache reads {fmt(sm.cache)}
          </Text>
          <Text color={C.accent}>{sparkline(S.points.filter(p => !p.isFuture).map(total))}</Text>
          <Box flexDirection="column">
            {sm.byFam
              .filter(([, v]) => v > 0)
              .map(([f, v]) => (
                <Box key={`fam-${f}`} columnGap={1}>
                  <Box width={8}>
                    <Text>{FAMILY_LABEL[f]}</Text>
                  </Box>
                  <Text color={FAMILY_COLOR[f]}>{bar(v / maxFam, barW + 8)}</Text>
                  <Text>{fmt(v)}</Text>
                </Box>
              ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  planMonthlyUsd = Math.max(0, Number(options.planMonthlyUsd ?? 200)) || 200
  aliases = parseAliases(String(options.projectAliases ?? ''))
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-ops', description: 'Open the live agents and token usage dashboard' })
    const now = await $.clock.now()
    sessionId = await $.session.id()
    localRepo = await $.session
      .cwd()
      .then(repoOf)
      .catch(() => null)
    const prior = await read($, liveAtom)
    for (const row of prior.agents) {
      if (!row.isLocal) continue
      const t = track(row.id, now)
      Object.assign(t, row, { lastOut: row.tokensOut })
    }
    peak = prior.peak
    track(MAIN, now)
    return next(e)
  })

  on('command.run', { command: 'agent-ops' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agent Ops' })
    startPolling($, true)
    return { text: 'Agent Ops dashboard opened.' }
  })

  on('turn.start', async ($, e, next) => {
    const t = track(MAIN, await $.clock.now())
    t.status = 'running'
    t.activity = 'Thinking…'
    t.todo = null
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = track(MAIN, await $.clock.now())
      t.status = 'idle'
      t.activity = e.isAborted ? 'Interrupted' : 'Waiting for a prompt'
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const t = track(e.agentId ?? MAIN, await $.clock.now())
    t.model = e.model
    t.effort = e.effort === undefined ? null : typeof e.effort === 'number' ? `budget ${e.effort}` : e.effort
    t.steps += 1
    if (t.status === 'waiting' || t.status === 'idle') t.status = 'running'
    let estimate = 0
    const stream = next(e)
    try {
      while (true) {
        const r = await stream.next()
        if (r.done) {
          const u = r.value?.usage
          if (u) {
            t.tokensIn += u.input_tokens + u.cache_creation_input_tokens
            t.tokensOut += u.output_tokens
            t.cacheRead += u.cache_read_input_tokens
          }
          return r.value
        }
        const c = r.value
        if (c.kind === 'text' || c.kind === 'thinking') {
          estimate += c.text.length / 4
          t.liveOut += c.text.length / 4
          if (c.kind === 'thinking') t.activity = 'Thinking…'
        } else if (c.kind === 'input') {
          estimate += c.json.length / 4
          t.liveOut += c.json.length / 4
        } else if (c.kind === 'tool') {
          t.activity = `Calling ${c.name}`
        }
        yield c
      }
    } finally {
      t.liveOut = Math.max(0, t.liveOut - estimate)
    }
  })

  on('tool.call', async ($, e, next) => {
    const t = track(e.agentId ?? MAIN, await $.clock.now())
    const input = e as unknown as Record<string, unknown>
    t.activity = describeTool(e.tool, input)
    if (t.status === 'waiting') t.status = 'running'
    if (e.tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos as { status?: string }[]
      t.todo = { done: todos.filter(x => x.status === 'completed').length, total: todos.length }
    } else if (e.tool === 'TaskCreate') {
      t.tasks.created += 1
    } else if (e.tool === 'TaskUpdate') {
      if (input.status === 'completed') t.tasks.done += 1
      if (input.status === 'deleted') t.tasks.created = Math.max(0, t.tasks.created - 1)
    }
    return next(e)
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const t = track(e.agent_id ?? MAIN, await $.clock.now())
    t.status = 'waiting'
    t.activity = `Permission: ${e.tool_name}`
    return next(e)
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) stopPolling()
    return next(e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const press = (e.data as { press?: string } | null)?.press ?? ''
    if (press === 'agents' || press === 'usage' || press === 'economics') await update($, tabAtom, () => press)
    if (press === 'proj-more') await update($, showAllProjectsAtom, v => !v)
    if (press.startsWith('proj:')) {
      const name = press.slice(5)
      await update($, projectAtom, () => (name === '*' ? null : name))
    }
    if (press.startsWith('range-')) {
      const r = press.slice(6)
      if (r === 'day' || r === 'week' || r === 'month' || r === 'year') await update($, rangeAtom, () => r)
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // A pane left open across a reload has no timers yet; drawing may not write state, so only start them.
    startPolling($, false)
    const L = await read($, liveAtom)
    const H = (await read($, historyAtom)) as History
    const range = (await read($, rangeAtom)) as Range
    const tab = (await read($, tabAtom)) as Tab
    const scanError = await read($, scanErrorAtom)
    const pricing = (await read($, pricingAtom)) as PricingNote[]
    const now = await $.clock.now()
    const repos = (await read($, reposAtom)) as RepoHistory
    const wanted = await read($, projectAtom)
    const showAllProjects = await read($, showAllProjectsAtom)
    const resolve = projectResolver([...Object.keys(repos), ...L.agents.flatMap(a => (a.repo ? [a.repo] : []))], aliases)
    const projects = mergeProjects(repos, resolve)
    const selected = wanted !== null && (projects.has(wanted) || L.agents.some(a => resolve(a.repo) === wanted)) ? wanted : null
    const scope: Scope = { resolve, projects, selected }
    const Hs = selected === null ? H : (projects.get(selected)?.hist ?? {})
    const Ls: Live = selected === null ? L : narrowLive(L, a => resolve(a.repo) === selected, Hs, now)
    const S = series(Hs, range, now)
    const S_all = selected === null ? S : series(H, range, now)
    const chips = projectChips(L, scope, now, showAllProjects)
    if (e.surface === 'desktop' || e.surface === 'terminal') {
      const { Box, Client } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" gap={2} paddingX={2} paddingY={1} backgroundColor={C.bg}>
          <Client key={`dash-top-${UI_REV}`} module="./dash.tsx" props={topView(Ls)} width="100%" />
          <Box columnGap={2} rowGap={1} flexWrap="wrap" alignItems="center">
            <Client key={`tab-agents-${UI_REV}`} module="./tab.tsx" props={{ id: 'agents', label: `Agents (${Ls.agents.length})`, isOn: tab === 'agents' }} />
            <Client key={`tab-usage-${UI_REV}`} module="./tab.tsx" props={{ id: 'usage', label: 'Usage history', isOn: tab === 'usage' }} />
            <Client key={`tab-economics-${UI_REV}`} module="./tab.tsx" props={{ id: 'economics', label: 'Economics', isOn: tab === 'economics' }} />
            {tab !== 'agents' ? (
              <Box flexGrow={1} justifyContent="flex-end" columnGap={2}>
                <Client key={`range-day-${UI_REV}`} module="./tab.tsx" props={{ id: 'range-day', label: 'Day', isOn: range === 'day' }} />
                <Client key={`range-week-${UI_REV}`} module="./tab.tsx" props={{ id: 'range-week', label: 'Week', isOn: range === 'week' }} />
                <Client key={`range-month-${UI_REV}`} module="./tab.tsx" props={{ id: 'range-month', label: 'Month', isOn: range === 'month' }} />
                <Client key={`range-year-${UI_REV}`} module="./tab.tsx" props={{ id: 'range-year', label: 'Year', isOn: range === 'year' }} />
              </Box>
            ) : null}
          </Box>
          <Box columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
            {chips.map((c, i) => (
              <Client key={`proj-${i}-${UI_REV}`} module="./tab.tsx" props={c} />
            ))}
          </Box>
          {tab === 'agents' ? (
            <Client key={`dash-agents-${UI_REV}`} module="./dash.tsx" props={agentsView(Ls, scanError, now, scope)} width="100%" />
          ) : tab === 'usage' ? (
            <Client key={`dash-usage-${UI_REV}`} module="./dash.tsx" props={usageView(S, range, now, scope)} width="100%" />
          ) : (
            <Client key={`dash-economics-${UI_REV}`} module="./dash.tsx" props={economicsView(Hs, range, now, planMonthlyUsd, scope, S_all.points.reduce((a, p) => a + (p.isFuture ? 0 : p.usd), 0), Object.keys(H).sort()[0]?.slice(0, 10) ?? null, pricing)} width="100%" />
          )}
        </Box>
      )
    }
    const setRange: Setter<Range> = r => async () => {
      await update($, rangeAtom, () => r)
    }
    const setTab: Setter<Tab> = t => async () => {
      await update($, tabAtom, () => t)
    }
    return plainView($.ui.resolve(e), Ls, S, range, tab, setRange, setTab, e.props.bodyColumns)
  })
}
