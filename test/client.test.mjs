/**
 * Offline checks for the dsh-chatmode browser half. The bundle is evaluated in
 * a small `vm` context with a fake module loader, locale service, slot service,
 * Remote namespaces, and a minimal React stand-in, so the response rewrite, the
 * composer switch, and their cleanup are exercised without a browser.
 *
 * Run with: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** A minimal React stand-in: elements, plus hook calls that never re-render. */
function makeReact() {
  const Fragment = Symbol('Fragment')
  const settle = () => {}
  return {
    Fragment,
    createElement(type, props, ...children) {
      // React drops nullish and boolean children; mirror that so assertions can
      // count real nodes.
      const kept = children
        .flat()
        .filter(child => child !== null && child !== undefined && child !== false && child !== true)
      return { type, props: props ?? {}, children: kept }
    },
    useState(initial) {
      return [initial, settle]
    },
    useRef(value) {
      return { current: value }
    },
    useEffect() {},
  }
}

/** Build one isolated client plugin instance plus the fakes it talks to. */
function loadClient(active = 'zh') {
  let loaded
  const window = {
    __ModuleLoader__: {
      load(module) {
        loaded = module
      },
    },
  }
  const React = makeReact()
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected client import: ${name}`)
  }
  vm.runInNewContext(source, { window, console }, { filename: 'client.js' })
  assert.equal(loaded.id, 'dsh-chatmode', 'the bundle id must match the package name')

  const dictionaries = new Map()
  const cleanups = []
  const locale = {
    register(namespace, values) {
      dictionaries.set(namespace, values)
      return () => dictionaries.delete(namespace)
    },
    bind(namespace) {
      return (key) => {
        const values = dictionaries.get(namespace)
        return values?.[active]?.[key] ?? values?.en?.[key] ?? key
      }
    },
  }
  const executed = []
  const remote = {
    agentPresets: makeNamespace(),
    commands: {
      async execute(sessionId, line, attachments) {
        executed.push({ sessionId, line, attachments })
        return { ok: true, value: { commandId: 'c1', result: { kind: 'success' } } }
      },
    },
  }
  const slots = []
  const ctx = {
    locale,
    remote,
    slots: {
      inject(name, callback) {
        cleanups.push(callback())
        return () => {}
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
    effect(create) {
      const cleanup = create()
      const disposer = typeof cleanup === 'function' ? cleanup : () => {}
      cleanups.push(disposer)
      return disposer
    },
  }
  const plugin = loaded.factory(require)
  assert.equal(plugin.inject.join(','), 'locale,slots,remote.agentPresets,remote.commands')
  const originalList = Object.getOwnPropertyDescriptor(ctx.remote.agentPresets, 'list')
  plugin.apply(ctx)
  return {
    namespace: ctx.remote.agentPresets,
    remote,
    slots,
    executed,
    dictionaries,
    originalList,
    setActive(value) {
      active = value
    },
    setCommandResult(result) {
      remote.commands.execute = async (sessionId, line, attachments) => {
        executed.push({ sessionId, line, attachments })
        return result
      }
    },
    dispose() {
      for (const cleanup of cleanups.reverse()) cleanup()
    },
  }
}

/** A namespace shaped like the gateway's RemoteNamespaceService methods. */
function makeNamespace() {
  const rows = {
    list: {
      ok: true,
      value: {
        presets: [
          { id: 'standard', isDefault: true, name: 'Standard', description: 'Standard description' },
          { id: 'chatmode', isDefault: false, name: '聊天模式 / Chat mode', description: 'Bilingual fallback' },
        ],
      },
    },
    read: {
      ok: true,
      value: {
        agentPreset: 'chatmode',
        content: 'plugins:\n  - name: persona\n',
        name: '聊天模式 / Chat mode',
        description: 'Bilingual fallback',
      },
    },
  }
  const namespace = {}
  for (const method of ['list', 'read']) {
    Object.defineProperty(namespace, method, {
      configurable: true,
      enumerable: true,
      get() {
        return async () => structuredClone(rows[method])
      },
    })
  }
  return namespace
}

// 1. Chinese and English dictionaries win over the published bilingual copy.
{
  const client = loadClient('zh')
  const listed = await client.namespace.list()
  const chatmode = listed.value.presets.find((row) => row.id === 'chatmode')
  const standard = listed.value.presets.find((row) => row.id === 'standard')
  assert.equal(chatmode.name, '聊天模式')
  assert.match(chatmode.description, /联网搜索/)
  assert.match(chatmode.description, /智能搜索/)
  assert.equal(standard.name, 'Standard', 'other presets keep their published copy')
  assert.equal(standard.description, 'Standard description')

  client.setActive('en')
  const english = await client.namespace.list()
  assert.equal(english.value.presets.find((row) => row.id === 'chatmode').name, 'Chat mode')

  const read = await client.namespace.read()
  assert.equal(read.value.name, 'Chat mode')
  assert.match(read.value.description, /web search/)
  client.dispose()
}

// 2. The read response only rewrites the Chat mode declaration.
{
  const client = loadClient('zh')
  const other = await client.namespace.read()
  assert.equal(other.value.name, '聊天模式')
  assert.equal(other.value.agentPreset, 'chatmode')
  client.dispose()
}

// 3. Cleanup restores the namespace accessors instead of deleting the methods.
{
  const client = loadClient('zh')
  assert.equal(typeof client.originalList.get, 'function')
  client.dispose()
  const after = Object.getOwnPropertyDescriptor(client.namespace, 'list')
  assert.equal(typeof after.get, 'function', 'the gateway getter is restored')
  assert.equal(after.get, client.originalList.get, 'the original getter is restored')
  assert.equal(Object.hasOwn(client.namespace, 'list'), true)
  const listed = await client.namespace.list()
  assert.equal(listed.value.presets.find((row) => row.id === 'chatmode').name, '聊天模式 / Chat mode')
}

/** The switch registration and its bound dictionary lookup. */
function switchSeat(client, active = 'zh') {
  const found = client.slots.find((slot) => slot.options.name === 'conversation.input.left')
  assert.ok(found, 'the switch occupies the composer left tool row')
  const dictionary = client.dictionaries.get('dsh-chatmode')?.[active]
  assert.ok(dictionary, `the ${active} dictionary is registered`)
  const t = (key) => dictionary[key] ?? key
  return { ...found, t, dictionary }
}

// 4. The switch registers one composer cell with its own locale bindings.
{
  const client = loadClient('zh')
  const seat = switchSeat(client)
  assert.equal(seat.options.id, 'dsh-chatmode-smartsearch')
  assert.equal(seat.options.locale, 'dsh-chatmode')
  assert.equal(typeof seat.options.inject, 'function')
  assert.equal(typeof seat.options.order, 'number')
  client.dispose()
}

// 5. The injected face runs the same command a human would type.
{
  const client = loadClient('zh')
  const seat = switchSeat(client)
  const face = seat.options.inject('session-9')
  assert.equal(await face.execute('off'), null)
  assert.equal(client.executed[0].sessionId, 'session-9')
  assert.equal(client.executed[0].line, '/smartsearch off')
  assert.equal(client.executed[0].attachments.length, 0)
  assert.equal(await face.execute('on'), null)
  assert.equal(client.executed[1].line, '/smartsearch on')

  client.setCommandResult({ ok: false, error: { message: 'no command registry', code: 'UNKNOWN' } })
  assert.equal(await face.execute('off'), 'no command registry')
  client.setCommandResult({ ok: true, value: undefined })
  assert.equal(await face.execute('on'), 'unknown command: /smartsearch on')
  client.dispose()
}

// 6. The control renders only for a Chat mode session with a folded state.
{
  const client = loadClient('zh')
  const seat = switchSeat(client)
  const face = seat.options.inject('session-9')
  const projection = (values) => (key) => values[key]

  assert.equal(
    seat.component({
      useProjection: projection({ agentPreset: 'standard', smartsearch: { enabled: true } }),
      t: seat.t, ...face,
    }),
    null,
    'another preset keeps its composer untouched',
  )
  assert.equal(
    seat.component({ useProjection: projection({ agentPreset: 'chatmode' }), t: seat.t, ...face }),
    null,
    'an unreadable switch renders nothing instead of guessing',
  )

  const control = seat.component({
    useProjection: projection({ agentPreset: 'chatmode', smartsearch: { enabled: true } }),
    t: seat.t, ...face,
  })
  assert.ok(control, 'a Chat mode session gets the control')
  const [style, wrap] = control.children
  assert.equal(style.type, 'style', 'the control carries its own stylesheet')
  assert.match(style.children[0], /\.dcm-smartsearch__button/)
  assert.match(style.children[0], /--dsw-alias-label-primary/, 'the styles use host theme tokens')
  const button = wrap.children[0]
  assert.equal(button.type, 'button')
  assert.equal(button.props.role, 'switch')
  assert.equal(button.props['aria-checked'], true)
  assert.match(button.props['aria-label'], /智能搜索/)
  assert.match(button.props.className, /dcm-smartsearch__button--on/)
  assert.deepEqual(button.children.map((child) => child.type), ['span', 'span', 'span'])
  assert.deepEqual(button.children.map((child) => child.children[0]), [
    button.children[0].children[0],
    '智能搜索',
    '开',
  ])
  assert.equal(wrap.children.length, 1, 'no failure line before a click')
}

// 7. Clicking the enabled control asks for off; a disabled state asks for on.
{
  const client = loadClient('zh')
  const seat = switchSeat(client)
  const face = seat.options.inject('session-9')
  const projection = (values) => (key) => values[key]

  const enabledControl = seat.component({
    useProjection: projection({ agentPreset: 'chatmode', smartsearch: { enabled: true } }),
    t: seat.t, ...face,
  })
  enabledControl.children[1].children[0].props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(client.executed.at(-1).line, '/smartsearch off')
  assert.equal(enabledControl.children[1].children[0].props.disabled, false, 'the control starts enabled')

  const disabledControl = seat.component({
    useProjection: projection({ agentPreset: 'chatmode', smartsearch: { enabled: false } }),
    t: seat.t, ...face,
  })
  const disabledButton = disabledControl.children[1].children[0]
  assert.equal(disabledButton.props['aria-checked'], false)
  assert.match(disabledButton.props['aria-label'], /关/)
  assert.doesNotMatch(disabledButton.props.className, /--on/)
  disabledButton.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(client.executed.at(-1).line, '/smartsearch on')
  client.dispose()
}

console.log('dsh-chatmode client tests passed')
