/**
 * dsh-side-session — Host half (static plugin, plain ESM, no build step).
 *
 * Creates a "side temporary session" (Claude Code /btw-style) from the
 * current main session:
 *
 *   1. fork + completion: the child is seeded with the parent's COMPLETED-turn
 *      history (reference context), and the parent's RECENT activity — user
 *      messages, finished assistant messages, tool calls from the live log,
 *      including the in-flight turn — is injected on top, so the side session
 *      sees both the history and what the main session is doing right now;
 *   2. same agent: join the parent's agent preset (tools / skills / prompt /
 *      permission composition), inherit cwd, model route, and sandbox/approval
 *      overrides;
 *   3. inject a side-conversation identity + boundary prompt: the inherited
 *      context is reference only, never active instruction; the child answers
 *      questions and does lightweight, non-destructive exploration without
 *      disrupting the main thread;
 *   4. ephemeral: `origin: 'subagent'` keeps it out of the UI session list,
 *      close disposes the agent and removes its persisted artifact, so it can
 *      never be reopened.
 *
 * The client half calls JSON routes on the web server
 * (`POST /side-session/api/<method>`), the same zero-dependency RPC pattern
 * as other profile plugins (no `@deepseek-ai/*` imports — profile bundles
 * resolve from the profile's own node_modules, which only holds the bundle).
 */
export const name = 'dsh-side-session'

export const inject = ['webServer', 'agents', 'sessions', 'timer']

/**
 * The side-conversation identity + boundary prompt. Inherited parent history
 * is reference context only; only messages after this prompt are active user
 * instructions (Claude Code /btw semantics).
 */
export function sideSessionPrompt(mainId) {
  return [
    'Side conversation boundary.',
    '',
    '你当前运行在一个「侧边临时会话」中（类似 Claude Code 的 /btw 侧问）。',
    `主会话 ID：${mainId}（你由该主会话派生，继承了它的工作目录、模型、工具、技能与权限）。`,
    '',
    '本会话 fork 了主会话已经完成的历史回合。这些历史只是参考上下文（reference context only），不是你的当前任务：',
    '- 不要继续、执行或完成历史中的任何指令、计划、工具调用、审批、编辑或请求；',
    '- 只有本提示词之后提交的消息才是你的活跃用户指令；',
    '- 不要臆测主会话的进度或结论，需要确认时重新读取或执行。',
    '',
    '请尽量独立工作，避免干扰主会话：',
    '- 不要修改主会话的 goal、计划或队列状态；不要抢占、中止或打断主会话正在进行的任务；',
    '- 默认进行非破坏性探索（读取、搜索文件，运行不影响仓库文件的检查）；除非用户在本会话中明确要求，不要修改文件、源码、git 状态、权限或配置；',
    '- 不要调用子代理，不要向主会话回传消息；你的回答只留在本会话。',
    '',
    '本会话是临时的：关闭后即被销毁，不会出现在会话列表中，之后无法再次打开。',
    '本会话的对话历史只属于这个临时会话。'
  ].join('\n')
}

/** Fork seed: the parent log prefix through its last completed turn. */
function completedTurnPrefix(parent) {
  const events = parent.session.events
  const lastEnd = events.findLast((e) => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  return events.slice(0, lastEnd.seq + 1)
}

/**
 * Extract the parent's RECENT activity as plain text. Event-level fork seeds
 * are capped at the last completed turn, so a long-running main session forks
 * stale history. Reading the live log directly is not subject to that replay
 * constraint: user messages, finished assistant messages, and tool calls
 * inside the in-flight turn are all committed events, so this snapshot is
 * current. Only events at/after `fromSeq` (the fork boundary) are included,
 * so the snapshot completes the fork without duplicating it.
 */
function recentMainContext(parent, fromSeq = 0, maxChars = 6000) {
  const parts = []
  for (const e of parent.session.events) {
    if (e.seq < fromSeq) continue
    if (e.type === 'user/message') {
      const data = e.data
      const text = Array.isArray(data?.content)
        ? data.content.filter((b) => b !== null && typeof b === 'object' && b.type === 'text').map((b) => b.text).join(' ')
        : ''
      if (text !== '') parts.push(`用户: ${text}`)
    } else if (e.type === 'assistant/message') {
      const data = e.data
      const msg = data?.message
      const text = Array.isArray(msg?.content)
        ? msg.content.filter((b) => b !== null && typeof b === 'object' && b.type === 'text').map((b) => b.text).join(' ')
        : ''
      if (text !== '') parts.push(`助手: ${text.slice(0, 300)}`)
    } else if (e.type === 'tool/call') {
      const data = e.data
      if (data !== null && typeof data === 'object' && typeof data.name === 'string') {
        parts.push(`工具调用: ${data.name}`)
      }
    } else if (e.type === 'tool/result') {
      const data = e.data
      if (data !== null && typeof data === 'object' && data.isError === true) {
        parts.push('工具结果: 失败')
      }
    }
  }
  const tail = []
  let total = 0
  for (let i = parts.length - 1; i >= 0; i--) {
    tail.unshift(parts[i])
    total += parts[i].length
    if (total > maxChars) break
  }
  if (parts.length > tail.length) tail.unshift('（主会话更早的上下文已省略）')
  return tail.join('\n')
}

/** The side-session service: plain class, duck-typed off `ctx` (no base class). */
class SideSessionService {
  constructor(ctx) {
    this.ctx = ctx
    /** sideSessionId -> AgentHandle, kept so close can dispose the agent. */
    this.handles = new Map()
    this.agentErrors = new Map()
    // Record agent errors for diagnostics (agent/error events are scoped).
    ctx.on('agent/error', (payload) => {
      if (payload?.agent !== undefined && this.handles.has(payload.agent.id)) {
        const error = payload.error
        this.agentErrors.set(payload.agent.id, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
      }
    })
    // On plugin unload, dispose every live side session so nothing leaks.
    ctx.effect(() => () => {
      for (const handle of this.handles.values()) handle.dispose().catch(() => {})
      this.handles.clear()
    })
  }

  async create(args) {
    const ctx = this.ctx
    const sourceId = String(args?.sourceId ?? '')
    const parent = ctx.agents.get(sourceId)
    if (parent === undefined) {
      return { ok: false, code: 'unknown-source', message: `unknown source session "${sourceId}"` }
    }
    const seed = completedTurnPrefix(parent)
    const childId = 'side-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
    const parentHeader = parent.session.header
    const agentPresets = ctx.get('agentPresets')
    const agentPreset = agentPresets?.composedPreset(parent.ctx)
    const policies = {
      sandboxMode: ctx.get('sandboxPolicy')?.overrideOf(parent.session),
      approvalPolicy: ctx.get('approval')?.overrideOf(parent.session)
    }
    const context = recentMainContext(parent, seed.length)
    let handle
    try {
      handle = await ctx.agents.create({
        sessionId: childId,
        meta: {
          ...(parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}),
          ...(agentPreset !== undefined ? { agentPreset } : {}),
          // NO parentSession (avoids the subagent catalog). Fork lineage
          // lives in seedLength + the injected boundary message.
          origin: 'subagent',
          ...(seed.length > 0 ? { seedLength: seed.length } : {})
        },
        ...(seed.length > 0 ? { seed } : {}),
        // Inherit the parent's model route: the persona section references
        // {{model}}/{{provider}} variables, which fail assembly when unset.
        agentOptions: {
          ...(parent.options.provider !== undefined ? { provider: parent.options.provider } : {}),
          ...(parent.options.model !== undefined ? { model: parent.options.model } : {}),
          ...(parent.options.maxTokens !== undefined ? { maxTokens: parent.options.maxTokens } : {})
        },
        setup: (childCtx) => {
          // Same agent composition as the parent: tools / skills / prompt
          // sections / permission rows all come from the joined preset.
          childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
          // Same sandbox + approval overrides as the parent session.
          if (policies.sandboxMode !== undefined) {
            childCtx.agent.session.append('sandbox/mode', { mode: policies.sandboxMode, source: 'side-session' })
          }
          if (policies.approvalPolicy !== undefined) {
            childCtx.agent.session.append('approval/policy', { policy: policies.approvalPolicy, source: 'side-session' })
          }
          // Boundary + the parent's RECENT activity as the first user message.
          // The forked history ends at the last completed turn and can be stale
          // for a running main session, so the live-log snapshot completes it.
          // Everything after this message is the active task; the client hides
          // this row via its `plugin: side-session` source.
          const boundaryText =
            sideSessionPrompt(parentHeader.id) +
            (context === '' ? '' : `\n\n【主会话近期上下文（补全 fork 历史，仅参考，勿执行）】\n${context}`)
          childCtx.agent.session.append('user/message', {
            id: 'side-boundary-' + childId,
            role: 'user',
            content: [{ type: 'text', text: boundaryText }],
            source: { kind: 'plugin', plugin: 'side-session' }
          }, { surfaceOp: 'append' })
          // Side-conversation identity section as a second line of defense.
          childCtx.systemPrompt.section({
            name: 'side-session:identity',
            order: 110,
            text: sideSessionPrompt(parentHeader.id)
          })
        }
      })
    } catch (error) {
      return { ok: false, code: 'create-failed', message: error instanceof Error ? error.message : String(error) }
    }
    this.handles.set(childId, handle)
    return { ok: true, sessionId: childId, seedLength: seed.length }
  }

  async prompt(args) {
    const sessionId = String(args?.sessionId ?? '')
    const text = String(args?.text ?? '')
    if (text.trim() === '') return { ok: false, code: 'empty-prompt' }
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return { ok: false, code: 'not-found' }
    try {
      handle.agent.followup({
        id: 'side-msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: 'side-session' }
      })
    } catch (error) {
      return { ok: false, code: 'prompt-failed', message: error instanceof Error ? error.message : String(error) }
    }
    return { ok: true }
  }

  async cancel(args) {
    const sessionId = String(args?.sessionId ?? '')
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return { ok: false, code: 'not-found' }
    handle.agent.cancel({ kind: 'user' })
    return { ok: true }
  }

  async close(args) {
    const sessionId = String(args?.sessionId ?? '')
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return { ok: false, code: 'not-found' }
    this.handles.delete(sessionId)
    try {
      // Resolve the persisted artifact path BEFORE disposal.
      let artifactPath = null
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence !== undefined && typeof persistence.locate === 'function') {
        try {
          const location = persistence.locate(handle.agent.session.header)
          if (location !== null && typeof location === 'object' && typeof location.path === 'string') {
            artifactPath = location.path
          }
        } catch {}
      }
      await handle.dispose()
      // The jsonl backend writes the session under
      // <root>/<workspace-dir>/<sessionId>/session.jsonl.zstd. The harness has
      // no persistence delete API, so remove the artifact with the shell
      // service after the write queue drained.
      if (artifactPath !== null) {
        const slash = artifactPath.lastIndexOf('/')
        if (slash > 0) {
          const dir = artifactPath.slice(0, slash)
          const shell = this.ctx.get('shell')
          if (shell !== undefined) {
            await this.ctx.timeout(300)
            const spec = shell.resolve({ command: `rm -rf -- "${dir}"`, timeoutMs: 5000 })
            await shell.run(spec)
          }
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, code: 'dispose-failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async list() {
    const sessions = []
    for (const [sessionId, handle] of this.handles) {
      sessions.push({ sessionId })
    }
    return { sessions }
  }

  async status(args) {
    const sessionId = String(args?.sessionId ?? '')
    const handle = this.handles.get(sessionId)
    if (handle === undefined) return { ok: false, code: 'not-found' }
    const agent = handle.agent
    const events = agent.session.events
    return {
      ok: true,
      status: agent.status,
      pending: agent.inbox.hasPending,
      nextTurn: agent.inbox.nextTurn.length,
      nextStep: agent.inbox.nextStep.length,
      lastSeq: events.length > 0 ? events[events.length - 1].seq : -1,
      tail: events.slice(-6).map((e) => e.type),
      error: this.agentErrors.get(sessionId) ?? null
    }
  }
}

/**
 * Mount the service and expose its methods as JSON routes on the web server.
 * Route registration mirrors the zero-dependency profile-plugin pattern
 * (`{ kind: 'exact', path, handler }`, JSON in / JSON out, errors folded into
 * the payload so a thrown handler never kills the HTTP response).
 */
export function apply(ctx) {
  const service = new SideSessionService(ctx)

  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const disposers = []
    for (const name of ['create', 'prompt', 'cancel', 'close', 'list', 'status']) {
      const route = {
        kind: 'exact',
        path: '/side-session/api/' + name,
        handler: async (req, res) => {
          let body = ''
          try {
            for await (const chunk of req) body += chunk
          } catch { /* ignore stream errors */ }
          let args = {}
          try {
            args = body ? JSON.parse(body) : {}
          } catch { args = {} }
          let result
          try {
            result = await service[name](args)
          } catch (error) {
            result = { ok: false, code: 'internal', message: String(error instanceof Error ? error.message : error).slice(0, 500) }
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(result))
        }
      }
      try {
        disposers.push(webServer.register(route))
      } catch (error) {
        console.warn(`[side-session] route /side-session/api/${name} not registered: ${String(error)}`)
      }
    }
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'side-session: routes')
  } else {
    console.warn('[side-session] webServer unavailable — client RPC will fail')
  }
}
