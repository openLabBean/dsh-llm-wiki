/**
 * Client-half behavioural test for the WIKI manager: slot registrations, list
 * view, add modal, graph → node selection, AI answer and delete confirmation.
 * Loads `client.js` with a stub module loader, a tiny hook runtime and a mocked
 * `/wiki-manager/api` fetch router. No browser required.
 *
 *   node test/client.smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const NOW = '2026-10-21T00:00:00.000Z'

// ---------------------------------------------------------------------------
// Tiny React + hook runtime
// ---------------------------------------------------------------------------

let currentRuntime = null

function createRuntime() {
  return { states: [], refs: [], hookIndex: 0, effects: [] }
}
const runtimes = new Map()
function runtimeFor(type) {
  if (!runtimes.has(type)) runtimes.set(type, createRuntime())
  return runtimes.get(type)
}

function createElement(type, props, ...children) {
  return { __el: true, type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
}

const ReactStub = {
  createElement,
  useState(initial) {
    const runtime = currentRuntime
    const index = runtime.hookIndex++
    if (!(index in runtime.states)) runtime.states[index] = typeof initial === 'function' ? initial() : initial
    const set = (value) => {
      runtime.states[index] = typeof value === 'function' ? value(runtime.states[index]) : value
    }
    return [runtime.states[index], set]
  },
  useMemo(fn) {
    currentRuntime.hookIndex += 1
    return fn()
  },
  useEffect(fn) {
    currentRuntime.hookIndex += 1
    currentRuntime.effects.push(fn)
  },
  useCallback(fn) {
    currentRuntime.hookIndex += 1
    return fn
  },
  useRef(initial) {
    const runtime = currentRuntime
    const index = runtime.hookIndex++
    if (!(index in runtime.refs)) runtime.refs[index] = { current: initial }
    return runtime.refs[index]
  },
}

function renderComponent(type, props) {
  const runtime = runtimeFor(type)
  runtime.hookIndex = 0
  runtime.effects = []
  currentRuntime = runtime
  const tree = type(props)
  for (const effect of runtime.effects) effect()
  currentRuntime = null
  return tree
}

// ---------------------------------------------------------------------------
// Environment stubs
// ---------------------------------------------------------------------------

const calls = []
let kbs = []
let graphPayload = null
let treePayload = null
let nodePayload = null
let askPayload = null

globalThis.window = {
  __ModuleLoader__: { load(entry) { (globalThis.__loaded = entry) } },
  setTimeout: (fn) => {
    void fn
    return 0
  },
  clearTimeout: () => {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  devicePixelRatio: 1,
  localStorage: {
    getItem(key) { return nativeStorage.get(key) ?? null },
    setItem(key, value) { nativeStorage.set(key, value) },
    removeItem(key) { nativeStorage.delete(key) },
  },
}
globalThis.setTimeout = () => 0
globalThis.localStorage = globalThis.window.localStorage
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}

function sseReply(events) {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        controller.close()
      },
    }),
  }
}

globalThis.fetch = async (url, init) => {
  const method = init?.method ?? 'GET'
  const parsed = new URL(url, 'http://localhost')
  calls.push({ method, path: parsed.pathname, search: parsed.search, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
  const route = `${method} ${parsed.pathname}`
  const reply = (status, value) => ({ ok: status < 400, status, json: async () => value })

  if (route === 'GET /wiki-manager/api/kbs') return reply(200, { items: kbs.map((item) => ({ ...item, validation: { pageCount: 3, tagCount: 2 } })), activeId: kbs[0]?.id ?? null })
  if (route === 'POST /wiki-manager/api/kbs') {
    const body = JSON.parse(init.body)
    const item = { id: 'kb_new', name: body.name, purpose: body.purpose, description: body.description ?? '', icon: body.icon ?? 'network', color: body.color ?? 'blue', path: body.path, createdAt: NOW, updatedAt: NOW }
    kbs = [item]
    return reply(200, { item, validation: { pageCount: 3 } })
  }
  if (route === 'POST /wiki-manager/api/validate') return reply(200, { path: JSON.parse(init.body).path, isVault: true, pageCount: 3, tagCount: 2, hasTemplates: false })
  if (route === 'DELETE /wiki-manager/api/kbs/kb_new') {
    kbs = []
    return reply(200, { removed: 'kb_new' })
  }
  if (route === 'GET /wiki-manager/api/graph') return reply(200, graphPayload)
  if (route === 'GET /wiki-manager/api/tree') {
    const rel = parsed.searchParams.get('rel') ?? ''
    if (rel === '') return reply(200, { name: 'vault', path: '/tmp/vault', children: treePayload.children, truncated: false })
    if (rel === 'wiki') return reply(200, { path: rel, children: treePayload.wikiChildren, truncated: false })
    if (rel === 'wiki/concepts') return reply(200, { path: rel, children: treePayload.conceptChildren, truncated: false })
    return reply(200, { path: rel, children: [], truncated: false })
  }
  if (route === 'GET /wiki-manager/api/node') return reply(200, { kb: kbs[0], page: nodePayload })
  if (route === 'POST /wiki-manager/api/ask') return reply(200, askPayload)
  if (route === 'POST /wiki-manager/api/ask-stream') {
    return sseReply([
      { event: 'stage', stage: 'rules', rules: true, indexIncluded: true },
            { event: 'step', id: 'call_1', tool: 'read_rules', label: '读取 CLAUDE.md 检查规则', detail: '已加载', status: 'running' },
      { event: 'step-result', id: 'call_1', ok: true, output: '已加载 4 条规则' },
      { event: 'step', id: 'call_2', tool: 'bash', label: '执行命令', detail: 'ls wiki', status: 'running' },
      { event: 'stage', stage: 'retrieve', matched: 1, sources: [{ rel: 'wiki/concepts/semantic.md', title: '语义层', domain: 'ONT' }] },
      { event: 'stage', stage: 'think' },
      { event: 'thinking', text: '## 问题拆解\n- 用户想了解语义层\n' },
      { event: 'thinking-done' },
      { event: 'delta', text: '**结论**：语义层是契约，见 [[wiki/concepts/semantic.md]]。\n\n' },
      { event: 'delta', text: '- 依据一' },
      { event: 'sources', sources: [{ rel: 'wiki/concepts/semantic.md', title: '语义层', domain: 'ONT' }] },
      { event: 'done', model: 'test/model', matched: 1 },
    ])
  }
  if (route === 'GET /wiki-manager/api/prompt-suites') {
    return reply(200, { items: [{ id: 'ps_1', name: '测试套件', purpose: '周报与复盘', prompt: '请生成本周周报', attachments: [], createdAt: NOW, updatedAt: NOW }], limit: 50 * 1024 * 1024 })
  }
  if (route === 'POST /wiki-manager/api/prompt-suites') {
    const body = JSON.parse(init.body)
    return reply(200, { item: { id: 'ps_new', ...body, attachments: [], createdAt: NOW, updatedAt: NOW } })
  }
  if (/^GET \/wiki-manager\/api\/kbs\/[^/]+\/mcp$/u.test(route)) {
    return reply(200, { kbId: kbs[0]?.id ?? 'kb_new', enabled: false, endpointPath: '/wiki-manager/mcp/kb_new', endpoint: '/wiki-manager/mcp/kb_new', token: '', tokenPreview: '', createdAt: null, lastUsedAt: null })
  }
  if (/^POST \/wiki-manager\/api\/kbs\/[^/]+\/mcp$/u.test(route)) {
    return reply(200, { kbId: kbs[0]?.id ?? 'kb_new', enabled: true, endpointPath: '/wiki-manager/mcp/kb_new', endpoint: '/wiki-manager/mcp/kb_new', token: 'mcp_test_token_1234', tokenPreview: 'mcp_…1234', createdAt: NOW, lastUsedAt: null })
  }
  if (/^DELETE \/wiki-manager\/api\/kbs\/[^/]+\/mcp$/u.test(route)) {
    return reply(200, { kbId: kbs[0]?.id ?? 'kb_new', enabled: false, endpointPath: '/wiki-manager/mcp/kb_new', endpoint: '/wiki-manager/mcp/kb_new', token: '', tokenPreview: '', createdAt: null, lastUsedAt: null })
  }
  if (route === 'GET /wiki-manager/api/arch-prompt') {
    const templateId = parsed.searchParams.get('template') ?? 'general'
    if (templateId === 'product') {
      return reply(200, {
        template: '# 产品设计架构提示词\n根目录：{{知识库根目录}}\n产品能力目录：product/、features/、flows/\nSCHEMA.md 与 AGENTS.md',
        path: '/plugin/templates/wiki-arch-prompt-product.md',
        templateId,
      })
    }
    return reply(200, {
      template: '# 架构提示词\n根目录：{{知识库根目录}}\n领域：{{知识领域}}\n用途：{{主要用途}}\nSCHEMA.md 与 AGENTS.md',
      path: '/plugin/templates/wiki-arch-prompt.md',
      templateId,
    })
  }
  if (route === 'POST /wiki-manager/api/lint-task') {
    return reply(200, {
      instruction: '# 知识库健康体检任务\n\n## CLAUDE.md 检查（Lint）要求\n孤立页面、缺失交叉引用、停滞 deliverables\n\n## 执行步骤\n1. 读取目录\n2. 逐页检查\n\n## 输出格式\n## 体检摘要',
      pages: 3,
      total: 3,
      rules: true,
    })
  }
  return reply(404, { error: `unhandled ${route}` })
}

// ---------------------------------------------------------------------------
// Load bundle / register plugin
// ---------------------------------------------------------------------------

await import(pathToFileURL(CLIENT).href)
const loaded = globalThis.__loaded
assert.ok(loaded, 'client bundle did not register')
assert.equal(loaded.id, '@local/dsh-llm-wiki')
const plugin = loaded.factory((id) => {
  if (id === 'react') return ReactStub
  throw new Error(`unexpected require(${id})`)
})
assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout'])

const registrations = []
const dictionaries = {}
const inputSources = []
const panelsOpened = []
const layout = { selectPanel(id) { panelsOpened.push(id) } }
const inputTriggers = {
  registerSource(source) {
    inputSources.push(source)
    return () => {}
  },
}
const nativeAgentCalls = []
const nativeStorage = new Map()
const nativeWorkspaces = {
  async create(input) {
    nativeAgentCalls.push({ type: 'workspace', path: input.path })
    return { workspaceId: 'ws_native' }
  },
}
const nativeSessions = {
  async create(opts) {
    nativeAgentCalls.push({ type: 'session', workspaceId: opts.workspaceId })
    return 'session_native'
  },
  async using(sessionId, opts, run) {
    const reference = {
      ready: Promise.resolve(),
      binding: {
        session: {
          async prompt(content, mode) {
            nativeAgentCalls.push({ type: 'prompt', sessionId, content, mode })
          },
        },
      },
    }
    await run(reference)
  },
}
const nativeUiWorkspace = {
  openSession(sessionId) {
    nativeAgentCalls.push({ type: 'open', sessionId })
  },
}
plugin.apply({
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    register(namespace, dicts) {
      dictionaries[namespace] = dicts
    },
    bind(namespace) {
      return (key) => dictionaries[namespace]?.zh?.[key] ?? key
    },
  },
  layout,
  get(name) {
    if (name === 'inputTriggers') return inputTriggers
    if (name === 'workspaces') return nativeWorkspaces
    if (name === 'sessions') return nativeSessions
    if (name === 'uiWorkspace') return nativeUiWorkspace
    return undefined
  },
  inject(deps, run) {
    const child = { inputTriggers }
    for (const dep of deps) assert.ok(dep === 'inputTriggers' || dep in child, `unknown injected dependency ${dep}`)
    run(child)
  },
  slots: {
    inject(slotName, run) {
      return run()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
})
const main = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'wiki-manager')
const libraryEntry = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'prompt-library')
const side = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
assert.ok(main && libraryEntry && side)
assert.equal(main.options.key, 'wiki-manager')
assert.equal(side.options.id, 'wiki-manager')
assert.equal(side.options.order, 200)
assert.equal(side.options.label(), 'WIKI知识库')
const knowledgeSource = inputSources.find((source) => source.trigger === '@' && source.name === 'wiki-knowledge')
assert.ok(knowledgeSource, '@ knowledge-base source not registered')
assert.equal(knowledgeSource.showGroupTitle, false)

const WikiManager = main.component

// ---------------------------------------------------------------------------
// Element tree helpers
// ---------------------------------------------------------------------------


function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node.__el) return
  visit(node)
  for (const child of node.props.children ?? []) walk(child, visit)
}

function findAll(tree, predicate) {
  const found = []
  walk(tree, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

function textOf(node) {
  let text = ''
  walk(node, (element) => {
    for (const child of element.props.children ?? []) if (typeof child === 'string') text += child
  })
  return text
}

function button(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === label)[0]
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

let render
const restart = () => {
  runtimes.clear()
  render = () => renderComponent(WikiManager, { t: (key) => dictionaries.wikiManager.zh[key] ?? key })
}

let checks = 0
async function check(label, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${label}`)
}

console.log('wiki-manager client smoke test\n')

// ---------------------------------------------------------------------------

restart()
let tree = render()
await flush()
tree = render()

await check('renders the empty state with an add action', () => {
  const text = textOf(tree)
  assert.ok(text.includes('WIKI知识库'))
  assert.ok(text.includes('还没有登记知识库'))
  assert.ok(button(tree, '+ 新增知识库'))
})

await check('exposes the prompt library from the list header and drops the built-in tools area', () => {
  const text = textOf(tree)
  assert.ok(!text.includes('内置工具'), 'builtin tools area should be removed')
  assert.ok(!text.includes('内置丰富易用、具备强交互性的知识库配套工具集'), 'builtin tools hint should be removed')
  assert.equal(findAll(tree, (node) => node.type === 'button' && node.props.className === 'wm-toolCard').length, 0, 'tool cards should be removed')
  const libraryButton = button(tree, '提示词仓库')
  assert.ok(libraryButton !== undefined, 'prompt library button missing from the list header')
  assert.equal(libraryButton.props.className, 'wm-btn', 'prompt library button should be a plain secondary button')
  libraryButton.props.onClick()
  assert.deepEqual(panelsOpened, ['prompt-library'])
})

await check('prompt library lists suites and creates a new suite', async () => {
  const Library = libraryEntry.component
  const renderLibrary = () => renderComponent(Library, { t: (key) => dictionaries.wikiManager.zh[key] ?? key })
  let libTree = renderLibrary()
  await flush()
  libTree = renderLibrary()
  assert.ok(textOf(libTree).includes('提示词仓库'), 'library title missing')
  assert.ok(textOf(libTree).includes('测试套件'), 'suite card missing')
  button(libTree, '+ 新建套件').props.onClick()
  libTree = renderLibrary()
  const inputs = findAll(libTree, (node) => node.type === 'input' && node.props.type !== 'file')
  const textareas = findAll(libTree, (node) => node.type === 'textarea')
  assert.equal(inputs.length, 1, 'expected suite name input')
  assert.equal(textareas.length, 2, 'expected purpose/prompt textareas')
  inputs[0].props.onChange({ target: { value: '新套件' } })
  textareas[0].props.onChange({ target: { value: '用于周报' } })
  textareas[1].props.onChange({ target: { value: '请生成周报' } })
  libTree = renderLibrary()
  button(libTree, '保存').props.onClick()
  await flush()
  const created = calls.find((call) => call.method === 'POST' && call.path === '/wiki-manager/api/prompt-suites')
  assert.ok(created, 'POST /prompt-suites not called')
  assert.equal(created.body.name, '新套件')
  assert.equal(created.body.prompt, '请生成周报')
})

await check('adds a knowledge base through the modal', async () => {
  button(tree, '+ 新增知识库').props.onClick()
  tree = render()
  const modalElement = findAll(tree, (node) => typeof node.type === 'function' && node.props.onSaved !== undefined)[0]
  assert.ok(modalElement, 'edit modal not rendered')
  let modal = renderComponent(modalElement.type, modalElement.props)
  const archOptions = findAll(modal, (node) => node.type === 'button' && String(node.props.className ?? '').includes('wm-archOption'))
  assert.equal(archOptions.length, 5, 'expected 5 architecture template options')
  assert.ok(String(archOptions[0].props.className).includes('wm-archOptionActive'), '通用 should be selected by default')
  assert.ok(textOf(archOptions[0]).includes('通用'), '通用 option label missing')
  assert.ok(textOf(modal).includes('产品设计') && textOf(modal).includes('学术研究') && textOf(modal).includes('金融分析'), 'template option labels missing')
  assert.ok(textOf(modal).includes('不创建'), '不创建 option missing')
  const purposeSelect = findAll(modal, (node) => node.type === 'select')[0]
  assert.ok(purposeSelect, 'purpose select missing')
  assert.deepEqual(
    findAll(purposeSelect, (node) => node.type === 'option').map((node) => node.props.value),
    ['产品设计', '学术研究', '金融分析', '自媒体', '其他'],
    'purpose options should be 产品设计/学术研究/金融分析/自媒体/其他',
  )
  assert.equal(purposeSelect.props.value, '产品设计', 'default purpose should be 产品设计')
  const iconOptions = findAll(modal, (node) => node.type === 'button' && String(node.props.className ?? '').includes('wm-iconOption'))
  assert.equal(iconOptions.length, 36, 'expected 36 selectable icons')
  const iconOption = findAll(modal, (node) => node.type === 'button' && node.props.title === 'book')[0]
  assert.ok(iconOption, 'icon option missing')
  iconOption.props.onClick()
  modal = renderComponent(modalElement.type, modalElement.props)
  const colorOption = findAll(modal, (node) => node.type === 'button' && node.props.title === 'purple')[0]
  assert.ok(colorOption, 'color option missing')
  colorOption.props.onClick()
  modal = renderComponent(modalElement.type, modalElement.props)
  const inputs = findAll(modal, (node) => node.type === 'input')
  const textareas = findAll(modal, (node) => node.type === 'textarea')
  assert.equal(inputs.length, 2, 'expected name/path inputs')
  assert.equal(textareas.length, 1, 'expected description textarea')
  inputs[0].props.onChange({ target: { value: '测试知识库' } })
  textareas[0].props.onChange({ target: { value: '语义层与指标口径' } })
  inputs[1].props.onChange({ target: { value: '/tmp/vault' } })
  modal = renderComponent(modalElement.type, modalElement.props)
  assert.equal(findAll(modal, (node) => node.type === 'input')[1].props.value, '/tmp/vault', 'selected path missing')
  button(modal, '创建').props.onClick()
  await flush()
  tree = render()
  const created = calls.find((call) => call.method === 'POST' && call.path === '/wiki-manager/api/kbs')
  assert.ok(created, 'POST /kbs not called')
  assert.equal(created.body.name, '测试知识库')
  assert.equal(created.body.description, '语义层与指标口径')
  assert.equal(created.body.icon, 'book')
  assert.equal(created.body.color, 'purple')
  assert.equal(created.body.archTemplate, 'general')
  assert.equal(created.body.purpose, '产品设计', 'new knowledge base should send the new default purpose')
  assert.ok(textOf(tree).includes('测试知识库'))
  const cardDesc = findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('wm-cardDesc'))[0]
  assert.ok(cardDesc, 'card description missing')
  assert.ok(textOf(cardDesc).includes('语义层与指标口径'), 'card description text missing')
  const cardIcon = findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('wm-cardIcon'))[0]
  assert.ok(cardIcon, 'card icon missing')
  assert.ok(cardIcon.props.className.includes('wm-cardIconpurple'), 'card icon color missing')
  const glyph = findAll(tree, (node) => typeof node.type === 'function' && node.props?.id === 'book')[0]
  assert.ok(glyph, 'selected card icon missing')
  const firstCard = findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className === 'wm-card')[0]
  assert.ok(firstCard, 'knowledge-base card missing')
  assert.ok(!textOf(firstCard).includes('/tmp/vault'), 'knowledge-base path should not be shown on the card')
  assert.ok(findAll(tree, (node) => node.type === 'button' && /^进入知识库 →$/.test(textOf(node).trim())).length >= 1, 'card enter button missing')
  assert.ok(textOf(firstCard).includes('3 页面'), 'card page count should fall back to validation numbers')
  assert.ok(textOf(firstCard).includes('2 标签'), 'card tag count should fall back to validation numbers')
  assert.ok(textOf(tree).includes('WIKI 架构创建提示词'), 'architecture prompt should open right after creating with 通用')
  assert.ok(textOf(tree).includes('/tmp/vault'), 'knowledge-base path not injected into prompt')
  assert.ok(textOf(tree).includes('SCHEMA.md'), 'general architecture prompt content missing')
  assert.ok(textOf(tree).includes('/plugin/templates/wiki-arch-prompt.md'), 'general template path missing')
  const cancelPrompt = findAll(tree, (node) => node.type === 'button' && textOf(node) === '取消')[0]
  assert.ok(cancelPrompt, 'prompt dialog cancel button missing')
  cancelPrompt.props.onClick()
  tree = render()
  assert.ok(!textOf(tree).includes('WIKI 架构创建提示词'), 'prompt dialog should close on cancel')
})

await check('opens the MCP sharing dialog and enables it', async () => {
  tree = render()
  const open = findAll(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('wm-cardSecondary') && textOf(node).trim() === 'MCP')[0]
  assert.ok(open, 'MCP card button missing')
  await open.props.onClick()
  await flush()
  tree = render()
  const modalElement = findAll(tree, (node) => typeof node.type === 'function' && node.type.name === 'McpShareModal')[0]
  assert.ok(modalElement, 'MCP dialog element missing')
  let modal = renderComponent(modalElement.type, modalElement.props)
  assert.ok(textOf(modal).includes('通过 MCP 共享知识库'), 'MCP dialog title missing')
  button(modal, '启用 MCP 共享').props.onClick()
  await flush()
  const created = calls.find((call) => call.method === 'POST' && /\/mcp$/u.test(call.path))
  assert.ok(created, 'POST /mcp not called')
  const state = runtimeFor(WikiManager).states[6]
  modal = renderComponent(modalElement.type, { ...modalElement.props, state })
  assert.ok(textOf(modal).includes('MCP 共享已启用'), 'enabled state missing')
  const tokenInput = findAll(modal, (node) => node.type === 'input' && node.props.className.includes('wm-mcpTokenInput'))[0]
  assert.equal(tokenInput?.props.value, '*'.repeat(24), 'token should be fully masked by default')
  assert.ok(!textOf(modal).includes('mcpServers'), 'client config should start collapsed')
  assert.ok(findAll(modal, (node) => node.props?.className === 'wm-mcpEye').length === 1, 'token eye control missing')
})

await check('exposes knowledge bases in the @ menu with a hidden path ref', async () => {
  const rows = await knowledgeSource.candidates({}, { query: '' })
  assert.equal(rows.length, 1, 'expected one knowledge-base row')
  assert.equal(rows[0].name, '测试知识库')
  assert.equal(rows[0].description, '/tmp/vault')
  assert.equal(rows[0].icon, 'folder')
  assert.equal(rows[0].section, '知识库')
  assert.equal((await knowledgeSource.candidates({}, { query: '测试' })).length, 1)
  assert.equal((await knowledgeSource.candidates({}, { query: '不存在' })).length, 0)

  const picked = knowledgeSource.onPick({ candidate: rows[0] })
  assert.ok(picked?.insert, 'pick did not return an insert')
  assert.equal(picked.insert.source, 'wiki-knowledge')
  assert.equal(picked.insert.label, '测试知识库')
  assert.equal(picked.insert.appearance, 'file')
  assert.ok(picked.insert.ref.startsWith('kb:'), 'hidden ref missing')
  const serialized = knowledgeSource.codec.serialize(picked.insert.ref)
  assert.ok(serialized.includes('知识库：测试知识库'), 'serialized name missing')
  assert.ok(serialized.includes('根目录：/tmp/vault'), 'serialized path missing')
  assert.ok(serialized.includes('URL：wiki://kb/kb_new'), 'serialized URL missing')
  assert.equal(knowledgeSource.codec.clipboardText(picked.insert.ref), '测试知识库')
})

await check('creates with the 产品设计 architecture template', async () => {
  button(tree, '+ 新增知识库').props.onClick()
  tree = render()
  const modalElement = findAll(tree, (node) => typeof node.type === 'function' && node.props.onSaved !== undefined)[0]
  let modal = renderComponent(modalElement.type, modalElement.props)
  const archOptions = findAll(modal, (node) => node.type === 'button' && String(node.props.className ?? '').includes('wm-archOption'))
  const product = archOptions.find((node) => textOf(node).includes('产品设计'))
  assert.ok(product, '产品设计 option missing')
  product.props.onClick()
  modal = renderComponent(modalElement.type, modalElement.props)
  const inputs = findAll(modal, (node) => node.type === 'input')
  const textareas = findAll(modal, (node) => node.type === 'textarea')
  inputs[0].props.onChange({ target: { value: '产品设计库' } })
  textareas[0].props.onChange({ target: { value: '产品设计与体验' } })
  inputs[1].props.onChange({ target: { value: '/tmp/vault-product' } })
  modal = renderComponent(modalElement.type, modalElement.props)
  button(modal, '创建').props.onClick()
  await flush()
  await flush()
  await flush()
  tree = render()
  const created = calls.filter((call) => call.method === 'POST' && call.path === '/wiki-manager/api/kbs').slice(-1)[0]
  assert.ok(created, 'POST /kbs not called for product template')
  assert.equal(created.body.archTemplate, 'product')
  const archCall = calls.filter((call) => call.path === '/wiki-manager/api/arch-prompt').slice(-1)[0]
  assert.ok(archCall, 'arch-prompt not fetched')
  assert.equal(archCall.search, '?template=product', `unexpected arch-prompt query: ${archCall.search}`)
  assert.ok(textOf(tree).includes('WIKI 架构创建提示词'), 'product prompt dialog missing')
  assert.ok(textOf(tree).includes('/tmp/vault-product'), 'product prompt missing knowledge-base path')
  assert.ok(textOf(tree).includes('/plugin/templates/wiki-arch-prompt-product.md'), 'product template path missing')
  assert.ok(textOf(tree).includes('product/'), 'product template content missing')
  findAll(tree, (node) => node.type === 'button' && textOf(node) === '取消').slice(-1)[0].props.onClick()
  tree = render()
  assert.ok(!textOf(tree).includes('WIKI 架构创建提示词'), 'product prompt should close')
})

await check('skips the architecture prompt when 不创建 is selected', async () => {
  button(tree, '+ 新增知识库').props.onClick()
  tree = render()
  const modalElement = findAll(tree, (node) => typeof node.type === 'function' && node.props.onSaved !== undefined)[0]
  let modal = renderComponent(modalElement.type, modalElement.props)
  const archOptions = findAll(modal, (node) => node.type === 'button' && String(node.props.className ?? '').includes('wm-archOption'))
  const none = archOptions.find((node) => textOf(node).includes('不创建'))
  assert.ok(none, '不创建 option missing')
  none.props.onClick()
  modal = renderComponent(modalElement.type, modalElement.props)
  const inputs = findAll(modal, (node) => node.type === 'input')
  const textareas = findAll(modal, (node) => node.type === 'textarea')
  inputs[0].props.onChange({ target: { value: '已有架构库' } })
  textareas[0].props.onChange({ target: { value: '已有 WIKI 架构' } })
  inputs[1].props.onChange({ target: { value: '/tmp/vault-none' } })
  modal = renderComponent(modalElement.type, modalElement.props)
  const before = calls.filter((call) => call.path === '/wiki-manager/api/arch-prompt').length
  button(modal, '创建').props.onClick()
  await flush()
  await flush()
  await flush()
  tree = render()
  const created = calls.filter((call) => call.method === 'POST' && call.path === '/wiki-manager/api/kbs').slice(-1)[0]
  assert.equal(created.body.archTemplate, 'none')
  assert.equal(calls.filter((call) => call.path === '/wiki-manager/api/arch-prompt').length, before, 'arch-prompt must not be fetched for 不创建')
  assert.ok(!textOf(tree).includes('WIKI 架构创建提示词'), 'prompt dialog should not open for 不创建')
})

await check('opens the detail view and draws the graph', async () => {
  graphPayload = {
    kb: kbs[0],
    nodes: [
      { id: 'wiki/concepts/semantic.md', kind: 'page', label: '语义层', type: 'concept', domain: 'ONT', degree: 3 },
      { id: 'wiki/entities/chatbi.md', kind: 'page', label: 'ChatBI', type: 'entity', domain: 'AGT', degree: 2 },
      { id: 'raw/articles/AgentMemoryBook.md', kind: 'page', label: 'AgentMemoryBook', type: 'source', domain: 'MIXED', degree: 1 },
      { id: '#语义层', kind: 'tag', label: '#语义层', type: 'tag', domain: 'MIXED', degree: 2 },
    ],
    edges: [
      { source: 'wiki/concepts/semantic.md', target: 'wiki/entities/chatbi.md' },
      { source: 'wiki/concepts/semantic.md', target: '#语义层' },
    ],
    stats: { pages: 2, tags: 1, links: 1, isolated: 0 },
  }
  nodePayload = { rel: 'wiki/concepts/semantic.md', title: '语义层', meta: { type: 'concept', domain: 'ONT', status: 'stable' }, markdown: '# 语义层\n\n契约语义是关键。\n\n## 来源\n\n- `raw/articles/AgentMemoryBook.md`（原书译稿）\n- 出处 raw/articles/AgentMemoryBook.md（见上文）\n- `raw/articles/missing.md`（不存在）\n' }
  findAll(tree, (node) => node.type === 'button' && /^进入知识库/.test(textOf(node).trim()))[0].props.onClick()
  await flush()
  tree = render()
  const graphElement = findAll(tree, (node) => typeof node.type === 'function' && node.props.graph !== undefined)[0]
  assert.ok(graphElement, 'graph component missing')
  assert.equal(graphElement.props.graph.nodes.length, 4)
  assert.ok(textOf(tree).includes('2 页'), 'stats not rendered')
  assert.equal(findAll(tree, (node) => node.props?.className === 'wm-side').length, 0, 'right sidebar should start collapsed')
  const expandControl = findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === '‹')[0]
  assert.ok(expandControl, 'expand control missing when collapsed')
  expandControl.props.onClick()
  tree = render()
  const activeTab = findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('wm-tabActive'))[0]
  assert.ok(activeTab, 'active tab missing after expanding')
  assert.equal(textOf(activeTab), 'WIKI AI', 'AI assistant tab should be active by default')
})

await check('legend toggles pages and tags on and off', () => {
  const legendButtons = findAll(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('wm-legendItem'))
  assert.equal(legendButtons.length, 2, 'legend should only list pages and tags')
  const legendLabels = legendButtons.map((item) => textOf(item))
  assert.ok(legendLabels.includes('文件') && legendLabels.includes('标签'), 'legend labels should be 文件/标签')
  const pages = legendButtons.find((item) => textOf(item) === '文件')
  pages.props.onClick()
  tree = render()
  let graphElement = findAll(tree, (node) => node.props.graph !== undefined)[0]
  assert.ok(graphElement.props.hiddenTypes.has('page'), 'hiddenTypes should hide pages')
  const off = findAll(tree, (node) => node.type === 'button' && node.props.className.includes('wm-legendOff'))
  assert.equal(off.length, 1)
  assert.equal(off[0].props['aria-pressed'], false)
  off[0].props.onClick()
  tree = render()
  graphElement = findAll(tree, (node) => node.props.graph !== undefined)[0]
  assert.equal(graphElement.props.hiddenTypes.has('page'), false)
  const tags = findAll(tree, (node) => node.type === 'button' && node.props.className.includes('wm-legendItem')).find((item) => textOf(item) === '标签')
  assert.ok(tags, 'tag legend item missing')
  tags.props.onClick()
  tree = render()
  graphElement = findAll(tree, (node) => node.props.graph !== undefined)[0]
  assert.ok(graphElement.props.hiddenTypes.has('tag'), 'hiddenTypes should hide tags')
  const tagsBack = findAll(tree, (node) => node.type === 'button' && node.props.className.includes('wm-legendItem')).find((item) => textOf(item) === '标签')
  tagsBack.props.onClick()
  tree = render()
})

await check('hiding pages clears the selection', async () => {
  const graphElement = findAll(tree, (node) => node.props.graph !== undefined)[0]
  graphElement.props.onSelect(graphPayload.nodes[0])
  await flush()
  tree = render()
  const visibleMarkdown = findAll(tree, (node) => typeof node.props?.markdown === 'string')
  assert.ok(visibleMarkdown.some((node) => node.props.markdown.includes('契约语义')), 'page content should be visible before hiding')
  const pages = findAll(tree, (node) => node.type === 'button' && typeof node.props.className === 'string' && node.props.className.includes('wm-legendItem')).find((item) => textOf(item) === '文件')
  pages.props.onClick()
  tree = render()
  const hiddenMarkdown = findAll(tree, (node) => typeof node.props?.markdown === 'string')
  assert.ok(!hiddenMarkdown.some((node) => node.props.markdown.includes('契约语义')), 'selection should be cleared when its type is hidden')
  assert.ok(textOf(tree).includes('点击左侧图谱中的节点'), 'empty-state hint missing')
  // restore visibility for the following checks
  const pagesBack = findAll(tree, (node) => node.type === 'button' && node.props.className.includes('wm-legendItem')).find((item) => textOf(item) === '文件')
  pagesBack.props.onClick()
  tree = render()
})

await check('selects a page node and renders its content', async () => {
  const graphElement = findAll(tree, (node) => typeof node.type === 'function' && node.props.graph !== undefined)[0]
  graphElement.props.onSelect(graphPayload.nodes[0])
  await flush()
  tree = render()
  const markdown = findAll(tree, (node) => typeof node.type === 'function' && node.props.markdown !== undefined)
  assert.ok(markdown.length >= 1, 'markdown block missing')
  assert.ok(markdown[0].props.markdown.includes('契约语义'))
  assert.ok(textOf(tree).includes('语义层'))
  const renderedMarkdown = markdown[0].type(markdown[0].props)
  const html = renderedMarkdown.props.dangerouslySetInnerHTML.__html
  const links = (html.match(/data-wikilink="raw\/articles\/AgentMemoryBook\.md"/gu) ?? []).length
  assert.ok(links >= 2, 'vault source paths (code span + plain text) should be clickable')
  assert.ok(!html.includes('data-wikilink="raw/articles/missing.md"'), 'paths missing from the graph stay plain')
  const callsBefore = calls.length
  markdown[0].props.onWikilink('raw/articles/AgentMemoryBook.md')
  await flush()
  const nodeCall = calls.slice(callsBefore).find((call) => call.path === '/wiki-manager/api/node')
  assert.ok(nodeCall, 'clicking a vault source path should open that page')
  assert.ok(nodeCall.search.includes('rel=raw%2Farticles%2FAgentMemoryBook.md'), 'opened rel should be the clicked path')
})

await check('switches to the file tree and opens a page', async () => {
  treePayload = {
    children: [
      { name: 'wiki', type: 'dir', path: 'wiki', hasChildren: true },
      { name: 'CLAUDE.md', type: 'file', path: 'CLAUDE.md', ext: 'md' },
    ],
    wikiChildren: [
      { name: 'concepts', type: 'dir', path: 'wiki/concepts', hasChildren: true },
      { name: 'entities', type: 'dir', path: 'wiki/entities', hasChildren: true },
    ],
    conceptChildren: [{ name: 'semantic.md', type: 'file', path: 'wiki/concepts/semantic.md', ext: 'md' }],
  }
  const treeTab = findAll(tree, (node) => node.type === 'button' && textOf(node) === '目录结构')[0]
  assert.ok(treeTab, 'tree view button missing')
  treeTab.props.onClick()
  await flush()
  tree = render()
  assert.ok(calls.some((call) => call.method === 'GET' && call.path === '/wiki-manager/api/tree'), 'tree endpoint not requested')
  assert.ok(calls.some((call) => call.method === 'GET' && call.search.includes('rel=wiki')), 'lazy wiki level not requested')
  const text = textOf(tree)
  assert.ok(text.includes('wiki') && text.includes('CLAUDE.md'), `tree nodes missing: ${text.slice(0, 200)}`)
  assert.equal(findAll(tree, (node) => node.props.graph !== undefined).length, 0, 'graph should be hidden in tree view')
  assert.ok(findAll(tree, (node) => typeof node.type === 'function' && node.props?.node?.type === 'dir').length >= 1, 'folder icon missing')

  const wikiDir = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('wiki'))[0]
  assert.ok(wikiDir, 'wiki directory node missing')
  wikiDir.props.onClick()
  await flush()
  tree = render()
  const concepts = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('concepts'))[0]
  assert.ok(concepts, 'directory node missing')
  concepts.props.onClick()
  await flush()
  tree = render()
  const fileButton = findAll(tree, (node) => node.type === 'button' && textOf(node) === 'semantic.md')[0]
  assert.ok(fileButton, 'file node missing')
  fileButton.props.onClick()
  await flush()
  tree = render()
  const markdown = findAll(tree, (node) => typeof node.type === 'function' && node.props.markdown !== undefined)
  assert.ok(markdown.length >= 1, 'clicking a file should open its content')
})

await check('switches back to the graph view', () => {
  const graphTab = findAll(tree, (node) => node.type === 'button' && textOf(node) === '关系图谱')[0]
  assert.ok(graphTab, 'graph view button missing')
  graphTab.props.onClick()
  tree = render()
  assert.ok(findAll(tree, (node) => node.props.graph !== undefined).length >= 1, 'graph should be visible again')
})

await check('clears the selection when the canvas background is clicked', () => {
  const graphElement = findAll(tree, (node) => typeof node.type === 'function' && node.props.graph !== undefined)[0]
  assert.equal(typeof graphElement.props.onClear, 'function')
  graphElement.props.onClear()
  const cleared = render()
  assert.ok(!textOf(cleared).includes('wiki/concepts/semantic.md'), 'page path still shown after clear')
  assert.ok(textOf(cleared).includes('向 WIKI AI 提问'), 'inline WIKI AI chat empty state missing after clear')
  const askTab = findAll(cleared, (node) => node.type === 'button' && textOf(node) === 'WIKI AI')[0]
  assert.ok(askTab && askTab.props.className.includes('wm-tabActive'), 'blank-canvas click should return to WIKI AI tab')
})

await check('WIKI AI tab renders the inline chat with page search', () => {
  button(tree, 'WIKI AI').props.onClick()
  tree = render()
  const text = textOf(tree)
  assert.ok(text.includes('向 WIKI AI 提问'), 'inline WIKI AI empty state missing')
  assert.ok(text.includes('输入页面名称'), 'page-search hint missing')
  assert.ok(!text.includes('WIKI Agent'), 'agent session bar should be removed')
  assert.ok(!text.includes('打开已有会话'), 'native-session entry point should be removed')
  assert.ok(!text.includes('扫描断链'), 'quick suggestions should be removed')
  const search = findAll(tree, (node) => node.type === 'input' && String(node.props?.className ?? '').includes('wm-chatSearch'))
  assert.equal(search.length, 0, 'standalone page search input should be removed')
  const composer = findAll(tree, (node) => node.type === 'textarea')[0]
  assert.ok(composer, 'chat composer missing')
  assert.ok(String(composer.props?.placeholder ?? '').includes('输入页面名称'), 'composer placeholder should mention page search')
  assert.ok(button(tree, '发送'), 'send button missing')
})

await check('graph header no longer offers the health check button', () => {
  const health = findAll(tree, (node) => node.type === 'button' && textOf(node) === '健康体检')
  assert.equal(health.length, 0, 'health check button should be removed from the graph header')
  const refresh = findAll(tree, (node) => node.type === 'button' && textOf(node) === '刷新图谱')[0]
  assert.ok(refresh, 'refresh button should still be present')
})

await check('page search opens the matching page', async () => {
  button(tree, 'WIKI AI').props.onClick()
  tree = render()
  const composer = findAll(tree, (node) => node.type === 'textarea')[0]
  assert.ok(composer, 'chat composer missing')
  composer.props.onChange({ target: { value: 'semantic' } })
  tree = render()
  const items = findAll(tree, (node) => node.type === 'button' && String(node.props?.className ?? '').includes('wm-chatSearchItem'))
  assert.ok(items.length >= 1, 'composer page hints missing')
  items[0].props.onClick()
  for (let step = 0; step < 8; step += 1) await flush()
  tree = render()
  assert.ok(textOf(tree).includes('wiki/concepts/semantic.md'), 'clicked page was not opened')
})

await check('chat composer streams the answer inline without opening an agent session', async () => {
  nativeAgentCalls.length = 0
  button(tree, 'WIKI AI').props.onClick()
  tree = render()
  const composer = findAll(tree, (node) => node.type === 'textarea')[0]
  assert.ok(composer, 'chat composer missing')
  composer.props.onChange({ target: { value: '语义层是什么' } })
  tree = render()
  button(tree, '发送').props.onClick()
  for (let step = 0; step < 12; step += 1) await flush()
  tree = render()
  const text = textOf(tree)
  const answers = findAll(tree, (node) => typeof node.type === 'function' && node.props?.markdown !== undefined)
  assert.ok(answers.some((node) => String(node.props.markdown).includes('结论')), 'inline answer missing')
  assert.ok(text.includes('执行过程'), 'step timeline missing')
  assert.ok(text.includes('引用页面'), 'sources missing')
  const foldedSteps = findAll(tree, (node) => node.props?.className === 'wm-chatStep')
  assert.equal(foldedSteps.length, 0, 'execution steps should fold together with the thinking block once the answer is done')
  const stepsHead = findAll(tree, (node) => node.type === 'button' && String(node.props?.className ?? '').includes('wm-chatThinkingHead') && textOf(node).includes('执行过程'))[0]
  assert.ok(stepsHead, 'execution steps header missing')
  assert.ok(textOf(stepsHead).includes('已完成'), 'execution steps header should settle to done once the answer is complete')
  stepsHead.props.onClick()
  tree = render()
  assert.equal(findAll(tree, (node) => node.props?.className === 'wm-chatStep').length, 2, 'clicking the header should unfold the execution steps')
  findAll(tree, (node) => node.type === 'button' && String(node.props?.className ?? '').includes('wm-chatThinkingHead') && textOf(node).includes('执行过程'))[0].props.onClick()
  tree = render()
  assert.equal(findAll(tree, (node) => node.props?.className === 'wm-chatStep').length, 0, 'clicking again should fold the execution steps')
  assert.equal(nativeAgentCalls.length, 0, 'inline chat must not open a native session')
})

await check('collapses and expands the right sidebar', () => {
  const collapse = findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === '›')[0]
  assert.ok(collapse, 'collapse control missing')
  collapse.props.onClick()
  tree = render()
  const expand = findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === '‹')[0]
  assert.ok(expand, 'expand control missing')
  expand.props.onClick()
  tree = render()
})

await check('deletes with a confirmation step', async () => {
  button(tree, '← 返回列表').props.onClick()
  tree = render()
  button(tree, '删除').props.onClick()
  tree = render()
  const confirm = button(tree, '确认删除')
  assert.ok(confirm, 'confirmation action missing')
  assert.ok(textOf(tree).includes('不会删除本地文件'))
  confirm.props.onClick()
  await flush()
  tree = render()
  const removed = calls.find((call) => call.method === 'DELETE' && call.path === '/wiki-manager/api/kbs/kb_new')
  assert.ok(removed, 'DELETE not called')
})

await check('returns to the last visited page after remounting the plugin', async () => {
  kbs = [{ id: 'kb_demo', name: 'DataPilot 知识库', purpose: '产品设计', description: '演示库', icon: 'network', color: 'blue', path: '/tmp/datapilot', createdAt: NOW, updatedAt: NOW }]
  graphPayload = { ...graphPayload, kb: kbs[0] }
  restart()
  tree = render()
  await flush()
  tree = render()
  const enter = findAll(tree, (node) => node.type === 'button' && /^进入知识库/.test(textOf(node).trim()))[0]
  assert.ok(enter, 'enter button missing')
  enter.props.onClick()
  await flush()
  tree = render()
  const graphElement = findAll(tree, (node) => typeof node.type === 'function' && node.props.graph !== undefined)[0]
  graphElement.props.onSelect(graphPayload.nodes[0])
  await flush()
  tree = render()
  assert.ok(
    findAll(tree, (node) => typeof node.props?.markdown === 'string').some((node) => String(node.props.markdown).includes('契约语义')),
    'page should be open before the remount',
  )
  const raw = nativeStorage.get('dsh-wiki-manager:last-location')
  assert.ok(raw, 'last location should be persisted while a page is open')
  const stored = JSON.parse(raw)
  assert.equal(stored.kbId, 'kb_demo')
  assert.equal(stored.pageRel, 'wiki/concepts/semantic.md')
  restart()
  for (let step = 0; step < 5; step += 1) {
    tree = render()
    await flush()
  }
  const restored = textOf(tree)
  assert.ok(restored.includes('wiki/concepts/semantic.md'), `restored page path missing: ${restored.slice(0, 160)}`)
  assert.ok(
    findAll(tree, (node) => typeof node.props?.markdown === 'string').some((node) => String(node.props.markdown).includes('契约语义')),
    'restored page content missing',
  )
  assert.ok(findAll(tree, (node) => node.props.graph !== undefined).length >= 1, 'restored detail view should render the graph')
  assert.ok(!restored.includes('还没有登记知识库'), 'should not fall back to the empty/list view')
})

await check('forgets the saved location after returning to the list', async () => {
  button(tree, '← 返回列表').props.onClick()
  tree = render()
  assert.equal(nativeStorage.get('dsh-wiki-manager:last-location'), undefined, 'returning to the list should clear the saved location')
  assert.ok(textOf(tree).includes('WIKI知识库'), 'list view missing after going back')
})

await check('sidebar glyph renders an svg', () => {
  const icon = side.component({ size: 18, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)
})

console.log(`\n${checks} checks passed.`)
