# Contributing to topic2md

Thanks for considering a contribution. This doc covers the mechanics; for the
why/how of the architecture itself, read [`CLAUDE.md`](./CLAUDE.md) (the
AI-collaboration handbook — it's the most up-to-date description of invariants
and gotchas).

## Prerequisites

- Node.js **22+**
- pnpm **9.15+** (`corepack enable && corepack prepare pnpm@9.15.9 --activate`)
- macOS / Linux (Windows via WSL). Author is on macOS Apple Silicon.

## Getting started

```bash
git clone https://github.com/LLM-X-Factorer/topic2md.git
cd topic2md
pnpm install                                                            # or --registry=https://registry.npmmirror.com in China
pnpm --filter @topic2md/image-screenshot exec playwright install chromium   # first time only
cp .env.example .env && $EDITOR .env                                    # OPENROUTER_API_KEY + TAVILY_API_KEY minimum
pnpm build
pnpm topic2md "DeepSeek V3.2 tech highlights"                           # smoke test CLI
pnpm --filter @topic2md/web dev                                         # or the web UI at http://localhost:3000
```

## The three checks

CI runs these three — please run them locally before pushing:

```bash
pnpm lint          # eslint across all packages
pnpm typecheck     # tsc --noEmit across all packages
pnpm format:check  # prettier --check
```

Format drift is a frequent cause of red CI; run `pnpm format` to autofix.

## Architecture red lines

Violations of these block merge:

1. **`packages/core` must not import any plugin package** (`@topic2md/source-*`,
   `image-*`, `theme-*`, `publish-*`). Plugins are injected via the root
   `plugins.config.ts`; core only consumes interfaces from `@topic2md/shared`.
2. Don't swap Mastra / OpenRouter / Playwright for alternatives — they're
   intentional selections. Alternatives can live as plugins alongside.
3. Any new external dependency that isn't a plugin needs discussion in an issue
   first.

See `CLAUDE.md` § "架构红线" for the rationale.

## Adding a new plugin

Each plugin is its own workspace package under `packages/<kind>-<name>/`:

```
packages/source-weixin/
├── package.json         # only workspace dep allowed: @topic2md/shared
├── tsconfig.json        # extends ../../tsconfig.base.json
└── src/index.ts         # exports a factory: export function weixinSource(config): SourcePlugin
```

Interfaces live in `@topic2md/shared`. The factory validates its config and
throws a plain `Error` on bad input. Implement `dispose?()` if the plugin owns
long-lived resources (browsers, DB handles, etc.) — the runner calls it in
`finally`.

Then wire it up in the root `plugins.config.ts`. Core never learns the plugin's
name.

## Commit messages

- English, imperative mood, subject omitted ("add X" not "added X" or "I add X").
- Body explains _why_, not _what_ (the diff is the what).
- Close issues with `Closes #N` per issue — **multi-close needs its own
  keyword each**: `Closes #1, closes #2` works; `Closes #1 #2` only closes #1.
- When Claude Code co-authored, keep the sign-off the tool adds.

Pattern the project has landed on:

```
feat(images): warm CLIP + persist embeddings + alt-quality penalty

<2-4 sentences: why this change, what changed, any gotchas>

Closes #26, closes #27, closes #28

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Branching and PRs

- `main` is protected; feature branches in the form `<kind>/<slug>` —
  `feat/add-weixin-source`, `fix/regen-runid-parsing`, `docs/readme-en`, etc.
- One logical change per PR. Refactors stay separate from behavior changes.
- Keep the PR description focused on _why_; the diff already shows _what_.
- Link related issues; use `Closes #N` to auto-close.
- CI must be green before request-review. If format:check is red, run
  `pnpm format` — don't hand-edit around it.

## Where to find bugs and feature ideas

GitHub Issues is the source of truth. Labels:

- Priority: `p0-blocker`, `p1-important`, `p2-later`
- Area: `area/core`, `area/web`, `area/plugin`, `area/cli`, `area/infra`
- Type: `bug`, `enhancement`, `help wanted`, `good first issue`

Good first issues are tagged as such — look for `help wanted` + `p2-later` +
`good first issue` for entry-level contributions.

## Security issues

Do **not** open public issues for security problems. See
[`SECURITY.md`](./SECURITY.md).

## Questions

Open a GitHub Discussion or a `question`-labeled issue. We don't have a chat
channel yet.
