export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'

export type CacheMark = { at: number; context: number }

export type TurnPlan = {
  id: string
  home: Tier
  tier: Tier
  steps: number
  output: number
  failures: number
  startContext: number
}

export type DecisionEntry = {
  at: number
  scope: 'main' | 'subagent'
  from: Tier
  to: Tier
  reason: string
  isApplied: boolean
  prompt: string
  stayCost?: number
  switchCost?: number
}

export type AgentRoute = { tier: Tier; baseline: Tier }

export type RouterSession = {
  pin: Tier | null
  boost: { tier: Tier; turnsLeft: number } | null
  lastTier: Tier | null
  lastContext: number
  tierCache: Partial<Record<Tier, CacheMark>>
  stepsEma: number
  outputEma: number
  growthEma: number
  pendingOverride: Tier | null
  pendingText: { turnId: string; text: string } | null
  turn: TurnPlan | null
  agents: Record<string, AgentRoute>
  last: DecisionEntry | null
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': { session: RouterSession }
  }
}
