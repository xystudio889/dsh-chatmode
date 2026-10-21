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

function makeContext({ globalTools = [{ name: 'read' }, { name: 'write' }] } = {}) {
  const listeners = new Map()
  const warnings = []
  const restricted = []
  const registeredTools = []

  const ctx = {
    tools: {
      schemas: () => globalTools,
      restrict(filter) {
        restricted.push(filter)
        return () => {}
      },
      register(definition) {
        registeredTools.push(definition)
        return () => {}
      },
    },
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
    logger: {
      warn: (message) => warnings.push(message),
      info: () => {},
    },
    inject(dependencies, callback) {
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

  const create = () => apply(ctx)
  return { ctx, create, listeners, warnings, restricted, registeredTools }
}

function userMessage(text) {
  return {
    id: `m-${Math.random()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
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

async function preStep(listeners, agent, messages, decision = { kind: 'enter', messages }) {
  return listeners.get('agent/pre-step')[0](
    { agent, messages, signal: new AbortController().signal, step: 1 },
    async () => decision,
  )
}

// 1. The mode registers no tool and denies every global tool for its scope.
{
  const { create, restricted, registeredTools } = makeContext()
  create()
  assert.deepEqual(registeredTools, [], 'chat mode must not register a tool')
  assert.deepEqual(restricted, [{ deny: ['read', 'write'] }], 'global tools must be denied')
}

// 2. First eligible step gets the durable skill catalog, model-invocable only.
{
  const { create, listeners } = makeContext()
  create()
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
  assert.match(text, /Chat mode, which has no tools/)
}

// 3. A session that already published the catalog does not publish it again.
{
  const { create, listeners } = makeContext()
  create()
  const events = [
    { type: 'user/message', data: { source: { kind: 'skill-catalog' } } },
    { type: 'assistant/message', data: {} },
  ]
  const agent = makeAgent(events)
  const message = userMessage('hello again')
  const decision = await preStep(listeners, agent, [message])
  assert.deepEqual(decision.messages, [message])
}

// 4. `/name` injects the user-invocable skill body into the same step.
{
  const { create, listeners } = makeContext()
  create()
  const events = [{ type: 'user/message', data: { source: { kind: 'skill-catalog' } } }]
  const agent = makeAgent(events)
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

// 5. An unknown /name stays ordinary prose; a rejected step is left untouched.
{
  const { create, listeners, warnings } = makeContext()
  create()
  const events = [{ type: 'user/message', data: { source: { kind: 'skill-catalog' } } }]
  const agent = makeAgent(events)
  const message = userMessage('/not-a-real-skill hi')
  const decision = await preStep(listeners, agent, [message])
  assert.deepEqual(decision.messages, [message])
  assert.deepEqual(warnings, [])
}

{
  const { create, listeners } = makeContext()
  create()
  const agent = makeAgent()
  const message = userMessage('hello')
  const rejected = { kind: 'reject' }
  const decision = await preStep(listeners, agent, [message], rejected)
  assert.equal(decision, rejected)
}

// 6. Without global tools no restriction is registered at all.
{
  const { create, restricted } = makeContext({ globalTools: [] })
  create()
  assert.deepEqual(restricted, [])
}

console.log('dsh-chatmode plugin tests passed')
