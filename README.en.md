# topic2md

> Natural-language topic → high-quality markdown article. Open-source web tool.

`topic2md` compiles a one-sentence topic (e.g. "What are the technical
highlights of the DeepSeek V3.2 release?") end-to-end into a markdown document
with frontmatter, real images, and citations. It's positioned as an upstream
generator for [md2wechat](https://github.com/LLM-X-Factorer/md2wechat) but is
fully standalone — no coupling to any downstream.

> 中文 README: [`README.md`](./README.md)

## Architecture

```
┌──────────┐
│  topic   │ natural-language sentence
└────┬─────┘
     ▼
┌──────────┐   ┌───────────┐   ┌────────────┐   ┌────────┐   ┌──────────┐   ┌───────────┐
│ research │ → │  outline  │ → │  sections  │ → │ images │ → │ assemble │ → │  publish  │
└────┬─────┘   └────┬──────┘   └────┬───────┘   └───┬────┘   └────┬─────┘   └─────┬─────┘
     │              │                │               │              │                │
 SourcePlugin   LLM (OpenRouter)  LLM × N parallel  ImagePlugin    ThemePlugin   PublishPlugin
```

- **Orchestration**: Mastra workflow, TS-native.
- **Model gateway**: OpenRouter — pick Claude / GPT / Gemini / DeepSeek / MiniMax / GLM from the Web UI.
- **All external coupling is plugin-based**: research sources, image providers, themes, publish destinations are injected via the root `plugins.config.ts`.
- **Real images + relevance gates**: candidate pool from og:image / page screenshots (Playwright), filtered by CLIP cosine similarity (jina-clip-v2 on Replicate, optional, with SQLite-backed embedding cache across runs) + alt-quality penalty + vision-LLM rerank. If nothing qualifies, the section stays image-free.
- **Observability**: Langfuse, optional.

## Quick start

```bash
pnpm install                                   # Node 22+, pnpm 9+
pnpm --filter @topic2md/image-screenshot exec playwright install chromium  # first time only

cp .env.example .env
# Fill in OPENROUTER_API_KEY + TAVILY_API_KEY + DEFAULT_MODEL

pnpm build
pnpm topic2md "DeepSeek V3.2 tech highlights"   # CLI end-to-end
pnpm topic2md "DeepSeek V3.2 tech highlights" \
  --background "I'm an ML engineer studying the architecture changes for an internal talk"
# or
pnpm topic2md "<topic>" --background-file ./brief.md

pnpm topic2md list                              # list past runs
pnpm topic2md show <run-id> --markdown          # view a past run's full body
pnpm topic2md regen <run-id> --section 2        # regenerate one section (0-based)
pnpm topic2md regen <run-id> --section 2 \
  --background "...override original background"  # defaults to the source run's background
# or
pnpm --filter @topic2md/web dev                 # boot Web UI at http://localhost:3000
```

Artifacts land in `out/` at the repo root (anchored via `import.meta.url` in
`plugins.config.ts`), regardless of CLI cwd or `next dev`.

Need a shareable PDF for non-technical reviewers:

```bash
node scripts/mkpdf.mjs out/2026-04-21-xxx.md     # produces sibling .pdf
```

Chromium-headless print-to-PDF. CJK text rendered via macOS system PingFang SC.
Remote images are cached to `out/_pdf_assets/` first so the PDF is
offline-reproducible.

### Background context (`--background`)

`topic` tells the pipeline _what_ to write. `--background` tells it _who for,
why, from what angle_ — freeform text threaded through research → outline →
sections:

- `SourcePlugin` receives `ResearchOptions.background` and decides how to use
  it (Perplexity folds it into the user message; Tavily ignores it because
  stuffing freeform text into a retrieval query hurts recall).
- Outline / sections prompts conditionally inject a "research background:..."
  block that shapes topic selection, tone, and audience.
- Persisted in the `runs.background` column. `regen` reuses the source run's
  background by default, overridable via `--background`.
- Web UI exposes it as a collapsible textarea.

Same topic with different backgrounds produces visibly different section
breakdowns and tone — the point is to avoid stock-report flavor.

### Tested models (2026-04)

| Model                             | Status     | Notes                                                                 |
| --------------------------------- | ---------- | --------------------------------------------------------------------- |
| `openrouter/minimax/minimax-m2.7` | ✅ default | End-to-end ~60-200s, stable                                           |
| `openrouter/z-ai/glm-5.1`         | ⚠️ flaky   | Occasional "No object generated" in JSON mode; retry usually recovers |
| `openrouter/qwen/qwen3.6-plus`    | ❔ retest  | Needs revalidation under JSON mode                                    |
| Claude / GPT / Gemini families    | untested   | Expected to work, not verified on this account                        |

Swap via `pnpm topic2md "..." --model <id>` or change `DEFAULT_MODEL`.

## Monorepo layout

```
topic2md/
├── plugins.config.ts            # user declares enabled plugins here (core does not import plugins)
├── apps/
│   └── web/                     # Next.js 15 App Router: trigger + streaming progress + markdown preview
├── packages/
│   ├── core/                    # Mastra workflow, plugin registry, LLM abstraction, SQLite persistence, regen
│   ├── shared/                  # shared types + zod schemas + event types
│   ├── source-tavily/           # Tavily research source
│   ├── source-perplexity/       # Perplexity research source
│   ├── image-screenshot/        # Playwright og:image + screenshots
│   ├── image-library/           # Unsplash image provider
│   ├── theme-md2wechat/         # enriches frontmatter per md2wechat theme
│   ├── publish-md2wechat/       # pushes to md2wechat → WeChat draft
│   └── publish-file/            # writes markdown to disk
└── cli/                         # topic2md CLI: run / list / show / regen
```

**Multi-source research** / **multi-source images** / **theme + publish** are
enabled by stacking plugins in `plugins.config.ts`. `packages/core` has no
awareness of any specific source or destination.

**Architecture red line**: `packages/core` must not import any plugin package.
All plugins are explicitly registered in the root `plugins.config.ts` and
injected at runtime. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) before changing
this.

## Building a plugin

Plugins implement interfaces from `@topic2md/shared`:

```ts
interface SourcePlugin {
  name: string;
  research(topic: string, opts?: ResearchOptions): Promise<Source[]>;
}

interface ImagePlugin {
  name: string;
  discover(req: ImageRequest, opts?: ImageOptions): Promise<ImageCandidate[]>;
}

interface ThemePlugin {
  name: string;
  decorate(frontmatter: Frontmatter, ctx: ThemeContext): Promise<Frontmatter>;
}

interface PublishPlugin {
  name: string;
  publish(article: Article, opts?: PublishOptions): Promise<PublishResult>;
}
```

Create a workspace package `@topic2md/your-plugin` exporting a factory:

```ts
// packages/your-plugin/src/index.ts
import type { SourcePlugin } from '@topic2md/shared';

export function yourSource(config: { apiKey: string }): SourcePlugin {
  return {
    name: 'your-source',
    async research(topic, opts) {
      /* call your API, return Source[] */
    },
  };
}
```

Wire it up in `plugins.config.ts`:

```ts
import { yourSource } from '@topic2md/your-plugin';

export default {
  sources: [yourSource({ apiKey: process.env.YOUR_API_KEY! })],
  images: [],
  themes: [],
  publish: [],
} satisfies PluginConfig;
```

> Reference implementations: `packages/source-tavily`,
> `packages/image-screenshot`, `packages/publish-file`.

## Environment variables

| Variable              | Required | Notes                                                                     |
| --------------------- | -------- | ------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`  | ✅       | Model gateway. Can be bypassed by injecting a custom LLM.                 |
| `TAVILY_API_KEY`      | ✅       | Required when `@topic2md/source-tavily` is enabled.                       |
| `DEFAULT_MODEL`       | ⛔       | Defaults to `openrouter/anthropic/claude-sonnet-4-6`                      |
| `PERPLEXITY_API_KEY`  | ⛔       | Required when the Perplexity plugin is enabled.                           |
| `REPLICATE_API_TOKEN` | ⛔       | Enables CLIP relevance gate (strongly recommended). Absent ⇒ auto-bypass. |
| `LANGFUSE_PUBLIC_KEY` | ⛔       | For Langfuse observability (set both keys).                               |
| `LANGFUSE_SECRET_KEY` | ⛔       | Same.                                                                     |
| `LANGFUSE_HOST`       | ⛔       | Override for self-hosted Langfuse.                                        |
| `DATABASE_URL`        | ⛔       | Defaults to `sqlite:./data.db`                                            |

## Langfuse observability

Set `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` and each run creates a trace
in Langfuse with the 6 workflow steps as spans. No-op when the env vars are
absent.

```bash
LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... pnpm topic2md "<topic>"
```

## Docker

```bash
docker build -t topic2md .
docker run --rm -p 3000:3000 \
  -e OPENROUTER_API_KEY=... -e TAVILY_API_KEY=... \
  topic2md
```

Minimal docker-compose:

```yaml
services:
  topic2md:
    build: .
    ports: ['3000:3000']
    environment:
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      TAVILY_API_KEY: ${TAVILY_API_KEY}
      LANGFUSE_PUBLIC_KEY: ${LANGFUSE_PUBLIC_KEY:-}
      LANGFUSE_SECRET_KEY: ${LANGFUSE_SECRET_KEY:-}
    volumes:
      - ./out:/app/out
```

Images are also auto-published to GitHub Container Registry from `main` —
`ghcr.io/llm-x-factorer/topic2md:main`.

## Sizing a deployment

The workflow is a long synchronous request (60-200s per run) plus Chromium for
image screenshotting. **Serverless is not a fit** — Vercel / Cloudflare
Workers / Netlify all have function-timeout limits shorter than a single run.

| Use case                        | Shape                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Single-user self-host           | 1 vCPU / 2 GB RAM / 20 GB SSD                                                                                          |
| Small team, 2-5 concurrent runs | 2-4 vCPU / 4-8 GB RAM / 40 GB SSD                                                                                      |
| Public SaaS                     | Queue + worker pool. Add rate limits, per-user quotas, and a separate Redis. Don't expose `runTopic2md` synchronously. |

Monthly cost ballpark for the self-host shape: **$15-30** total (VPS + API
usage at one article/day).

## Integrating with md2wechat (optional)

`topic2md` emits standard markdown that
[md2wechat](https://github.com/LLM-X-Factorer/md2wechat) can turn into WeChat
Official Account formatting directly. Two optional plugins bridge the two:

- `@topic2md/theme-md2wechat` — reads md2wechat's `/api/themes` and writes
  theme-relevant frontmatter so the article's structure aligns with the target
  theme.
- `@topic2md/publish-md2wechat` — POSTs to md2wechat's `/api/publish` to land
  the article straight in the WeChat draft box.

Both go through the plugin channel; `core` never knows about the downstream.

## Roadmap / bug tracking

Everything lives in [GitHub Issues](https://github.com/LLM-X-Factorer/topic2md/issues):

- Priority: `p0-blocker` / `p1-important` / `p2-later`
- Area: `area/web` / `area/core` / `area/plugin` / `area/cli` / `area/infra`
- Type: `bug` / `enhancement` / `help wanted` / `good first issue`

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for dev setup, architecture rules,
and commit/PR conventions. For security issues, see
[`SECURITY.md`](./SECURITY.md).

## License

MIT — see [`LICENSE`](./LICENSE).
