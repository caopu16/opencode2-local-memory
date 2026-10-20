# 从 DSH 版移植到 opencode v2

本插件是 `dsh-local-memory`（适配 DSH 0.2.x）向 opencode v2 插件体系的移植。
两套运行时的插件契约差别很大，下面逐条对照。

## 1. 插件形态

- **DSH**：Cordis function-plugin，导出 `name` / `inject` / `apply(ctx, config)`，
  在 `apply` 里用 `ctx.on(...)` 注册事件、`ctx.tools.register(...)` 注册工具。
- **opencode v2**：default export `Plugin.define({ id, setup(ctx) })`。`setup` 里通过
  `ctx` 的领域 API 注册能力：`ctx.tool.transform()`、`ctx.event.subscribe()`、
  `ctx.session.hook('context')` 等。V1 的函数式插件（`(input, options) => Hooks`）
  在 v2 不加载（官方 loader 报 `must export a default definition with an id and
  an effect or setup function`）。

## 2. 读取刚结束的一轮对话

- **DSH 0.2.x**：`session.events` 同步 getter 被删，官方替代是 session projection
  （框架按每个提交事件驱动的纯折叠）。插件注册 `localMemoryTurn` projection，在
  `turn/end` 读已维护好的折叠状态。
- **opencode v2**：没有 projection API。用 `ctx.event.subscribe()` 监听 `session.idle`，
  再用 `ctx.session.context({ sessionID })` 拉整段消息。v2 消息自带内容（user 有 `.text`，
  assistant 有 `.content[]`，不再是 v1 的 `{info, parts}`），`renderLastTurn` 把
  「最后一条真实用户消息 → 结尾」渲染成本轮 transcript。工具调用压成计数行，assistant 文本保留。

对应文件：`src/capture.ts` 的 `renderLastTurn`。

## 3. 注入记忆

- **DSH**：在 `agent/pre-step` 第 1 步追加一条带自有 `source.kind` 的快照 user 消息，
  `form: 'snapshot'` 保证新快照顶替旧快照。
- **opencode v2**：没有消息来源 kind。改用 session `context` 钩子（`ctx.session.hook('context', cb)`），
  在回调里原地编辑请求的可变 `system: SystemPart[]`——把记忆块折叠进 `system[0]`
  （而不是新增数组项，兼容「system 必须排第一」的后端），用 MARKER 原地替换保持幂等。

对应文件：`src/index.ts` 的 `mergeSystemMemory`，记忆块由 `src/inject.ts` 的 `buildMemoryBlock` 拼装。

## 4. 摘要路由

- **DSH**：进程内 `ctx.llm.stream(...)`，用 `BlockAssembler` 收流。
- **opencode v2**：没有进程内 LLM 句柄，但有一发式 `ctx.generate.text({ prompt, model })`。
  直接用它做摘要：把摘要 system prompt 拼在 transcript 前面发一次，读回 `.text`。
  这比 v1 简单——不需要新建临时会话再删除。

对应文件：`src/capture.ts` 的 `summarizeTurn`。

### 递归防护

v2 用 `ctx.generate.text` 做摘要，是无状态的一发调用，不会产生新会话、也不触发
`session.idle`，所以没有「摘要会话又被当成一轮去摘要」的递归问题（v1 需要 scratch
session id Set 来防护）。

## 5. 锚点里的 db 字段

两版都记 `session:<id>` 而不是数据库路径，字段名保留 `db:`，
与官方 memsearch 锚点格式逐字节兼容，两边互读互不覆盖。
opencode 版的 `turn:` 记的是本轮起始用户消息的 message id。

## 6. 构建 / 安装

- **DSH**：提交 `lib/` 构建产物，`dsh plugin --profile web add github:...` 安装。
- **opencode v2**：直接跑 `.ts`，无构建步骤。`package.json` 的 `main` 指向 `src/index.ts`，
  安装就是把项目路径（或 npm 包名）加进 opencode 配置的 `plugins` 数组
  （见 `scripts/install.sh`）。依赖 `@opencode/plugin >=2.0.0`。

## 升级后验证

```bash
npm test       # 单元测试（renderLastTurn / search / 锚点幂等）
npm run smoke  # 假 opencode client，离线跑通 注册→capture→inject→search
```

插件在 opencode 启动时加载，改动后需要**重启 opencode 并新开会话**。
