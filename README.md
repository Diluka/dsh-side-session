# dsh-side-session

类似 Claude Code `/btw` 的**侧边临时会话窗口**，用于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)。

在主会话的会话头部点击「侧边会话」，右侧浮出一个临时会话窗口：它 **fork 主会话已完成的历史回合**（作为参考上下文），并**补全主会话的最新动态**（当前进行中的轮次里已提交的用户消息、助手消息、工具调用），再注入 boundary 提示词告知代理「这是侧边临时会话、主会话 ID、历史只是参考、避免干扰主会话」。侧边会话**不显示在会话列表**，**关闭即销毁、无法再次打开**。

## 特性（对照需求）

| 需求 | 实现 |
| --- | --- |
| 1. 创建时 fork 主会话 | 子会话以主会话已完成轮次的日志前缀为 seed（`meta.seedLength` 标记边界） |
| 2. 代理与主会话一致 | `agentPresets.composeFrom(childCtx, parent.ctx)` 挂载同一 preset（工具/技能/提示词/权限行一致）；继承 `cwd`、模型路由（provider/model）、sandbox 模式、approval 策略 |
| 3. 注入侧边会话提示词 | 双保险：system prompt section + **第一条 user 消息**（`Side conversation boundary...`），明确「fork 的历史只是参考上下文，只有 boundary 之后的用户消息才是活跃指令」 |
| 4. 不进列表 + 关闭后不可重开 | 子会话以 `origin: 'subagent'` 创建（UI 会话列表天然过滤）；关闭时 `handle.dispose()` 销毁 agent 并用 shell 删除持久化落盘文件，进程重启后也不存在 |

## 为什么是「fork + 补全」而不是纯 fork

事件级 fork（seed）要求「无未闭合轮次」，所以只能取到主会话**最后一个已完成 turn** 之前的历史。主会话长期运行时，这个历史是滞后的。

解决：`recentMainContext()` 直接读主会话的**内存日志**——不受重放约束，当前进行中轮次里已提交的事件（用户消息、助手消息、工具调用）全部可见——取 fork 边界之后的最新活动，随 boundary 消息注入。侧边会话因此**既知道历史，也知道主会话此刻在干什么**。

## 为什么延迟初始化

点击按钮**立即**弹出面板（不等待任何创建过程）；fork + 子 agent 的创建发生在**首条消息发送时**。打开但未使用不会产生任何会话。

## 架构

```
┌─────────────────────────── Host（DSH 进程）───────────────────────────┐
│ lib/index.js（零依赖 ESM，不 import 任何 @deepseek-ai/*）             │
│  webServer 路由 POST /side-session/api/<method>                       │
│   create → fork seed + 近期上下文快照 + boundary 消息 + 子 agent       │
│   prompt → agent.followup（host 内驱动）                              │
│   cancel → agent.cancel                                               │
│   close  → dispose agent + 删除落盘文件                               │
│   list / status                                                       │
└───────────────────────────────────────────────────────────────────────┘
┌────────────────────────── Client（浏览器）────────────────────────────┐
│ lib/client.js（ModuleLoader bundle，/plugins/@dsh-external/...）      │
│  conversation.session.header.actions  「侧边会话」按钮                 │
│  shell.overlay                       浮动侧边面板                     │
│    助手消息复用主会话的 MarkdownText（GFM/KaTeX/代码块/复制按钮）、    │
│    思考折叠、工具调用 chip、运行状态、错误显示                         │
│  RPC：fetch POST /side-session/api/<method>                           │
└───────────────────────────────────────────────────────────────────────┘
```

- Host/Client 通过 webServer JSON 路由通信（与 `dsh-balance-plugin` 等 profile 插件相同的零依赖范式：profile bundle 只能解析 profile 自己的 node_modules，不能 import `@deepseek-ai/*`）。
- 面板复用标准 `sessions` 服务：`binding(sessionId)` 绑定会话、`session.subscribe()/getSnapshot()` 渲染消息流；fork 历史与 boundary 消息在渲染时过滤（`seq < seedLength`、`source.plugin === 'side-session'`）。
- 消息发送不走 wire 的 `session.prompt`（它会拒绝 `origin: 'subagent'` 的会话），由 host 半部直接 `agent.followup()`。

## 安装

静态 profile 插件，纯 JS 无构建步骤，支持本地路径 / tarball / GitHub 安装：

```bash
# 本地路径（仓库或 tarball 均可，效果等价）
dsh plugin --profile web add /path/to/dsh-side-session
# 或 GitHub（若发布到公开仓库）
dsh plugin --profile web add github:你的名字/dsh-side-session
```

`dsh plugin add` 会把它写入 profile 的 `package.json`（`dsh.profile.bundles` 自动追加，patch 机制生效）。**重启 dsh web 后生效**。

## 使用

1. 打开 DSH Web 界面并进入任意会话。
2. 会话头部点击「侧边会话」→ 右侧立即打开侧边临时会话窗口（fork 与 agent 创建延迟到首条消息）。
3. 在窗口中提问，代理将以与主会话相同的目录 / 工具 / 技能 / 权限工作，遵守 boundary 提示词（历史仅供参考、非破坏性探索、不干扰主线程）。
4. 点击「关闭」→ 侧边会话被销毁并删除落盘记录，无法再次打开。

## 文件

- `lib/index.js` — Host 半部（零依赖）：fork + 近期上下文快照 + boundary 消息注入，创建 / 发送 / 停止 / 关闭 / 列出侧边会话；webServer JSON 路由。
- `lib/client.js` — Client 半部（ModuleLoader bundle）：头部按钮 + 浮动面板 UI，助手消息复用主会话 MarkdownText。
- `package.json` — `dsh.bundle.patch`（layer patch）、`dsh.client`（web 平台声明）、peerDependencies（仅类型参考，运行时零依赖）。
- `cordis.patch.yml` — bundle patch：把插件行插入 profile 的 layer stack。
- `dsh.plugin.json` — 插件清单（元数据）。
- `src/` — 早期动态插件版本（Typert Remote RPC），仅历史参考，不再使用。

## License

MIT
