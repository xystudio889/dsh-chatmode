/**
 * dsh-chatmode — browser half.
 *
 * Two contributions, both small:
 *
 * 1. The shipped mode picker localizes only the four built-in presets; a
 *    user-authored declaration is shown with the single `name`/`description`
 *    string the Host published. Chat mode therefore rewrites the
 *    `agentPresets/list` (and `read`) responses for its own id with copy from
 *    the active locale. Every surface that renders the roster — the
 *    new-session chip, the session header label, and the Settings section —
 *    reads through those responses, so they all switch together. The patch is
 *    installed in the `remote.agentPresets` service lifetime and removed with
 *    this plugin; it never rewrites stored preset metadata.
 * 2. The composer's left tool row carries the Smart search switch. It reads the
 *    Host's `smartsearch` Session projection (the folded `/smartsearch` log
 *    records, so it survives reload and follows a fork), and toggles it by
 *    executing the same command a human would type. The switch is shown only
 *    for a Chat mode session; other presets keep their tool row untouched.
 */

const PRESET_ID = 'chatmode'
const NAMESPACE = 'dsh-chatmode'
/** The composer seat the switch occupies, and its cell key. */
const COMPOSER_SLOT = 'conversation.input.left'
const SEARCH_SLOT_ID = 'dsh-chatmode-smartsearch'
/** The Host projection this switch reads, and the command that changes it. */
const SEARCH_PROJECTION = 'smartsearch'
const SEARCH_COMMAND = 'smartsearch'
/** The projection that names the session's preset. */
const PRESET_PROJECTION = 'agentPreset'

const DICTIONARIES = {
  zh: {
    name: '聊天模式',
    description: '保留 Skill，可联网搜索与抓取（可用「智能搜索」开关关闭），自动读取 @ 引用的文件与图片。',
    'search.label': '智能搜索',
    'search.on': '开',
    'search.off': '关',
    'search.onTitle': '智能搜索已开启：可联网搜索与抓取。点击关闭，本轮之后不再提供搜索工具。',
    'search.offTitle': '智能搜索已关闭：本轮之后没有搜索与抓取工具。点击开启。',
    'search.failed': '切换失败',
  },
  en: {
    name: 'Chat mode',
    description: 'Keeps Skills, adds web search and fetch behind a Smart search switch, and reads @-referenced files and images automatically.',
    'search.label': 'Smart search',
    'search.on': 'On',
    'search.off': 'Off',
    'search.onTitle': 'Smart search is on: web search and fetch are available. Click to turn them off from the next turn.',
    'search.offTitle': 'Smart search is off: this session has no web tools from the next turn. Click to turn them on.',
    'search.failed': 'Could not switch',
  },
}

/** The switch's own stylesheet, rendered with the control it belongs to. */
const STYLES = `
.dcm-smartsearch { display: inline-flex; align-items: center; gap: 6px; }
.dcm-smartsearch__button {
  display: inline-flex; align-items: center; gap: 4px;
  height: 28px; min-width: 34px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 20px;
  cursor: pointer;
}
.dcm-smartsearch__button--on {
  border-color: transparent;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
@media (hover: hover) {
  .dcm-smartsearch__button:hover:not(:disabled) {
    background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-primary);
  }
}
.dcm-smartsearch__button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary));
  outline-offset: 2px;
}
.dcm-smartsearch__button:disabled { opacity: 0.6; cursor: default; }
.dcm-smartsearch__glyph { display: inline-flex; flex: 0 0 auto; width: 14px; height: 14px; }
.dcm-smartsearch__label { white-space: nowrap; }
.dcm-smartsearch__state { font-size: 12px; opacity: 0.85; }
.dcm-smartsearch__error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
`

window.__ModuleLoader__.load({
  id: 'dsh-chatmode',
  factory(require) {
    const React = require('react')

    /**
     * Replace one roster row's display copy without touching its identity or
     * activation state.
     * @param {*} row - one Host roster row.
     * @param {(key: string) => string} t - bound Chat mode dictionary.
     * @returns {*} the localized row, or the original row for another preset.
     */
    function localizeRow(row, t) {
      if (row === null || typeof row !== 'object' || row.id !== PRESET_ID) return row
      return { ...row, name: t('name'), description: t('description') }
    }

    /**
     * Localize the roster read response.
     * @param {*} result - `RemoteResult<AgentPresetRoster>`.
     * @param {(key: string) => string} t - bound Chat mode dictionary.
     * @returns {*} the localized result.
     */
    function localizeList(result, t) {
      const presets = result?.ok === true ? result.value?.presets : undefined
      if (!Array.isArray(presets)) return result
      return {
        ...result,
        value: { ...result.value, presets: presets.map(row => localizeRow(row, t)) },
      }
    }

    /**
     * Localize the configuration-read response.
     * @param {*} result - `RemoteResult<AgentPresetDocument>`.
     * @param {(key: string) => string} t - bound Chat mode dictionary.
     * @returns {*} the localized result.
     */
    function localizeRead(result, t) {
      const value = result?.ok === true ? result.value : undefined
      if (value === null || typeof value !== 'object' || value.agentPreset !== PRESET_ID) return result
      return { ...result, value: { ...value, name: t('name'), description: t('description') } }
    }

    /**
     * Wrap one namespace method with a response mapper.
     * @param {*} namespace - the `remote.agentPresets` service.
     * @param {string} method - `list` or `read`.
     * @param {(result: *, t: (key: string) => string) => *} map - response mapper.
     * @param {() => (key: string) => string} translate - current dictionary lookup.
     * @returns {(() => void) | undefined} cleanup, or undefined when the method is absent.
     */
    function wrap(namespace, method, map, translate) {
      const original = namespace[method]
      if (typeof original !== 'function') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(namespace, method)
      const patched = (...args) => original.apply(namespace, args).then(result => map(result, translate()))
      try {
        Object.defineProperty(namespace, method, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: patched,
        })
      } catch (error) {
        // A future frozen namespace must not break the whole page; the chip
        // simply keeps the declaration's bilingual fallback.
        console.warn('dsh-chatmode: could not localize the agent-preset roster', error)
        return undefined
      }
      return () => {
        if (namespace[method] !== patched) return
        // The gateway installs each method as a configurable own getter, so
        // deleting the value would leave the namespace without that method.
        // Restore the exact descriptor instead.
        if (descriptor === undefined) Reflect.deleteProperty(namespace, method)
        else Object.defineProperty(namespace, method, descriptor)
      }
    }

    /**
     * The globe glyph marking the web tools this switch governs.
     * @param {*} h - `React.createElement`.
     * @returns {*} the inline SVG.
     */
    function globeGlyph(h) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        focusable: 'false', 'aria-hidden': 'true',
      },
        h('circle', { cx: 8, cy: 8, r: 6.2 }),
        h('ellipse', { cx: 8, cy: 8, rx: 2.8, ry: 6.2 }),
        h('path', { d: 'M2 8h12' }),
      )
    }

    /**
     * The composer's Smart search switch.
     *
     * State is the Host's folded projection, never local optimism: the click
     * executes `/smartsearch on|off`, and the projection settles the control
     * when the command's `command/done` record arrives.
     * @param {*} props - composer slot props plus the injected command runner.
     * @returns {*} the control, or null outside a Chat mode session.
     */
    function SmartSearchControl({ useProjection, t, execute }) {
      const h = React.createElement
      const preset = useProjection(PRESET_PROJECTION)
      const state = useProjection(SEARCH_PROJECTION)
      const [pending, setPending] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const alive = React.useRef(true)
      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      if (preset !== PRESET_ID || state === undefined) return null
      const enabled = state.enabled !== false
      const label = t('search.label')
      const onAir = () => {
        setPending(true)
        setFailure(null)
        execute(enabled ? 'off' : 'on').then(message => {
          if (!alive.current) return
          setPending(false)
          setFailure(message)
        })
      }

      return h(React.Fragment, null,
        h('style', { key: 'dsh-chatmode-smartsearch' }, STYLES),
        h('span', { key: 'control', className: 'dcm-smartsearch' },
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': `${label}: ${enabled ? t('search.on') : t('search.off')}`,
            title: enabled ? t('search.onTitle') : t('search.offTitle'),
            className: enabled ? 'dcm-smartsearch__button dcm-smartsearch__button--on' : 'dcm-smartsearch__button',
            disabled: pending,
            onClick: onAir,
          },
            h('span', { className: 'dcm-smartsearch__glyph' }, globeGlyph(h)),
            h('span', { className: 'dcm-smartsearch__label' }, label),
            h('span', { className: 'dcm-smartsearch__state' }, enabled ? t('search.on') : t('search.off')),
          ),
          failure === null ? null : h('span', {
            className: 'dcm-smartsearch__error', role: 'status', title: failure,
          }, t('search.failed')),
        ),
      )
    }

    return {
      inject: ['locale', 'slots', 'remote.agentPresets', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NAMESPACE, DICTIONARIES), 'dsh-chatmode: preset dictionaries')
        const t = ctx.locale.bind(NAMESPACE)
        ctx.effect(() => {
          const namespace = ctx.remote.agentPresets
          const cleanups = [
            wrap(namespace, 'list', localizeList, () => t),
            wrap(namespace, 'read', localizeRead, () => t),
          ].filter(cleanup => cleanup !== undefined)
          return () => {
            for (const cleanup of cleanups.reverse()) cleanup()
          }
        }, 'dsh-chatmode: localized mode picker')
        ctx.slots.inject(COMPOSER_SLOT, () => ctx.slots.register({
          name: COMPOSER_SLOT,
          id: SEARCH_SLOT_ID,
          order: 20,
          locale: NAMESPACE,
          inject: sessionId => ({
            /**
             * Run the switch's command for this session.
             * @param {'on' | 'off'} next - the requested state.
             * @returns {Promise<string | null>} null on an admitted execution,
             *   otherwise a user-visible failure line.
             */
            execute: async next => {
              const result = await ctx.remote.commands.execute(sessionId, `/${SEARCH_COMMAND} ${next}`, [])
              if (result?.ok !== true) {
                const message = result?.error?.message
                return typeof message === 'string' && message.length > 0 ? message : 'command rejected'
              }
              if (result.value === undefined) return `unknown command: /${SEARCH_COMMAND} ${next}`
              return null
            },
          }),
        }, SmartSearchControl))
      },
    }
  },
})
