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

## 架构

```
┌─────────────────────────── Host（DSH 进程）───────────────────────────┐
│ src/host.js                                                           │
│  harness.handle('side-session/create')  → fork seed + 近期上下文快照   │
│                                           + boundary 消息 + 子 agent   │
│  harness.handle('side-session/prompt')  → agent.followup（host 内驱动）│
│  harness.handle('side-session/cancel')  → agent.cancel                │
│  harness.handle('side-session/close')   → dispose agent + 删除落盘文件 │
└───────────────────────────────────────────────────────────────────────┘
┌────────────────────────── Client（浏览器）────────────────────────────┐
│ src/client.js                                                         │
│  conversation.session.header.actions  「侧边会话」按钮                 │
│  shell.overlay                       浮动侧边面板                     │
│    用户气泡（主会话样式 token）、助手消息（markdown 渲染：代码块/      │
│    表格/列表/行内格式）、思考折叠、工具调用 chip、运行状态、错误显示    │
└───────────────────────────────────────────────────────────────────────┘
```

- Host/Client 通过 Package-private RPC（`harness.handle` ↔ `host.call`）通信。
- 面板复用标准 `sessions` 服务：`binding(sessionId)` 绑定会话、`session.subscribe()/getSnapshot()` 渲染消息流；fork 历史与 boundary 消息在渲染时过滤（`seq < seedLength`、`source.plugin === 'side-session'`）。
- 消息发送不走 wire 的 `session.prompt`（它会拒绝 `origin: 'subagent'` 的会话），由 host 半部直接 `agent.followup()`。

## 使用

1. 打开 DSH Web 界面并进入任意会话。
2. 会话头部点击「侧边会话」→ 右侧打开侧边临时会话窗口（已 fork 主会话历史 + 带入最新动态）。
3. 在窗口中提问，代理将以与主会话相同的目录 / 工具 / 技能 / 权限工作，遵守 boundary 提示词（历史仅供参考、非破坏性探索、不干扰主线程）。
4. 点击「关闭」→ 侧边会话被销毁并删除落盘记录，无法再次打开。

## 开发与验证

仓库源码（`src/host.js`、`src/client.js`）即动态 Cordis 插件的 `code.host` / `code.client` 函数体，可直接用于 DSH 的动态插件机制验证：

1. 用 `cordis_define` 定义插件（`kind: 'new'`，`idPrefix: 'side'`，分别粘贴 `src/host.js` 与 `src/client.js` 的内容）。
2. `cordis_run` 激活；在页面会话头部出现「侧边会话」按钮即加载成功。

## 文件

- `src/host.js` — Host 半部：fork + 近期上下文快照 + boundary 消息注入，创建 / 发送 / 停止 / 关闭 / 列出侧边会话。
- `src/client.js` — Client 半部：头部按钮 + 浮动面板 UI（markdown 渲染、思考折叠、工具 chip、运行状态）。
- `plugin.json` — 插件清单（元数据）。

## License

MIT
