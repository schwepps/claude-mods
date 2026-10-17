import type { ClientModule, ClientSurface, RenderChildren } from 'claude-code'

import type { AgentState, AgentsView, CardView, DashView, EconomicsView, SessionView, TopView, UsageView } from '../types'
import { FAMILY_COLOR, FAMILY_LABEL, fmt, fmtInt, fmtUsd } from './data'
import { C } from './theme'

type Pt = { x: number; y: number } | null
type S = { shown: Record<string, number>; hover: Pt }
type Els = ClientSurface<S>['elements']

const FRAME_MS = 33
/** Share of the remaining distance covered per frame: about a second to settle, so values glide between updates. */
const EASE = 0.12
const METER_SEGMENTS = 24
const SPARK_COLS = 12
const CHART_ROWS = 10

const STATUS: Record<AgentState, { color: string; icon: string; label: string }> = {
  running: { color: C.ok, icon: '●', label: 'Running' },
  waiting: { color: C.warn, icon: '▲', label: 'Waiting' },
  idle: { color: C.idle, icon: '○', label: 'Idle' },
  done: { color: C.accent, icon: '✓', label: 'Done' },
  failed: { color: C.bad, icon: '✕', label: 'Failed' },
}

const latest = new Map<string, Record<string, number>>()

/** Surfaces take whole percentages only. */
const pct = (x: number) => `${Math.max(0, Math.min(100, Math.round(x)))}%`

function targetsOf(v: DashView): Record<string, number> {
  const t: Record<string, number> = {}
  if (v.view === 'top') {
    t.rate = v.rate
    t.today = v.today
    t.costToday = v.costToday
    t.max = v.max
    const sum = v.mix.reduce((a, m) => a + m.tokens, 0) || 1
    for (const m of v.mix) t[`mix:${m.family}`] = (m.tokens / sum) * 100
  } else if (v.view === 'agents') {
    for (const line of v.groups) {
      t[`pt:${line.name}`] = line.tokensToday
      t[`pc:${line.name}`] = line.costToday
    }
    for (const g of [...v.groups.flatMap(line => line.sessions), ...v.idle]) {
      t[`g:${g.key}`] = g.tokens
      t[`gc:${g.key}`] = g.costUsd
      for (const c of g.cards) {
        t[`t:${c.id}`] = c.tokens
        t[`r:${c.id}`] = c.rate
        c.spark.slice(-SPARK_COLS).forEach((x, i) => (t[`s:${c.id}:${i}`] = x))
      }
    }
  } else if (v.view === 'economics') {
    t.cost = v.cost
    t.plan = v.planShare
    t.mult = v.multiple
    t.share = (v.shareOfTotal ?? 0) * 100
    v.byKind.forEach((k, i) => (t[`k:${i}`] = k.usd))
    v.byModel.forEach(m => (t[`f:${m.key}`] = m.usd))
    v.points.forEach((p, i) => (t[`c:${v.range}:${i}`] = p.usd))
    for (const r of v.byProject ?? []) t[`ep:${r.name}`] = r.usd
  } else {
    v.tiles.forEach((tile, i) => tile.value !== null && (t[`tile:${i}`] = tile.value))
    v.points.forEach((p, i) => p.values.forEach((x, f) => (t[`u:${v.range}:${i}:${f}`] = x)))
    for (const r of v.byProject ?? []) r.values.forEach((x, f) => (t[`bp:${r.name}:${f}`] = x))
  }
  return t
}

function step(cur: Record<string, number>, target: Record<string, number>): { next: Record<string, number>; isMoving: boolean } {
  const next: Record<string, number> = {}
  let isMoving = false
  for (const [k, to] of Object.entries(target)) {
    const at = cur[k] ?? 0
    const gap = to - at
    if (Math.abs(gap) <= Math.max(0.01, Math.abs(to) * 0.001)) next[k] = to
    else {
      next[k] = at + gap * EASE
      isMoving = true
    }
  }
  return { next, isMoving }
}

const sameKeysAndValues = (a: Record<string, number>, b: Record<string, number>) => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k])
}

const Dash: ClientModule<DashView, S> = (props, surface) => {
  const target = targetsOf(props)
  latest.set(props.view, target)
  if (surface.state === undefined) {
    const view = props.view
    surface.every(FRAME_MS, () => {
      const cur = surface.state?.shown ?? {}
      const goal = latest.get(view) ?? {}
      const { next, isMoving } = step(cur, goal)
      if (isMoving || !sameKeysAndValues(cur, next)) surface.setState({ shown: next, hover: surface.state?.hover ?? null })
    })
    surface.setState({ shown: {}, hover: null })
    surface.onPointer(e => {
      const cur = surface.state
      if (!cur) return
      if (e.type === 'leave') {
        if (cur.hover) surface.setState({ ...cur, hover: null })
      } else if (cur.hover?.x !== e.x || cur.hover?.y !== e.y) surface.setState({ ...cur, hover: { x: e.x, y: e.y } })
    })
  }
  const shown = surface.state?.shown ?? {}
  const val = (k: string) => shown[k] ?? 0
  const els = surface.elements
  if (props.view === 'top') return top(els, props, val)
  if (props.view === 'agents') return agents(els, props, val, surface.columns)
  const at = surface.state?.hover ?? null
  if (props.view === 'economics') return economics(els, props, val, columnAt(at, economicsBand(surface.rows, surface.columns), surface.columns, props.points.length))
  return usage(els, props, val, columnAt(at, usageBand(props, surface.columns), surface.columns, props.points.length))
}

export default Dash

type Val = (k: string) => number

/** One row tall; a fill of `fraction` drawn as boxes so it shares the layout grid with every other bar. */
function meterSegments({ Box }: Els, fraction: number, colorAt: (i: number) => string) {
  const lit = Math.max(0, Math.min(1, fraction)) * METER_SEGMENTS
  return (
    <Box width="100%" height={1} columnGap={1}>
      {Array.from({ length: METER_SEGMENTS }, (_, i) => (
        <Box key={`seg-${i}`} width={0} flexGrow={1} height={1} backgroundColor={C.line}>
          <Box width={pct(Math.max(0, Math.min(1, lit - i)) * 100)} height={1} backgroundColor={colorAt(i)} />
        </Box>
      ))}
    </Box>
  )
}

const PLOT_LEFT = 11
const PLOT_RIGHT = 3

const BAND_SLACK = 1
const ECONOMICS_NOTE_CHARS = 252

type Band = { top: number; bottom: number }

/** Rows the usage plot occupies, from the tiles above it: seven rows each, wrapped greedily with the row gap of two. */
function usageBand(v: UsageView, columns: number): Band {
  const widths = v.tiles.map(t => Math.max(t.label.length, t.text?.length ?? 8, t.note.length) + 6)
  let lines = 1
  let used = 0
  for (const w of widths) {
    if (used > 0 && used + 2 + w > columns) {
      lines++
      used = w
    } else used += (used > 0 ? 2 : 0) + w
  }
  const top = lines * 7 + (lines - 1) * 2 + 2 + 2
  return { top, bottom: top + CHART_ROWS }
}

/** Rows the economics plot occupies, counted up from the region's bottom: footnote, gap, chart panel border, padding, readout, axis, gaps. */
function economicsBand(rows: number, columns: number): Band {
  const note = Math.ceil(ECONOMICS_NOTE_CHARS / Math.max(1, columns))
  const bottom = rows - note - 8
  return { top: bottom - CHART_ROWS, bottom }
}

/** The chart column under the pointer, or null unless it is inside the plot's rows and columns. */
function columnAt(at: Pt, band: Band, columns: number, count: number): number | null {
  const width = columns - PLOT_LEFT - PLOT_RIGHT
  if (!at || count === 0 || width < count) return null
  if (at.y < band.top - BAND_SLACK || at.y >= band.bottom + BAND_SLACK) return null
  if (at.x < PLOT_LEFT || at.x >= PLOT_LEFT + width) return null
  return Math.min(count - 1, Math.floor(((at.x - PLOT_LEFT) / width) * count))
}

/** One fixed row under a chart, so showing or clearing it never moves the layout. */
function readout({ Box, Text }: Els, key: string, parts: { text: string; color?: string }[] | null) {
  return (
    <Box key={key} width="100%" height={1} columnGap={2}>
      {parts ? (
        parts.map((r, j) => (
          <Text key={`ro-${j}`} bold={j === 0} color={r.color ?? C.muted}>
            {r.text}
          </Text>
        ))
      ) : (
        <Text color={C.muted}>Hover a column for details</Text>
      )}
    </Box>
  )
}

function panel({ Box }: Els, key: string, children: RenderChildren) {
  return (
    <Box key={key} flexDirection="column" gap={1} flexGrow={1} width={0} minWidth={40} paddingX={2} paddingY={1} borderStyle="round" borderColor={C.line} backgroundColor={C.panel}>
      {children}
    </Box>
  )
}

function top(els: Els, v: TopView, val: Val) {
  const { Box, Text } = els
  const rate = val('rate')
  const max = Math.max(1, val('max') || v.max)
  const segColor = (i: number) => {
    const f = i / (METER_SEGMENTS - 1)
    return f < 0.5 ? C.accent : f < 0.85 ? C.accent2 : C.warn
  }
  const kpi = (label: string, value: string, color: string = C.fg, width?: number) => (
    <Box key={`kpi-${label}`} flexDirection="column" width={width}>
      <Text color={C.muted}>{label}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  )
  const used = v.mix.filter(m => m.tokens > 0)
  return (
    <Box flexDirection="column" gap={2} width="100%">
      <Box justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Text bold color={C.accent}>
          ◉ AGENT/OPS
        </Text>
        <Text color={C.muted}>
          {v.sessions} {v.sessions === 1 ? 'session' : 'sessions'} · live
        </Text>
      </Box>
      <Box flexWrap="wrap" columnGap={6} rowGap={1}>
        {kpi('AGENTS UP', `${v.up}/${v.count}`)}
        {kpi('THROUGHPUT', `${fmtInt(rate)} tok/s`, C.fg, 16)}
        {kpi('TOKENS TODAY', fmt(val('today')))}
        {kpi('WAITING', String(v.waiting), v.waiting ? C.warn : C.fg)}
        {kpi('API VALUE TODAY', fmtUsd(val('costToday')), C.ok)}
      </Box>
      <Box flexWrap="wrap" gap={2}>
        {panel(els, 'meter', [
          <Box key="meter-h" justifyContent="space-between">
            <Text color={C.muted}>THROUGHPUT · OUTPUT TOK/S</Text>
            <Box width={8} justifyContent="flex-end">
              <Text bold color={C.fg}>
                {fmtInt(rate)}
              </Text>
            </Box>
          </Box>,
          <Box key="meter-bar" width="100%">
            {meterSegments(els, rate / max, segColor)}
          </Box>,
          <Box key="meter-scale" justifyContent="space-between">
            <Text color={C.muted}>0</Text>
            <Text color={C.muted}>{fmt(max / 2)}</Text>
            <Text color={C.muted}>{fmt(max)}</Text>
          </Box>,
        ])}
        {panel(els, 'mix', [
          <Box key="mix-h" justifyContent="space-between">
            <Text color={C.muted}>MODEL MIX · TODAY</Text>
            <Text bold color={C.fg}>
              {fmt(val('today'))}
            </Text>
          </Box>,
          <Box key="mix-bar" width="100%" height={1} backgroundColor={C.line}>
            {used.map(m => (
              <Box key={`mixbar-${m.family}`} width={pct(val(`mix:${m.family}`))} height={1} backgroundColor={FAMILY_COLOR[m.family]} />
            ))}
          </Box>,
          <Box key="mix-lg" columnGap={3} flexWrap="wrap">
            {used.length === 0 ? (
              <Text color={C.muted}>No usage yet today</Text>
            ) : (
              used.map(m => (
                <Text key={`mixlg-${m.family}`} color={C.muted}>
                  <Text color={FAMILY_COLOR[m.family]}>■</Text> {FAMILY_LABEL[m.family]}{' '}
                  <Text color={C.fg}>{Math.round(val(`mix:${m.family}`))}%</Text>
                </Text>
              ))
            )}
          </Box>,
        ])}
      </Box>
    </Box>
  )
}

function sparkBars({ Box }: Els, values: number[], color: string) {
  const max = Math.max(1, ...values)
  return (
    <Box width={SPARK_COLS} height={1} alignItems="flex-end">
      {values.map((x, i) => (
        <Box key={`sp-${i}`} width={0} flexGrow={1} height={pct(Math.max(6, (x / max) * 100))} backgroundColor={x > 0 ? color : C.line} />
      ))}
    </Box>
  )
}

type Columns = { model: boolean; spark: boolean }

const W = { status: 15, model: 20, output: 18, outputNarrow: 7, tokens: 9, sessionTotal: 18 }

function headerRow({ Box, Text }: Els, cols: Columns) {
  const heading = (label: string) => <Text color={C.muted}>{label}</Text>
  return (
    <Box key="thead" gap={2}>
      <Box width={W.status}>{heading('STATUS')}</Box>
      <Box width={0} flexGrow={2} minWidth={0}>
        {heading('AGENT')}
      </Box>
      <Box width={0} flexGrow={3} minWidth={0}>
        {heading('DOING NOW')}
      </Box>
      {cols.model ? <Box width={W.model}>{heading('MODEL')}</Box> : null}
      <Box width={cols.spark ? W.output : W.outputNarrow} justifyContent="flex-end">
        {heading('TOK/S')}
      </Box>
      <Box width={W.tokens} justifyContent="flex-end">
        {heading('TOKENS')}
      </Box>
    </Box>
  )
}

function agentRow(els: Els, c: CardView, val: Val, cols: Columns) {
  const { Box, Text } = els
  const st = STATUS[c.status]
  const isQuiet = c.status === 'idle' || c.status === 'done' || c.status === 'failed'
  const text = isQuiet ? C.muted : C.fg
  const color = FAMILY_COLOR[c.family]
  const rate = val(`r:${c.id}`)
  return (
    <Box key={`row-${c.id}`} gap={2} alignItems="center">
      <Box width={W.status}>
        <Text color={st.color}>
          {st.icon} {st.label}
          {c.status === 'waiting' && c.when ? ` ${c.when}` : ''}
        </Text>
      </Box>
      <Box width={0} flexGrow={2} minWidth={0} columnGap={1}>
        <Text color={text} bold={!isQuiet} wrap="truncate-end">
          {c.name}
        </Text>
        {c.progress !== null ? <Text color={C.accent}>{Math.round(c.progress * 100)}%</Text> : null}
      </Box>
      <Box width={0} flexGrow={3} minWidth={0}>
        <Text color={C.muted} wrap="truncate-end">
          {c.activity}
        </Text>
      </Box>
      {cols.model ? (
        <Box width={W.model}>
          <Text color={C.muted} wrap="truncate-end">
            <Text color={color}>■</Text> {c.model}
            {c.effort ? ` · ${c.effort}` : ''}
          </Text>
        </Box>
      ) : null}
      <Box width={cols.spark ? W.output : W.outputNarrow} gap={1} justifyContent="flex-end" alignItems="center">
        {cols.spark && !isQuiet ? sparkBars(els, Array.from({ length: SPARK_COLS }, (_, i) => val(`s:${c.id}:${i}`)), color) : null}
        <Text color={rate > 0 ? C.fg : C.muted}>{isQuiet ? '—' : fmtInt(rate)}</Text>
      </Box>
      <Box width={W.tokens} justifyContent="flex-end">
        <Text color={text} bold={!isQuiet}>
          {fmt(val(`t:${c.id}`))}
        </Text>
      </Box>
    </Box>
  )
}

const RAIL: Record<AgentState, string> = { running: C.ok, waiting: C.warn, idle: C.idle, done: C.idle, failed: C.bad }

/** One card per session: a status rail on the left, the session line, then one row per agent. */
function sessionCard(els: Els, g: SessionView, val: Val, cols: Columns, withHeader: boolean) {
  const { Box, Text } = els
  const summaryColor = g.status === 'waiting' ? C.warn : g.status === 'running' ? C.ok : g.status === 'failed' ? C.bad : C.muted
  return (
    <Box key={`sess-${g.key}`} width="100%" borderStyle="round" borderColor={g.status === 'waiting' ? '#5a4520' : C.line} backgroundColor={C.panel}>
      <Box width={1} backgroundColor={RAIL[g.status]} />
      <Box flexDirection="column" flexGrow={1} minWidth={0} gap={1} paddingX={2} paddingY={1}>
        <Box gap={3} alignItems="center">
          <Box flexGrow={1} minWidth={0} columnGap={2}>
            <Text bold color={C.fg} wrap="truncate-end">
              {g.title}
            </Text>
            <Text color={C.muted} wrap="truncate-end">
              {g.subtitle}
            </Text>
          </Box>
          <Text color={summaryColor}>{g.summary}</Text>
          <Box width={W.sessionTotal} justifyContent="flex-end">
            <Text bold color={C.fg}>
              {fmt(val(`g:${g.key}`))} <Text color={C.ok}>{fmtUsd(val(`gc:${g.key}`))}</Text>
            </Text>
          </Box>
        </Box>
        <Box flexDirection="column">
          {withHeader ? headerRow(els, cols) : null}
          {g.cards.map(c => agentRow(els, c, val, cols))}
        </Box>
      </Box>
    </Box>
  )
}

/** Sessions with nothing running share one compact card, a line each. */
function idleCard(els: Els, sessions: SessionView[], val: Val, showProject: boolean) {
  const { Box, Text } = els
  return (
    <Box key="idle" width="100%" borderStyle="round" borderColor={C.line} backgroundColor={C.bg}>
      <Box width={1} backgroundColor={C.idle} />
      <Box flexDirection="column" flexGrow={1} minWidth={0} paddingX={2} paddingY={1}>
        {sessions.map(g => (
          <Box key={`idle-${g.key}`} gap={2} alignItems="center">
            <Box width={W.status}>
              <Text color={STATUS[g.status === 'failed' ? 'failed' : 'idle'].color}>
                {g.status === 'failed' ? '✕ Failed' : '○ Idle'}
              </Text>
            </Box>
            <Box flexGrow={1} minWidth={0} columnGap={2}>
              <Text color={C.fg} wrap="truncate-end">
                {g.title}
              </Text>
              <Text color={C.muted} wrap="truncate-end">
                {showProject ? g.project : g.subtitle}
              </Text>
            </Box>
            <Text color={C.muted}>{g.when}</Text>
            <Box width={W.sessionTotal} justifyContent="flex-end">
              <Text color={C.fg}>
                {fmt(val(`g:${g.key}`))} <Text color={C.ok}>{fmtUsd(val(`gc:${g.key}`))}</Text>
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

function agents(els: Els, v: AgentsView, val: Val, columns: number) {
  const { Box, Text } = els
  const cols: Columns = { model: columns === 0 || columns >= 90, spark: columns === 0 || columns >= 72 }
  return (
    <Box flexDirection="column" gap={1} width="100%">
      {v.error ? <Text color={C.warn}>{v.error}</Text> : null}
      {v.groups.map((line, li) => (
        <Box key={`proj-${line.name}`} flexDirection="column" gap={1} width="100%">
          {v.showProjectLines ? (
            <Box justifyContent="space-between" columnGap={3} flexWrap="wrap" paddingTop={li === 0 ? 0 : 1}>
              <Box columnGap={2} flexWrap="wrap">
                <Text bold color={C.accent}>
                  {line.name}
                </Text>
                <Text color={C.muted}>{line.summary}</Text>
              </Box>
              <Text color={C.muted}>
                <Text color={C.fg}>{fmt(val(`pt:${line.name}`))}</Text> ·{' '}
                <Text color={C.ok}>{fmtUsd(val(`pc:${line.name}`))}</Text> today
              </Text>
            </Box>
          ) : null}
          {line.sessions.map((g, i) => sessionCard(els, g, val, cols, li === 0 && i === 0))}
        </Box>
      ))}
      {v.idle.length ? idleCard(els, v.idle, val, v.showProjectLines) : null}
    </Box>
  )
}

function usage(els: Els, v: UsageView, val: Val, hovered: number | null) {
  const { Box, Text } = els
  const totals = v.points.map((p, i) => p.values.reduce((a, _x, f) => a + val(`u:${v.range}:${i}:${f}`), 0))
  const targetMax = Math.max(1, ...v.points.map(p => p.values.reduce((a, b) => a + b, 0))) * 1.1
  const every = v.points.length > 24 ? 5 : v.points.length > 12 ? 3 : 1
  return (
    <Box flexDirection="column" gap={2} width="100%">
      <Box flexWrap="wrap" gap={2}>
        {v.tiles.map((t, i) => (
          <Box key={`tile-${t.label}`} flexDirection="column" flexGrow={1} paddingX={2} paddingY={1} borderStyle="round" borderColor={C.line} backgroundColor={C.panel}>
            <Text color={C.muted}>{t.label}</Text>
            <Text bold color={t.color}>
              {t.value !== null ? fmt(val(`tile:${i}`)) : t.text}
            </Text>
            <Text color={t.noteColor}>{t.note}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" gap={1} width="100%" paddingX={2} paddingY={1} borderStyle="round" borderColor={C.line} backgroundColor={C.panel}>
        <Box width="100%" height={CHART_ROWS}>
          <Box flexDirection="column" justifyContent="space-between" width={8} height={CHART_ROWS}>
            <Text color={C.muted}>{fmt(targetMax)}</Text>
            <Text color={C.muted}>{fmt(targetMax / 2)}</Text>
            <Text color={C.muted}>0</Text>
          </Box>
          <Box flexGrow={1} height={CHART_ROWS} alignItems="flex-end">
            {v.points.map((p, i) => (
              <Box key={`col-${v.range}-${i}`} width={0} flexGrow={1} height={pct((totals[i]! / targetMax) * 100)} flexDirection="column-reverse">
                {p.values.map((_x, f) => {
                  const part = totals[i]! > 0 ? (val(`u:${v.range}:${i}:${f}`) / totals[i]!) * 100 : 0
                  return part > 0 ? <Box key={`seg-${i}-${f}`} width="100%" height={pct(part)} backgroundColor={FAMILY_COLOR[v.families[f]!]} /> : null
                })}
              </Box>
            ))}
          </Box>
        </Box>
        <Box width="100%">
          <Box width={8} />
          <Box flexGrow={1}>
            {v.points.map((p, i) => (
              <Box key={`x-${v.range}-${i}`} width={0} flexGrow={1}>
                <Text color={C.muted}>{i % every === 0 ? p.label : ''}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        {readout(
          els,
          'usage-readout',
          hovered === null
            ? null
            : v.points[hovered]!.isFuture
              ? [{ text: v.points[hovered]!.full }, { text: 'No data yet' }]
              : [
                  { text: v.points[hovered]!.full, color: C.fg },
                  { text: `${fmt(v.points[hovered]!.values.reduce((a, b) => a + b, 0))} tokens`, color: C.fg },
                  ...v.points[hovered]!.values.flatMap((x, f) => (x > 0 ? [{ text: `■ ${FAMILY_LABEL[v.families[f]!]} ${fmt(x)}`, color: FAMILY_COLOR[v.families[f]!] }] : [])),
                ],
        )}
      </Box>
      <Box flexWrap="wrap" columnGap={3}>
        {v.families.map(f => (
          <Text key={`lg-${f}`} color={C.muted}>
            <Text color={FAMILY_COLOR[f]}>■</Text> {FAMILY_LABEL[f]}
          </Text>
        ))}
      </Box>
      {v.byProject && v.byProject.length ? projectTokens(els, v, val) : null}
    </Box>
  )
}

const PROJECT_COL = 26

function projectTokens({ Box, Text }: Els, v: UsageView, val: Val) {
  const rows = v.byProject ?? []
  const max = Math.max(1, ...rows.map(r => r.total))
  return (
    <Box flexDirection="column" gap={1} width="100%" paddingX={2} paddingY={1} borderStyle="round" borderColor={C.line} backgroundColor={C.panel}>
      <Box justifyContent="space-between">
        <Text color={C.muted}>BY PROJECT</Text>
        <Text color={C.muted}>tokens, split by model</Text>
      </Box>
      {rows.map(r => {
        const parts = r.values.map((_, f) => val(`bp:${r.name}:${f}`))
        const shown = parts.reduce((a, b) => a + b, 0)
        const isRest = /^\d+ more$/.test(r.name)
        return (
          <Box key={`bp-${r.name}`} gap={2} alignItems="center">
            <Box width={PROJECT_COL}>
              <Text color={isRest ? C.muted : C.fg} wrap="truncate-end">
                {r.name}
              </Text>
            </Box>
            <Box flexGrow={1} height={1} backgroundColor={C.line}>
              {parts.map((x, f) =>
                x > 0 ? <Box key={`bps-${r.name}-${f}`} width={pct((x / max) * 100)} height={1} backgroundColor={isRest ? C.idle : FAMILY_COLOR[v.families[f]!]} /> : null,
              )}
            </Box>
            <Box width={8} justifyContent="flex-end">
              <Text color={isRest ? C.muted : C.fg}>{fmt(shown)}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function projectCosts({ Box, Text }: Els, v: EconomicsView, val: Val) {
  const rows = v.byProject ?? []
  const max = Math.max(1e-9, ...rows.map(r => r.usd))
  const head = (label: string) => <Text color={C.muted}>{label}</Text>
  return (
    <Box flexDirection="column" gap={1} width="100%" paddingX={2} paddingY={1} borderStyle="round" borderColor={C.line} backgroundColor={C.panel}>
      <Box gap={2}>
        <Box width={PROJECT_COL}>{head('COST BY PROJECT')}</Box>
        <Box width={9} justifyContent="flex-end">
          {head('COST')}
        </Box>
        <Box flexGrow={1}>{head('SHARE')}</Box>
        <Box width={12} justifyContent="flex-end">
          {head('PER SESSION')}
        </Box>
        <Box width={8} justifyContent="flex-end">
          {head('VS PLAN')}
        </Box>
      </Box>
      {rows.map(r => {
        const usd = val(`ep:${r.name}`)
        const isRest = /^\d+ more$/.test(r.name)
        const tone = isRest ? C.muted : C.fg
        return (
          <Box key={`ep-${r.name}`} gap={2} alignItems="center">
            <Box width={PROJECT_COL}>
              <Text color={tone} wrap="truncate-end">
                {r.name}
              </Text>
            </Box>
            <Box width={9} justifyContent="flex-end">
              <Text color={isRest ? C.muted : C.ok}>{fmtUsd(usd)}</Text>
            </Box>
            <Box flexGrow={1} gap={1} alignItems="center">
              <Box flexGrow={1} height={1} backgroundColor={C.line}>
                <Box width={pct((usd / max) * 100)} height={1} backgroundColor={isRest ? C.idle : C.ok} />
              </Box>
              <Box width={5} justifyContent="flex-end">
                <Text color={C.muted}>{Math.round(r.share * 100)}%</Text>
              </Box>
            </Box>
            <Box width={12} justifyContent="flex-end">
              <Text color={tone}>{r.perSession === null ? '—' : fmtUsd(r.perSession)}</Text>
            </Box>
            <Box width={8} justifyContent="flex-end">
              <Text color={tone}>{r.multiple >= 10 ? Math.round(r.multiple) : r.multiple.toFixed(1)}×</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function barRow({ Box, Text }: Els, key: string, label: string, fraction: number, color: string, value: string, detail: string) {
  return (
    <Box key={key} flexDirection="column">
      <Box justifyContent="space-between" columnGap={2}>
        <Text color={C.fg}>{label}</Text>
        <Text color={C.muted}>
          <Text bold color={C.fg}>
            {value}
          </Text>
          {detail ? `  ${detail}` : ''}
        </Text>
      </Box>
      <Box width="100%" height={1} backgroundColor={C.line}>
        <Box width={pct(fraction * 100)} height={1} backgroundColor={color} />
      </Box>
    </Box>
  )
}

function economics(els: Els, v: EconomicsView, val: Val, hovered: number | null) {
  const { Box, Text } = els
  const cost = val('cost')
  const plan = val('plan')
  const mult = val('mult')
  const kindMax = Math.max(1e-9, ...v.byKind.map((_, i) => val(`k:${i}`)))
  const famMax = Math.max(1e-9, ...v.byModel.map(m => val(`f:${m.key}`)))
  const kindColor = [C.accent2, C.accent, C.ok]
  const colMax = Math.max(0.01, ...v.points.map(p => p.usd)) * 1.1
  const every = v.points.length > 24 ? 5 : v.points.length > 12 ? 3 : 1
  const box = (key: string, children: RenderChildren, grow = 1) => (
    <Box key={key} flexDirection="column" gap={1} flexGrow={grow} minWidth={40} paddingX={2} paddingY={1} borderStyle="round" borderColor={C.line} backgroundColor={C.panel}>
      {children}
    </Box>
  )
  return (
    <Box flexDirection="column" gap={2} width="100%">
      <Box width="100%" borderStyle="round" borderColor={C.line} backgroundColor={C.panel}>
        <Box width={1} backgroundColor={C.ok} />
        <Box flexGrow={1} flexWrap="wrap" justifyContent="space-between" alignItems="center" gap={2} paddingX={2} paddingY={1}>
          <Box flexDirection="column">
            <Text color={C.muted}>
              API-EQUIVALENT COST · {v.rangeLabel.toUpperCase()} · {v.scope.toUpperCase()}
            </Text>
            <Text bold color={C.ok}>
              {fmtUsd(cost)}
            </Text>
            <Text color={C.muted}>
              {v.shareOfTotal === null
                ? `vs ${fmtUsd(plan)} of your ${fmtUsd(v.planMonthly)}/month plan for ${v.coveredDays === null ? 'the same period' : `the ${v.coveredDays} days with data`}`
                : 'your plan covers all projects, so this one is shown as a share of total spend'}
            </Text>
          </Box>
          {v.shareOfTotal === null ? (
            <Box flexDirection="column" alignItems="flex-end">
              <Text color={C.muted}>VALUE FROM YOUR PLAN</Text>
              <Text bold color={mult >= 1 ? C.ok : C.warn}>
                {mult >= 10 ? Math.round(mult) : mult.toFixed(1)}×
              </Text>
              <Text color={C.muted}>{cost >= plan ? `${fmtUsd(cost - plan)} saved` : `${fmtUsd(plan - cost)} under plan price`}</Text>
            </Box>
          ) : (
            <Box flexDirection="column" alignItems="flex-end">
              <Text color={C.muted}>SHARE OF TOTAL SPEND</Text>
              <Text bold color={C.accent}>
                {Math.round(val('share'))}%
              </Text>
              <Text color={C.muted}>{fmtUsd(cost)} of all projects' cost</Text>
            </Box>
          )}
        </Box>
      </Box>
      <Box flexWrap="wrap" gap={2}>
        {box('kinds', [
          <Text key="kh" color={C.muted}>
            COST BY TOKEN TYPE
          </Text>,
          ...v.byKind.map((k, i) => barRow(els, `k-${i}`, k.label, val(`k:${i}`) / kindMax, kindColor[i] ?? C.accent, fmtUsd(val(`k:${i}`)), `${fmt(k.tokens)} tokens`)),
        ])}
        {box('models', [
          <Text key="fh" color={C.muted}>
            COST BY MODEL
          </Text>,
          ...(v.byModel.length
            ? v.byModel.map(m => barRow(els, `f-${m.key}`, m.label, val(`f:${m.key}`) / famMax, FAMILY_COLOR[m.family], fmtUsd(val(`f:${m.key}`)), `${fmt(m.tokens)} tokens`))
            : [<Text key="fe" color={C.muted}>No priced usage yet</Text>]),
          ...v.pricing.map((note, i) => (
            <Text key={`price-${i}`} color={C.warn}>
              ▲ {note}
            </Text>
          )),
        ])}
      </Box>
      {v.byProject && v.byProject.length ? projectCosts(els, v, val) : null}
      <Text color={C.accent}>◆ {v.insight}</Text>
      {box('chart', [
        <Text key="ch" color={C.muted}>
          API-EQUIVALENT COST PER {v.range === 'day' ? 'HOUR' : v.range === 'year' ? 'MONTH' : 'DAY'}
        </Text>,
        <Box key="cplot" width="100%" height={CHART_ROWS}>
          <Box flexDirection="column" justifyContent="space-between" width={8} height={CHART_ROWS}>
            <Text color={C.muted}>{fmtUsd(colMax)}</Text>
            <Text color={C.muted}>{fmtUsd(colMax / 2)}</Text>
            <Text color={C.muted}>$0</Text>
          </Box>
          <Box flexGrow={1} height={CHART_ROWS} alignItems="flex-end" columnGap={0}>
            {v.points.map((p, i) => (
              <Box key={`cc-${v.range}-${i}`} width={0} flexGrow={1} height={pct((val(`c:${v.range}:${i}`) / colMax) * 100)} backgroundColor={C.ok} />
            ))}
          </Box>
        </Box>,
        <Box key="cx" width="100%">
          <Box width={8} />
          <Box flexGrow={1}>
            {v.points.map((p, i) => (
              <Box key={`cx-${v.range}-${i}`} width={0} flexGrow={1}>
                <Text color={C.muted}>{i % every === 0 ? p.label : ''}</Text>
              </Box>
            ))}
          </Box>
        </Box>,
        readout(els, 'chart-readout', hovered === null ? null : v.points[hovered]!.isFuture ? [{ text: v.points[hovered]!.full }, { text: 'No data yet' }] : [{ text: v.points[hovered]!.full, color: C.fg }, { text: fmtUsd(v.points[hovered]!.usd), color: C.ok }, { text: 'API-equivalent cost' }]),
      ])}
      <Text color={C.muted}>
        Estimated from transcript token counts at Anthropic API list prices (Oct 2026), including cache writes and reads and fast mode. Excludes web search and other tool fees. Your plan's usage limits are not modelled. The plan price is a setting of this mod.
      </Text>
    </Box>
  )
}
