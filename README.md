# dsh-chatmode

DeepSeek Harness 扩展：新增 **聊天模式**（Chat mode）。

> 将保留你的 Skill，但是模型不会进行任何操作，并且思考也只会一次性生成答案。能做到和网页相似的体验，将会非常节省 token。

## 这个模式做了什么

- **没有任何工具**：模式不挂载任何工具插件（read / write / bash / pwsh / web / todo / subagent / goal / plan 等全部没有），并且会为该模式的作用域隐藏宿主全局挂载的工具。模型拿到的工具 schema 列表为空。
- **循环自然收敛为一次**：没有工具就没有工具调用轮次，DSH 的 agent loop 在模型第一次回复后即结束本轮（一次思考、一次性生成答案），不会为了操作而继续多步。
- **Skill 仍然保留**：
  - 每个会话会收到一次性的技能目录消息（技能名 + 描述，模型可调用范围内的技能），告诉模型它无法自己加载技能。
  - 用户在输入里写 `/技能名` 时，该技能的完整 `<skill_content>` 正文会在同一步自动注入，模型直接按技能说明作答——不需要 `skill` 工具，也不会产生第二次生成。
- **精简提示词**：`persona` 使用 `complete: true` 和 `includeRuntimeContext: false`，系统提示只保留聊天模式人设，去掉编码代理、计划模式、工具指引等章节，进一步节省 token。

## 安装

```powershell
# 在 DSH 的 Web UI「插件」页安装本地目录，或：
dsh plugin --profile <profile> add F:\code\dsh-plugin\dsh-chatmode
```

也可以在任意 DSH profile 的 `cordis.patch.yml` 之外，用 `plugin_manager` 安装本目录（bundle patch 会自动插入模式声明）。

安装后，在 **设置 → 模式**（或新会话的模式选择器）中即可看到「聊天模式」；新建会话选择它，或对空白会话切换模式。

## 模式定义

`cordis.patch.yml` 向 `@deepseek-ai/dsh-agent-preset` 插入一行声明：

| 字段 | 值 |
|---|---|
| `id` | `chatmode` |
| 名称 | `聊天模式` |
| 描述 | 见上 |
| 组成 | `@deepseek-ai/dsh-persona`（聊天模式人设）+ `dsh-chatmode`（本包的运行时代码） |

本包不注册任何工具；运行时代码只做两件事：发布技能目录 / 注入 `/技能名` 正文，以及为该模式作用域隐藏全局工具。

## 运行时实现

`index.js` 导出标准 Cordis 插件（`name` / `inject` / `apply`）：

- `ctx.inject(['tools'])`：监听 `tools/change`，把当前全局工具名作为 `deny` 列表注册到 `ctx.tools.restrict()`，并随全局工具增减刷新；模式作用域内的工具始终为空。
- `ctx.inject(['skills', 'workingDirectory'])`：监听 `agent/pre-step`，在接受的步骤上追加一次性技能目录消息与 `/技能名` 注入的技能正文。所有失败都被吞掉并记录警告，不会让一轮对话变成失败轮。

不依赖任何 `@deepseek-ai/*` 运行时包（profile 安装的 bundle 无法解析它们）；消息构造、`<skill_content>` 渲染等模型可见格式在本包内自带，与官方 `dsh-tool-skill` / `dsh-skill` 保持一致。

## 显示元数据与语言

- 插件/设置页的 bundle 标题与描述来自 `locale/*.json`，按软件语言切换：`locale/en.json` 只有英文（`Chat mode` + 英文描述），`locale/zh.json` 只有中文（`聊天模式` + 中文描述）。
- 模式选择框里的名称与描述来自 `cordis.patch.yml` 的 preset 声明，是宿主侧返回的**单一字符串**，不参与客户端本地化：DSH 客户端的 `presetDisplayText` 只对内置模式（standard / ptc / minimal / cordis）使用本地化词条，自定义模式直接原样显示声明的 `name`/`description`（官方注释：*without making user-authored metadata translatable*）。
- 因此自定义模式无法做到“中文界面显示中文、英文界面显示英文”。本包按需求把模式名称/描述设为**中文单语**：`name: '聊天模式'`，描述为上面的中文句子。想改成英文单语，直接改 `cordis.patch.yml` 和 `package.json` 的对应文本即可；真正按语言切换需要客户端 UI 插件接管预设选择器，成本较高且易随版本失效。

## 已验证

安装到当前 desktop profile 后，通过宿主内的临时探针读取了真实运行状态：

- 模式已进入 roster：`chatmode`（名称、描述、order=5），无 `broken` 诊断。
- 模式组合已挂载且两行均处于 active 状态：`@deepseek-ai/dsh-persona` + `dsh-chatmode`。
- 在聊天模式作用域内，可见工具列表为空（全局挂载的 Agent Teams 工具也被隐藏），系统提示只剩聊天模式人设（`complete: true`），可选运行时上下文已关闭。

`/技能名` 注入与目录只发布一次等逻辑由 `test/plugin.test.mjs` 在离线假上下文中覆盖。真正的对话手感（回答是否像网页聊天）仍需在新会话中选择「聊天模式」后由用户确认。

## 限制

- 模型不能自行选择技能：它只能看到技能目录，并由用户用 `/技能名` 触发正文注入。这是「零工具 + 单步生成」约束下的取舍。
- 从其它模式切换到本模式的已有会话，历史里可能残留旧的技能目录消息（提示模型调用 `skill` 工具）；本模式不会改写历史消息。建议用新会话体验聊天模式。
- 技能目录在一次会话中只发布一次；会话内技能文件变更后不会自动重发（本模式不挂载压缩/刷新类插件）。
- 需要宿主已挂载 `skills` 服务与技能提供者（桌面默认组合满足）；缺失时技能目录与 `/技能名` 注入自动跳过，模式仍可正常聊天。

## 开发

```powershell
node --check index.js
node test/plugin.test.mjs
```

`test/plugin.test.mjs` 用假 Cordis 上下文覆盖：不注册工具、隐藏全局工具、目录只发布一次、`/技能名` 注入、`reject` 决策原样返回。

## License

MIT
