export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other'

export type AgentState = 'running' | 'waiting' | 'idle' | 'done' | 'failed'

export type AgentRow = {
  id: string
  name: string
  type: string
  status: AgentState
  model: string | null
  effort: string | null
  tokensIn: number
  tokensOut: number
  cacheRead: number
  rate: number
  spark: number[]
  progress: { done: number; total: number } | null
  steps: number
  activity: string
  startedAt: number
  /** Session title for a subagent of another session; null for this session's agents. */
  session: string | null
  project: string | null
  /** The repository folder the agent works in, worktrees folded into their repo; merged into projects by name. */
  repo: string | null
  isLocal: boolean
  /** API-equivalent spend of this agent's transcript so far; 0 for this session's agents, priced per session instead. */
  costUsd: number
  /** When the agent entered its current status (this session) or last wrote to its transcript (others). */
  since: number
}

/**
 * Per model family: [input incl. cache writes, output, cache reads, then USD at API list prices:
 * total, uncached input, output, cache writes, cache reads]. Older entries may stop after the token counts.
 */
export type Usage = number[]

/** Keyed by model version ("opus-5-5"); history from before versions were tracked is keyed by bare family ("opus"). */
export type Bucket = Record<string, Usage>

/** Keyed by local hour, `YYYY-MM-DDTHH`. */
export type History = Record<string, Bucket>

/** Per repository folder: usage (earlier days folded into one bucket at noon) and the session ids active each day. */
export type RepoHistory = Record<string, { hist: History; sessions: Record<string, string[]> }>

/** A model id the price table has no exact row for: priced as a related version, or not at all when `as` is null. */
export type PricingNote = { model: string; as: string | null; tokens: number }

export type Live = {
  agents: AgentRow[]
  /** API-equivalent spend of this session's own transcript. */
  selfUsd: number
  byModel: Bucket
  rate: number
  peak: number
  at: number
}

export type Range = 'day' | 'week' | 'month' | 'year'

export type Tab = 'agents' | 'usage' | 'economics'

/** What the hooks module hands each live region; plain JSON. */
export type TopView = {
  view: 'top'
  up: number
  count: number
  rate: number
  max: number
  today: number
  waiting: number
  sessions: number
  costToday: number
  mix: { family: ModelFamily; tokens: number }[]
}

export type CardView = {
  id: string
  name: string
  status: AgentState
  activity: string
  model: string
  family: ModelFamily
  effort: string | null
  effortLevel: number
  type: string
  progress: number | null
  progressText: string
  tokens: number
  rate: number
  spark: number[]
  /** "2m" while waiting, "12m ago" while idle or done, empty otherwise. */
  when: string
}

export type SessionView = {
  key: string
  title: string
  subtitle: string
  /** The most urgent status among its agents: what the rail shows. */
  status: AgentState
  summary: string
  tokens: number
  costUsd: number
  project: string
  when: string
  cards: CardView[]
}

export type ProjectGroupView = {
  name: string
  summary: string
  tokensToday: number
  costToday: number
  sessions: SessionView[]
}

export type AgentsView = {
  view: 'agents'
  error: string | null
  /** Project lines above their session cards; one unnamed group when a project is selected. */
  groups: ProjectGroupView[]
  showProjectLines: boolean
  idle: SessionView[]
}

export type UsageTile = { label: string; value: number | null; text: string | null; note: string; color: string; noteColor: string }

export type UsageView = {
  view: 'usage'
  range: Range
  unit: string
  tiles: UsageTile[]
  families: ModelFamily[]
  points: { label: string; full: string; isFuture: boolean; values: number[] }[]
  /** Tokens per project for the period, split like `families`; null while one project is selected. */
  byProject: { name: string; values: number[]; total: number }[] | null
}

export type EconomicsView = {
  view: 'economics'
  range: Range
  rangeLabel: string
  planMonthly: number
  cost: number
  planShare: number
  /** Days the plan is compared over when history starts inside the range; null when it covers the whole range. */
  coveredDays: number | null
  /** Warnings about models priced approximately or at $0. */
  pricing: string[]
  multiple: number
  /** Share of all projects' cost for the period; null when no project is selected. */
  shareOfTotal: number | null
  byModel: { key: string; label: string; family: ModelFamily; usd: number; tokens: number }[]
  byKind: { label: string; usd: number; tokens: number }[]
  insight: string
  points: { label: string; full: string; isFuture: boolean; usd: number }[]
  /** Null while one project is selected. */
  byProject: { name: string; usd: number; share: number; perSession: number | null; multiple: number }[] | null
  scope: string
}

export type DashView = TopView | AgentsView | UsageView | EconomicsView

export type TabView = { id: string; label: string; isOn: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agent-ops': {
      live: Live
      history: History
      range: Range
      tab: Tab
      scanError: string | null
      pricing: PricingNote[]
      repos: RepoHistory
      /** The selected project, null for all. */
      project: string | null
      showAllProjects: boolean
    }
  }
}
