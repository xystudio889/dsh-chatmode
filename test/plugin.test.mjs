/**
 * Offline checks for the dsh-chatmode runtime plugin. These exercise the
 * plugin's own logic against a fake Cordis context; the live profile check is
 * done after installation.
 *
 * Run with: node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const SKILLS = [
  {
    name: 'demo-skill',
    description: 'A demo skill that explains things.',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'filesystem',
    content: '# Demo\nFollow these instructions.',
  },
  {
    name: 'user-only-skill',
    description: 'Only a human may invoke this.',
    invocation: { modelInvocable: false, userInvocable: true },
    source: 'project-dsh',
    provider: 'filesystem',
    content: 'user-only body',
  },
]

const FILES = {
  'notes.md': { type: 'file', text: '# Notes\nhello from the notes file.' },
  'docs/my note.md': { type: 'file', text: 'quoted path content' },
  'docs/': { type: 'directory' },
  'pic.png': { type: 'file', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]) },
}

function bytesOf(entry) {
  if (entry.bytes !== undefined) return entry.bytes
  return new TextEncoder().encode(entry.text ?? '')
}

function makeFs(files = FILES) {
  return {
    async resolve(path) {
      return { targetKey: path, displayPath: path }
    },
    async stat(target) {
      const entry = files[target.displayPath]
      if (entry === undefined) return undefined
      return {
        version: 'v1',
        type: entry.type ?? 'file',
        size: bytesOf(entry).byteLength,
      }
    },
    async readBytes(target, _signal, maxBytes) {
      const entry = files[target.displayPath]
      const data = bytesOf(entry)
      if (data.byteLength > maxBytes) {
        const error = new Error('too large')
        error.code = 'FS_TOO_LARGE'
        throw error
      }
      return data
    },
    async readByteRange(target, range) {
      return bytesOf(files[target.displayPath]).slice(range.offset, range.offset + range.length)
    },
    processPath(target) {
      return target.displayPath
    },
  }
}

function makeAttachments() {
  const saved = []
  return {
    saved,
    imageLimits: {
      maxImageBytes: 1024,
      maxMessageImageBytes: 2048,
      maxImagesPerMessage: 2,
    },
    async saveImage({ data, mediaType, name }) {
      const ref = {
        attachmentId: `a${saved.length + 1}`,
        mediaType,
        bytes: data.byteLength,
        width: 1,
        height: 1,
        name,
      }
      saved.push(ref)
      return ref
    },
  }
}

function makeContext({
  globalTools = [{ name: 'read' }, { name: 'write' }, { name: 'web_search' }, { name: 'web_fetch' }],
  files = FILES,
  fs = true,
  attachments = makeAttachments(),
  llm = { async resolveModelInfo(_provider, model) {
    return { inputModalities: model === 'vision-model' ? ['text', 'image'] : ['text'] }
  } },
} = {}) {
  const listeners = new Map()
  const warnings = []
  const restricted = []
  const registeredTools = []
  const injected = []
  const sections = []
  const commands = []
  const suppressed = []
  let registeredProjection
  let projectionState = { enabled: true, running: null }

  const tools = {
    schemas: () => globalTools,
    restrict(filter) {
      restricted.push(filter)
      return () => {}
    },
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
    // A resolved step set shaped like the shipped `ResolvedToolSet`: only the
    // step's own agent scope sees the admitted tools.
    async resolve(context) {
      const visible = new Map(globalTools.map((tool) => [tool.name, tool]))
      return {
        dispose: () => {},
        view: (scope) => (scope === context.agent ? visible : new Map()),
      }
    },
  }

  const ctx = {
    tools,
    skills: {
      async snapshot() {
        return { skills: SKILLS.map((skill) => ({ ...skill })), complete: true }
      },
      async get(name) {
        const skill = SKILLS.find((candidate) => candidate.name === name)
        return skill === undefined ? undefined : { ...skill }
      },
    },
    workingDirectory: {
      async ensure() {
        return 'C:/workspace'
      },
    },
    sessionProjections: {
      async register(definition) {
        registeredProjection = definition
        return { stateOf: () => projectionState, readerFor: () => () => projectionState, dispose: async () => {} }
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      suppressRuntimeContext() {
        suppressed.push(true)
        return () => {}
      },
      getSectionOrder(name) {
        return name === 'DEPLOYMENT_PERSONA_PREFIX' ? 0 : -1
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    logger: {
      warn: (message) => warnings.push(message),
      info: () => {},
    },
    get(name) {
      return ctx[name]
    },
    inject(dependencies, callback) {
      injected.push([...dependencies])
      if (dependencies.every((dependency) => ctx[dependency] !== undefined)) {
        const disposer = callback(ctx)
        return typeof disposer === 'function' ? disposer : () => {}
      }
      return () => {}
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(create) {
      const disposer = create()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }

  if (fs) ctx.fs = makeFs(files)
  ctx.attachments = attachments
  ctx.llm = llm

  const create = () => apply(ctx)
  return {
    ctx,
    create,
    listeners,
    warnings,
    restricted,
    registeredTools,
    injected,
    attachments,
    sections,
    commands,
    suppressed,
    /** The projection this plugin registered. */
    projection: () => registeredProjection,
    /** Force the projection's folded state for the gate and persona reads. */
    setSearchState(state) {
      projectionState = state
    },
  }
}

function userMessage(text, source = { kind: 'user' }) {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

function makeAgent(events = []) {
  return {
    id: 'session-1',
    session: {
      seq: events.length,
      eventAt: (index) => events[index],
      surface: { nodes: new Set(events.map((_, index) => index)) },
    },
  }
}

async function preStep(listeners, agent, messages, decision = { kind: 'enter', messages }, modelSelection = { provider: 'deepseek', model: 'text-model' }) {
  return listeners.get('agent/pre-step')[0](
    { agent, messages, modelSelection, signal: new AbortController().signal, step: 1, turn: 1 },
    async () => decision,
  )
}

const CATALOG_PUBLISHED = [{ type: 'user/message', data: { source: { kind: 'skill-catalog' } } }]

// 1. The mode registers no tool and denies every inherited tool except web.
{
  const { create, restricted, registeredTools } = makeContext()
  await create()
  assert.deepEqual(registeredTools, [], 'chat mode must not register a tool')
  assert.deepEqual(restricted, [{ deny: ['read', 'write'] }], 'only non-web inherited tools are denied')
}

// 2. Without non-web inherited tools no restriction is registered at all.
{
  const { create, restricted } = makeContext({ globalTools: [{ name: 'web_search' }, { name: 'web_fetch' }] })
  await create()
  assert.deepEqual(restricted, [])
}

// 3. First eligible step gets the durable skill catalog, model-invocable only.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent()
  const message = userMessage('hello')
  const decision = await preStep(listeners, agent, [message])
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  const catalog = decision.messages[1]
  assert.equal(catalog.role, 'user')
  assert.equal(catalog.source.kind, 'skill-catalog')
  const text = catalog.content[0].text
  assert.match(text, /<available_skills>/)
  assert.match(text, /demo-skill/)
  assert.doesNotMatch(text, /user-only-skill/, 'non-model-invocable skills stay out of the catalog')
  assert.match(text, /tool list is the only authority/)
  assert.match(text, /files .* @ .* read into the conversation/i)
}

// 4. A session that already published the catalog does not publish it again.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent([...CATALOG_PUBLISHED, { type: 'assistant/message', data: {} }])
  const message = userMessage('hello again')
  const decision = await preStep(listeners, agent, [message])
  assert.deepEqual(decision.messages, [message])
}

// 5. `/name` injects the user-invocable skill body into the same step.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const message = userMessage('/demo-skill explain the demo')
  const decision = await preStep(listeners, agent, [message])
  assert.equal(decision.messages.length, 2)
  const injection = decision.messages[1]
  assert.equal(injection.source.kind, 'skill-invocation')
  assert.equal(injection.source.name, 'demo-skill')
  const text = injection.content[0].text
  assert.match(text, /<skill_content name="demo-skill">/)
  assert.match(text, /<skill_instructions>\n# Demo\nFollow these instructions.\n<\/skill_instructions>/)
}

// 6. An unknown /name stays ordinary prose; a rejected step is left untouched.
{
  const { create, listeners, warnings } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const message = userMessage('/not-a-real-skill hi')
  const decision = await preStep(listeners, agent, [message])
  assert.deepEqual(decision.messages, [message])
  assert.deepEqual(warnings, [])
}

{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent()
  const message = userMessage('hello')
  const rejected = { kind: 'reject' }
  const decision = await preStep(listeners, agent, [message], rejected)
  assert.equal(decision, rejected)
}

// 7. `@file` is read into the conversation without a filesystem tool.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const message = userMessage('please summarize @notes.md')
  const decision = await preStep(listeners, agent, [message])
  assert.equal(decision.messages.length, 2)
  const injected = decision.messages[1]
  assert.equal(injected.source.kind, 'file-reference')
  const text = injected.content.map((block) => block.text ?? '').join('\n')
  assert.match(text, /The user referenced the following files with @/)
  assert.match(text, /<file_reference path="notes\.md" type="text"/)
  assert.match(text, /hello from the notes file\./)
}

// 8. Quoted mentions keep spaces and resolve as one path.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const message = userMessage('read @"docs/my note.md"')
  const decision = await preStep(listeners, agent, [message])
  const text = decision.messages[1].content.map((block) => block.text ?? '').join('\n')
  assert.match(text, /path="docs\/my note\.md"/)
  assert.match(text, /quoted path content/)
}

// 9. An invalid `@` reference fails the turn and injects no file declaration.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const message = userMessage('read @missing.md')
  await assert.rejects(
    () => preStep(listeners, agent, [message]),
    (error) => error.message === 'cannot find file.',
  )
}

// 10. A directory mention is not a file and fails the same way.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  await assert.rejects(
    () => preStep(listeners, agent, [userMessage('open @docs/')]),
    (error) => error.message === 'cannot find file.',
  )
}

// 11. Structured mentions (session or URL) are not files and stay untouched.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const message = userMessage('continue @[demo](dsh-session:abc) and @[site](https://example.com)')
  const decision = await preStep(listeners, agent, [message])
  assert.deepEqual(decision.messages, [message])
}

// 12. A skill-catalog failure does not discard the file context.
{
  const { create, listeners, ctx } = makeContext()
  await create()
  ctx.skills.snapshot = async () => {
    throw new Error('snapshot unavailable')
  }
  const agent = makeAgent()
  const decision = await preStep(listeners, agent, [userMessage('please summarize @notes.md')])
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[1].source.kind, 'file-reference')
  assert.match(decision.messages[1].content.map((block) => block.text ?? '').join('\n'), /hello from the notes file/)
}

// 13. File access injects the fs service explicitly.
{
  const { create, injected } = makeContext()
  await create()
  assert.ok(
    injected.some((dependencies) => dependencies.includes('fs')),
    'the file bridge must declare fs as an injected service',
  )
}

// 14. A throwing fs property is still reached through the unchecked reflector.
{
  const { create, listeners, ctx } = makeContext()
  await create()
  const fs = ctx.fs
  Object.defineProperty(ctx, 'fs', {
    configurable: true,
    get() {
      throw new Error('cannot get property "fs" without inject')
    },
  })
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'fs' ? fs : originalGet(name))
  const decision = await preStep(listeners, makeAgent(CATALOG_PUBLISHED), [userMessage('read @notes.md')])
  assert.equal(decision.messages[1].source.kind, 'file-reference')
  assert.match(decision.messages[1].content.map((block) => block.text ?? '').join('\n'), /hello from the notes file/)
}

// 15. A text-only route gets a note instead of an unreadable image block.
{
  const { create, listeners, attachments } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const decision = await preStep(listeners, agent, [userMessage('what is in @pic.png')])
  const injected = decision.messages[1]
  assert.equal(injected.content.some((block) => block.type === 'image'), false)
  assert.match(injected.content.map((block) => block.text ?? '').join('\n'), /does not accept image input/)
  assert.equal(attachments.saved.length, 0)
}

// 16. An image-capable route gets the declaration and the image block.
{
  const { create, listeners, attachments } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const decision = await preStep(
    listeners, agent, [userMessage('what is in @pic.png')], undefined,
    { provider: 'deepseek', model: 'vision-model' },
  )
  const injected = decision.messages[1]
  const image = injected.content.find((block) => block.type === 'image')
  assert.ok(image, 'the image block is injected on an image-capable route')
  assert.match(injected.content.map((block) => block.text ?? '').join('\n'), /type="image" media-type="image\/png"/)
  assert.equal(attachments.saved.length, 1)
}

// 17. Synthetic messages and non-user sources never become file references.
{
  const { create, listeners } = makeContext()
  await create()
  const agent = makeAgent(CATALOG_PUBLISHED)
  const synthetic = userMessage('@missing.md', { kind: 'skill-catalog' })
  const decision = await preStep(listeners, agent, [synthetic])
  assert.deepEqual(decision.messages, [synthetic])
}

// 18. The switch folds its own command's log records, so replay keeps the value.
{
  const { create, projection } = makeContext()
  await create()
  const definition = projection()
  assert.equal(definition.key, 'smartsearch')
  assert.equal(definition.stateVersion, 1)
  const initial = definition.init()
  assert.deepEqual(initial, { enabled: true, running: null })

  // An unrelated event keeps the exact state reference.
  assert.equal(definition.apply(initial, { type: 'assistant/message', data: {} }), initial)
  assert.equal(definition.apply(initial, { type: 'command/run', data: { name: 'plan', args: 'off' } }), initial)

  const requested = definition.apply(initial, {
    type: 'command/run',
    data: { commandId: 'c1', name: 'smartsearch', args: ' off' },
  })
  assert.deepEqual(requested, { enabled: true, running: { commandId: 'c1', wanted: false } })
  const settled = definition.apply(requested, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } })
  assert.deepEqual(settled, { enabled: false, running: null })
  assert.deepEqual(definition.wire.view(settled), { enabled: false })

  // A failure leaves the switch where it was.
  const failed = definition.apply(requested, { type: 'command/done', data: { commandId: 'c1', kind: 'error' } })
  assert.deepEqual(failed, { enabled: true, running: null })
  // A stale settlement for another command changes nothing.
  const stale = { enabled: true, running: { commandId: 'c2', wanted: false } }
  assert.equal(
    definition.apply(stale, { type: 'command/done', data: { commandId: 'c1', kind: 'success' } }),
    stale,
  )
  // Both schemas normalize a damaged checkpoint instead of throwing.
  assert.deepEqual(definition.stateSchema.parse({ enabled: 'nope' }), { enabled: true, running: null })
  assert.deepEqual(definition.stateSchema.parse(null), { enabled: true, running: null })
  assert.deepEqual(definition.wire.viewSchema.parse(undefined), { enabled: true })
}

// 19. `/smartsearch` records its argument and only narrates the outcome.
{
  const { create, commands } = makeContext()
  await create()
  assert.equal(commands.length, 1)
  const definition = commands[0]
  assert.equal(definition.name, 'smartsearch')
  assert.notEqual(definition.recordInput, false, 'the projection reads the logged argument')
  assert.match(definition.description, /search/)
  assert.deepEqual(definition.handler({ rawInput: '' }), { kind: 'error', text: 'Usage: /smartsearch on|off' })
  assert.deepEqual(definition.handler({ rawInput: ' maybe' }), { kind: 'error', text: 'Usage: /smartsearch on|off' })
  assert.equal(definition.handler({ rawInput: ' off' }).kind, 'success')
  assert.match(definition.handler({ rawInput: ' off' }).text, /Smart search off/)
  assert.match(definition.handler({ rawInput: ' ON' }).text, /Smart search on/)
  assert.match(definition.handler({ rawInput: ' 关闭' }).text, /Smart search off/)
  assert.match(definition.handler({ rawInput: '开启' }).text, /Smart search on/)
}

// 20. An off switch resolves a step set without the web tools; an on one passes through.
{
  const { create, ctx, setSearchState } = makeContext()
  await create()
  const agent = makeAgent()
  const enabled = await ctx.tools.resolve({ agent, signal: new AbortController().signal })
  assert.deepEqual([...enabled.view(agent).keys()].sort(), ['read', 'web_fetch', 'web_search', 'write'])
  assert.equal(enabled.view('another-agent').size, 0, 'a foreign scope still sees nothing')

  setSearchState({ enabled: false, running: null })
  const disabled = await ctx.tools.resolve({ agent, signal: new AbortController().signal })
  assert.deepEqual([...disabled.view(agent).keys()].sort(), ['read', 'write'])
  assert.equal(disabled.view(agent).has('web_search'), false)
  assert.equal(disabled.view(agent).has('web_fetch'), false)

  // The in-flight selection wins, so the switch flips from the next step.
  setSearchState({ enabled: true, running: { commandId: 'c9', wanted: false } })
  const pending = await ctx.tools.resolve({ agent, signal: new AbortController().signal })
  assert.equal(pending.view(agent).has('web_search'), false)
}

// 21. The persona is the one complete prompt section and follows the switch.
{
  const { create, ctx, sections, suppressed, setSearchState } = makeContext()
  await create()
  assert.equal(sections.length, 1)
  const [section] = sections
  assert.equal(section.name, 'deployment:persona-prefix')
  assert.equal(section.complete, true)
  assert.equal(section.order, 0)
  assert.equal(suppressed.length, 1, 'the runtime-context snapshot stays out of the prompt')

  const agent = makeAgent()
  const enabledText = section.text({ agent })
  assert.match(enabledText, /You are a helpful assistant in Chat mode/)
  assert.match(enabledText, /Smart search is on/)
  assert.match(enabledText, /web_search and web_fetch/)
  assert.match(enabledText, /cite the relevant URLs/)
  assert.doesNotMatch(enabledText, /\{\{/, 'the prompt carries no unresolvable variable')

  setSearchState({ enabled: false, running: null })
  const disabledText = section.text({ agent })
  assert.match(disabledText, /Smart search is off/)
  assert.match(disabledText, /no tools at all/)
  assert.doesNotMatch(disabledText, /web_search and web_fetch are your only tools/)

  // No agent (a scope-free assembly) keeps the enabled wording.
  assert.match(section.text({}), /Smart search is on/)
}

console.log('dsh-chatmode plugin tests passed')

