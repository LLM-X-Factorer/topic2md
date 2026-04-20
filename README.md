# topic2md

> 自然语言话题 → 高质量中文 markdown 文章的开源 Web 工具。

`topic2md` 把一句话话题（例：「DeepSeek V3.2 发布，有什么技术亮点」）端到端编译成带 frontmatter、配图与引用的 markdown 文档。它定位为 [md2wechat](https://github.com/LLM-X-Factorer/md2wechat) 的上游生成器，但完全独立开源，不绑定任何下游。

## 架构

```
┌──────────┐
│  topic   │ 自然语言一句话
└────┬─────┘
     ▼
┌──────────┐   ┌───────────┐   ┌────────────┐   ┌────────┐   ┌──────────┐   ┌───────────┐
│ research │ → │  outline  │ → │  sections  │ → │ images │ → │ assemble │ → │  publish  │
└────┬─────┘   └────┬──────┘   └────┬───────┘   └───┬────┘   └────┬─────┘   └─────┬─────┘
     │              │                │               │              │                │
 SourcePlugin   LLM (OpenRouter)  LLM × N parallel  ImagePlugin    ThemePlugin   PublishPlugin
```

- **核心编排**：Mastra workflow，TS 原生。
- **模型网关**：OpenRouter，Web UI 下拉切换 Claude / GPT / Gemini / DeepSeek。
- **外部耦合一律插件化**：研究源、图片源、主题、发布目的地都通过根目录 `plugins.config.ts` 注入。
- **真实配图**：走 og:image / 正文截图（Playwright），保留来源链接。
- **观测**：Langfuse，可选。

## 快速开始

```bash
pnpm install                                  # Node 22+, pnpm 9+
pnpm --filter @topic2md/image-screenshot exec playwright install chromium  # 截图插件首次使用前

cp .env.example .env
# 填入 OPENROUTER_API_KEY + TAVILY_API_KEY + DEFAULT_MODEL

pnpm build
pnpm topic2md "DeepSeek V3.2 发布的技术亮点"  # CLI 端到端
pnpm topic2md "DeepSeek V3.2 发布的技术亮点" \
  --background "我是算法工程师，想弄清楚架构改动细节，用于内部技术分享"
# 或
pnpm topic2md "话题" --background-file ./brief.md

pnpm topic2md list                             # 看历史 run
pnpm topic2md show <run-id> --markdown         # 看某次 run 的完整正文
pnpm topic2md regen <run-id> --section 2       # 只重跑第 3 节（0-based）
pnpm topic2md regen <run-id> --section 2 \
  --background "…覆盖原 run 的背景"             # 默认复用 source run 的 background
# 或
pnpm --filter @topic2md/web dev               # 起 Web UI (http://localhost:3000)
```

产物统一写到仓库根目录 `out/`（`plugins.config.ts` 用 `import.meta.url` 锚定），CLI 和 Web 入口产出同一处。

### 调研背景（`--background`）

`topic` 只告诉流水线"要写什么"，`--background` 告诉流水线"给谁看、为什么写、从哪个角度切"——自由文本，贯穿 research → outline → sections 三步：

- SourcePlugin 收到 `ResearchOptions.background`，自行决定是否使用（Perplexity 会折进 user message；Tavily 只吃检索 query，忽略）。
- outline / sections 的 user prompt 条件拼接"调研背景：…"段落，约束选题、语气、受众。
- 持久化在 `runs.background` 列；`regen` 默认复用 source run 的背景，可选 `--background` 覆盖。
- Web UI 用折叠 textarea 暴露，可选填。

同一话题换 background 会产出明显不同的切分和语气——避开通稿感。

### 已验证的模型（2026-04）

| 模型                              | 状态      | 备注                                       |
| --------------------------------- | --------- | ------------------------------------------ |
| `openrouter/minimax/minimax-m2.7` | ✅ 默认   | 一次端到端 ~15s 跑完                       |
| `openrouter/z-ai/glm-5.1`         | ⚠️ 不稳定 | structured output 偶发 Invalid JSON / 早停 |
| `openrouter/qwen/qwen3.6-plus`    | ❌ 不兼容 | OpenRouter 不提供 `tool_choice` 支持       |

换模型用 `pnpm topic2md "..." --model <id>` 或改 `DEFAULT_MODEL`。

## Monorepo 结构

```
topic2md/
├── plugins.config.ts            # 用户在此声明启用哪些插件（core 不 import plugin）
├── apps/
│   └── web/                     # Next.js 15 App Router：触发 + 流式进度 + markdown 预览
├── packages/
│   ├── core/                    # Mastra workflow、plugin registry、LLM 抽象、SQLite 持久化、regen
│   ├── shared/                  # 公共 types + zod schemas + 事件类型
│   ├── source-tavily/           # Tavily 研究源
│   ├── source-perplexity/       # Perplexity 研究源（多源聚合时的第二输入）
│   ├── image-screenshot/        # Playwright og:image + 截图
│   ├── image-library/           # Unsplash 图库
│   ├── theme-md2wechat/         # 按 md2wechat 主题丰富 frontmatter
│   ├── publish-md2wechat/       # 直接发布到 md2wechat → 公众号草稿
│   └── publish-file/            # md 文件落盘
└── cli/                         # topic2md CLI：run / list / show / regen
```

**研究源多选** / **图片多源** / **主题 + 发布** 都通过在 `plugins.config.ts` 里堆叠插件启用，`packages/core` 对任何具体源/目的地都无感知。

**架构红线**：`packages/core` 不得 `import` 任何 plugin 包。所有 plugin 通过根目录 `plugins.config.ts` 显式注册后注入。

## 插件开发

所有插件实现来自 `@topic2md/shared` 的接口：

```ts
interface SourcePlugin {
  name: string;
  research(topic: string, opts?: ResearchOptions): Promise<Source[]>;
}

interface ImagePlugin {
  name: string;
  capture(req: ImageRequest, opts?: ImageOptions): Promise<ImageRef | null>;
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

新建一个 workspace 包 `@topic2md/your-plugin`，导出一个工厂函数：

```ts
// packages/your-plugin/src/index.ts
import type { SourcePlugin } from '@topic2md/shared';

export function yourSource(config: { apiKey: string }): SourcePlugin {
  return {
    name: 'your-source',
    async research(topic, opts) {
      /* 调 API、返回 Source[] */
    },
  };
}
```

然后在根目录 `plugins.config.ts` 里启用它：

```ts
import { yourSource } from '@topic2md/your-plugin';

export default {
  sources: [yourSource({ apiKey: process.env.YOUR_API_KEY! })],
  images: [],
  themes: [],
  publish: [],
} satisfies PluginConfig;
```

> 参考实现：`packages/source-tavily`、`packages/image-screenshot`、`packages/publish-file`。

## 环境变量

| 变量                  | 必需 | 说明                                           |
| --------------------- | ---- | ---------------------------------------------- |
| `OPENROUTER_API_KEY`  | ✅   | 模型网关；也可以注入自定义 LLM 绕过            |
| `TAVILY_API_KEY`      | ✅   | 启用 `@topic2md/source-tavily` 时必需          |
| `DEFAULT_MODEL`       | ⛔   | 默认 `openrouter/anthropic/claude-sonnet-4-6`  |
| `PERPLEXITY_API_KEY`  | ⛔   | 启用 Perplexity 插件时需要                     |
| `LANGFUSE_PUBLIC_KEY` | ⛔   | 启用 Langfuse 观测时需要（与 SECRET 一并设置） |
| `LANGFUSE_SECRET_KEY` | ⛔   | 同上                                           |
| `LANGFUSE_HOST`       | ⛔   | 自托管 Langfuse 时指定                         |
| `DATABASE_URL`        | ⛔   | 默认 `sqlite:./data.db`                        |

## Langfuse 观测

设置 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` 后，每次运行会在 Langfuse 中创建一条 trace，workflow 的 6 个节点作为 span 上报。未设置环境变量时完全无感。

```bash
pnpm add -w langfuse    # 按需在 workspace 顶层安装
LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... pnpm topic2md "话题"
```

## Docker

```bash
docker build -t topic2md .
docker run --rm -p 3000:3000 \
  -e OPENROUTER_API_KEY=... -e TAVILY_API_KEY=... \
  topic2md
```

最小 docker-compose 参考：

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

## 与 md2wechat 集成（可选）

`topic2md` 产出标准 markdown，可以直接喂给 [md2wechat](https://github.com/LLM-X-Factorer/md2wechat) 得到微信公众号排版。未来会提供两个可选插件：

- `@topic2md/theme-md2wechat`：读取 md2wechat 的 `/api/themes`，把目标主题信息写进 frontmatter，让文章结构对齐主题要求。
- `@topic2md/publish-md2wechat`：直接 POST 给 md2wechat 的 `/api/publish`，一条龙到公众号草稿箱。

两者都走插件通道，`core` 不感知下游存在。

## 路线图 / bug 追踪

在 [GitHub Issues](https://github.com/LLM-X-Factorer/topic2md/issues) 维护：

- `p0-blocker` / `p1-important` / `p2-later` 标优先级
- `area/web` / `area/core` / `area/plugin` / `area/cli` / `area/infra` 标区域
- 提新需求或 bug 请直接开 issue，PR 里用 `Closes #N` 关联

## 许可证

MIT — 见 [LICENSE](./LICENSE)。
