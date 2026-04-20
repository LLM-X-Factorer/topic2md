# topic2md — Claude 协作说明

> 给未来进入这个 repo 的 Claude / 其他 AI 代理看的操作手册。人类开发者请读 [README.md](./README.md)。

## 架构红线（违反即返工）

- **`packages/core` 不得 `import` 任何 plugin 包**（`@topic2md/source-*` / `image-*` / `theme-*` / `publish-*`）。Plugin 通过根目录 `plugins.config.ts` 显式注入，经由 `runTopic2md({ plugins })` 传入 `RuntimeContext`，core 只消费 `@topic2md/shared` 暴露的接口。
- **不要替换以下硬性选型**：Mastra workflow（`@mastra/core`）、OpenRouter 作为 LLM 网关、Playwright 做截图。备选只能作为 plugin 并存。
- **Mock plugins 的位置**是 `packages/core/src/testing/`，通过子路径 `@topic2md/core/testing` 暴露。它们是本包内的测试替身，不算违反红线。

## 工作流

6 步，Mastra workflow（`packages/core/src/workflow.ts`），顺序不可乱：

1. `research` — SourcePlugin 抓 N 条权威资料
2. `outline` — LLM 产出 title/digest/sections[]（`generateObject` + `OutlineSchema`）
3. `sections` — 每段 LLM 并行生成 markdown（`Promise.all`）
4. `images` — core 按 section 关键词亲和度 + 去重分配 source，交给 ImagePlugin 抓图
5. `assemble` — 组装 frontmatter + 正文 + 引用列表（纯函数，`markdown.ts`）
6. `publish` — PublishPlugin 落盘 / 发布

每步 `try/catch` 后 emit `step.error` 再 `throw`。`sections` 单段 LLM 失败用双 attempt + `pickBest`，不拖累全局。

## 模型现状（2026-04）

| 模型                              | 状态              | 说明                                                                              |
| --------------------------------- | ----------------- | --------------------------------------------------------------------------------- |
| `openrouter/minimax/minimax-m2.7` | ✅ **默认**，稳定 | 已验证端到端干净通过，~15s 走完 6 步                                              |
| `openrouter/z-ai/glm-5.1`         | ⚠️ 不稳定         | structured output 偶发 Invalid JSON / 40-140 字早停；代码已加重试但仍有坏情况     |
| `openrouter/qwen/qwen3.6-plus`    | ❌ 不兼容         | OpenRouter 返回 "No endpoints support `tool_choice`"；换 Qwen 需改 `mode: 'json'` |
| Claude / GPT / Gemini 系          | 未测              | 预计稳定，但没 credits 验过                                                       |

换模型时先 `curl https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY"` 确认 id 可用。

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
- Vercel AI SDK `generateObject` **正常完成 finishReason = `tool-calls`**（它用 tool call 返回 JSON），不是 `stop`。不要把 `tool-calls` 当截断信号 — 上次改错过一次，引发 100% 误重试→限流→整步挂掉。`length` 才是真截断。
- Plugin 工厂函数规范：`createXxx(config): Xxx Plugin`，工厂内做参数校验并抛 `Error`。`name` 字段是 plugin 的身份，出 warn/error 时会带上。
- 每个 plugin 独立 package，`package.json` 里 workspace 依赖只写 `@topic2md/shared: workspace:*`，不要 cross-plugin。
- commit message 英文祈使句，主语省略；description 写 "why" 不写 "what"。签名：
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

## 已知待办

见根目录 `README.md` 「未来功能」段，或提出来一起 scope。红线是：任何新的外部耦合一律走 plugin 通道，不往 `packages/core` 里加 `import`。
