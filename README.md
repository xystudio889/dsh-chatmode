<p align="center">
  <img src="./icon.svg" width="96" alt="dsh-chatmode icon">
</p>

# dsh-chatmode - a web-like Chat mode with web access

[English](README.md) | [中文](README_zh.md)

[![npm](https://img.shields.io/npm/v/dsh-chatmode)](https://www.npmjs.com/package/dsh-chatmode)
[![stars](https://img.shields.io/github/stars/xystudio889/dsh-chatmode?style=flat)](https://github.com/xystudio889/dsh-chatmode)

A DeepSeek Harness extension that adds a **Chat mode** preset.

> **Author's note:** This project was developed entirely by DeepSeek Harness AI, and the code is fully AI-generated. If you find a bug, please report it.

> Keeps your Skills, adds web search and fetch, reads `@`-referenced files into context, and still returns one final answer per turn, close to a web chat.

## What this mode does

- **Web access only.** The preset mounts the shared `web_search` and `web_fetch` tools. It hides every other tool inherited from the Host (Agent Teams, MCP rows, shell, filesystem, todo, subagent, goal, plan, ...), so the model's toolset is exactly the two web tools.
- **Smart search switch.** The composer's left tool row carries a `智能搜索 / Smart search` switch, shown only in a Chat mode session. It is a real switch, not a prompt hint: while it is off, the step's resolved toolset contains neither `web_search` nor `web_fetch`, the model is told it has no tools, and those tools' own prompt guidance disappears with them. Turning it back on restores both from the next step. The switch is the folded `/smartsearch on|off` record, so typing the command by hand is the same act, and a reload, fork, or resume rebuilds the same value.
- **The agent loop runs.** Tool calls are real multi-step turns now: the model can search, fetch a cited page, search again, and then answer. The persona keeps the final reply to one clear answer, so the experience still reads like a website chat.
- **Skills still need an explicit declaration.**
  - Each session receives a one-time skill catalog message (skill name + description, for skills within the model's callable scope) telling the model it cannot load skills by itself.
  - When the user writes `/skill-name` in the input, that skill's full `<skill_content>` body is injected automatically in the same step. No `skill` tool is mounted, and the model must not pretend it loaded one.
- **`@` file and image injection.** An `@path` or `@"path with spaces"` mention in a direct user message is resolved from the session working directory and read into the conversation before the model request:
  - text files become a `<file_reference>` block (bounded, with truncation marked), so the model can answer without a filesystem tool;
  - images become a durable image attachment and an image content block when the selected model route accepts image input; otherwise a text note names the image and says it is not attached;
  - an `@` reference that does not resolve to a regular file fails the turn with `cannot find file.` and injects **no** file declaration at all;
  - session mentions such as `@[title](dsh-session:...)` are not files and are left untouched.
- **Localized mode-picker entry.** The Host publishes a single name/description string for a custom preset, so this package ships a small Client half that localizes its own roster row for the active UI language. The new-session chip, the session header label, and the Settings mode list all read the localized name; the declaration also carries a bilingual fallback for clients without the plugin.
- **Lean prompt with a truthful tool sentence.** The persona is one `complete: true` prompt section owned by this package, with runtime context suppressed, so the coding-agent, plan-mode, and tool-guidance sections stay out. Because it is assembled per step, its tool sentence follows the Smart search switch: "your only tools are web_search and web_fetch" while the switch is on, "you have no tools at all" while it is off.

## Installation

```powershell
# Install the local directory from the DSH Web UI "Plugins" page, or:
dsh plugin --profile <profile> add F:\code\dsh-plugin\dsh-chatmode
```

You can also install this directory with `plugin_manager` in any DSH profile; the bundle patch inserts the mode declaration automatically. The package now contains both halves:

- `index.js` — the preset runtime (tool policy, Smart search, persona, Skills bridge, `@` file context);
- `client.js` — the browser half that localizes the mode-picker entry and renders the switch.

After installing or updating, restart DeepSeek Harness: `index.js` is Host code, and only a restart loads the new plugin generation. Refresh the Web page afterwards (the Client half reloads with it).

Once installed, "聊天模式 / Chat mode" appears in **Settings → Modes** (or in the mode selector of a new session). Select it for a new session, or switch an empty session to it.

## Mode definition

`cordis.patch.yml` inserts one declaration line into `@deepseek-ai/dsh-agent-preset`:

| Field | Value |
|---|---|
| `id` | `chatmode` |
| Name | `聊天模式 / Chat mode` (Client half localizes it) |
| Description | See above |
| Composition | `@deepseek-ai/dsh-tool-web` (web tools) + `dsh-chatmode` (runtime code, persona, and the switch) |

There is deliberately no `@deepseek-ai/dsh-persona` row: that row contributes a static string, and this mode's prompt has to describe whether the web tools are available right now. A `complete: true` persona is the sole prompt section, so the dynamic text cannot be added beside it — this package registers it instead.

The runtime registers no web tools itself; `dsh-tool-web` supplies `web_search` / `web_fetch`, and the runtime code only filters inherited tools, resolves the Smart search gate, publishes the skill catalog / injects `/skill-name` bodies, and reads `@` references.

## Runtime implementation

`index.js` exports a standard Cordis plugin (`name` / `inject` / `apply`). `apply` is asynchronous because the switch's Session projection must be registered before anything publishes a reader for it; the preset mount awaits the plugin.

- `ctx.inject(['tools'])`: on load and on every `tools/change`, registers a `deny` list through `ctx.tools.restrict()` containing every inherited tool except `web_search` and `web_fetch`. The preset's own web registrations are exempt by the tools registry, so they stay visible; globally added tools are hidden on the next change.
- Smart search:
  - `ctx.sessionProjections.register()` folds a `smartsearch` unit out of `command/run` / `command/done`, and its `wire.view` exposes `{ enabled }` to the browser. It is the only authority — there is no plugin-owned state file.
  - `ctx.inject(['commands'])` registers `/smartsearch on|off` (English and Chinese arguments accepted). The handler validates and narrates; the value itself comes from the logged command.
  - `ctx.inject(['tools'])` wraps `tools.resolve()` on the raw service (`Symbol.for('cordis.original')`) so a step whose switch is off resolves a set without the two web tools. `resolve()` is the single input to the step's declared schemas, prompt guidance, dispatch, and program bindings, so filtering there hides the tools everywhere at once and leaves both registrations intact for the next step.
- `ctx.inject(['systemPrompt'])` registers the `deployment:persona-prefix` section with `complete: true` and suppresses runtime context. Its text function reads the switch per agent.
- `ctx.inject(['skills', 'workingDirectory', 'fs'])`: listens to `agent/pre-step` and, on accepted steps, appends:
  - one `file-reference` user message containing the preamble and every resolvable `@` file/image;
  - the one-time skill catalog message;
  - the skill body injected by `/skill-name`.
- File handling uses the Host `ctx.fs` service for resolution and bounded reads, `ctx.attachments.saveImage()` for images, and `ctx.llm.resolveModelInfo()` to gate image blocks on the route's declared image input. A missing or non-file target throws `Error('cannot find file.')` from `agent/pre-step`; DSH records that as the turn error, and no mention declaration reaches the model.
- All helper failures other than the explicit invalid-file error are swallowed and logged as warnings, so a chat-mode helper never turns a normal turn into a failed turn. The switch's own reader is deliberately fail-open: an unreadable projection keeps the web tools rather than silently removing them.

It imports no `@deepseek-ai/*` runtime packages; model-visible formats such as message construction and `<skill_content>` rendering are self-contained in this package and stay consistent with the official `dsh-tool-skill` / `dsh-skill`.

`client.js` wraps `remote.agentPresets.list` and `remote.agentPresets.read` while mounted and replaces the `chatmode` row's name/description with copy registered under the `dsh-chatmode` client locale namespace. The wrapper is removed on plugin disposal. The Host declaration remains a bilingual fallback.

It also registers the switch in the `conversation.input.left` composer seat. The control reads the `smartsearch` projection and the `agentPreset` projection (so another preset never sees it), and it toggles by executing `remote.commands.execute(sessionId, '/smartsearch off|on', [])` — the same command a human types — with any failure shown inline.

## Display metadata and language

- Bundle titles and descriptions on the plugin/settings page come from `locale/*.json` and switch with the software language: `locale/en.json` contains English, `locale/zh.json` contains Chinese.
- The mode picker gets custom-preset copy from `cordis.patch.yml` as a single Host string. That declaration now uses a bilingual fallback, and the Client half localizes the row for the active locale. A language change applies the next time a surface reloads the roster (for example, returning to the new-session screen or reopening Settings), without rewriting stored preset metadata.

## Verified

**Live (earlier revision, this desktop profile):** the mode appeared in the roster as `chatmode` with no `broken` diagnostics; within its scope the visible tool list held only `web_search` and `web_fetch`; the system prompt was one `complete: true` persona with optional runtime context disabled. The persona now comes from this package's runtime instead of a `dsh-persona` row, and the offline suites re-check the same tool-set and prompt properties on every change.

Logic is covered by the two offline suites. `test/plugin.test.mjs` runs the runtime against a fake Cordis context: no registered tool, inherited-tool restriction with the web exception, catalog published once, `/skill-name` injection, `@` text injection, quoted paths, image route gating, session-mention exclusion, the `cannot find file.` turn error, the switch's `command/run` / `command/done` fold (success, failure, stale settlement, damaged checkpoint), its command grammar, the resolved-set gate with an in-flight selection, and the persona sentence in both states. `test/client.test.mjs` evaluates the browser bundle in a `vm` sandbox with a fake module loader, locale, slot, and Remote services: roster localization, wrapper cleanup, the composer seat's registration, the `/smartsearch on|off` lines it sends, its failure mapping, and the render gate (another preset ⇒ nothing, unreadable switch ⇒ nothing, Chat mode ⇒ a `role="switch"` control).

Pending live verification after the next restart, in a new Chat mode session: the switch appears in the composer tool row; `@package.json` injects the file body; `@notfound.txt` ends the turn with `cannot find file.` and injects no declaration; turning the switch off and asking a live-information question produces an answer with no tool calls; `/smartsearch on` (or the switch) restores `web_search` / `web_fetch` from the next step.

## Limitations

- **The model cannot choose skills on its own**: it only sees the skill catalog, and the user triggers body injection with `/skill-name`.
- **`@` references are resolved at the step boundary**: a file created after the message was sent is only available if the user references it again; a missing file fails the turn instead of silently degrading.
- **Images depend on the model route**: a text-only route receives a note rather than an image block. Image reads use the attachment service and its byte/dimension limits.
- **Existing sessions** switched from another mode to this one may still carry old skill-catalog messages in their history; this mode does not rewrite history messages. Starting a new session is recommended.
- The skill catalog is published only once per session; changes to skill files within a session are not re-sent automatically.
- The host must already have the `skills` service and skill providers mounted (the desktop default composition satisfies this); when missing, the skill catalog and `/skill-name` injection are skipped automatically and the mode still chats normally. File injection requires `ctx.fs`; without it, `@` references are ignored with a warning.
- **The switch is per session and per step.** It applies from the next step of the session that ran it, not to a session already mid-step, and it is stored as a command record in that session's log — turning it off does not retract search results already in the conversation. Both the composer switch and the typed command leave a command row in the conversation; that row is the record the switch reads. The control is offered only in Chat mode, but `/smartsearch` itself is a plain command: while this bundle's runtime is loaded it can be typed in any session, and there it hides that session's web tools too.
- Web tools require the Host `ctx.web` service and at least one search/fetch provider. Without a usable search credential, `web_search` is withheld for that step; `web_fetch` still works through the local HTTP provider.

## Development

```powershell
node --check index.js
node --check client.js
npm test
```

`npm test` runs both offline suites: `test/plugin.test.mjs` (runtime, against a fake Cordis context) and `test/client.test.mjs` (browser bundle, evaluated in a `vm` sandbox).

## License

This project is licensed under the MIT License; the LICENSE file contains:
```
MIT License

Copyright (c) 2026 xystudiocode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
