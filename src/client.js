/**
 * dsh-side-session — Client half.
 *
 * Adds a "侧边会话" button to the session header and renders a floating side
 * panel (via `shell.overlay`) that hosts the temporary side session:
 *
 *   - click the header button → host `side-session/create` forks the current
 *     main session and returns the child session id;
 *   - the panel binds that session through the standard `sessions` service,
 *     renders its message flow, and sends prompts through `session.prompt`;
 *   - closing the panel calls host `side-session/close`, which disposes the
 *     agent — the session disappears from the store and can never be reopened.
 *
 * This file is the `code.client` body verbatim (plain JS, React via the
 * closure symbol, no imports, no native timers).
 */
return {
  name: 'side-session',
  inject: ['slots', 'timer'],
  apply(ctx) {
    const sessions = ctx.get('sessions')
    const slots = ctx.get('slots')
    if (slots === undefined || sessions === undefined) return

    /** The currently open side session id (null = closed). */
    let sideSessionId = null
    const listeners = new Set()
    const subscribeSide = (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
    const setSide = (id) => {
      sideSessionId = id
      for (const fn of [...listeners]) fn()
    }
    const getSide = () => sideSessionId

    styles.insert(`
.side-session-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(440px, 42vw);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-2, #1f1f1f);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  box-shadow: -8px 0 24px rgba(0,0,0,.25);
  z-index: 60;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #e5e5e5);
}
.side-session-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
  flex: none;
}
.side-session-header .ss-title {
  flex: 1;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-session-header button, .side-session-footer button {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  background: var(--dsw-alias-bg-layer-3, #2a2a2a);
  color: inherit;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
}
.side-session-header button:hover, .side-session-footer button:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.2));
}
.side-session-header button:disabled, .side-session-footer button:disabled {
  opacity: .5;
  cursor: default;
}
.side-session-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.side-session-body .ss-msg {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}
.side-session-body .ss-user {
  align-self: flex-end;
  max-width: 92%;
  background: var(--dsw-alias-brand-primary, #4d93f8);
  color: var(--dsw-alias-label-primary-inverted, #fff);
  padding: 8px 10px;
  border-radius: 10px 10px 2px 10px;
}
.side-session-body .ss-assistant {
  align-self: flex-start;
  max-width: 92%;
  background: var(--dsw-alias-bg-layer-3, #2a2a2a);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
  padding: 8px 10px;
  border-radius: 10px 10px 10px 2px;
}
.side-session-body .ss-tool {
  align-self: center;
  font-size: 11px;
  opacity: .65;
  font-family: var(--dsw-font-family-code, monospace);
}
.side-session-body .ss-empty {
  align-self: center;
  opacity: .55;
  padding: 24px 0;
}
.side-session-footer {
  flex: none;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
  align-items: flex-end;
}
.side-session-footer textarea {
  flex: 1;
  resize: none;
  background: var(--dsw-alias-bg-layer-3, #2a2a2a);
  color: inherit;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
  min-height: 36px;
  max-height: 140px;
}
.side-session-footer textarea:focus {
  outline: 1px solid var(--dsw-alias-brand-primary, #4d93f8);
}
`)

    /** Extract display text from a user content block list. */
    function textOfContent(content) {
      if (!Array.isArray(content)) return ''
      return content
        .map((block) => (block && block.type === 'text' ? block.text : ''))
        .join('\n')
    }

    /** Extract display text from assistant blocks. */
    function textOfBlocks(blocks) {
      if (!Array.isArray(blocks)) return ''
      return blocks
        .map((block) => {
          if (!block) return ''
          if (block.kind === 'text' || block.kind === 'reasoning') return block.text ?? ''
          if (block.kind === 'tool-call') return `⚙ ${block.name}(${String(block.argsRaw ?? '').slice(0, 200)})`
          return ''
        })
        .join('\n')
    }

    /**
     * Resolve the client-side Session face for a side session id. The host
     * broadcasts `session/created` right after creation, so the binding usually
     * resolves on the first try; poll briefly to ride out list-propagation lag.
     */
    function useSideSession(sessionId) {
      const [session, setSession] = React.useState(null)
      const [snapshot, setSnapshot] = React.useState(null)
      React.useEffect(() => {
        if (sessionId === null) {
          setSession(null)
          setSnapshot(null)
          return
        }
        let stopped = false
        let disposeSnap = null
        let timer = null
        const tick = () => {
          if (stopped) return
          const bound = sessions.binding(sessionId)
          if (bound === undefined) {
            timer = ctx.timeout(tick, 200)
            return
          }
          const s = bound.session
          s.open?.()
          setSession(s)
          setSnapshot(s.getSnapshot())
          disposeSnap = s.subscribe(() => {
            if (!stopped) setSnapshot(s.getSnapshot())
          })
        }
        tick()
        return () => {
          stopped = true
          if (timer !== null) timer()
          if (disposeSnap !== null) disposeSnap()
        }
      }, [sessionId])
      return { session, snapshot }
    }

    /** The floating side-session panel (shell.overlay occupant). */
    function SidePanel() {
      const sessionId = React.useSyncExternalStore(subscribeSide, getSide)
      const { session, snapshot } = useSideSession(sessionId)
      const [draft, setDraft] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const bodyRef = React.useRef(null)

      React.useEffect(() => {
        const el = bodyRef.current
        if (el !== null) el.scrollTop = el.scrollHeight
      }, [snapshot])

      if (sessionId === null) return null

      const running = snapshot?.running === true
      const nodes = snapshot?.nodes ?? []

      const send = async () => {
        const text = draft.trim()
        if (text === '' || session === null || sending) return
        setSending(true)
        try {
          const result = await session.prompt([{ type: 'text', text }], 'queue')
          if (result.ok) setDraft('')
        } catch (error) {
          console.error('side-session send failed:', error)
        } finally {
          setSending(false)
        }
      }

      const close = async () => {
        setSide(null)
        setDraft('')
        try {
          await host.call('side-session/close', { sessionId })
        } catch (error) {
          console.error('side-session close failed:', error)
        }
      }

      const rows = nodes
        .map((node, index) => {
          if (node.kind === 'user') {
            const text = textOfContent(node.content)
            if (text === '') return null
            return React.createElement('div', { key: node.seq ?? index, className: 'ss-msg ss-user' }, text)
          }
          if (node.kind === 'assistant') {
            const text = textOfBlocks(node.blocks)
            if (text === '') return null
            return React.createElement('div', { key: node.seq ?? index, className: 'ss-msg ss-assistant' }, text)
          }
          if (node.kind === 'tool-result' || node.kind === 'tool-call') {
            const name = node.kind === 'tool-call' ? node.name : node.call?.name ?? node.callId
            return React.createElement('div', { key: node.seq ?? index, className: 'ss-tool' }, `⚙ ${name ?? 'tool'}`)
          }
          return null
        })
        .filter((row) => row !== null)

      return React.createElement(
        'div',
        { className: 'side-session-overlay' },
        React.createElement(
          'div',
          { className: 'side-session-header' },
          React.createElement('div', { className: 'ss-title' }, '侧边临时会话'),
          running
            ? React.createElement(
                'button',
                { onClick: () => { if (session !== null) session.cancel() }, title: '停止' },
                '停止'
              )
            : null,
          React.createElement('button', { onClick: close, title: '关闭并销毁侧边会话' }, '关闭')
        ),
        React.createElement(
          'div',
          { className: 'side-session-body', ref: bodyRef },
          rows.length === 0
            ? React.createElement('div', { className: 'ss-empty' }, '侧边临时会话已就绪 — 在这里输入你的问题')
            : rows
        ),
        React.createElement(
          'div',
          { className: 'side-session-footer' },
          React.createElement('textarea', {
            value: draft,
            placeholder: '输入消息…（Enter 发送）',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            },
            disabled: session === null || sending
          }),
          React.createElement(
            'button',
            { onClick: send, disabled: session === null || sending || draft.trim() === '' },
            sending ? '…' : '发送'
          )
        )
      )
    }

    /** The header toggle button (conversation.session.header.actions occupant). */
    function ToggleButton(props) {
      const mainId = props.sessionId
      const sideOpen = React.useSyncExternalStore(subscribeSide, getSide)
      const [busy, setBusy] = React.useState(false)
      const open = async () => {
        if (busy || sideOpen !== null || mainId === undefined) return
        setBusy(true)
        try {
          const result = await host.call('side-session/create', { sourceId: mainId })
          if (result !== null && result.ok === true && typeof result.sessionId === 'string') {
            setSide(result.sessionId)
          } else {
            console.error('side-session create failed:', result)
          }
        } catch (error) {
          console.error('side-session create failed:', error)
        } finally {
          setBusy(false)
        }
      }
      return React.createElement(
        'button',
        {
          onClick: open,
          disabled: busy || sideOpen !== null || mainId === undefined,
          title: sideOpen !== null ? '侧边会话已打开' : '打开侧边临时会话（fork 当前会话）'
        },
        busy ? '…' : '侧边会话'
      )
    }

    slots.inject('conversation.session.header.actions', () => slots.register(
      { name: 'conversation.session.header.actions', id: 'side-session.toggle', order: 200, label: '侧边会话' },
      (props) => React.createElement(ToggleButton, props)
    ))

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'side-session.panel', order: 200, label: '侧边临时会话面板' },
      () => React.createElement(SidePanel)
    ))
  }
}
