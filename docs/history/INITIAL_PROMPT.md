# topic2md — Kickoff Prompt (v0)

> 把这份文件作为新 repo 的启动说明。第一次进新 repo 时可以整段喂给 Claude Code / Cursor / Windsurf，让它据此搭骨架并跑通 MVP。

---

## 1. 项目定位

**自然语言话题 → 高质量中文 markdown 文章** 的开源 Web 工具。

- 输入：一句话话题或方向（例：「DeepSeek V3.2 发布，有什么技术亮点」「2026 北航软件学院保研经验」）。
- 输出：结构化 markdown 文档（frontmatter + 正文 + 真实配图 URL + 引用列表）。
- 定位：作为 **md2wechat**（github.com/LLM-X-Factorer/md2wechat）的上游生成器，但**完全独立开源**，不绑定任何下游。

## 2. 产品价值

- **完全自动化**：一次输入 → 直接产出成品 md，workflow 中间**不做 HITL**。
- **插件化一切外部耦合**：研究源、图片源、主题适配、发布目的地都是可插拔 plugin。
- **真实图片而非 AI 生成**：通过搜索结果定位权威页面，Playwright 截图 / 抓取 `og:image` 与正文图，保留来源链接。
- **模型可选**：OpenRouter 作为默认 LLM gateway，UI 下拉菜单切换 Claude / GPT / Gemini / DeepSeek 等。

## 3. 硬性技术决策（不要自作主张改）

| 维度 | 选型 | 原因 |
|---|---|---|
| 语言 | TypeScript 5.6+，Node 22 LTS | 单栈，便于与 md2wechat 共享类型 |
| 编排框架 | **Mastra** | TS 原生、Workflows + Agents 双模、Vercel AI SDK 内核 |
| 模型网关 | **OpenRouter** | Mastra 原生 gateway，字符串 `openrouter/<provider>/<model>` 即用 |
| Web 框架 | **Next.js 15 App Router** | 前后端一体，服务端跑长任务 |
| 截图 | **Playwright**（headless Chromium） | 比 Puppeteer 现代、社区活跃 |
| 研究 API | **Tavily**（默认）+ **Perplexity**（可选插件） | 走 HTTP API，**不走 MCP**（MCP 是给 agent 用的，Web 后端直接调 HTTP） |
| 存储 | SQLite（better-sqlite3） | 与 md2wechat 一致 |
| 观测 | Langfuse | Mastra 一键接入 |
| 包管理 | pnpm + turbo（monorepo） | 插件各自成包 |
| 部署 | Docker + 腾讯 Lighthouse | 与 md2wechat 同一台，运维心智统一 |

**不要选 LangGraph.js**：TS 是 Python 的二等 port；API 冗长；无 OpenRouter 一等公民支持。

## 4. Monorepo 结构

```
topic2md/
├── package.json            # pnpm workspaces root
├── pnpm-workspace.yaml
├── turbo.json
├── plugins.config.ts       # 用户在此声明启用哪些插件（core 不 import plugin）
├── apps/
│   └── web/                # Next.js 15 App Router：任务触发 + 进度流式 + markdown 预览
├── packages/
│   ├── core/               # Pipeline 编排：workflow 定义、plugin registry、types
│   ├── shared/             # 通用 types（Article、Section、ImageRef、Source…）
│   ├── source-tavily/      # 【MVP】研究源插件
│   ├── source-perplexity/  # 研究源插件（可选）
│   ├── image-screenshot/   # 【MVP】Playwright 截图插件
│   ├── image-library/      # Unsplash/Pexels 图库插件（可选）
│   ├── theme-md2wechat/    # md2wechat 主题感知插件（读 /api/themes → frontmatter）
│   ├── publish-md2wechat/  # md2wechat 发布插件（调 /api/publish）
│   └── publish-file/       # 【MVP】md 文件落盘
└── cli/                    # 纯命令行入口，不依赖 web（复用 core）
```

**核心原则**：`packages/core` 不得 `import` 任何 plugin。所有 plugin 通过根目录 `plugins.config.ts` 显式注册后注入。

## 5. plugins.config.ts 形态样板

```ts
import type { PluginConfig } from '@topic2md/core';
import { tavilySource } from '@topic2md/source-tavily';
import { screenshotImage } from '@topic2md/image-screenshot';
import { filePublish } from '@topic2md/publish-file';

export default {
  sources: [tavilySource({ apiKey: process.env.TAVILY_API_KEY! })],
  images:  [screenshotImage({ concurrency: 3 })],
  themes:  [],                        // MVP 阶段空，后续 themeMd2wechat() 即可接入
  publish: [filePublish({ outDir: './out' })],
} satisfies PluginConfig;
```

## 6. MVP 范围（v0.1）

- **只**实现：单话题输入 → 一条线性 workflow → 产出 .md 文件。
- Workflow 节点（Mastra workflow）：
  1. `research`：调用启用的第一个 source plugin，拿到 N 条权威结果。
  2. `outline`：LLM 基于 research 产出文章大纲（section 标题 + 要点 + 每节需要的图片类型）。
  3. `sections`：每个 section 一个 Mastra agent 并行执行，**必要时**可二次查证（tool call 回 research plugin），输出 markdown 段落 + 配图需求。
  4. `images`：根据 section 产出的图片需求，调 image plugin 并行抓图。
  5. `assemble`：组装 frontmatter（title / digest / author / date）+ 正文 + 配图 + 引用列表。
  6. `publish`：落到 file plugin。
- Web UI：一个输入框、模型下拉、"开始"按钮、SSE 进度日志、最终 markdown 预览（react-markdown）。

**不在 MVP 范围**（明确延后）：
- md2wechat 主题感知插件
- md2wechat 直连发布插件
- 多源研究聚合
- 文章局部重跑（regen section）
- 图片去重与质量打分

## 7. 最小可跑 workflow 示意（伪代码，给 vibe coding 参考）

```ts
// packages/core/src/workflow.ts
import { createWorkflow, createStep } from '@mastra/core';
import { z } from 'zod';

const researchStep = createStep({
  id: 'research',
  inputSchema: z.object({ topic: z.string() }),
  outputSchema: z.object({ sources: z.array(SourceSchema) }),
  execute: async ({ inputData, plugins }) => {
    const src = plugins.sources[0];
    return { sources: await src.research(inputData.topic) };
  },
});

// outline / sections / images / assemble 同理……

export const topic2mdWorkflow = createWorkflow({
  id: 'topic2md',
  inputSchema: z.object({ topic: z.string(), model: z.string().default('openrouter/anthropic/claude-sonnet-4-6') }),
  outputSchema: z.object({ markdownPath: z.string() }),
})
  .then(researchStep)
  .then(outlineStep)
  .then(sectionsStep)     // 内部 parallel map
  .then(imagesStep)       // 内部 parallel map
  .then(assembleStep)
  .then(publishStep)
  .commit();
```

## 8. 环境变量清单

```
OPENROUTER_API_KEY=           # 必须
TAVILY_API_KEY=               # MVP 必须
PERPLEXITY_API_KEY=           # 可选
LANGFUSE_PUBLIC_KEY=          # 可选（观测）
LANGFUSE_SECRET_KEY=
DEFAULT_MODEL=openrouter/anthropic/claude-sonnet-4-6
DATABASE_URL=                 # 默认 sqlite:./data.db
```

## 9. 代码风格

- 不写无谓注释 / docstring；命名清晰即可。
- 不做"impossible scenario"的防御性编程；插件边界做 zod 校验。
- 长任务一律走 Mastra workflow，**禁止**在 Next.js route handler 里裸跑多步 LLM 调用。
- 每个 plugin 独立 package，对外暴露工厂函数 `createXxx(config)`。
- commit message 英文，1-2 句，祈使句。

## 10. 初始迭代顺序（建议 vibe coding 分步走）

1. 脚手架：pnpm workspace + turbo + tsconfig + eslint + prettier + Docker + GitHub Actions（lint + build）。
2. `packages/shared`：核心 types（Article / Section / Source / ImageRef / PluginConfig / Workflow context）。
3. `packages/core`：plugin registry、Mastra workflow 六节点（research / outline / sections / images / assemble / publish），先用 mock plugin 跑通。
4. `packages/source-tavily`：替换 mock，真实调 Tavily。
5. `packages/image-screenshot`：Playwright headless 截图。
6. `packages/publish-file`：写 .md。
7. `cli/`：`topic2md "话题"` 命令行端到端跑通。
8. `apps/web`：Next.js UI + SSE 进度流。
9. Langfuse 接入 + README。
10. Docker image + deploy workflow。

## 11. README 应当包含

- 一图架构图（话题 → 6 节点 pipeline → md + 下游 publish plugin）。
- 插件开发指南（对 PluginConfig 接口说明 + 示例）。
- 环境变量表。
- docker-compose 最小启动示例。
- 与 md2wechat 集成的 optional 章节（通过 `publish-md2wechat` 插件）。

---

## 给 vibe coding 工具的启动指令建议

> 你是这个 repo 的主要贡献者。请按上述文档构建 topic2md。从第 10 节的"初始迭代顺序"第 1 步开始，每完成一步提交一个独立 commit。遇到决策分歧时优先遵守第 3 节"硬性技术决策"，不要自作主张替换 Mastra / OpenRouter / Playwright。插件系统的隔离性（core 不 import plugin）是架构红线，违反即返工。
