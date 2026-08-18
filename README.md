# dsh-side-session

类似 Codex app 的**侧边临时会话窗口**，用于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)。

在主会话的会话头部点击「侧边会话」，右侧浮出一个临时会话窗口：它会 **fork 当前主会话**、继承主会话的**代理配置**（工作目录、工具、技能、权限），并注入一段提示词告知代理「这是侧边临时会话、主会话 ID、避免干扰主会话」。侧边会话**不显示在会话列表**，**关闭即销毁、无法再次打开**。

## 特性（对照需求）

| 需求 | 实现 |
| --- | --- |
| 1. 创建时 fork 主会话 | 子会话以主会话已完成轮次的日志前缀作为 seed（`ctx.agents.create({ seed, meta.parentSession })`） |
| 2. 代理与主会话一致 | `agentPresets.composeFrom(childCtx, parent.ctx)` 挂载同一 preset（工具/技能/提示词/权限行一致）；继承 `cwd`、sandbox 模式、approval 策略 |
| 3. 注入侧边会话提示词 | `systemPrompt.section('side-session:identity')` 注入：临时会话身份、主会话 ID、不干扰主会话的约束 |
| 4. 不进列表 + 关闭后不可重开 | 子会话以 `origin: 'subagent'` 创建（UI 会话列表天然过滤）；**不写入持久化**（纯内存 agent）；关闭时 `handle.dispose()` 销毁 agent 与 session，进程重启后也不存在 |

## 架构

```
┌─────────────────────────── Host（DSH 进程）───────────────────────────┐
│ src/host.js                                                           │
│  harness.handle('side-session/create')  → fork 主会话，创建子 agent    │
│  harness.handle('side-session/close')   → dispose agent（销毁会话）    │
│  harness.handle('side-session/list')    → 列出存活侧边会话             │
└───────────────────────────────────────────────────────────────────────┘
┌────────────────────────── Client（浏览器）────────────────────────────┐
│ src/client.js                                                         │
│  conversation.session.header.actions  「侧边会话」按钮                 │
│  shell.overlay                       浮动侧边面板（消息流 + 输入框）   │
└───────────────────────────────────────────────────────────────────────┘
```

- Host/Client 通过 Package-private RPC（`harness.handle` ↔ `host.call`）通信。
- 面板复用标准 `sessions` 服务：`binding(sessionId)` 绑定会话、`session.prompt()` 发送、`session.subscribe()/getSnapshot()` 渲染消息流。

## 使用

1. 打开 DSH Web 界面并进入任意会话。
2. 会话头部点击「侧边会话」→ 右侧打开侧边临时会话窗口（已 fork 当前主会话）。
3. 在窗口中提问，代理将以与主会话相同的目录 / 工具 / 技能 / 权限工作，并遵守「不干扰主会话」的提示词。
4. 点击「关闭」→ 侧边会话被销毁，无法再次打开。

## 开发与验证

仓库源码（`src/host.js`、`src/client.js`）即动态 Cordis 插件的 `code.host` / `code.client` 函数体，可直接用于 DSH 的动态插件机制验证：

1. 用 `cordis_define` 定义插件（`kind: 'new'`，`idPrefix: 'side'`，分别粘贴 `src/host.js` 与 `src/client.js` 的内容）。
2. `cordis_run` 激活；在页面会话头部出现「侧边会话」按钮即加载成功。

## 文件

- `src/host.js` — Host 半部：创建 / 关闭 / 列出侧边会话，提示词注入，权限继承。
- `src/client.js` — Client 半部：头部按钮 + 浮动面板 UI。
- `plugin.json` — 插件清单（元数据）。

## License

MIT
