<p align="center">
  <img src="./icon.svg" width="96" alt="dsh-chatmode icon">
</p>

# dsh-chatmode - A web-like minimalist experience

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-chatmode)](https://www.npmjs.com/package/dsh-chatmode)
[![stars](https://img.shields.io/github/stars/xystudio889/dsh-chatmode?style=flat)](https://github.com/xystudio889/dsh-chatmode)

A DeepSeek Harness extension that adds a new **Chat mode**.

> **Author's note:** This project was developed entirely by DeepSeek Harness AI, and the code is fully AI-generated. If you find a bug, please report it.

> Your Skills are preserved, but the model won't perform any actions, and a single thinking pass produces the answer. This gives a web-chat-like experience and saves a lot of tokens.

## What this mode does

- **No tools at all**: the mode mounts no tool plugins (read / write / bash / pwsh / web / todo / subagent / goal / plan — none of them), and it hides host-globally-mounted tools within the mode's scope. The tool schema list the model receives is empty.
- **The loop naturally converges to a single pass**: no tools means no tool-call turns, so DSH's agent loop ends the turn right after the model's first reply (one thinking pass, a single answer). It won't continue for multiple steps just to perform actions.
- **Skills are still kept**:
  - Each session receives a one-time skill catalog message (skill name + description, for skills within the model's callable scope) telling the model it cannot load skills by itself.
  - When the user writes `/skill-name` in the input, that skill's full `<skill_content>` body is injected automatically in the same step, and the model answers directly according to the skill instructions — no `skill` tool needed, and no second generation pass.
- **Lean prompt**: `persona` uses `complete: true` and `includeRuntimeContext: false`, so the system prompt keeps only the chat-mode persona and drops sections such as the coding agent, plan mode, and tool guidance, saving even more tokens.

## Installation

```powershell
# Install the local directory from the DSH Web UI "Plugins" page, or:
dsh plugin --profile <profile> add F:\code\dsh-plugin\dsh-chatmode
```

You can also install this directory with `plugin_manager` in any DSH profile (in addition to `cordis.patch.yml`); the bundle patch inserts the mode declaration automatically.

Once installed, "聊天模式" (Chat mode) appears in **Settings → Modes** (or in the mode selector of a new session). Select it for a new session, or switch an empty session to it.

## Mode definition

`cordis.patch.yml` inserts one declaration line into `@deepseek-ai/dsh-agent-preset`:

| Field | Value |
|---|---|
| `id` | `chatmode` |
| Name | `聊天模式` |
| Description | See above |
| Composition | `@deepseek-ai/dsh-persona` (chat-mode persona) + `dsh-chatmode` (this package's runtime code) |

This package registers no tools; the runtime code does only two things: publish the skill catalog / inject `/skill-name` bodies, and hide global tools within the mode's scope.

## Runtime implementation

`index.js` exports a standard Cordis plugin (`name` / `inject` / `apply`):

- `ctx.inject(['tools'])`: listens to `tools/change`, registers the current global tool names as a `deny` list via `ctx.tools.restrict()`, and refreshes as global tools are added or removed; tools inside the mode scope are always empty.
- `ctx.inject(['skills', 'workingDirectory'])`: listens to `agent/pre-step` and, on accepted steps, appends the one-time skill catalog message and the skill body injected by `/skill-name`. All failures are swallowed and logged as warnings, so they never turn a conversation turn into a failed turn.

It depends on no `@deepseek-ai/*` runtime packages (profile-installed bundles cannot resolve them); model-visible formats such as message construction and `<skill_content>` rendering are self-contained in this package and stay consistent with the official `dsh-tool-skill` / `dsh-skill`.

## Display metadata and language

- Bundle titles and descriptions on the plugin/settings page come from `locale/*.json` and switch with the software language: `locale/en.json` contains only English (`Chat mode` + English description), and `locale/zh.json` contains only Chinese (`聊天模式` + Chinese description).
- The name and description in the mode selector come from the preset declaration in `cordis.patch.yml`, which is a **single string** returned by the host and does not participate in client-side localization: DSH client's `presetDisplayText` only uses localized entries for built-in modes (standard / ptc / minimal / cordis), and custom modes display the declared `name`/`description` verbatim (official note: *without making user-authored metadata translatable*).
- Therefore a custom mode cannot achieve "Chinese UI shows Chinese, English UI shows English". As required, this package sets the mode name/description to **Chinese only**: `name: '聊天模式'`, with the Chinese sentence above as the description. To make it English-only instead, simply change the corresponding text in `cordis.patch.yml` and `package.json`; true per-language switching would require a client UI plugin to take over the preset selector, which is costly and prone to breaking across versions.

## Verified

After installing into the current desktop profile, the real runtime state was read through a temporary probe inside the host:

- The mode is in the roster: `chatmode` (name, description, order=5), with no `broken` diagnostics.
- The mode composition is mounted and both rows are active: `@deepseek-ai/dsh-persona` + `dsh-chatmode`.
- Within the chat-mode scope the visible tool list is empty (globally mounted Agent Teams tools are hidden too), the system prompt contains only the chat-mode persona (`complete: true`), and optional runtime context is disabled.

Logic such as `/skill-name` injection and the catalog being published only once is covered by `test/plugin.test.mjs` in an offline fake context. The actual conversational feel (whether answers feel like web chat) still needs to be confirmed by the user after selecting "聊天模式" in a new session.

## Limitations

- The model cannot choose skills on its own: it only sees the skill catalog, and the user triggers body injection with `/skill-name`. This is the trade-off under the "zero tools + single-pass generation" constraint.
- Existing sessions switched from another mode to this one may still carry old skill-catalog messages in their history (prompting the model to call the `skill` tool); this mode does not rewrite history messages. Starting a new session is recommended to experience chat mode.
- The skill catalog is published only once per session; changes to skill files within a session are not re-sent automatically (this mode mounts no compaction/refresh plugins).
- The host must already have the `skills` service and skill providers mounted (the desktop default composition satisfies this); when missing, the skill catalog and `/skill-name` injection are skipped automatically and the mode still chats normally.

## Development

```powershell
node --check index.js
node test/plugin.test.mjs
```

`test/plugin.test.mjs` uses a fake Cordis context to cover: registering no tools, hiding global tools, publishing the catalog only once, `/skill-name` injection, and returning `reject` decisions unchanged.

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