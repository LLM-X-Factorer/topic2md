# topic2md — Claude 协作说明

> 给未来进入这个 repo 的 Claude / 其他 AI 代理看的操作手册。人类开发者请读 [README.md](./README.md)。

## 架构红线（违反即返工）

- **`packages/core` 不得 `import` 任何 plugin 包**（`@topic2md/source-*` / `image-*` / `theme-*` / `publish-*`）。Plugin 通过根目录 `plugins.config.ts` 显式注入，经由 `runTopic2md({ plugins })` 传入 `RuntimeContext`，core 只消费 `@topic2md/shared` 暴露的接口。
- **不要替换以下硬性选型**：Mastra workflow（`@mastra/core`）、OpenRouter 作为 LLM 网关、Playwright 做截图。备选只能作为 plugin 并存。
- **Mock plugins 的位置**是 `packages/core/src/testing/`，通过子路径 `@topic2md/core/testing` 暴露。它们是本包内的测试替身，不算违反红线。

## 工作流

6 步，Mastra workflow（`packages/core/src/workflow.ts`），顺序不可乱：

1. `research` — **所有** SourcePlugin 并行跑（Promise.allSettled），merge + URL dedupe + cross-source score boost
2. `outline` — LLM 产出 title/digest/sections[]（`generateObject` + `OutlineSchema`）。**首次失败会重试 1 次**；sections 都会 backfill imageHint（LLM 省略就用 title/points 兜底）
3. `sections` — 每段并行生成；**每段 attempt + retry**，两次都失败用 outline.points 渲染成 bullet list 兜底（不留空白）
4. `images` — core 按 section 关键词亲和度 + 去重分配 source，交给 ImagePlugin 抓图；后处理做 URL dedupe + shareicon 黑名单
5. `assemble` — 组装 frontmatter + 正文 + 引用列表（纯函数，`markdown.ts`）。ThemePlugin 在这一步装饰 frontmatter
6. `publish` — PublishPlugin 落盘 / 发布

每步 `try/catch` 后 emit `step.error` 再 `throw`。运行结束 finally 遍历所有 plugin 调 `dispose?()`（best-effort）释放资源，否则 Playwright 浏览器会让 Node 不退出。

## 持久化

每次 `runTopic2md` 默认写 SQLite（`DATABASE_URL=sqlite:<repo>/data.db`，anchored in `plugins.config.ts`）：`runs` 表存一条元数据，`run_stages` 存每步 Mastra output。CLI 读这个库提供 `list` / `show` / `regen` 子命令。`regenSection` 基于存的 research+outline+sections 只重跑一节 + 重 assemble + 重 publish，新 run 带 `source_run_id` 指回原始。

## 模型现状（2026-04，已切 `mode: 'json'`）

| 模型                              | 状态              | 说明                                                                                   |
| --------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| `openrouter/minimax/minimax-m2.7` | ✅ **默认**，稳定 | 真实跑过 3 次话题：DeepSeek V3.2 / 北航保研 / AI 医学影像 5 大核心能力。60~200s 端到端 |
| `openrouter/z-ai/glm-5.1`         | ⚠️ 偶发           | JSON mode 下比 tool-call 稳很多但仍可能 "No object generated"；retry 救回多数          |
| `openrouter/qwen/qwen3.6-plus`    | ❔ 重估           | 旧结论说不支持 `tool_choice`，切 json mode 后有可能通——真要用再验证                    |
| Claude / GPT / Gemini 系          | 未测              | 预计稳定，但没 credits 验过                                                            |

换模型时先 `curl https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY"` 确认 id 可用。`fallbackModels: [...]` 里可以挂一串兜底。

## 常用命令

```bash
pnpm install --registry=https://registry.npmmirror.com   # 作者在中国，主 npm 偶发 ECONNRESET
pnpm --filter @topic2md/image-screenshot exec playwright install chromium  # 首次截图插件用
pnpm build                           # turbo run build across all packages
pnpm lint / typecheck / format:check # 三把尺子
pnpm topic2md "话题" [--model <id>]   # CLI 端到端
pnpm --filter @topic2md/web dev      # 起 http://localhost:3000
```

环境变量在 `.env`（gitignored）。必填 `OPENROUTER_API_KEY` + `TAVILY_API_KEY` + `DEFAULT_MODEL`。

## 输出路径

`plugins.config.ts` 用 `import.meta.url` 锚定 repo 根，所以无论 CLI 从哪里调用、`next dev` cwd 是 `apps/web`，产物都写到根目录 `out/`。Don't break this — 用户依赖这个行为。

## 编辑这个项目时的注意

- Zod schemas 在 `@topic2md/shared` 里定义，`noUncheckedIndexedAccess: true` 打开了，所有数组访问都要 `??` 或断言。
- **`generateObject` 强制用 `mode: 'json'`**（`packages/core/src/llm.ts`），绕开 OpenRouter-routed providers (MiniMax/GLM) 的 tool-call 畸形 JSON 路径，把 sections 步耗时从 ~500s 降到 ~60s。正常完成 finishReason 是 `'stop'`（不再是 `'tool-calls'`）。只把 `length` 当截断信号；不要把其他 reason 误判为失败，上次那次误判触发全量重试把限流撞穿。
- LLM.generate 对 `fallbackModels` 支持 — 传数组自动在首选失败时切下一个，发 `generation.fallback` 事件；Langfuse observer 会把 `generation.*` 事件映射成 trace.generation 节点。
- Plugin 工厂函数规范：`createXxx(config): XxxPlugin`，工厂内做参数校验并抛 `Error`。`name` 字段是 plugin 的身份，出 warn/error 时会带上。**有长期资源（browser / db handle）** 实现 `dispose?()`，runner 结束时会调用。
- 每个 plugin 独立 package，`package.json` 里 workspace 依赖只写 `@topic2md/shared: workspace:*`，不要 cross-plugin。
- commit message 英文祈使句，主语省略；description 写 "why" 不写 "what"。签名：
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## 已知待办 / bug 追踪

一律走 GitHub Issues（repo `LLM-X-Factorer/topic2md`）：

```bash
gh issue list --repo LLM-X-Factorer/topic2md --state open
gh issue list --label p1-important
gh issue view <n>
```

标签体系：

- 优先级：`p0-blocker` / `p1-important` / `p2-later`
- 区域：`area/web` / `area/core` / `area/plugin` / `area/cli` / `area/infra`
- 类型：默认 `bug` / `enhancement`

在 commit message 结尾写 `Closes #N`（或多条 `Closes #1 #2 #20`）即可自动关单。红线是：任何新的外部耦合一律走 plugin 通道，不往 `packages/core` 里加 `import`，想加新源 / 发布目的地就开新 `packages/<source|image|theme|publish>-<name>` 包。
