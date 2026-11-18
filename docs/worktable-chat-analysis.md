# dsh-worktable 侧边栏 AI 对话框实现分析

> 分析对象：<https://github.com/Aisland-SJL/dsh-worktable>（v0.4.0，MIT）
> 目标：把 WIKI知识库的 AI 面板做成同款「右侧原生对话 + 左侧知识内容」效果。
> 结论先行：**worktable 没有实现聊天 UI。你看到的 AI 对话框是 DSH 宿主原生会话视图，worktable 只负责把它挤到右侧并切换会话。**

## 1. 一句话结论

worktable 的「AI 对话框」= 宿主原生 Conversation，不是插件自绘：

- 插件只注册了两个座位：`sidebar.footer.action`（左侧工作台入口）和 `shell.overlay`（覆盖内容区的分栏层）。
- 原生对话视图从来没有被搬进插件；插件通过给会话的 `viewArea` 设置 `margin-left` / `margin-right` / `margin-top`，把官方对话挤到右侧。
- 打开项目时，通过宿主 `sessions` / `uiWorkspace` 接口切到项目绑定的会话；关闭时再切回打开前的会话。
- 因此消息流式输出、思考过程、工具调用卡、审批、附件、模型选择、Markdown 渲染全部是宿主现成能力，worktable 一行都没写。

worktable 自己的 PRD 也写死了这个边界：

- `02_process/PRD.md:331`：其中一个窗格恒为聊天窗，**继承工作区全部会话**。
- `02_process/PRD.md:334`：非目标——**不搬动/替换官方会话组件**。
- `02_process/PRD.md:336-340`：聊天窗 = 官方会话视图区整体，插件仅能以 `margin-left` / `margin-top` 将其挤到右/下角，无法把官方组件拆出来放进中间。

## 2. 代码证据

### 2.1 注册位置

`01_content/src/client/index.tsx:3256-3263`：

```ts
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay',
  id: 'dsh-worktable-split',
  order: 100,
}, SplitWorkspace))

ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'dsh-worktable',
  order: 20,
  children: { 'sidebar.worktable.project': { kind: 'list', scope: 'root' } },
}, WorktableSection))
```

注意：**没有 `main` 座位**。worktable 不占用宿主主视图，所以原生会话一直存在，才有东西可挤。

### 2.2 找会话根、算几何、挤边距

`01_content/src/client/split.tsx`：

- `:664 findConversationRoot()`：遍历 `[data-phase]`，排除 textarea/input，优先 `data-phase="active"`，其次 `hero`，兜底 `settling`。
- `:698 resolveAnchor(root)`：兼容两版 DOM。`root.children[0]` 是头部（或头部包装），`root.children[1]` 是滚动内容区 `viewArea`；空会话按无头部处理。
- `:766 open(spec)`：打开分栏，解析锚点，读 localStorage 宽度，计算默认比例，然后 `applyMargin()`。
- `:900 syncAnchor()`：切换会话/`hero→active` 时重新找根、重算锚点；左侧内容保持挂载，不关闭。
- `:960 applyMargin()`：核心只有几行——

```ts
const gap = Math.max(0, colW - chatW) + 'px'
viewArea.style.marginLeft = hasLeft ? leftW + 'px' : (chatLeft ? '' : gap)
viewArea.style.marginRight = hasLeft ? '' : (chatLeft ? gap : '')
viewArea.style.marginTop = mt
this.root.style.setProperty('--dsh-chat-user-width', Math.round(chatW) + 'px')
```

- `:973`：同时把 `--dsh-chat-user-width` 钉成挤出的聊天列宽，避免原生对话内容宽度上限 680–920px 不跟随。
- `:993 setChatW(w)`：拖分隔条时更新宽度、重新挤位、持久化。

`--dsh-chat-user-width` 是关键：只改 margin 不够，原生对话内容有宽度上限，聊天列窄了以后内容不会自动适配，所以要把这个 CSS 变量固定到目标列宽。

### 2.3 覆盖层只负责内容，不包聊天

`split.tsx:3135 SplitWorkspace` 渲染 `WorkspaceLayer`（`:2951`）：分栏内容、标签条、分隔线、关闭按钮都在覆盖层里；原生聊天不在覆盖层里，只是被 margin 挤到右侧。因此：

- 聊天仍然可以正常输入、滚动、点工具卡；
- 覆盖层不能全屏铺满，否则会挡住聊天；
- 关闭覆盖层时恢复原来的 margin 和 `--dsh-chat-user-width`。

### 2.4 会话绑定/切换

`01_content/src/client/sessionCompat.ts`：

- `:9 openHostSession(ctx, sessions, id)`：新版走 `ctx.get('uiWorkspace')?.openSession(id)`，旧版回退 `sessions.open(id)`。
- `:2 currentSessionOf(snapshot)`：从会话列表快照里取当前会话。
- `:18 sendHostSession(bridge, id, text)`：旧宿主兼容的发送方式。

`01_content/src/client/index.tsx:1629 openSplit()`：

1. `splitStore.open(spec)` 打开覆盖层；
2. 记录打开前会话 `prev`；
3. 若项目绑定了会话，`openHostSession(bound)` 把右侧聊天切过去；
4. 关闭时（`index.tsx:1441-1446`）`openHostSession(prev)` 切回打开前的会话；
5. 切换会话不关闭分栏：`syncAnchor()` 重新锚定即可（PRD §12.4 明确要求）。

### 2.5 往原生对话里塞上下文

`01_content/src/client/hostInput.ts:4 appendHostInput()`：直接操作宿主输入框的 actions：

```ts
const inserted = typeof input.actions?.insertText === 'function'
  ? input.actions.insertText(addition, span)
  : scope.bail?.('slash/input-insert-text', { text: addition, span })
```

这就是「把知识库节点/文件内容带进对话」的正确方式：追加到原生 composer，但不发送，让用户自己决定。

### 2.6 宽度与持久化

- `index.tsx:204` / `:566`：`chatWidth` 默认 `360` 或 `340`，范围 `280–600`。
- `split.tsx:826-836`：宽度上限 = 列宽 − 内容窗最小宽；默认取列宽 30%。
- `split.tsx` 内 `PERSIST_KEY`/`loadSaved`/`persistSaved`：按布局 id 存 `{ chatW, topH, leftW, paneWs... }` 到 localStorage。
- `split.tsx:900` 起：`ResizeObserver` 观察会话根，`MutationObserver` 兜底会话根被替换；锚点变化才重算，流式输出时不抖动。

## 3. worktable 没有实现什么

明确排雷，避免把工作量估错：

| 能力 | 谁实现 |
| --- | --- |
| 消息流式、Markdown、代码块 | DSH 原生 Conversation |
| 思考过程 / 工具调用卡 / 审批 | DSH 原生 Conversation |
| 模型选择、附件、会话历史 | DSH 原生 Conversation |
| 会话创建/切换/持久化 | DSH `sessions` / `uiWorkspace` |
| 右侧聊天窗位置/宽度 | worktable 的 margin + CSS 变量 |
| 左侧项目内容、标签、分隔条 | worktable 的 `shell.overlay` |
| 项目 ↔ 对话绑定 | worktable 自己存的 binding + 宿主 `openHostSession` |

所以「借鉴 worktable 的 AI 对话框」准确说是：**借鉴它的会话锚定 + margin 挤位 + 会话绑定，聊天本体继续用原生。**

## 4. WIKI 现状与冲突点

当前 WIKI知识库：

- `client.js:2445` 注册了 `main` 座位（`{ name: 'main', key: PANEL_ID }`），进入知识库后整个主视图被 WIKI 接管。
- `client.js:2448-2450` 注册 `sidebar.panellist`，点击后激活 WIKI 主视图。
- AI 面板是自绘的：`client.js:1357` 请求 `/wiki-manager/api/ask-stream`，`client.js:1374` 自己消费 SSE，`:1722` 渲染思考过程，`:1736` 渲染回答；宿主 `index.js:1257` 提供 `/ask-stream`。
- 结果是：WIKI 主视图激活时，原生 Conversation 根本不可见，没有会话根可以挤。

**这是架构级冲突，不是换个组件能解决的：**

> 想同时看到「WIKI 内容 + 原生 AI 对话」，WIKI 详情页就不能再占用 `main` 座位；必须像 worktable 一样，把详情内容放进 `shell.overlay`，把原生会话留在主视图并挤到右侧。

## 5. 三种可选方案

### 方案 A：工作台式原生对话（效果完全一致，推荐）

做法：

1. WIKI 详情不再注册/使用 `main` 座位；改为 `shell.overlay` + 左侧内容窗。
2. 打开知识库时：
   - 确定该 KB 绑定的会话（新建或绑定现有会话，cwd = KB 路径）；
   - `openHostSession(bound)` 把原生对话切过去；
   - `splitStore.open({ id: kb.id, title: kb.name, chatWidth: { default: 360, min: 280, max: 600 }, main: [WIKI 内容窗] })`。
3. 覆盖层左侧渲染图谱/目录/页面内容；右侧原生对话保持宿主默认。
4. 关闭时恢复打开前会话与 margin/宽度变量。
5. 节点/文件操作加「发送到对话」：`appendHostInput` 追加到原生 composer（不自动发送）。

效果：与 worktable 截图一致，聊天是真正的宿主对话，工具卡/审批/思考过程天然一致。

成本：WIKI 详情页要迁移到覆盖层；需要一套锚定/挤位引擎（可从 worktable MIT 代码裁剪）；需要 KB ↔ 会话绑定；需要双宿主 DOM 适配与回归测试。

粗估：核心引擎 600–900 行（worktable 的 split.tsx 有 3224 行，但大部分是多窗格/标签/窗口容器，WIKI 只需要「左内容 + 右聊天」），加页面迁移、绑定流程、测试，约 3–5 个工作日。

### 方案 B：注册官方 `conversation.view` 页签（官方座位，但不是并排）

当前 DSH 宿主有 `conversation.view` 座位，官方 Trajectory 插件用它注册「轨迹」视图页签；`conversation.session.header.views.actions` 等座位还提供页签管理。

做法：WIKI 注册一个 `conversation.view`，在原生会话的页签区出现「WIKI知识库」；切到该页签时显示 WIKI 内容，composer 仍是原生输入框。

优点：不用 DOM hack，不抢 `main`，升级稳定性最好。
缺点：**聊天和 WIKI 是页签切换关系，不是右侧并排**；聊天记录在「对话」页签里，看 WIKI 时看不到对话流。适合「在会话里查看知识库」而不是「知识库右侧带 AI 对话框」。

成本最低，但效果不是 worktable 那种并排。

### 方案 C：继续自绘，做视觉仿制

保留当前 `/ask-stream` 和自绘聊天，只对齐 worktable 的视觉/布局。

优点：不动架构，不改会话模型。
缺点：**不可能完全一致**——原生工具卡、审批交互、思考过程组件都不是插件可复用的 React 组件，只能仿外观；后续宿主 UI 一改就对不上。

## 6. 推荐路线

如果「效果完全参考」是硬要求：**走方案 A**。

如果只是想要「右侧有一个像宿主一样的对话区」，且能接受 WIKI 与对话分页签：走方案 B。

如果只想快速美化现有 WIKI AI 面板：走方案 C，但不要承诺与 worktable 完全一致。

建议先做 A 的**单 KB 原型**（不改现有详情页，加一个「工作台预览」入口）：

1. 复用 worktable 的 `findConversationRoot` / `resolveAnchor` / `applyMargin` / `syncAnchor`（MIT，保留版权声明）。
2. 只保留右侧聊天 + 一个左侧内容窗，去掉多窗格/标签/窗口容器。
3. 手动绑定一个现有会话，验证：打开挤位、拖宽、切会话不关、关闭恢复、聊天可交互。
4. 原型通过后再决定是否整体迁移 WIKI 详情页与绑定流程。

## 7. 风险清单

- **DOM 契约风险**：`[data-phase]`、`children[0/1]`、`--dsh-chat-user-width` 都不是公开 API；worktable 自己也在 PRD 里把它列为硬约束，并维护双版本锚点。DSH 升级必须回归。
- **只能贴边**：原生会话不能被拆出来放中间；WIKI 布局只能是「聊天在右/下」。
- **会话绑定**：每个 KB 要有归属会话；自动新建会在工作区产生对话记录，手动绑定更稳但多一步交互。
- **焦点/键盘**：覆盖层不能挡住聊天；Esc 关闭、输入框焦点、拖拽分隔条都要测。
- **导航语义**：WIKI 从 `main` 迁到 overlay 后，侧边栏激活态、返回列表、深链接都要重新设计。
- **双份聊天**：迁移期不要同时保留 `/ask-stream` 自绘聊天和原生聊天，否则用户会看到两个 AI。

## 8. 参考代码索引

| 作用 | 文件 | 行 |
| --- | --- | --- |
| 找会话根 | `01_content/src/client/split.tsx` | 664 |
| 解析锚点 | 同上 | 698 |
| 打开分栏 | 同上 | 766 |
| 重锚定 | 同上 | 900 |
| 挤边距 + 宽度变量 | 同上 | 960–973 |
| 拖宽 | 同上 | 993 |
| 覆盖层根组件 | 同上 | 3135 |
| 打开项目/切换会话 | `01_content/src/client/index.tsx` | 1629 |
| 关闭恢复会话 | 同上 | 1441–1446 |
| 注册 overlay/sidebar | 同上 | 3256–3263 |
| 注入原生 composer | `01_content/src/client/hostInput.ts` | 4 |
| 会话兼容桥 | `01_content/src/client/sessionCompat.ts` | 9 |
| PRD 硬约束 | `02_process/PRD.md` | 331–343 |

GitHub 对应链接（main 分支）：

- <https://github.com/Aisland-SJL/dsh-worktable/blob/main/01_content/src/client/split.tsx#L664>
- <https://github.com/Aisland-SJL/dsh-worktable/blob/main/01_content/src/client/split.tsx#L960>
- <https://github.com/Aisland-SJL/dsh-worktable/blob/main/01_content/src/client/index.tsx#L1629>
- <https://github.com/Aisland-SJL/dsh-worktable/blob/main/01_content/src/client/hostInput.ts#L4>
- <https://github.com/Aisland-SJL/dsh-worktable/blob/main/02_process/PRD.md#L331>

## 8.5 B 方案：知识库路径如何传给聊天 composer

B 方案里 `conversation.view` 是「某个会话内部的一个视图页签」，composer 也是该会话的原生 composer。路径不应该靠每条消息拼字符串，而应该分成两层：

### 第一层（主通道）：会话 cwd

`conversation.view` 注册时能拿到 `sessionId`：

```js
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'wiki-manager',
  label: () => 'WIKI知识库',
  inject: (sessionId) => ({ sessionId }),
}, WikiConversationView))
```

进入知识库时，先确保有一个 **cwd = 知识库根目录** 的会话：

```js
const result = await ctx.sessions.create({ cwd: kb.path })
if (result?.ok) {
  const sessionId = result.value.sessionId
  await openHostSession(ctx, ctx.sessions, sessionId) // worktable 同款双版本兼容
}
```

然后在 WIKI 视图里从 `sessionId` 读 cwd：

```js
const session = ctx.sessions.binding(props.sessionId)?.session
const cwd = session?.cwd
const kb = findKbByPath(cwd) // 精确匹配或最长前缀匹配
```

这样：

- Agent 的文件工具默认工作目录就是知识库根目录，相对路径直接可用；
- composer 不需要显示路径，也不需要每条消息都带路径；
- WIKI 视图根据 cwd 决定显示哪个知识库；切会话时视图跟着会话走。

### 第二层（可选）：显式把路径/当前页写进 composer

只有需要让 AI 明确知道「当前知识库/当前页面」时才写 composer，复用 worktable 的 `appendHostInput` 思路：

```js
const scope = ctx.sessions.scope(props.sessionId)
const input = ctx.conversation.input.for(scope)
const state = input.state.getSnapshot()

if (state && (state.phase === 'plain' || state.phase === 'claimed')) {
  const text = state.draft.trim()
    ? `\n\n当前知识库：${kb.name}\n根目录：${kb.path}`
    : `当前知识库：${kb.name}\n根目录：${kb.path}`
  input.actions.insertText(text, {
    start: state.draft.length,
    end: state.draft.length,
    draftRev: state.draftRev,
  })
  input.focus()
}
```

要点：

- 用 `actions.insertText`，不要直接改 `state.draft`；它会处理 revision/phase 守卫和撤销边界。
- 如果有引用 chip，草稿坐标不是简单字符串长度，直接照抄 `hostInput.ts` 里的 `draftRev` / `occurrences` 计算，不要自己算。
- 只在用户点「引用知识库」/「把当前页面发给 AI」时插入，不要每次打开 WIKI 页签都自动插入，否则会污染草稿、重复消耗 token。
- 如果只是让 Agent 能读文件，第一层的会话 cwd 就够了；第二层是「让模型明确知道上下文」，不是工作目录的替代品。

### 进入知识库的完整路径

```
WIKI 列表点击 KB
  → 查 kbId → sessionId 绑定
  → 没有则 ctx.sessions.create({ cwd: kb.path })
  → openHostSession(sessionId)
  → 打开 WIKI 页签（conversation.view）
  → 视图用 props.sessionId 读 session.cwd → 映射回 KB
  → composer 原生继承该会话 cwd
  → 可选：点“引用知识库”时 insertText
```

### B 方案的两个硬限制

1. **空会话没有视图区**：宿主 `DefaultConversationViews` 在 `session.blank && phase === 'blank'` 时直接返回 null；新建的空白会话不会显示 WIKI 页签。也就是说 B 只能「先有对话，再切 WIKI 页签」，不能像 A 一样「进入知识库立刻看到 WIKI + 聊天」。
2. **`conversation.view` 是全局页签**：注册后所有会话都会出现「WIKI知识库」页签；要么接受「未绑定知识库」空态，要么按当前会话动态注册/注销（复杂且容易闪）。worktable 的 `shell.overlay` 没有这个问题。

所以如果「进入知识库就同时看到图谱和聊天」是硬需求，B 的路径传递虽然能解决 cwd，但解决不了空会话/并排问题，仍然建议 A。

## 9. 下一步

先不改 WIKI 代码。确认方向后建议按以下顺序：

1. 确认「并排原生对话」是否是必须（是 → A；否 → B/C）。
2. 确认 KB ↔ 会话绑定方式：手动绑定现有会话，还是自动为每个 KB 新建会话。
3. 做 A 的单 KB 原型，跑通挤位/拖宽/切会话/关闭恢复。
4. 原型通过后再迁移详情页，最后删除自绘 `/ask-stream` 聊天。
