# claude-mods

Claude Code mods by [schwepps](https://github.com/schwepps).

| Mod | What it does |
| --- | --- |
| [model-router](model-picker-mod) | Routes each turn and subagent to the cheapest Claude model that keeps quality, gated by a prompt-cache cost model. `/route` shows status and savings. |
| [agent-ops](agent-ops-mod/agent-ops) | Live agents dashboard: status, activity, progress, tokens, model and effort, plus day/week/month usage by model. Open it with `/agent-ops`. |
| [vtsls-lean](vtsls-lean) | The vtsls TypeScript LSP with one tsserver per session and no automatic type acquisition, about 160 MB less per session. Replaces `vtsls@claude-code-lsps`. |

## Install

At the prompt of a terminal session:

```
/plugin install model-router --marketplace schwepps/claude-mods
/plugin install agent-ops --marketplace schwepps/claude-mods
```

From a shell:

```bash
claude plugin install model-router --marketplace schwepps/claude-mods
```

```bash
claude plugin install agent-ops --marketplace schwepps/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads the mod in every session).

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `schwepps/claude-mods`, then Add plugin.

These mods are hooks modules and need a recent Claude Code build.

## Develop

```bash
claude plugin validate model-picker-mod && claude plugin test model-picker-mod
```

```bash
claude plugin validate agent-ops-mod/agent-ops && claude plugin test agent-ops-mod/agent-ops
```
