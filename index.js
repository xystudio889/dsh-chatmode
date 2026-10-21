/**
 * dsh-chatmode — runtime half of the "聊天模式 / Chat mode" agent preset.
 *
 * The mode mounts no tool plugin, so an agent composed under it never gets a
 * tool schema and the agent loop naturally stops after its first model step.
 * This plugin adds the two things the mode still promises:
 *
 * 1. Skills stay usable without a tool. A durable catalog of model-invocable
 *    skills is published once per session, and typing `/skill-name` in a user
 *    message injects that skill's full `<skill_content>` block into the same
 *    step. Nothing here registers a tool.
 * 2. No tool leaks in. Tools mounted globally by the Host (for example an
 *    Agent Teams or MCP row) are denied for this preset's scope, so the mode
 *    keeps "no tools" even in profiles that mount tools outside presets.
 *
 * Model-facing text keeps the same canonical shapes as the shipped
 * `dsh-tool-skill` / `dsh-skill` packages so the model sees familiar framing.
 *
 * @module dsh-chatmode
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-chatmode'
export const inject = []

/** Cap per catalog description, matching the shipped skill catalog default. */
const CATALOG_DESCRIPTION_MAX_LENGTH = 500
/** Durable message-source kind used for the published skill catalog. */
const CATALOG_SOURCE_KIND = 'skill-catalog'
const CATALOG_SOURCE_FORM = 'catalog'
/**
 * A whitespace-bounded `/name` token anywhere in direct user text. The shape is
 * the public skill-name grammar, so file paths and fractions never match.
 */
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * Mount both halves of the mode runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the preset-scoped plugin context.
 */
export function apply(ctx) {
  installToolRemoval(ctx)
  installSkillBridge(ctx)
}

// ---------------------------------------------------------------------------
// No tools at all
// ---------------------------------------------------------------------------

/**
 * Deny every globally mounted tool for this preset's scope. Preset-mounted
 * tools need no handling: this mode mounts none. The deny list is refreshed on
 * `tools/change` so a tool registered after the preset loaded is still hidden.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function installToolRemoval(ctx) {
  ctx.inject(['tools'], (host) => {
    let appliedKey
    let disposeRestriction
    let syncing = false

    const sync = () => {
      if (syncing) return
      syncing = true
      try {
        const names = [...new Set(host.tools.schemas().map((schema) => schema.name))].sort()
        const key = names.join('\u0000')
        if (key === appliedKey) return
        if (disposeRestriction !== undefined) {
          disposeRestriction()
          disposeRestriction = undefined
        }
        if (names.length > 0) disposeRestriction = host.tools.restrict({ deny: names })
        appliedKey = key
      } catch (error) {
        log(host, `could not hide global tools: ${describeError(error)}`)
      } finally {
        syncing = false
      }
    }

    host.on('tools/change', sync)
    host.effect(() => () => {
      if (disposeRestriction !== undefined) {
        disposeRestriction()
        disposeRestriction = undefined
      }
    }, 'chatmode: global tool restriction')
    sync()
  })
}

// ---------------------------------------------------------------------------
// Skills without a tool
// ---------------------------------------------------------------------------

/**
 * Publish the skill catalog once per session and inject user-invoked skill
 * bodies into the same step.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
function installSkillBridge(ctx) {
  ctx.inject(['skills', 'workingDirectory'], (host) => {
    host.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (signal?.aborted === true) return decision
      try {
        return await enrichStep(host, agent, messages, signal, decision)
      } catch (error) {
        // A chat-mode helper must never turn a normal turn into a failed turn.
        log(host, `skill bridge skipped: ${describeError(error)}`)
        return decision
      }
    })
  })
}

/**
 * Append the durable skill catalog (first eligible step only) and any invoked
 * skill instructions to the accepted step.
 * @param {*} host - injection context carrying `skills` and `workingDirectory`.
 * @param {*} agent - the step's agent.
 * @param {ReadonlyArray<*>} messages - the claimed user messages of this step.
 * @param {AbortSignal} signal - turn cancellation signal.
 * @param {{ kind: 'enter', messages: *[], startsRequestSeries?: true }} decision - the accepted decision.
 * @returns {Promise<*>} the possibly extended decision.
 */
async function enrichStep(host, agent, messages, signal, decision) {
  const extra = []
  let cwd
  const resolveCwd = async () => {
    if (cwd === undefined) cwd = await host.workingDirectory.ensure(agent, signal)
    return cwd
  }

  if (!hasPublishedCatalog(agent)) {
    const catalog = await buildCatalog(host, agent, signal, resolveCwd)
    if (catalog !== undefined) extra.push(catalog)
  }

  for (const skillName of invokedSkillNames(messages)) {
    const skill = await host.skills.get(skillName, {
      cwd: await resolveCwd(),
      signal,
      scope: agent,
    })
    if (signal?.aborted === true) return decision
    if (skill === undefined || !isUserInvocable(skill)) continue
    extra.push(createUserMessage({
      content: [{ type: 'text', text: renderSkillContent(skill) }],
      source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
    }))
  }

  if (extra.length === 0) return decision
  return { ...decision, messages: [...decision.messages, ...extra] }
}

/**
 * Render the one-time catalog message, or `undefined` when this session has no
 * model-invocable skill or the catalog could not be observed completely.
 * @param {*} host - injection context carrying `skills`.
 * @param {*} agent - the step's agent.
 * @param {AbortSignal} signal - turn cancellation signal.
 * @param {() => Promise<string>} resolveCwd - memoized working-directory lookup.
 * @returns {Promise<* | undefined>} the catalog message.
 */
async function buildCatalog(host, agent, signal, resolveCwd) {
  const snapshot = await host.skills.snapshot({ cwd: await resolveCwd(), signal, scope: agent })
  if (signal?.aborted === true || snapshot.complete !== true) return undefined
  const entries = snapshot.skills
    .filter(isModelInvocable)
    .map((skill) => ({
      name: skill.name,
      description: boundDescription(skill.description, CATALOG_DESCRIPTION_MAX_LENGTH),
    }))
  if (entries.length === 0) return undefined
  return createUserMessage({
    content: [{ type: 'text', text: renderCatalog(entries) }],
    source: { kind: CATALOG_SOURCE_KIND, form: CATALOG_SOURCE_FORM, entries },
  })
}

/**
 * Whether this session's durable log already carries a skill catalog message,
 * so a mode using one session across turns publishes it only once.
 * @param {*} agent - the step's agent.
 * @returns {boolean} whether a catalog message exists in the session history.
 */
function hasPublishedCatalog(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return false
  if (typeof session.seq !== 'number' || typeof session.eventAt !== 'function') return false
  for (let index = session.seq - 1; index >= 0; index -= 1) {
    const event = session.eventAt(index)
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind === CATALOG_SOURCE_KIND) return true
  }
  return false
}

/** Model-facing catalog prose. The framing mirrors the shipped skill catalog. */
function renderCatalog(entries) {
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    ...entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`),
    '</available_skills>',
    '',
    'This session is in Chat mode, which has no tools: you cannot load a skill yourself, and you must not claim to have loaded one.',
    'When the user invokes a skill with /<skill-name>, its full <skill_content> block is injected into the conversation; follow it.',
    'If a task clearly matches a listed skill, ask the user to invoke it as /<skill-name>.',
    '</system-reminder>',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Mirrored model-facing helpers (kept local: a profile bundle cannot import
// the Harness runtime packages it does not depend on)
// ---------------------------------------------------------------------------

/** @param {*} skill */
function isModelInvocable(skill) {
  return skill?.invocation?.modelInvocable === true
}

/** @param {*} skill */
function isUserInvocable(skill) {
  return skill?.invocation?.userInvocable === true
}

/**
 * Render one loaded skill exactly like the shipped `skill` tool result.
 * @param {*} skill - name, provider, optional resource base, and body.
 * @returns {string} the canonical `<skill_content>` block.
 */
function renderSkillContent(skill) {
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...renderResourceHint(skill),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

function renderResourceHint(skill) {
  const base = skill.resourceBase
  if (base === undefined) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  }
  if (base.kind === 'directory') {
    return [
      `Base directory for this skill: ${escapeText(base.path)}`,
      'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    ]
  }
  if (base.kind === 'url') {
    return [
      `Base URL for this skill: ${escapeText(base.url)}`,
      'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
    ]
  }
  return [
    `Resources for this skill: ${escapeText(base.description)}`,
    'Load referenced resources only as needed.',
  ]
}

/** @param {string} value */
function escapeAttr(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/** @param {string} value */
function escapeText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * `/name` gesture tokens from the claimed user messages, deduplicated in
 * first-seen order. Only direct user input can forge a gesture.
 * @param {ReadonlyArray<*>} messages - the step's claimed batch.
 * @returns {string[]} candidate skill names, unvalidated against the registry.
 */
function invokedSkillNames(messages) {
  const names = []
  for (const message of messages) {
    if (message?.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      for (const match of block.text.matchAll(SKILL_GESTURE)) {
        const skillName = match[2]
        if (skillName !== undefined && !names.includes(skillName)) names.push(skillName)
      }
    }
  }
  return names
}

/**
 * Create one identified, frozen user-role message, matching the Harness
 * `createUserMessage` contract without importing it.
 * @param {{ content: *[], source: * }} input - message content and producer source.
 * @returns {*} an immutable user message with a fresh identity.
 */
function createUserMessage(input) {
  return freezeJson(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

function freezeJson(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) freezeJson(item)
  }
  return value
}

/** @param {string} description */
function boundDescription(description, maxLength) {
  const normalized = String(description).replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

function log(host, message) {
  host.logger?.warn?.(`chatmode: ${message}`)
}

function describeError(error) {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '[unrenderable error]'
  }
}
