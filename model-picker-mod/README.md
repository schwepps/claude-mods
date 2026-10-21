# model-router

A Claude Code mod that picks the model (Haiku, Sonnet, Opus, Fable) for each turn and each subagent. The goal is to spend fewer tokens without losing quality.

## How it decides

**Your `/model` is home.** Each turn either runs on the home model or takes a detour to another model. The router never changes `/model` itself.

1. **Subagents (the biggest saving).** A subagent starts with an empty context, so changing its model has no prompt-cache cost.
   - `Explore`, `claude-code-guide` and `statusline-setup` run on Haiku.
   - `Plan` and security reviewers run on Opus. Other reviewers run on Sonnet.
   - `general-purpose` agents are sized from their task.
   - Forks, agents that already name a model, and other plugins' agents are left alone.
2. **Main loop: cheaper models only when it pays.** Prompt caches belong to one model. On a long conversation, switching models means re-writing the whole context into the new model's cache. A cost model compares two options over the next few turns: staying, or switching and later coming back. It switches only when switching is cheaper.
   - **Opus → Haiku** usually pays for a trivial turn, such as `git status`, a rename or a lookup.
   - **Opus → Sonnet** rarely pays mid-session. Opus 5.5 and Sonnet 5.5 cache reads cost the same, so only output tokens get cheaper. It does pay at the start of a session or right after compaction.
3. **Quality is asymmetric.** Moving to a stronger model needs no cost check. Moving to a cheaper one needs a confident classification and a passing cost check.
   - Unclear prompts stay on home.
   - Follow-ups ("yes", "go ahead", "2") stay on the current model.
4. **Escalation.**
   - "Still failing", "that's wrong" and similar replies undo a downgrade. If you were already on home, they move up one tier for three turns. Fable is the exception: with the default `fableMode`, it takes a second rejection while the first is still held.
   - "No regression" and "not a regression" are not rejections.
   - Three failed tool calls in a row on a downgraded model return the rest of the turn to home.
5. **Classification.** Only the words you typed are classified. Blocks the app adds (system reminders, messages from other sessions, CI and task notices, subagent reports) are dropped first; a turn made only of them stays on the current model. For a slash command, only the text after the command counts. Keyword rules run first. When the rules are unsure, and only when the answer could change the decision, the router asks Haiku 5.5 (about $0.0003 per call).

If any part of the router fails, the turn runs on your `/model` unchanged.

## Use

| Input | Effect |
| --- | --- |
| `::haiku fix the typo in README` | One turn on Haiku. The prefix is stripped before the model sees the prompt. |
| `::opus` (on its own) | Pins Opus for the session. |
| `::auto` (on its own) | Unpins. |
| `/route` | Status, last decision with its cost estimate, today's and this week's savings and spend by model. |
| `/route log` | The last 20 routing decisions, each with its session. |
| `/route sessions` | The 10 most expensive sessions of the last 7 days, with spend by model. |
| `/route sonnet` · `/route auto` | Pin or unpin. |

The status line shows the current tier, the reason for it, and today's estimated savings.

## Settings

Change these in the config menu, or under `pluginConfigs.model-router` in settings.

| Option | Default | |
| --- | --- | --- |
| `mainLoop` | `auto` | `shadow` logs decisions but changes nothing; `off` disables main-loop routing |
| `subagents` | `auto` | `off` leaves subagents alone |
| `fableMode` | `escalation` | `escalation`: `::fable`, or a second rejection in a row; `manual`: only `::fable`; `auto`: very hard prompts and the first rejection too |
| `minTier` | `haiku` | Floor: the router never picks a model below this |
| `classifier` | `true` | Ask Haiku about unclear prompts |
| `haikuEffort` | `low` | Effort for main-loop turns sent to Haiku; `inherit` uses the session's. Haiku keeps its own cache, so this never touches the home model's cache |
| `*Model` | `claude-*-5-5`, `claude-fable-5-1` | Model ids per tier (change them for Bedrock or Vertex) |
| `cacheTtlMinutes` / `cacheWriteMultiplier` | `60` / `2` | Cache assumptions: 1-hour cache. Use `5` / `1.25` for the 5-minute cache |
| `horizonTurns` | `3` | How many turns a downgrade is assumed to last |
| `prices` | empty (built-in) | Override prices: `tier=input/output/cacheRead` in $ per million tokens, separated by `;`, for example `opus=4/20/0.2; haiku=0.1/0.5/0.01`. Tiers left out keep the built-in price |
| `pricesAsOf` | empty | `YYYY-MM-DD` date of your `prices`. `/route` and the session-start toast warn once prices are over 90 days old |

## When new models or prices arrive

- **New version of a family** (Opus 6, Haiku 6): set the `*Model` id. Ids are matched by family name, so nothing else changes.
- **New prices**: set `prices` and `pricesAsOf`, or update `DEFAULT_PRICES` and `DEFAULT_PRICES_AS_OF` in `hooks/policy.ts`. `/route` shows the prices in use and their age.
- **Claude Code learns Haiku 5.5**: raise or remove `HAIKU_MAIN_LOOP_MAX_CONTEXT` in `hooks/policy.ts`.
- **A new family or tier**: code change (tiers, prices, settings).
- Then run `claude plugin test .`, a few lab scenarios, and `/reload-plugins`.

## Install for every session

```bash
claude plugin install model-router --marketplace schwepps/claude-mods
```

Or at the prompt of a terminal session: `/plugin install model-router --marketplace schwepps/claude-mods`. To develop against a local checkout, run Claude Code with `--plugin-dir <this folder>`.

## Develop and test

```bash
claude plugin validate . && claude plugin test .
```

`tests/` holds the free, deterministic tests: the policy, plus multi-turn scenarios run against mocked models (`tests/harness.ts`).

`lab/` is the live battle test. It runs real headless Claude Code sessions, each in a throwaway git repo, sends each turn after the previous one finishes, and checks which model answered every request. It spends real tokens: roughly $1–3 for the full set.

```bash
python3 lab/run.py
```

```bash
python3 lab/run.py -k pin -k subagent --workers 1 --keep
```

Scenarios live in `lab/scenarios.json`. Each turn sets the tiers allowed for the main loop and for subagents, a status fragment the router must show, and text the answer must include or exclude. Reports go to `lab/reports/`.

Every `--plugin-dir` copy of the mod shares one stats store, so lab runs show up in `/route` stats for those copies.

## Limits

- Savings are **estimates** at API list prices. The baseline assumes the home model's cache would have been warm. On a subscription, read them as relative usage, not dollars.
- Subagent savings are counted only for agent types that would otherwise inherit your model. `Explore` may already default to a small model.
- This Claude Code build does not know Haiku 5.5 yet. Its own `/cost` prices those turns as an unknown model and overstates them; use `/route` for the router's figures. The build also assumes a 200K window for Haiku 5.5, so the main loop is never sent to Haiku above 120K context.
- Pins and held escalations live in the session process; `claude --resume` starts without them.
- Effort is changed only on Haiku detours (`haikuEffort`), always to the same value, so Haiku's cache stays valid and the home model's is never touched. Pick the session's effort once (`high` for everyday coding); changing it mid-session invalidates the prompt cache.
- Going to a cheaper model drops the stronger model's earlier reasoning blocks for that turn only. They come back when the conversation returns to that model.
