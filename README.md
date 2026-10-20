# opencode2-local-memory

opencode v2 本地跨会话记忆插件：捕获每轮对话摘要、把最近几天的记忆注入系统提示，并提供 `memory_search` 工具按需检索全部历史记忆。

这是 [dsh-local-memory](https://github.com/caopu16/dsh-local-memory) 向 opencode v2 插件体系的移植版。纯 JS / 纯文本实现，零 native 依赖——不依赖 memsearch CLI / pymilvus / numpy，因此不受本机 CPU 达不到 x86-64-v2 基线的影响。

## 版本要求

- opencode **v2**（基于 `@opencode/plugin` 的 v2 插件契约，peer `>=2.0.0`，实测 opencode v2.0.29 / plugin 2.0.30）。default 导出 `Plugin.define({ id, setup(ctx) })`，V1 的函数式插件在 v2 不加载。
- Node `>=22.6.0`（opencode 直接运行 `.ts`，无需构建步骤）。

## 功能

| 能力 | 说明 |
| --- | --- |
| **capture** | 每次会话进入 `session.idle` 时，用 SDK 读取刚结束的这一轮对话，摘要成 markdown bullet，追加到 `<project>/.memsearch/memory/YYYY-MM-DD.md` |
| **inject** | 通过 session `context` 钩子，把最近 `injectDays` 天（默认 2 天）的记忆折叠进请求的 `system[]` |
| **memory_search** | 纯 JS 关键词匹配，翻**全部**日文件（不止最近 2 天），供模型主动捞更早记忆 |
| **兼容 memsearch** | 与官方 `@zilliz/memsearch-opencode` 插件共用 `.memsearch/memory/` 目录和锚点格式，互读互不覆盖 |

## 与 DSH 原版的差异（移植要点）

opencode v2 的插件契约（`Plugin.define({ id, setup(ctx) })`，能力经 `ctx` 领域 API 注册）与 DSH 0.2.x 不同，三处核心改动：

1. **读取刚结束的一轮**：DSH 0.2.x 提供 session projection 读完整的一轮；opencode 没有 projection API。本插件用 `ctx.event.subscribe()` 监听 `session.idle`，再用 `ctx.session.context()` 拉取整段 v2 消息（消息自带内容，不再是 v1 的 `{info, parts}`），自己把最后一轮（最后一条真实用户消息到结尾）渲染成 transcript。
2. **注入方式**：DSH 用带自有 source kind 的快照 user 消息注入；opencode 没有消息来源 kind，改为在 session `context` 钩子里原地编辑可变的 `system: SystemPart[]`（带 marker 原地替换、保持幂等、不跨轮堆积）。
3. **摘要路由**：DSH 用进程内 `ctx.llm`；opencode v2 提供一发式 `ctx.generate.text({ prompt, model })`，直接用它做摘要——无需像 v1 那样新建临时会话再删除，也就没有临时会话 `session.idle` 递归的问题。

## 安装

### 本地路径安装（推荐，开发期）

```bash
cd ~/opencode2-local-memory
bash scripts/install.sh
```

脚本会把本项目的绝对路径加入 opencode 配置（`$OPENCODE_CONFIG` → `~/.config/opencode/opencode.jsonc` → `~/.config/opencode/opencode.json`）的 `plugins` 数组，幂等，可重复执行。

> 注意：脚本用 JSON 方式回写配置，会丢弃原文件里的 `//` / `/* */` 注释（已先存一份 `.bak`）。如果想保留注释，手动编辑即可（见下）。

### 手动加入

在 opencode 配置的 `plugins` 数组里加入本项目路径或 npm 包名：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/home/you/opencode2-local-memory"
  ]
}
```

安装后**重启 opencode 或新开一个会话**，`memory_search` 工具与记忆注入才会生效。

## 配置

配置经 `ctx.options` 读取（v2 用对象形式传入，不再是 v1 的 `[路径, 配置]` 元组）：

```jsonc
{
  "plugins": [
    { "package": "/home/you/opencode2-local-memory", "options": { "injectDays": 3, "searchMaxResults": 10 } }
  ]
}
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `captureEnabled` | `true` | 是否捕获新对话 |
| `injectEnabled` | `true` | 是否注入最近记忆 |
| `searchEnabled` | `true` | 是否注册 `memory_search` 工具 |
| `summarizeEnabled` | `true` | 是否用 LLM 摘要；关掉则写原文 transcript |
| `injectDays` | `2` | 注入时回看几个日文件 |
| `injectMaxLinesPerFile` | `40` | 每个日文件最多注入多少行 |
| `captureMaxChars` | `24000` | 单轮 transcript 送摘要器的字符上限 |
| `summarizeMaxTokens` | `1200` | 摘要最大 token（预留，当前 prompt 走会话默认） |
| `summarizeTimeoutMs` | `120000` | 摘要超时（预留） |
| `minPromptLength` | `8` | 用户消息短于此长度不捕获 |
| `searchMaxResults` | `20` | `memory_search` 单次最多返回几个轮次块 |
| `searchMaxLinesPerResult` | `12` | 每个轮次块最多返回几行正文 |
| `provider` / `model` | 空 | 摘要路由；留空自动用本轮助手回复的 provider/model |

## 使用

日常无需手动操作：capture 在每次会话空闲时自动记录，inject 自动把最近记忆塞进系统提示。

当话题可能早于注入窗口时，模型会主动调用：

```
memory_search(query: "flyway V22", top_k: 5)
```

返回结果按关键词 / 子串命中打分排序，包含日期文件、轮次标题和正文片段。

## 项目结构

```
opencode2-local-memory/
├── src/
│   ├── index.ts        # 插件入口：default export Plugin.define({id,setup})
│   ├── constants.ts    # 默认配置、marker、摘要 system prompt
│   ├── util.ts         # 日期、记忆目录解析
│   ├── capture.ts      # 读 session.context、渲染本轮、generate.text 摘要、写日文件
│   ├── inject.ts       # 最近记忆读取 + system 提示合并
│   └── search.ts       # 纯 JS 关键词召回与结果格式化
├── scripts/
│   ├── install.sh      # 把本项目加入 opencode 配置的 plugins
│   └── smoke-test.ts   # 用假 ctx 跑通 setup→capture→inject→search
├── test/
│   ├── search.test.ts  # search 单元测试（node:test）
│   └── capture.test.ts # renderLastTurn / 锚点幂等单元测试
├── docs/
│   ├── design.md       # 设计说明
│   └── migration-opencode.md # 从 DSH 版移植到 opencode 的对照
├── package.json
└── README.md
```

## 测试

```bash
cd ~/opencode2-local-memory
npm test          # 单元测试（node --test，不需要安装 opencode）
npm run smoke     # 冒烟测试（假 opencode client，离线跑通全链路）
npm run typecheck # 类型检查（需要 tsc 与 @types/node 可解析）
```

## 记忆文件格式

与 `@zilliz/memsearch-opencode` 插件对齐：

```markdown
# 2026-08-26

## Session 08:49

### 08:49
<!-- session:ses_xxx turn:msg_xxx db:session:ses_xxx -->
- User 要求检查数据库与前端多语言 JSON 文件。
- Assistant 执行了 i18n 同步。
```

`db:` 字段沿用官方格式，这里记会话 id（`session:...`）而不是数据库路径，便于回溯原会话，同时保持锚点逐字节兼容、两边互读。
