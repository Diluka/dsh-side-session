/**
 * dsh-side-session — Host half.
 *
 * Creates a "side temporary session" (Codex-style) from the current main
 * session:
 *
 *   1. fork: seed the child session with the parent's completed-turn prefix;
 *   2. same agent: join the parent's agent preset (tools / skills / prompt /
 *      permission composition) and inherit cwd + sandbox/approval overrides;
 *   3. inject a side-session identity prompt telling the agent it is a
 *      temporary side session, which main session it came from, and to avoid
 *      interfering with the main session's work;
 *   4. ephemeral: `origin: 'subagent'` keeps it out of the UI session list,
 *      it is never persisted, and close disposes the agent so it can never be
 *      reopened.
 *
 * This file is the `code.host` body verbatim (plain JS, no imports). It is
 * registered through the harness RPC methods below and consumed by the
 * client half.
 */
return {
  name: 'side-session',
  inject: ['agents', 'sessions'],
  apply(ctx) {
    /** sideSessionId -> AgentHandle, kept so close can dispose the agent. */
    const handles = new Map()

    /** The identity prompt injected into every side session. */
    function sideSessionPrompt(mainId) {
      return [
        '你当前运行在一个「侧边临时会话」中（类似 Codex 的 side session）。',
        '',
        `- 主会话 ID：${mainId}（本会话从该主会话 fork 而来，继承了它的对话上下文、工作目录、工具、技能与权限）`,
        '- 本会话是临时的：关闭后即被销毁，不会出现在会话列表中，之后无法再次打开。请不要在其中安排需要跨会话持续的任务。',
        '- 请尽量独立工作，避免干扰主会话：',
        '  - 不要修改主会话的 goal、计划或队列状态；',
        '  - 不要抢占、中止或打断主会话正在进行的任务；',
        '  - 与主会话并发操作同一批文件时，先读取确认最新内容再写入，避免互相覆盖；',
        '  - 除非用户明确要求，不要把结论写回主会话。',
        '',
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

    /** Capture the parent's explicit policy overrides (keeps permissions aligned). */
    function captureParentPolicies(parent) {
      return {
        sandboxMode: ctx.get('sandboxPolicy')?.overrideOf(parent.session),
        approvalPolicy: ctx.get('approval')?.overrideOf(parent.session)
      }
    }

    /** Append captured overrides to the child log (mirrors subagent delegation). */
    function appendPolicies(session, overrides) {
      if (overrides.sandboxMode !== undefined) {
        session.append('sandbox/mode', { mode: overrides.sandboxMode, source: 'side-session' })
      }
      if (overrides.approvalPolicy !== undefined) {
        session.append('approval/policy', { policy: overrides.approvalPolicy, source: 'side-session' })
      }
    }

    /** Create a side session forked from `sourceId`. */
    harness.handle('side-session/create', async (args) => {
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
      const policies = captureParentPolicies(parent)
      let handle
      try {
        handle = await ctx.agents.create({
          sessionId: childId,
          meta: {
            ...(parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}),
            ...(agentPreset !== undefined ? { agentPreset } : {}),
            parentSession: parentHeader.id,
            origin: 'subagent',
            ...(seed.length > 0 ? { seedLength: seed.length } : {})
          },
          ...(seed.length > 0 ? { seed } : {}),
          setup: (childCtx) => {
            // Same agent composition as the parent: tools / skills / prompt
            // sections / permission rows all come from the joined preset.
            childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
            // Same sandbox + approval overrides as the parent session.
            appendPolicies(childCtx.agent.session, policies)
            // Side-session identity prompt (requirement 3).
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
      handles.set(childId, handle)
      return { ok: true, sessionId: childId }
    })

    /** Dispose a side session: the agent is destroyed, the session leaves the store. */
    harness.handle('side-session/close', async (args) => {
      const sessionId = String(args?.sessionId ?? '')
      const handle = handles.get(sessionId)
      if (handle === undefined) return { ok: false, code: 'not-found' }
      handles.delete(sessionId)
      try {
        await handle.dispose()
      } catch (error) {
        return { ok: false, code: 'dispose-failed', message: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true }
    })

    /** List live side sessions created through this plugin. */
    harness.handle('side-session/list', () => {
      const sessions = []
      for (const [sessionId, handle] of handles) {
        sessions.push({
          sessionId,
          parentSessionId: handle.agent.session.header.parentSession ?? null
        })
      }
      return { sessions }
    })

    // On plugin unload, dispose every live side session so nothing leaks.
    ctx.effect(() => () => {
      for (const handle of handles.values()) handle.dispose().catch(() => {})
      handles.clear()
    })
  }
}
