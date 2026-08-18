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
    const {
      MarkdownText,
      Button,
      Pill,
      StateDot,
      DisclosureRow,
      MessageText,
      IconSendOutline16,
      IconStopFill16,
      IconCloseOutline16,
      IconThinkOutline16,
      IconCodeOutline16
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    exports.name = 'dsh-side-session'
    exports.inject = ['slots', 'sessions']

    /** JSON RPC to the host half: POST /side-session/api/<method>. */
    async function apiCall(name, args) {
      const res = await fetch('/side-session/api/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {})
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return await res.json()
    }

    exports.apply = (ctx) => {
      const sessions = ctx.sessions
      const sideRemote = {
        create: (args) => apiCall('create', args),
        prompt: (args) => apiCall('prompt', args),
        cancel: (args) => apiCall('cancel', args),
        close: (args) => apiCall('close', args),
        status: (args) => apiCall('status', args)
      }

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
        const [showTools, setShowTools] = React.useState(false)
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
                DisclosureRow,
                {
                  icon: React.createElement(IconThinkOutline16, null),
                  title: '思考',
                  open: showReasoning,
                  expandable: true,
                  onToggle: () => setShowReasoning((v) => !v),
                  className: 'ss-reasoning',
                  collapsedContent: React.createElement('span', { className: 'ss-reasoning-preview' }, reasoning[0].slice(0, 80))
                },
                React.createElement('div', { className: 'ss-reasoning-body' }, reasoning.join('\n'))
              )
            : null,
          tools.length > 0
            ? React.createElement(
                DisclosureRow,
                {
                  icon: React.createElement(IconCodeOutline16, null),
                  title: `工具调用 ${tools.length}`,
                  open: showTools,
                  expandable: true,
                  onToggle: () => setShowTools((v) => !v),
                  className: 'ss-tools',
                  collapsedContent: React.createElement(
                    'span',
                    { className: 'ss-tools-preview' },
                    tools.map((t) => t.name).join('、')
                  )
                },
                React.createElement(
                  'div',
                  { className: 'ss-tools-detail' },
                  tools.map((t, idx) =>
                    React.createElement(
                      Pill,
                      { key: idx, className: 'ss-tool-chip' },
                      React.createElement('span', { className: 'ss-tool-name' }, t.name)
                    )
                  )
                )
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
        const [open, setOpen] = React.useState(false)
        const name = node.call?.name ?? node.callId ?? 'tool'
        const resultText = (node.content ?? [])
          .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
          .join('\n')
          .slice(0, 400)
        return React.createElement(
          'div',
          { className: 'ss-row' },
          React.createElement(
            DisclosureRow,
            {
              icon: React.createElement(IconCodeOutline16, null),
              title: name,
              open: open,
              expandable: resultText !== '',
              onToggle: () => setOpen((v) => !v),
              className: 'ss-tool-row ' + (node.isError ? 'error' : '')
            },
            resultText !== ''
              ? React.createElement('div', { className: 'ss-tool-result' }, resultText)
              : null
          )
        )
      }

      /** Extract display text from a user content block list. */
      function textOfContent(content) {
        if (!Array.isArray(content)) return ''
        return content
          .map((block) => (block && block.type === 'text' ? block.text : ''))
          .join('\n')
      }

      /** HH:MM timestamp for a message node (main-session bubble meta style). */
      function timeOf(node) {
        const t = node?.time ?? node?.data?.time
        if (typeof t === 'number' && Number.isFinite(t)) {
          const d = new Date(t)
          if (!Number.isNaN(d.getTime())) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        }
        if (typeof t === 'string' && t.length >= 16) return t.slice(11, 16)
        return ''
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
        /** True while the user is at/near the bottom: auto-follow new output.
         *  Scrolling up detaches; scrolling back to the bottom re-attaches.
         *  Without this, streaming chunks yank the viewport down while the
         *  user is reading earlier output. */
        const stickToBottom = React.useRef(true)

        React.useEffect(() => {
          const el = bodyRef.current
          if (el === null) return
          const onScroll = () => {
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }
          el.addEventListener('scroll', onScroll, { passive: true })
          return () => el.removeEventListener('scroll', onScroll)
        }, [])

        React.useEffect(() => {
          const el = bodyRef.current
          if (el !== null && stickToBottom.current) el.scrollTop = el.scrollHeight
        }, [snapshot])

        if (state === null) return null

        const running = snapshot?.running === true
        const nodes = snapshot?.nodes ?? []
        const initialized = sessionId !== null

        const send = async () => {
          // While running the button is the STOP control (main-session
          // behavior): cancel the in-flight generation instead of sending.
          if (sending || running) {
            if (sessionId !== null) {
              sideRemote.cancel({ sessionId }).catch((error) => console.error('side-session cancel failed:', error))
            }
            setSending(false)
            return
          }
          const text = draft.trim()
          if (text === '') return
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
            if (result !== null && result.ok === true) {
              setDraft('')
              stickToBottom.current = true
            }
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
                  React.createElement('div', { className: 'ss-bubble' }, text),
                  timeOf(node) !== ''
                    ? React.createElement('div', { className: 'ss-meta' }, timeOf(node))
                    : null
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
            React.createElement(StateDot, { state: running ? 'ongoing' : 'idle', size: 10, className: 'ss-status' }),
            React.createElement('div', { className: 'ss-title' }, '侧边临时会话'),
            React.createElement(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                icon: React.createElement(IconCloseOutline16, null),
                className: 'ss-header-btn',
                onClick: close,
                disabled: sending && sessionId === null,
                title: sending && sessionId === null ? '正在初始化侧边会话，请稍候' : '关闭并销毁侧边会话'
              }
            )
          ),
          React.createElement(
            'div',
            { className: 'side-session-body', ref: bodyRef },
            rows.length === 0
              ? React.createElement(
                  'div',
                  { className: 'ss-empty' },
                  React.createElement('div', { className: 'ss-empty-headline' }, '侧边临时会话'),
                  React.createElement('div', { className: 'ss-empty-sub' }, 'Preview'),
                  React.createElement(
                    'div',
                    { className: 'ss-empty-meta' },
                    initialized
                      ? '已带入主会话的近期上下文，仅作参考'
                      : '发送第一条消息时初始化（fork 主会话上下文）'
                  ),
                  React.createElement('div', { className: 'ss-empty-hint' }, '在这里输入你的问题（Enter 发送）')
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
            React.createElement(
              'div',
              { className: 'ss-composer-card' },
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
                'div',
                { className: 'ss-composer-actions' },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'ss-send',
                    onClick: send,
                    disabled: !sending && !running && (draft.trim() === '' || (session === null && initialized)),
                    title: sending || running ? '停止生成' : '发送',
                    'aria-label': sending || running ? 'Stop generating' : 'Send'
                  },
                  React.createElement(sending || running ? IconStopFill16 : IconSendOutline16, null)
                )
              )
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
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            className: 'ss-toggle-btn',
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

    /** Panel stylesheet — main-session look: 16px base, bubble token with
     *  timestamp, 16/28 assistant body via MarkdownText, composer card. */
    const PANEL_CSS = `
.side-session-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(460px, 46vw);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-base, #ffffff);
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  box-shadow: -8px 0 24px rgba(0,0,0,.18);
  z-index: 60;
  font-size: 16px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
}
.side-session-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  flex: none;
  background: var(--dsw-alias-bg-layer-1, #fafafa);
}
.side-session-header .ss-title {
  flex: 1;
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-session-header .ss-header-btn { flex: none; }
/* header toggle button — main-session Session-log style */
.ss-toggle-btn {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1)) !important;
  border-radius: 18px !important;
  padding: 6px 12px !important;
  height: 32px;
  font-size: 13px !important;
  color: var(--dsw-alias-label-primary, #0f1115) !important;
}
.ss-toggle-btn:disabled { opacity: .45; cursor: default; }
.side-session-body {
  flex: 1; overflow-y: auto;
  padding: 16px 16px 12px;
  display: flex; flex-direction: column; gap: 16px;
}
.side-session-body .ss-empty {
  align-self: center;
  text-align: center;
  padding: 56px 16px 24px;
  display: flex; flex-direction: column; align-items: center; gap: 12px;
  max-width: 340px;
}
.side-session-body .ss-empty-headline {
  font-size: 26px; font-weight: 500; line-height: 32px;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.side-session-body .ss-empty-sub {
  font-size: 16px; line-height: 24px;
  color: var(--dsw-alias-label-secondary, #61666b);
}
.side-session-body .ss-empty-meta {
  font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  white-space: pre-line;
}
.side-session-body .ss-empty-hint {
  font-size: 13px; line-height: 20px;
  color: var(--dsw-alias-label-quaternary, #9aa0a6);
}
/* ---- user message: right-aligned bubble (main-session bubble token) + timestamp ---- */
.ss-row { display: flex; flex-direction: column; }
.ss-row.user { align-items: flex-end; gap: 6px; }
.ss-row.assistant { align-items: flex-start; width: 100%; min-width: 0; gap: 8px; }
.ss-user-stack {
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  min-width: 0; max-width: min(525px, 82%);
}
.ss-bubble {
  background: var(--dsw-specific-bubble, #edf3fe);
  max-width: 100%;
  color: var(--dsw-alias-label-primary, #0f1115);
  border-radius: 22px;
  padding: 10px 16px;
  font-size: 16px; line-height: 24px;
  word-break: break-word; white-space: pre-wrap;
}
.ss-meta {
  font-size: 14px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  margin: 0 4px;
  font-variant-numeric: tabular-nums;
}
/* ---- assistant message: 16/28 body, MarkdownText owns its internals ---- */
.ss-assistant-body { min-width: 0; width: 100%; font-size: 16px; line-height: 28px; color: var(--dsw-alias-label-primary, #0f1115); }
.ss-assistant-body > * + * { margin-top: 8px; }
/* ---- reasoning fold: primitives DisclosureRow (Think look) ---- */
.ss-reasoning { width: 100%; margin: 0; }
.ss-reasoning .ss-reasoning-preview {
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  margin-left: 8px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 260px;
}
.ss-reasoning .ss-reasoning-body {
  margin: 4px 0 0;
  padding: 8px 12px;
  white-space: pre-wrap;
  font-size: 13px; line-height: 1.7;
  color: var(--dsw-alias-label-secondary, #61666b);
  background: var(--dsw-alias-bg-layer-1, #f5f5f6);
  border-radius: 10px;
}
/* ---- tool calls: folded DisclosureRow (main-session collapsible cards) ---- */
.ss-tools { width: 100%; margin: 0; }
.ss-tools .ss-tools-preview {
  font-size: 13px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  margin-left: 8px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 280px;
}
.ss-tools .ss-tools-detail { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; padding: 0 2px; }
.ss-tool-chip .ss-tool-name { font-weight: 500; color: var(--dsw-alias-label-primary, #0f1115); }
.ss-tool-chip.error { color: #c0392b; border-color: rgba(192,57,43,.45); background: rgba(192,57,43,.08); }
.ss-tool-row { width: 100%; margin: 0; }
.ss-tool-row.error .ss-reasoning-body, .ss-tool-row.error [data-disclosure-row] { color: #c0392b; }
.ss-tool-result {
  align-self: stretch;
  font-size: 12px;
  font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  background: var(--dsw-alias-bg-layer-1, #f5f5f6);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  border-radius: 10px; padding: 8px 12px; margin-top: 4px;
  white-space: pre-wrap; word-break: break-word;
  max-height: 180px; overflow-y: auto;
  color: var(--dsw-alias-label-secondary, #61666b);
  line-height: 1.6;
}
.ss-context-tag {
  align-self: center; font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  padding: 2px 12px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1));
}
/* ---- thinking indicator ---- */
.ss-thinking {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 2px;
  color: var(--dsw-alias-label-secondary, #61666b);
  font-size: 13px;
}
.ss-thinking .ss-dots span {
  display: inline-block; width: 5px; height: 5px; margin-right: 3px;
  border-radius: 50%; background: currentColor;
  animation: ss-blink 1.2s infinite;
}
.ss-thinking .ss-dots span:nth-child(2) { animation-delay: .2s; }
.ss-thinking .ss-dots span:nth-child(3) { animation-delay: .4s; }
@keyframes ss-blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }
.side-session-body .ss-error {
  align-self: stretch;
  font-size: 12px; color: #c0392b;
  background: rgba(192,57,43,.08);
  border: 1px solid rgba(192,57,43,.3);
  padding: 8px 12px; border-radius: 10px;
  white-space: pre-wrap; word-break: break-word;
  line-height: 1.6;
}
/* ---- composer card (main-session composer look) ---- */
.side-session-footer {
  flex: none;
  padding: 0 16px 12px;
  display: flex; flex-direction: column;
  background: linear-gradient(rgba(255,255,255,0), var(--dsw-alias-bg-base, #ffffff) 36px);
}
.ss-composer-card {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1));
  border-radius: 22px;
  padding: 10px 10px 8px;
  box-shadow: 0 1px 6px rgba(0,0,0,.05);
}
.side-session-footer textarea {
  width: 100%; resize: none;
  background: transparent; color: inherit; border: none; outline: none;
  padding: 4px 12px 0;
  font: inherit; font-size: 16px; line-height: 24px;
  min-height: 28px; max-height: 150px;
}
.side-session-footer textarea::placeholder { color: var(--dsw-alias-label-tertiary, #81858c); }
.side-session-footer textarea:disabled { opacity: .5; }
.ss-composer-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.side-session-footer .ss-send {
  flex: none; width: 34px; height: 34px; padding: 0;
  border: none; border-radius: 999px;
  background: rgb(65, 118, 230);
  color: #ffffff;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.side-session-footer .ss-send:hover { filter: brightness(1.07); }
.side-session-footer .ss-send:disabled { opacity: .45; cursor: default; }
`

    return module.exports
  }
})
