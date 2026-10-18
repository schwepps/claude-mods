# vtsls-lean

The [vtsls](https://github.com/yioneko/vtsls) TypeScript/JavaScript language server, tuned to use less memory. It replaces `vtsls@claude-code-lsps`, with the same command and file extensions.

Every Claude Code session starts its own language server. With default settings, one session measured about 1.4 GB in total:

| Process | RSS |
| --- | --- |
| vtsls | 52 MB |
| tsserver, `partialSemantic` (syntax server) | 111 MB |
| tsserver, semantic | 1183 MB |
| typingsInstaller | 51 MB |

The settings below drop the syntax server and `typingsInstaller`, about 160 MB per session:

| Setting | Effect |
| --- | --- |
| `typescript.tsserver.useSyntaxServer: "never"` | One tsserver instead of two. The syntax server only answers quick requests while an editor waits on the semantic server, and an agent can wait. |
| `typescript.disableAutomaticTypeAcquisition: true` | No `typingsInstaller` process and no `@types` downloads for JavaScript projects. Projects that declare their own `@types` packages are unaffected. |

`typescript.tsserver.maxTsServerMemory` keeps its default (3072 MB). A lower cap makes tsserver run out of memory on large projects and restart in a loop.

vtsls reads these keys with dotted lookups (`typescript.tsserver.useSyntaxServer`) over a nested object, so `settings` in `.lsp.json` must be nested, not flat dotted keys.

## Install

vtsls must be on your `PATH`. Unlike the original plugin, this one does not install it for you:

```bash
npm install -g @vtsls/language-server typescript
```

Then disable the original plugin and install this one:

```bash
claude plugin disable vtsls@claude-code-lsps
```

```bash
claude plugin install vtsls-lean@claude-mods
```

Restart your sessions to pick up the change.
