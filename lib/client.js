/**
 * dsh-side-session — Client half (static plugin, hand-written ModuleLoader
 * bundle, no build step).
 *
 * Adds a "侧边会话" button to the session header and renders a floating side
 * panel (via `shell.overlay`):
 *
 *   - clicking the header button opens the panel INSTANTLY (no create wait);
 *   - the side session (fork seed + recent context + agent) is created
 *     lazily when the user sends the first message;
 *   - the panel binds the session through the standard `sessions` service,
 *     renders the message flow with the MAIN SESSION's MarkdownText
 *     (GFM / KaTeX / code blocks / copy buttons) and sends prompts through
 *     the host Remote namespace `sideSession`;
 *   - closing the panel calls `sideSession.close`, which disposes the agent,
 *     removes its persisted artifact, and can never be reopened.
 *
 * The browser module loader hands `factory(require)` a real require resolved
 * against the platform module table, so primitives and React are reachable.
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-side-session',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')

    exports.name = 'dsh-side-session'
    exports.inject = ['slots', 'sessions', 'remote', 'remote.sideSession']

    exports.apply = (ctx) => {
      const sessions = ctx.sessions
      const sideRemote = ctx.remote.sideSession

      /** The currently open side session. `sessionId` stays null until the
       *  user sends the first message — the fork + agent creation happens
       *  then, not when the panel opens. */
      let sideState = null
      const listeners = new Set()
      const subscribeSide = (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
      const setSide = (state) => {
        sideState = state
        for (const fn of [...listeners]) fn()
      }
      const getSide = () => sideState

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.dyn = 'dsh-side-session'
        style.textContent = PANEL_CSS
        document.head.append(style)
        return () => style.remove()
      }, 'dsh-side-session: panel stylesheet')

      /** Render one inline-markdown text into React elements (fallback only;
       *  assistant bodies use the main session's MarkdownText). */
      function renderInline(text, keyBase) {
        const out = []
        let rest = text
        let n = 0
        while (rest.length > 0 && n < 120) {
          n++
          const codeStart = rest.indexOf('`')
          const boldStart = rest.indexOf('**')
          const linkStart = rest.indexOf('[')
          const italicStart = rest.indexOf('*')
          const candidates = []
          if (codeStart >= 0) candidates.push({ pos: codeStart, kind: 'code' })
          if (boldStart >= 0) candidates.push({ pos: boldStart, kind: 'bold' })
          if (linkStart >= 0) candidates.push({ pos: linkStart, kind: 'link' })
          if (italicStart >= 0) candidates.push({ pos: italicStart, kind: 'italic' })
          candidates.sort((a, b) => a.pos - b.pos || (a.kind === 'bold' ? -1 : 0))
          if (candidates.length === 0) {
            out.push(rest)
            break
          }
          const first = candidates[0]
          if (first.pos > 0) {
            out.push(rest.slice(0, first.pos))
            rest = rest.slice(first.pos)
          }
          let consumed = false
          if (first.kind === 'code') {
            const end = rest.indexOf('`', 1)
            if (end > 0) {
              out.push(React.createElement('code', { key: `${keyBase}-c${n}`, className: 'ss-inline-code' }, rest.slice(1, end)))
              rest = rest.slice(end + 1)
              consumed = true
            }
          } else if (first.kind === 'bold') {
            const end = rest.indexOf('**', 2)
            if (end > 0) {
              out.push(React.createElement('strong', { key: `${keyBase}-b${n}` }, renderInline(rest.slice(2, end), `${keyBase}-b${n}`)))
              rest = rest.slice(end + 2)
              consumed = true
            }
          } else if (first.kind === 'link') {
            const close = rest.indexOf(']', 1)
            const paren = close > 0 ? rest.indexOf('(', close + 1) : -1
            const end = paren > 0 ? rest.indexOf(')', paren + 1) : -1
            if (close > 0 && paren === close + 1 && end > paren) {
              const label = rest.slice(1, close)
              const href = rest.slice(paren + 1, end)
              out.push(React.createElement('a', { key: `${keyBase}-l${n}`, href, target: '_blank', rel: 'noreferrer' }, renderInline(label, `${keyBase}-l${n}`)))
              rest = rest.slice(end + 1)
              consumed = true
            }
          } else if (first.kind === 'italic') {
            const end = rest.indexOf('*', 1)
            if (end > 0) {
              out.push(React.createElement('em', { key: `${keyBase}-i${n}` }, renderInline(rest.slice(1, end), `${keyBase}-i${n}`)))
              rest = rest.slice(end + 1)
              consumed = true
            }
          }
          if (!consumed) {
            out.push(rest[0])
            rest = rest.slice(1)
          }
        }
        if (rest.length > 0) out.push(rest)
        return out
      }

      /** Fallback markdown blocks (used only if MarkdownText is unavailable). */
      function renderMarkdown(text, keyBase) {
        const lines = text.split('\n')
        const blocks = []
        let i = 0
        while (i < lines.length) {
          const line = lines[i]
          const fence = /^```([\w+-]*)\s*$/.exec(line)
          if (fence !== null) {
            const code = []
            i++
            while (i < lines.length && !/^```\s*$/.test(lines[i])) {
              code.push(lines[i])
              i++
            }
            i++
            blocks.push(React.createElement('pre', { key: `${keyBase}-code${blocks.length}`, className: 'ss-md-code' }, code.join('\n')))
            continue
          }
          const heading = /^(#{1,4})\s+(.*)$/.exec(line)
          if (heading !== null) {
            blocks.push(React.createElement('div', { key: `${keyBase}-h${blocks.length}`, className: `ss-md-h${heading[1].length}` }, renderInline(heading[2], `${keyBase}-h${blocks.length}`)))
            i++
            continue
          }
          if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            blocks.push(React.createElement('hr', { key: `${keyBase}-hr${blocks.length}`, className: 'ss-md-hr' }))
            i++
            continue
          }
          const quoteMatch = /^>\s?/.test(line)
          if (quoteMatch) {
            const q = []
            while (i < lines.length && /^>\s?/.test(lines[i])) {
              q.push(lines[i].replace(/^>\s?/, ''))
              i++
            }
            blocks.push(React.createElement('div', { key: `${keyBase}-q${blocks.length}`, className: 'ss-md-quote' }, renderInline(q.join('\n'), `${keyBase}-q${blocks.length}`)))
            continue
          }
          const listMatch = /^\s*([-*+]|\d+[.)])\s+/.exec(line)
          if (listMatch !== null) {
            const ordered = /^\s*\d+/.test(listMatch[1])
            const items = []
            while (i < lines.length) {
              const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
              if (m === null) break
              items.push(m[2])
              i++
            }
            blocks.push(React.createElement(
              ordered ? 'ol' : 'ul',
              { key: `${keyBase}-l${blocks.length}`, className: ordered ? 'ss-md-ol' : 'ss-md-ul' },
              items.map((item, idx) => React.createElement('li', { key: idx }, renderInline(item, `${keyBase}-l${blocks.length}-${idx}`)))
            ))
            continue
          }
          if (/^\s*\|.*\|\s*$/.test(line) && lines[i + 1] !== undefined && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            const rows = []
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
              rows.push(lines[i])
              i++
            }
            const cells = rows
              .filter((_, idx) => idx !== 1)
              .map((row) => row.split('|').slice(1, -1).map((c) => c.trim()))
            blocks.push(React.createElement(
              'table',
              { key: `${keyBase}-t${blocks.length}`, className: 'ss-md-table' },
              React.createElement(
                'tbody',
                null,
                cells.map((row, rIdx) => React.createElement(
                  'tr',
                  { key: rIdx },
                  row.map((cell, cIdx) => React.createElement(
                    rIdx === 0 ? 'th' : 'td',
                    { key: cIdx },
                    renderInline(cell, `${keyBase}-t${blocks.length}-${rIdx}-${cIdx}`)
                  ))
                ))
              )
            ))
            continue
          }
          if (line.trim() === '') {
            i++
            continue
          }
          const para = [line]
          i++
          while (
            i < lines.length &&
            lines[i].trim() !== '' &&
            !/^(```|#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s|\s*\|)/.test(lines[i])
          ) {
            para.push(lines[i])
            i++
          }
          blocks.push(React.createElement('div', { key: `${keyBase}-p${blocks.length}`, className: 'ss-md-p' }, renderInline(para.join('\n'), `${keyBase}-p${blocks.length}`)))
        }
        return blocks
      }

      /** One assistant message: reasoning fold + MarkdownText body + tool chips. */
      function AssistantMessage({ blocks, running }) {
        const [showReasoning, setShowReasoning] = React.useState(false)
        const reasoning = []
        const body = []
        const tools = []
        for (const block of blocks) {
          if (block.kind === 'reasoning' && block.text !== '') reasoning.push(block.text)
          else if (block.kind === 'text' && block.text !== '') body.push(block.text)
          else if (block.kind === 'tool-call') tools.push(block)
        }
        const codeLabels = React.useMemo(() => ({ copyLabel: '复制', copiedLabel: '已复制' }), [])
        return React.createElement(
          'div',
          { className: 'ss-row assistant' },
          reasoning.length > 0
            ? React.createElement(
                'details',
                { className: 'ss-reasoning', open: showReasoning, onToggle: (e) => setShowReasoning(e.target.open) },
                React.createElement('summary', null, '思考'),
                React.createElement('div', { className: 'ss-reasoning-body' }, reasoning.join('\n'))
              )
            : null,
          tools.length > 0
            ? React.createElement(
                'div',
                { className: 'ss-tools' },
                tools.map((t, idx) => React.createElement('span', { key: idx, className: 'ss-tool-chip' }, `⚙ ${t.name}`))
              )
            : null,
          React.createElement(
            'div',
            { className: 'ss-assistant-body' },
            body.map((text, idx) =>
              MarkdownText !== undefined
                ? React.createElement(MarkdownText, { key: idx, text, streaming: running, codeLabels })
                : React.createElement(React.Fragment, { key: idx }, renderMarkdown(text, `md-${idx}`))
            )
          )
        )
      }

      /** One tool-result row: a chip-like summary. */
      function ToolResultRow({ node }) {
        const name = node.call?.name ?? node.callId ?? 'tool'
        const resultText = (node.content ?? [])
          .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
          .join('\n')
          .slice(0, 400)
        return React.createElement(
          'div',
          { className: 'ss-row' },
          React.createElement('div', { className: 'ss-tool-chip ' + (node.isError ? 'error' : '') }, `⚙ ${name}`),
          resultText !== ''
            ? React.createElement('div', { className: 'ss-tool-result' }, resultText)
            : null
        )
      }

      /** Extract display text from a user content block list. */
      function textOfContent(content) {
        if (!Array.isArray(content)) return ''
        return content
          .map((block) => (block && block.type === 'text' ? block.text : ''))
          .join('\n')
      }

      /**
       * Resolve the client-side Session face for a side session id. The host
       * broadcasts `session/created` right after creation, so the binding
       * usually resolves on the first try; poll briefly to ride out
       * list-propagation lag.
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
        const state = React.useSyncExternalStore(subscribeSide, getSide)
        const mainId = state === null ? null : state.mainId
        const sessionId = state === null ? null : state.sessionId
        const seedLength = state === null ? null : state.seedLength
        const { session, snapshot } = useSideSession(sessionId)
        const [draft, setDraft] = React.useState('')
        const [sending, setSending] = React.useState(false)
        const bodyRef = React.useRef(null)

        React.useEffect(() => {
          const el = bodyRef.current
          if (el !== null) el.scrollTop = el.scrollHeight
        }, [snapshot])

        if (state === null) return null

        const running = snapshot?.running === true
        const nodes = snapshot?.nodes ?? []
        const initialized = sessionId !== null

        const send = async () => {
          const text = draft.trim()
          if (text === '' || sending) return
          setSending(true)
          try {
            // First message: initialize the side session (fork seed + recent
            // context + agent creation) now, then deliver the prompt.
            let target = sessionId
            if (target === null) {
              const created = await sideRemote.create({ sourceId: mainId })
              if (created === null || created.ok !== true || typeof created.sessionId !== 'string') {
                console.error('side-session create failed:', created)
                return
              }
              target = created.sessionId
              setSide({ mainId, sessionId: target, seedLength: typeof created.seedLength === 'number' ? created.seedLength : null })
            }
            const result = await sideRemote.prompt({ sessionId: target, text })
            if (result !== null && result.ok === true) setDraft('')
            else console.error('side-session send failed:', result)
          } catch (error) {
            console.error('side-session send failed:', error)
          } finally {
            setSending(false)
          }
        }

        const close = async () => {
          const id = sessionId
          setSide(null)
          setDraft('')
          if (id === null) return
          try {
            await sideRemote.close({ sessionId: id })
          } catch (error) {
            console.error('side-session close failed:', error)
          }
        }

        // Build the visible flow: forked history (seq < seedLength) is hidden,
        // and the injected boundary message (plugin: side-session) is hidden.
        const isBoundary = (node) => {
          const src = node?.source
          if (src !== null && typeof src === 'object' && src.kind === 'plugin' && src.plugin === 'side-session') return true
          const text = textOfContent(node?.content)
          return text.startsWith('Side conversation boundary.')
        }
        const rows = []
        const visible = nodes.filter(
          (node) =>
            !(typeof node.seq === 'number' && seedLength !== null && node.seq < seedLength) &&
            !isBoundary(node)
        )
        for (let index = 0; index < visible.length; index++) {
          const node = visible[index]
          if (node.kind === 'user') {
            const text = textOfContent(node.content)
            if (text === '') continue
            rows.push(
              React.createElement(
                'div',
                { key: node.seq ?? `u${index}`, className: 'ss-row user' },
                React.createElement(
                  'div',
                  { className: 'ss-user-stack' },
                  React.createElement('div', { className: 'ss-bubble' }, text)
                )
              )
            )
          } else if (node.kind === 'assistant') {
            rows.push(React.createElement(AssistantMessage, { key: node.seq ?? `a${index}`, blocks: node.blocks, running }))
          } else if (node.kind === 'tool-result' || node.kind === 'tool-call') {
            rows.push(React.createElement(ToolResultRow, { key: node.seq ?? `t${index}`, node }))
          } else if (node.kind === 'context' || node.kind === 'steering') {
            const text = textOfContent(node.content)
            if (text !== '') {
              rows.push(React.createElement('div', { key: node.seq ?? `c${index}`, className: 'ss-context-tag' }, node.kind === 'context' ? '上下文' : 'steering'))
            }
          }
        }
        const lastIsUser = visible.length > 0 && visible[visible.length - 1].kind === 'user'

        return React.createElement(
          'div',
          { className: 'side-session-overlay' },
          React.createElement(
            'div',
            { className: 'side-session-header' },
            React.createElement('span', { className: 'ss-status ' + (running ? 'running' : '') }),
            React.createElement('div', { className: 'ss-title' }, '侧边临时会话'),
            running
              ? React.createElement(
                  'button',
                  { onClick: () => { sideRemote.cancel({ sessionId }).catch((error) => console.error('side-session cancel failed:', error)) }, title: '停止' },
                  '停止'
                )
              : null,
            React.createElement('button', { onClick: close, title: '关闭并销毁侧边会话' }, '关闭')
          ),
          React.createElement(
            'div',
            { className: 'side-session-body', ref: bodyRef },
            rows.length === 0
              ? React.createElement(
                  'div',
                  { className: 'ss-empty' },
                  initialized
                    ? '侧边临时会话已就绪\n已带入主会话的近期上下文，仅作参考\n在这里输入你的问题（Enter 发送）'
                    : '侧边临时会话\n发送第一条消息时初始化（fork 主会话上下文）\n在这里输入你的问题（Enter 发送）'
                )
              : rows,
            running && lastIsUser
              ? React.createElement(
                  'div',
                  { className: 'ss-thinking' },
                  React.createElement('span', { className: 'ss-dots' }, React.createElement('span', null), React.createElement('span', null), React.createElement('span', null)),
                  '思考中…'
                )
              : null,
            snapshot?.lastAgentError != null
              ? React.createElement('div', { className: 'ss-error' }, String(snapshot.lastAgentError))
              : null,
            snapshot?.promptError != null
              ? React.createElement('div', { className: 'ss-error' }, `${snapshot.promptError.op}: ${snapshot.promptError.error.code} ${snapshot.promptError.error.message}`)
              : null
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
              disabled: (session === null && initialized) || sending
            }),
            React.createElement(
              'button',
              { className: 'ss-send', onClick: send, disabled: sending || draft.trim() === '' || (session === null && initialized) },
              sending ? '…' : '发送'
            )
          )
        )
      }

      /** The header toggle button (conversation.session.header.actions occupant). */
      function ToggleButton(props) {
        const mainId = props.sessionId
        const sideOpen = React.useSyncExternalStore(subscribeSide, getSide)
        const open = () => {
          if (sideOpen !== null || mainId === undefined) return
          // Opening the panel is instant; the fork + agent creation happens
          // lazily on the first message (see SidePanel.send).
          setSide({ mainId, sessionId: null, seedLength: null })
        }
        return React.createElement(
          'button',
          {
            onClick: open,
            disabled: sideOpen !== null || mainId === undefined,
            title: sideOpen !== null ? '侧边会话已打开' : '打开侧边临时会话（fork 当前会话）'
          },
          '侧边会话'
        )
      }

      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
        { name: 'conversation.session.header.actions', id: 'side-session.toggle', order: 200, label: '侧边会话' },
        (props) => React.createElement(ToggleButton, props)
      ))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'side-session.panel', order: 200, label: '侧边临时会话面板' },
        () => React.createElement(SidePanel)
      ))
    }

    /** Panel stylesheet — main-session look (bubble token, MarkdownText owns its own). */
    const PANEL_CSS = `
.side-session-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(460px, 46vw);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #1b1b1f);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  box-shadow: -8px 0 24px rgba(0,0,0,.3);
  z-index: 60;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #e5e5e5);
}
.side-session-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  flex: none;
  background: var(--dsw-alias-bg-layer-1, #232327);
}
.side-session-header .ss-title { flex: 1; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-session-header .ss-status { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; flex: none; }
.side-session-header .ss-status.running { background: #4caf50; animation: ss-pulse 1.2s ease-in-out infinite; }
@keyframes ss-pulse { 50% { opacity: .4; } }
.side-session-header button, .side-session-footer button {
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  background: var(--dsw-alias-bg-layer-3, #2b2b30);
  color: inherit; border-radius: 8px; padding: 4px 12px; cursor: pointer; font-size: 12px; line-height: 1.5;
}
.side-session-header button:hover, .side-session-footer button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); }
.side-session-header button:disabled, .side-session-footer button:disabled { opacity: .45; cursor: default; }
.side-session-body { flex: 1; overflow-y: auto; padding: 14px 14px 8px; display: flex; flex-direction: column; gap: 12px; }
.side-session-body .ss-empty { align-self: center; text-align: center; opacity: .6; padding: 48px 16px; font-size: 12px; line-height: 1.8; }
.ss-row { display: flex; flex-direction: column; }
.ss-row.user { align-items: flex-end; }
.ss-row.assistant { align-items: flex-start; width: 100%; min-width: 0; }
.ss-user-stack { flex-direction: column; align-items: flex-end; gap: 8px; min-width: 0; max-width: min(525px, 82%); display: flex; }
.ss-bubble {
  background: var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-3, #2b2b30));
  max-width: 100%; color: var(--dsw-alias-label-primary, #e5e5e5);
  border-radius: 22px; padding: 10px 16px; font-size: 16px; line-height: 24px;
  word-break: break-word; white-space: pre-wrap;
}
.ss-assistant-body { min-width: 0; width: 100%; font-size: 14px; line-height: 1.6; }
.ss-meta { font-size: 10px; opacity: .5; margin: 2px 6px 0; }
.ss-md-p { margin: 0 0 6px; }
.ss-md-h1, .ss-md-h2, .ss-md-h3, .ss-md-h4 { font-weight: 700; margin: 8px 0 4px; line-height: 1.4; }
.ss-md-h1 { font-size: 16px; } .ss-md-h2 { font-size: 15px; } .ss-md-h3 { font-size: 14px; } .ss-md-h4 { font-size: 13px; }
.ss-md-code {
  font-family: var(--dsw-font-family-code, ui-monospace, monospace); font-size: 12px;
  background: var(--dsw-alias-bg-base, #141418); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
  border-radius: 6px; padding: 8px 10px; margin: 6px 0; overflow-x: auto; white-space: pre;
}
.ss-inline-code { font-family: var(--dsw-font-family-code, ui-monospace, monospace); font-size: 12px; background: rgba(128,128,128,.18); border-radius: 4px; padding: 0 4px; }
.ss-md-ul, .ss-md-ol { margin: 4px 0 6px; padding-left: 20px; }
.ss-md-quote { border-left: 3px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); padding: 2px 10px; margin: 6px 0; opacity: .85; }
.ss-md-hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); margin: 8px 0; }
.ss-md-table { border-collapse: collapse; margin: 6px 0; font-size: 12px; width: 100%; }
.ss-md-table th, .ss-md-table td { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); padding: 4px 8px; text-align: left; }
.ss-reasoning { border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); margin: 4px 0 8px; font-size: 12px; opacity: .72; }
.ss-reasoning summary { cursor: pointer; user-select: none; padding: 2px 8px; color: var(--dsw-alias-label-primary-dimmed, #b0b4bb); }
.ss-reasoning .ss-reasoning-body { padding: 2px 10px 6px; white-space: pre-wrap; }
.ss-tools { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 2px; }
.ss-tool-chip {
  font-size: 11px; font-family: var(--dsw-font-family-code, ui-monospace, monospace);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); background: rgba(128,128,128,.1);
  border-radius: 999px; padding: 1px 8px; color: var(--dsw-alias-label-primary-dimmed, #b0b4bb);
}
.ss-tool-result {
  align-self: stretch; font-size: 11px; font-family: var(--dsw-font-family-code, ui-monospace, monospace);
  background: rgba(128,128,128,.07); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2));
  border-radius: 8px; padding: 6px 10px; margin-top: 4px; white-space: pre-wrap; word-break: break-word;
  max-height: 180px; overflow-y: auto; color: var(--dsw-alias-label-primary-dimmed, #b0b4bb);
}
.ss-context-tag { align-self: center; font-size: 10px; opacity: .5; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); }
.ss-thinking { display: flex; align-items: center; gap: 6px; padding: 6px 4px; color: var(--dsw-alias-label-primary-dimmed, #b0b4bb); font-size: 12px; }
.ss-thinking .ss-dots span { display: inline-block; width: 5px; height: 5px; margin-right: 3px; border-radius: 50%; background: currentColor; animation: ss-blink 1.2s infinite; }
.ss-thinking .ss-dots span:nth-child(2) { animation-delay: .2s; }
.ss-thinking .ss-dots span:nth-child(3) { animation-delay: .4s; }
@keyframes ss-blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }
.side-session-body .ss-error {
  align-self: stretch; font-size: 11px; color: #ff8080; background: rgba(255, 80, 80, .1);
  border: 1px solid rgba(255, 80, 80, .35); padding: 6px 10px; border-radius: 8px;
  white-space: pre-wrap; word-break: break-word;
}
.side-session-footer {
  flex: none; display: flex; gap: 8px; padding: 10px 14px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  align-items: flex-end; background: var(--dsw-alias-bg-layer-1, #232327);
}
.side-session-footer textarea {
  flex: 1; resize: none; background: var(--dsw-alias-bg-layer-3, #2b2b30); color: inherit;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 10px;
  padding: 8px 12px; font: inherit; font-size: 13px; min-height: 38px; max-height: 150px; line-height: 1.5;
}
.side-session-footer .ss-send { background: var(--dsw-alias-brand-primary, #4d93f8); color: var(--dsw-alias-label-primary-inverted, #fff); border: none; padding: 6px 16px; border-radius: 10px; font-weight: 600; }
.side-session-footer .ss-send:disabled { opacity: .45; }
`

    return module.exports
  }
})
