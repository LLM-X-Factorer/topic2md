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
4. `images` — 每段走 4 级漏斗，每级都允许"不配图"（详见下面"图片流水线"）
5. `assemble` — 组装 frontmatter + 正文 + 引用列表（纯函数，`markdown.ts`）。ThemePlugin 在这一步装饰 frontmatter
6. `publish` — PublishPlugin 落盘 / 发布

每步 `try/catch` 后 emit `step.error` 再 `throw`。运行结束 finally 遍历所有 plugin 调 `dispose?()`（best-effort）释放资源，否则 Playwright 浏览器会让 Node 不退出。

## 持久化

每次 `runTopic2md` 默认写 SQLite（`DATABASE_URL=sqlite:<repo>/data.db`，anchored in `plugins.config.ts`）：`runs` 表存一条元数据，`run_stages` 存每步 Mastra output。CLI 读这个库提供 `list` / `show` / `regen` 子命令。`regenSection` 基于存的 research+outline+sections 只重跑一节 + 重 assemble + 重 publish，新 run 带 `source_run_id` 指回原始。

`runs` 表靠 `ensureRunsColumn` 做 idempotent 的 `ALTER TABLE ADD COLUMN` 迁移；要加新列就在 `openDatabase` 末尾补一行调用，别改已有 `CREATE TABLE` DDL（老库存在、会被跳过）。

## 图片流水线（step 4）

每段 4 级漏斗（`packages/core/src/steps/images.ts`），任一级返回空都接受，section 留空（"宁缺毋滥"是产品底线，别把它优化掉）：

1. **收集 + URL dedupe + 黑名单**（`collectCandidates` → `filterAndDedupe` + `PLACEHOLDER_PATTERNS`）。所有 ImagePlugin 并行抓候选，URL 去重 + 占位符正则踢掉（shareicon / og-default / footer 等）。
2. **CLIP gate**（可选，`clipGate`）— `zsxkib/jina-clip-v2` on Replicate，把 section title + imageHint + 前 4 个 point 拼成 query，跟每张图算 cos，< 阈值砍掉。阈值 0.30 是在 68 条人工标注上 ROC 出来的（AUC 0.85、recall 0.97、砍 60% irrelevant）。**需要 `REPLICATE_API_TOKEN`；无则自动 bypass**。开关：`CLIP_GATE=disabled` 关；`CLIP_GATE_THRESHOLD=<float>` 改阈值。cold-start 首次 +~80s，轮询最长等 4 分钟。
3. **Vision rerank**（`visionRerank`，qwen3-vl-32b）— 看图 + 文选一。LLM 返回 pickIndex=-1 明确拒绝时 **不走 keyword fallback**，section 留空（`visionRejected` 路径）。vision 调用**抛错**（403/超时）才降级到 keyword。
4. **keywordRerank** — 只在 vision 调用失败或 `IMAGE_RERANK_MODEL=disabled` 时兜底，要求至少 1 个关键词在 alt/caption/context 命中，否则返回 null。

**Retune CLIP 阈值**的流程（`scripts/` 下的三件套）：

```bash
# 1. dump 候选池（平常关，调研时开）
IMAGE_CANDIDATE_LOG=out/debug/candidates.jsonl pnpm topic2md "...话题 A..."
IMAGE_CANDIDATE_LOG=out/debug/candidates.jsonl pnpm topic2md "...话题 B..."
# 2. 标注（本地 HTTP 7070，Y/N/Skip 直至标完）
node scripts/label-candidates.mjs
# 3. Replicate 批量 embed（断点续跑）
REPLICATE_API_TOKEN=... node scripts/embed-candidates.mjs
# 4. ROC + 阈值建议
node scripts/analyze-roc.mjs
```

候选池**不**持久化到 SQLite，只在 `IMAGE_CANDIDATE_LOG` 被设置时 append JSONL；跟 run 没有 1:1 关系，纯离线调研用。

## 调研背景（background）

`WorkflowInput.background`（可选自由文本）贯穿 research → outline → sections 三步，约束"用户是谁 / 目的 / 切入角度"，防止内容跑偏：

- `SourcePlugin.research` 收到 `ResearchOptions.background`。Perplexity 把它拼进 user message；Tavily 故意忽略（`query` 是检索串，塞长文本伤召回）。新 source plugin 接入时自行决定用不用。
- outline / sections 的 user prompt 在有 background 时条件拼接一段"调研背景：..."；system prompt 不动。
- 持久化在 `runs.background`；`regen` 默认复用 source run 的 background，`options.background` 不 undefined 就覆盖（传空串能清空）。
- CLI：`--background <text>` 或 `--background-file <path>`（二选一），`run` 和 `regen` 都支持；Web UI 用 `<details>` 折叠的 textarea。

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

环境变量在 `.env`（gitignored）。必填 `OPENROUTER_API_KEY` + `TAVILY_API_KEY` + `DEFAULT_MODEL`；`REPLICATE_API_TOKEN` 启用 CLIP gate（可选但强烈推荐）；`CLIP_GATE` / `CLIP_GATE_THRESHOLD` / `IMAGE_CANDIDATE_LOG` 调整/调研 CLIP gate 用。

## 输出路径

`plugins.config.ts` 用 `import.meta.url` 锚定 repo 根，所以无论 CLI 从哪里调用、`next dev` cwd 是 `apps/web`，产物都写到根目录 `out/`。Don't break this — 用户依赖这个行为。

## 编辑这个项目时的注意

- Zod schemas 在 `@topic2md/shared` 里定义，`noUncheckedIndexedAccess: true` 打开了，所有数组访问都要 `??` 或断言。
- **`generateObject` 强制用 `mode: 'json'`**（`packages/core/src/llm.ts`），绕开 OpenRouter-routed providers (MiniMax/GLM) 的 tool-call 畸形 JSON 路径，把 sections 步耗时从 ~500s 降到 ~60s。正常完成 finishReason 是 `'stop'`（不再是 `'tool-calls'`）。只把 `length` 当截断信号；不要把其他 reason 误判为失败，上次那次误判触发全量重试把限流撞穿。
- LLM.generate 对 `fallbackModels` 支持 — 传数组自动在首选失败时切下一个，发 `generation.fallback` 事件；Langfuse observer 会把 `generation.*` 事件映射成 trace.generation 节点。
- Plugin 工厂函数规范：`createXxx(config): XxxPlugin`，工厂内做参数校验并抛 `Error`。`name` 字段是 plugin 的身份，出 warn/error 时会带上。**有长期资源（browser / db handle）** 实现 `dispose?()`，runner 结束时会调用。
- **新加 run 入口必须在 `finally` 里调 `disposePlugins`**（`runner.ts` 里导出的 helper）。否则 `image-screenshot` 的 Playwright Chromium 会让 Node event loop 不空，CLI 看起来"挂住"但其实工作已经完成、入库了。`runTopic2md` 和 `regenSection` 都走这个规则。
- CLI 位置参数（如 regen 的 runId）不要用 `!arg.startsWith('-')` 过滤——nanoid 以 `-` / `_` 开头是合法的，这样过滤会让一部分 id 无法被识别为 runId。
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

在 commit message 结尾写 `Closes #N` 自动关单。**多条必须每个 issue 自带关键字**：`Closes #1, closes #2, closes #3`（逗号分隔）或换行分多行——`Closes #1 #2 #3` 这种空格并列只认第一个（踩过，别再踩）。红线是：任何新的外部耦合一律走 plugin 通道，不往 `packages/core` 里加 `import`，想加新源 / 发布目的地就开新 `packages/<source|image|theme|publish>-<name>` 包。
