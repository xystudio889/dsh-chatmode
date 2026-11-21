<p align="center">
  <img src="./icon.svg" width="96" alt="dsh-chatmode icon">
</p>

# dsh-chatmode - 带联网能力的网页式聊天模式

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-chatmode)](https://www.npmjs.com/package/dsh-chatmode)
[![stars](https://img.shields.io/github/stars/xystudio889/dsh-chatmode?style=flat)](https://github.com/xystudio889/dsh-chatmode)

DeepSeek Harness 扩展：新增 **聊天模式**（Chat mode）预设。

> **作者声明：**本项目完全由 Deepseek harness AI 开发，代码完全由 AI 生成，若有 bug 请指出。

> 保留你的 Skill，新增联网搜索与抓取，自动读取 `@` 引用的文件，并且每一轮仍只给出一个最终回答，接近网页聊天体验。

## 这个模式做了什么

- **只有联网工具**：预设挂载共享的 `web_search` 与 `web_fetch`，并隐藏宿主继承来的其他所有工具（Agent Teams、MCP、shell、文件系统、todo、subagent、goal、plan 等）。模型看到的工具就是这两个联网工具。
- **「智能搜索」开关**：输入框左侧工具栏上有一个 `智能搜索 / Smart search` 开关，只在聊天模式会话中出现。它是真的开关而非提示词暗示：关闭后，该步骤解析出的工具集里不再有 `web_search` 与 `web_fetch`，人设也会告诉模型它没有任何工具，这两个工具自带的提示词段落同时消失；重新打开后从下一步起恢复。开关即 `/smartsearch on|off` 这条命令记录的折叠结果，手打命令和点开关是同一件事，刷新、分叉、恢复会话都会得到同一个值。
- **恢复 agent 循环**：工具调用是真实的多步轮次，模型可以先搜索、再抓取引用页面、再搜索，最后给出回答。人设要求最终回答保持简洁，所以体验仍像网页聊天。
- **Skill 依旧需要提前声明**：
  - 每个会话会收到一次性的技能目录消息（技能名 + 描述，模型可调用范围内的技能），告诉模型它不能自己加载技能。
  - 用户在输入里写 `/技能名` 时，该技能的完整 `<skill_content>` 正文会在同一步自动注入。模式不挂载 `skill` 工具，模型也不能假装加载过技能。
- **`@` 文件与图片注入**：用户消息里的 `@path` 或 `@"带空格的路径"` 会在模型请求前按会话工作目录解析并读入上下文：
  - 文本文件变成 `<file_reference>` 块（有字节上限，截断会标记），模型不需要文件系统工具就能回答；
  - 图片在当前模型路由声明支持图片输入时，会保存为附件并注入 image 内容块；不支持时只注入一条文字说明，指出图片未附加；
  - `@` 指向不存在的文件或非普通文件时，本轮以 `cannot find file.` 报错结束，**不会**向上下文注入任何文件声明；
  - `@[标题](dsh-session:...)` 这类会话引用不是文件，原样保留、不会读取。
- **模式选择框适配中英文**：宿主对自定义模式只发布一条 `name`/`description` 字符串，因此本包附带一个很小的浏览器端半成品，把自身的 roster 行按当前界面语言本地化。新会话的模式按钮、会话头部的模式标签、设置里的模式列表都读取本地化后的名称；声明本身也带中英双语回退。
- **精简且如实描述工具的提示词**：人设由本包注册为一个 `complete: true` 的提示词段落，并关闭运行时上下文，因此不含编码代理、计划模式、工具指引等章节。它每一步都会重新生成，所以其中的工具说明跟随「智能搜索」开关：开启时说「你只有 web_search 与 web_fetch」，关闭时说「你没有任何工具」。

## 安装

```powershell
# 在 DSH 的 Web UI「插件」页安装本地目录，或：
dsh plugin --profile <profile> add F:\code\dsh-plugin\dsh-chatmode
```

也可以在任意 DSH profile 中用 `plugin_manager` 安装本目录；bundle patch 会自动插入模式声明。本包现在包含两半：

- `index.js` —— 预设运行时（工具过滤、智能搜索、人设、Skill 桥接、`@` 文件上下文）；
- `client.js` —— 浏览器端：本地化模式选择框条目并渲染开关。

安装或更新后需要重启 DeepSeek Harness——`index.js` 是宿主代码，只有重启才会加载新的插件代际；重启后刷新一次 Web 页面（浏览器端会一起重新加载）。

安装后，在 **设置 → 模式**（或新会话的模式选择器）中即可看到「聊天模式 / Chat mode」；新建会话选择它，或对空白会话切换模式。

## 模式定义

`cordis.patch.yml` 向 `@deepseek-ai/dsh-agent-preset` 插入一行声明：

| 字段 | 值 |
|---|---|
| `id` | `chatmode` |
| 名称 | `聊天模式 / Chat mode`（由浏览器端半成品本地化） |
| 描述 | 见上 |
| 组成 | `@deepseek-ai/dsh-tool-web`（联网工具）+ `dsh-chatmode`（运行时代码、人设与开关） |

这里故意没有 `@deepseek-ai/dsh-persona` 行：那一行提供的是静态字符串，而本模式的提示词必须说明此刻联网工具到底在不在。`complete: true` 的人设是唯一的提示词段落，动态文案没法并排追加，所以改由本包注册。

运行时本身不注册联网工具；`dsh-tool-web` 提供 `web_search` / `web_fetch`，运行时代码只负责过滤继承工具、解析智能搜索门控、发布技能目录 / 注入 `/技能名` 正文，以及读取 `@` 引用。

## 运行时实现

`index.js` 导出标准 Cordis 插件（`name` / `inject` / `apply`）。`apply` 是异步的，因为开关的会话投影必须在任何读取者发布之前注册完成；预设挂载会等待插件就绪。

- `ctx.inject(['tools'])`：加载时以及每次 `tools/change`，把除 `web_search`、`web_fetch` 之外的所有继承工具名注册为 `ctx.tools.restrict()` 的 `deny` 列表。预设自己的联网工具注册在 tools 注册表中是豁免的，因此保持可见；之后全局新增的工具会在下一次变更时被隐藏。
- 智能搜索：
  - `ctx.sessionProjections.register()` 从 `command/run` / `command/done` 折出一个 `smartsearch` 单元，`wire.view` 把 `{ enabled }` 暴露给浏览器。它是唯一权威，本插件不保存任何状态文件。
  - `ctx.inject(['commands'])` 注册 `/smartsearch on|off`（中英文参数都接受）。处理器只做校验与说明，真正的值来自被记录的命令。
  - `ctx.inject(['tools'])` 在原始服务对象上（`Symbol.for('cordis.original')`）包装 `tools.resolve()`：开关关闭的步骤解析出的工具集不含这两个联网工具。`resolve()` 是这一步的声明工具、提示词指引、派发与程序绑定共同读取的输入，所以在这里过滤能一次隐藏干净，同时保留两个注册供下一步恢复。
- `ctx.inject(['systemPrompt'])` 注册 `deployment:persona-prefix` 段落（`complete: true`）并关闭运行时上下文；段落的文本函数按 agent 读取开关状态。
- `ctx.inject(['skills', 'workingDirectory', 'fs'])`：监听 `agent/pre-step`，在接受的一步上追加：
  - 一条 `file-reference` 用户消息，包含前言和每个可解析的 `@` 文件/图片；
  - 一次性技能目录消息；
  - `/技能名` 注入的技能正文。
- 文件处理通过宿主 `ctx.fs` 解析路径并做有上限读取；图片通过 `ctx.attachments.saveImage()` 保存；通过 `ctx.llm.resolveModelInfo()` 检查当前路由是否声明支持图片输入。路径不存在或不是普通文件时，在 `agent/pre-step` 抛出 `Error('cannot find file.')`；DSH 会把它记录为本轮错误，且不会向模型注入任何 mention 声明。
- 除这个明确的无效文件错误外，其他辅助失败都会被吞掉并记录警告，不会把正常对话变成失败轮。开关自身的读取是刻意 fail-open 的：投影读不出来时保留联网工具，而不是悄悄把工具摘掉。

不依赖任何 `@deepseek-ai/*` 运行时包；消息构造、`<skill_content>` 渲染等模型可见格式在本包内自带，与官方 `dsh-tool-skill` / `dsh-skill` 保持一致。

`client.js` 在挂载期间包装 `remote.agentPresets.list` 与 `remote.agentPresets.read`，把 `chatmode` 行的名称/描述替换为注册在 `dsh-chatmode` 客户端 locale 命名空间下的文案；插件卸载时恢复原方法。宿主声明保留中英双语回退。

它还会把开关注册到 `conversation.input.left`（输入框工具行左侧）。控件读取 `smartsearch` 投影与 `agentPreset` 投影（因此其他模式看不到它），并通过执行 `remote.commands.execute(sessionId, '/smartsearch off|on', [])` 来切换——和用户手打的命令完全是同一条，失败会在控件旁就地提示。

## 显示元数据与语言

- 插件/设置页的 bundle 标题与描述来自 `locale/*.json`，按软件语言切换：`locale/en.json` 为英文，`locale/zh.json` 为中文。
- 模式选择框里的自定义模式名称/描述来自 `cordis.patch.yml` 的单条宿主字符串。该声明现在使用中英双语回退，同时浏览器端半成品会按当前 locale 本地化该行。切换语言后，下一次界面重新加载 roster（例如回到新会话页或重新打开设置）时生效，不会改写已保存的模式元数据。

## 已验证

**曾在早期版本上实测（当前 desktop profile）：** 模式进入 roster 为 `chatmode`，无 `broken` 诊断；其作用域内可见工具只有 `web_search` 与 `web_fetch`；系统提示是一个 `complete: true` 的人设，可选运行时上下文已关闭。人设现在改由本包运行时注册（不再有 `dsh-persona` 行），上述工具集与提示词属性由离线测试在每次改动后重新校验。

逻辑由两套离线测试覆盖。`test/plugin.test.mjs` 用假 Cordis 上下文跑运行时：不注册工具、带联网例外的继承工具过滤、目录只发布一次、`/技能名` 注入、`@` 文本注入、带空格路径、图片路由门控、会话 mention 排除、`cannot find file.` 轮次错误、开关的 `command/run` / `command/done` 折叠（成功、失败、过期结算、损坏的检查点）、命令语法、带在途选择时的工具集门控，以及两种状态下的人设句子。`test/client.test.mjs` 在 `vm` 沙箱里配合假模块加载器、locale、slot 与 Remote 服务评估浏览器端 bundle：roster 本地化、包装还原、输入框座位注册、它发出的 `/smartsearch on|off` 命令、失败映射，以及渲染门控（其他模式不渲染、投影读不到不渲染、聊天模式渲染一个 `role="switch"` 控件）。

重启后在新的聊天模式会话中仍需人工确认：开关出现在输入框工具行；`@package.json` 会注入文件正文；`@notfound.txt` 会以 `cannot find file.` 结束本轮且不注入任何声明；关闭开关后提一个需要实时信息的问题，回答里没有任何工具调用；`/smartsearch on`（或点开关）从下一步起恢复 `web_search` / `web_fetch`。

## 限制

- **模型不能自行选择技能**：它只能看到技能目录，由用户用 `/技能名` 触发正文注入。
- **`@` 引用在步骤边界解析**：消息发出后新创建的文件需要再次引用；文件缺失会直接让本轮报错，而不是静默降级。
- **图片取决于模型路由**：纯文本路由只会收到文字说明，不会收到 image 块。图片读取受附件服务的字节、像素与数量限制。
- **已有会话**从其它模式切换到本模式后，历史里可能残留旧的技能目录消息；本模式不会改写历史消息。建议用新会话体验。
- 技能目录在一次会话中只发布一次；会话内技能文件变更后不会自动重发。
- 需要宿主已挂载 `skills` 服务与技能提供者（桌面默认组合满足）；缺失时技能目录与 `/技能名` 注入自动跳过，模式仍可正常聊天。文件注入需要 `ctx.fs`；缺失时 `@` 引用会被忽略并记录警告。
- **开关按会话、按步骤生效**：它对执行命令的那个会话的下一步生效，不会改写正在进行的步骤；开关以命令记录的形式存在该会话日志里，所以关掉它不会撤回对话里已有的搜索结果。点开关和手打命令都会在对话里留下一条命令行，那条记录就是开关读取的数据源。控件只在聊天模式出现，但 `/smartsearch` 本身是普通命令：本包运行时加载期间，任何会话里都能手打它，并同样关掉那个会话的联网工具。
- 联网工具需要宿主 `ctx.web` 服务与至少一个搜索/抓取提供方。没有可用的搜索凭据时，该步骤不会提供 `web_search`；`web_fetch` 仍可通过本地 HTTP 提供方工作。

## 开发

```powershell
node --check index.js
node --check client.js
npm test
```

`npm test` 会跑两套离线测试：`test/plugin.test.mjs`（运行时，假 Cordis 上下文）与 `test/client.test.mjs`（浏览器端 bundle，在 `vm` 沙箱中评估）。

## License

本项目使用 MIT License，LICENSE 文件内容：
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
