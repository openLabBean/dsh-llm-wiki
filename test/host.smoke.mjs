/**
 * Host-half route test: registry CRUD, vault validation, graph, node content,
 * catalog and the AI answer route — all through the real HTTP handler with a
 * temporary vault and a stub LLM.
 *
 *   node test/host.smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { apply, inject, internals, name } from '../index.js'

const root = mkdtempSync(join(tmpdir(), 'wiki-manager-test-'))
const vault = join(root, 'vault')
mkdirSync(join(vault, 'wiki', 'concepts'), { recursive: true })
mkdirSync(join(vault, 'wiki', 'entities'), { recursive: true })
writeFileSync(
  join(vault, 'CLAUDE.md'),
  '# schema\n\n## 五、操作工作流\n\n### 5.2 查询（Query）\n\n1. 先读 `wiki/index.md` 定位相关页面。\n2. 深入具体页面，跨页综合，生成**带引用**的答案（引用指向 wiki 页面）。\n3. 答案沉淀：有价值的分析/对比/结论，主动询问用户是否归档回 wiki。\n\n### 5.3 检查（Lint）\n\n1. 扫描全部页面，识别页面间矛盾、孤立页面、被提及但缺少独立页面的概念、过时内容、缺失交叉引用、停滞 deliverables。\n2. 输出结构化问题清单（页面名 + 问题描述 + 建议）。\n\n### 5.4 归档\n\n其它。\n',
)
writeFileSync(
  join(vault, 'wiki', 'index.md'),
  '---\ntitle: 知识库索引\ntype: index\ndomain: MIXED\ntags: [索引]\n---\n\n# 索引\n\n- [[concepts/semantic]] 语义层\n- [[entities/chatbi]] ChatBI\n',
)
writeFileSync(
  join(vault, 'wiki', 'concepts', 'semantic.md'),
  '---\ntitle: 语义层\ntype: concept\ndomain: ONT\ntags: [语义层, 口径]\n---\n\n# 语义层\n\n关联 [[entities/chatbi]]，提到 #治理。\n',
)
writeFileSync(
  join(vault, 'wiki', 'entities', 'chatbi.md'),
  '---\ntitle: ChatBI\ntype: entity\ndomain: AGT\ntags: [智能问数, 语义层, 治理]\n---\n\n# ChatBI\n\n智能问数系统，见 [[concepts/semantic]]。\n',
)
writeFileSync(
  join(vault, 'wiki', 'concepts', 'metric.md'),
  '---\ntitle: 指标语义层\ntype: concept\ndomain: ONT\ntags: [语义层, 指标]\n---\n\n# 指标语义层\n\n见 [[concepts/semantic]]，治理见 #治理。\n',
)
writeFileSync(
  join(vault, 'wiki', 'entities', 'orphan.md'),
  '# 孤岛页\n\nno links here\n',
)

const dataFile = join(root, 'registry.json')
const routes = []
const skillProviders = []
let route
let mcpRoute

const llmCalls = []
let agentTestEnabled = false
let directoryPickerEnabled = false
let agentCreates = 0
let agentDisposed = 0
let agentPresetResolves = 0
let agentPresetMounts = 0
let lastAgentCreateOptions = null
let lastAgentFollowupMessage = null
let sessionEventListeners = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  webServer: {
    register(candidate) {
      routes.push(candidate)
      if (candidate.path === '/wiki-manager/api') route = candidate
      if (candidate.path === '/wiki-manager/mcp') mcpRoute = candidate
      return () => {}
    },
  },
  skills: {
    registerProvider(factory) {
      skillProviders.push(factory)
      return () => {}
    },
  },
  on(_event, listener) {
    sessionEventListeners.push(listener)
    return () => {}
  },
  get(service) {
    if (service === 'llm') {
      return {
        stream(options) {
          llmCalls.push(options)
          return (async function* stream() {
            yield { type: 'text-delta', index: 0, text: '结论：' }
            yield { type: 'text-delta', index: 0, text: '语义层是契约。[[wiki/concepts/semantic.md]]' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
    }
    if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
    if (service === 'directoryPicker' && directoryPickerEnabled) {
      return { capability: () => ({ kind: 'native', pick: async () => vault }) }
    }
    if (service === 'agents' && agentTestEnabled) {
      return {
        async create(options) {
          agentCreates += 1
          lastAgentCreateOptions = options
          if (typeof options.setup === 'function') await options.setup({})
          const agentId = `agent_${agentCreates}`
          const listeners = []
          const handle = {
            agent: {
              id: agentId,
              ctx: {
                on(type, listener) {
                  listeners.push({ type, listener })
                  return () => {}
                },
              },
              followup(message) {
                lastAgentFollowupMessage = message
                for (const item of listeners.filter((entry) => entry.type === 'agent/assistant-stream')) {
                  item.listener({ agent: handle.agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '已检查知识库。[[wiki/concepts/semantic.md]]' } } })
                  item.listener({ agent: { id: 'agent_other' }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '外部会话的内容' } } })
                }
                for (const listener of sessionEventListeners) {
                  listener({ id: agentId }, { type: 'tool/call', data: { name: 'read', callId: 'call_1', arguments: '{"path":"wiki/index.md"}' } })
                  listener({ id: agentId }, { type: 'tool/result', data: { message: { callId: 'call_1', content: [{ type: 'text', text: '索引内容' }] } } })
                  listener({ id: agentId }, { type: 'tool/call', data: { name: 'bash', callId: 'call_2', arguments: '{"command":"ls wiki"}' } })
                  listener({ id: agentId }, { type: 'turn/end', data: {} })
                }
              },
              cancel() {},
              whenIdle: async () => {},
            },
            dispose: async () => {
              agentDisposed += 1
            },
            options,
          }
          return handle
        },
      }
    }
    if (service === 'agentPresets' && agentTestEnabled) {
      return {
        async resolve(presetId) {
          agentPresetResolves += 1
          return { id: presetId ?? 'default' }
        },
        async mount(agentCtx, presetId) {
          agentPresetMounts += 1
          assert.equal(presetId, 'default', 'default agent preset should be mounted')
          return undefined
        },
      }
    }
    return undefined
  },
}

apply(ctx, { dataFile, agentRuntime: true })
assert.equal(name, 'wiki-manager')
assert.deepEqual(inject, ['webServer', 'skills'])
assert.ok(route, 'no wiki route registered')
assert.equal(routes.length, 2, 'expected wiki + mcp routes')
assert.ok(!routes.some((candidate) => candidate.path === '/prompt-studio/api'), 'prompt-studio route should be removed')
assert.ok(routes.some((candidate) => candidate.path === '/wiki-manager/mcp'), 'mcp route missing')
assert.equal(skillProviders.length, 0, 'prompt enhancer skill provider should be removed')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/wiki-manager/api')

function fakeRequest(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  const captures = { status: 0, headers: {}, body: '' }
  return {
    captures,
    writeHead(status, headers) {
      captures.status = status
      captures.headers = headers ?? {}
    },
    end(body) {
      captures.body = body ?? ''
    },
    headersSent: false,
    destroy() {},
  }
}

async function call(method, path, body) {
  const res = fakeResponse()
  await route.handler(fakeRequest(method, path, body), res)
  const parsed = res.captures.body === '' ? undefined : JSON.parse(res.captures.body)
  return { status: res.captures.status, body: parsed }
}

async function callWithTransport(method, path, headers = {}, localPort) {
  const res = fakeResponse()
  const request = fakeRequest(method, path)
  request.headers = headers
  if (localPort !== undefined) request.socket = { localPort }
  await route.handler(request, res)
  const parsed = res.captures.body === '' ? undefined : JSON.parse(res.captures.body)
  return { status: res.captures.status, body: parsed }
}
async function callMcp(payload, token) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
  req.method = 'POST'
  req.url = `/wiki-manager/mcp/${kbId}`
  req.headers = { authorization: `Bearer ${token}` }
  const res = fakeResponse()
  await mcpRoute.handler(req, res)
  const parsed = res.captures.body === '' ? undefined : JSON.parse(res.captures.body)
  return { status: res.captures.status, body: parsed }
}

async function callRaw(method, path, chunks, headers = {}) {
  const req = Readable.from(chunks)
  req.method = method
  req.url = path
  req.headers = headers
  const res = fakeResponse()
  await route.handler(req, res)
  const parsed = res.captures.body === '' ? undefined : JSON.parse(res.captures.body)
  return { status: res.captures.status, body: parsed }
}

let checks = 0
async function check(label, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${label}`)
}

console.log('wiki-manager host smoke test\n')

let kbId
let graphPageTotal = 0
await check('lists an empty registry', async () => {
  const response = await call('GET', '/wiki-manager/api/kbs')
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.items, [])
  assert.equal(response.body.activeId, null)
})

await check('validates a vault path', async () => {
  const response = await call('POST', '/wiki-manager/api/validate', { path: vault })
  assert.equal(response.status, 200)
  assert.equal(response.body.isVault, true)
  assert.equal(response.body.pageCount, 5)
  assert.equal(response.body.hasTemplates, false)
})

await check('rejects a missing directory', async () => {
  const response = await call('POST', '/wiki-manager/api/validate', { path: join(root, 'nope') })
  assert.equal(response.status, 400)
})

await check('registers a knowledge base', async () => {
  const response = await call('POST', '/wiki-manager/api/kbs', { name: '测试库', purpose: '工作', description: '语义层与指标口径', icon: 'book', color: 'purple', path: vault })
  assert.equal(response.status, 200)
  kbId = response.body.item.id
  assert.match(kbId, /^kb_/u)
  assert.equal(response.body.item.name, '测试库')
  assert.equal(response.body.item.description, '语义层与指标口径')
  assert.equal(response.body.item.icon, 'book')
  assert.equal(response.body.item.color, 'purple')
  assert.equal(response.body.validation.pageCount, 5)
  const list = await call('GET', '/wiki-manager/api/kbs')
  assert.equal(list.body.items.length, 1)
  assert.equal(list.body.activeId, kbId)
  assert.equal(list.body.items[0].stats.pages, 6, 'list card pages must cover the whole vault like the graph header')
  assert.ok(Number.isInteger(list.body.items[0].stats.tags), 'list card tag count missing')
})

await check('enables MCP sharing and serves JSON-RPC tools', async () => {
  const enabled = await callWithTransport('POST', `/wiki-manager/api/kbs/${kbId}/mcp`, { host: 'dsh-app://renderer' }, 61119)
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.enabled, true)
  assert.equal(enabled.body.endpoint, `http://127.0.0.1:61119/wiki-manager/mcp/${kbId}`)
  assert.match(enabled.body.token, /^mcp_/u)
  const normal = await callWithTransport('GET', `/wiki-manager/api/kbs/${kbId}/mcp`, { host: '127.0.0.1:61119' })
  assert.equal(normal.body.endpoint, `http://127.0.0.1:61119/wiki-manager/mcp/${kbId}`)
  const token = enabled.body.token
  const initialized = await callMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, token)
  assert.equal(initialized.status, 200)
  assert.equal(initialized.body.result.serverInfo.name, `wiki-${kbId}`)
  const listed = await callMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token)
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'kb_search'))
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'kb_read'))
  const searched = await callMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'kb_search', arguments: { query: '语义', limit: 3 } } }, token)
  const searchPayload = JSON.parse(searched.body.result.content[0].text)
  assert.ok(searchPayload.items.length >= 1)
  const read = await callMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'kb_read', arguments: { path: 'wiki/concepts/semantic.md' } } }, token)
  const readPayload = JSON.parse(read.body.result.content[0].text)
  assert.match(readPayload.markdown, /语义/u)
  const resources = await callMcp({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, token)
  assert.ok(resources.body.result.resources.some((resource) => resource.uri.startsWith('wiki://')))
  const denied = await callMcp({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, 'wrong')
  assert.equal(denied.status, 401)
  const disabled = await call('DELETE', `/wiki-manager/api/kbs/${kbId}/mcp`)
  assert.equal(disabled.body.enabled, false)
})

await check('rejects a duplicate path', async () => {
  const response = await call('POST', '/wiki-manager/api/kbs', { name: '重复', purpose: '工作', path: vault })
  assert.equal(response.status, 409)
})

await check('builds a graph with page and tag nodes', async () => {
  const response = await call('GET', `/wiki-manager/api/graph?kb=${kbId}`)
  assert.equal(response.status, 200)
  const ids = new Set(response.body.nodes.map((node) => node.id))
  assert.ok(ids.has('wiki/concepts/semantic.md'))
  assert.ok(ids.has('wiki/entities/chatbi.md'))
  assert.ok(ids.has('wiki/entities/orphan.md'))
  assert.ok(ids.has('#语义层'))
  assert.ok(response.body.edges.some((edge) => edge.source === 'wiki/concepts/semantic.md' && edge.target === 'wiki/entities/chatbi.md'))
  assert.ok(response.body.edges.some((edge) => edge.source === 'wiki/concepts/semantic.md' && edge.target === 'wiki/entities/chatbi.md'))
  assert.ok(response.body.edges.some((edge) => edge.target === '#治理'))
  assert.equal(response.body.stats.pages, 6, 'graph must cover the whole vault (wiki + CLAUDE.md)')
  assert.ok(response.body.stats.isolated >= 1)
  graphPageTotal = response.body.stats.pages
  const listWithStats = await call('GET', '/wiki-manager/api/kbs')
  assert.equal(listWithStats.body.items[0].stats.pages, graphPageTotal, 'list card pages must equal graph pages')
  assert.equal(listWithStats.body.items[0].stats.tags, response.body.stats.tags, 'list card tags must equal graph tags')
})

await check('serves page content and blocks path escape', async () => {
  const ok = await call('GET', `/wiki-manager/api/node?kb=${kbId}&rel=${encodeURIComponent('wiki/entities/chatbi.md')}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.body.page.title, 'ChatBI')
  assert.ok(ok.body.page.markdown.includes('智能问数'))
  const escaped = await call('GET', `/wiki-manager/api/node?kb=${kbId}&rel=${encodeURIComponent('../../../etc/passwd')}`)
  assert.ok(escaped.status === 403 || escaped.status === 404, `unexpected status ${escaped.status}`)
})

await check('serves the installation file tree lazily', async () => {
  const rootLevel = await call('GET', `/wiki-manager/api/tree?kb=${kbId}`)
  assert.equal(rootLevel.status, 200)
  const names = rootLevel.body.children.map((entry) => entry.name)
  assert.ok(names.includes('wiki'), 'wiki directory missing')
  assert.ok(names.includes('CLAUDE.md'), 'root markdown file missing')
  const wiki = rootLevel.body.children.find((entry) => entry.name === 'wiki')
  assert.equal(wiki.type, 'dir')
  assert.equal(wiki.hasChildren, true)

  const wikiLevel = await call('GET', `/wiki-manager/api/tree?kb=${kbId}&rel=wiki`)
  assert.equal(wikiLevel.status, 200)
  const dirs = wikiLevel.body.children.map((entry) => entry.name)
  assert.ok(dirs.includes('concepts') && dirs.includes('entities'), `wiki level incomplete: ${dirs.join(',')}`)

  const concepts = await call('GET', `/wiki-manager/api/tree?kb=${kbId}&rel=wiki/concepts`)
  assert.ok(concepts.body.children.some((node) => node.type === 'file' && node.path === 'wiki/concepts/semantic.md'))

  const entities = await call('GET', `/wiki-manager/api/tree?kb=${kbId}&rel=wiki/entities`)
  assert.ok(entities.body.children.some((node) => node.type === 'file' && node.path === 'wiki/entities/chatbi.md'))

  const escaped = await call('GET', `/wiki-manager/api/tree?kb=${kbId}&rel=../../etc`)
  assert.ok([400, 403, 404].includes(escaped.status), `unexpected status ${escaped.status}`)
})

await check('serves a catalog for other panels', async () => {
  const response = await call('GET', `/wiki-manager/api/catalog?kb=${kbId}`)
  assert.equal(response.status, 200)
  assert.equal(response.body.root, vault)
  assert.equal(response.body.catalog.length, 5)
  const chatbi = response.body.catalog.find((entry) => entry.p.endsWith('chatbi.md'))
  assert.equal(chatbi.t, 'ChatBI')
  assert.ok(Array.isArray(chatbi.k))
  assert.equal(response.body.templates.wordMaster, null)
})

await check('answers a question through the stub model with sources', async () => {
  const response = await call('POST', '/wiki-manager/api/ask', { kb: kbId, query: '语义层是什么' })
  assert.equal(response.status, 200)
  assert.ok(response.body.answer.includes('语义层'))
  assert.ok(response.body.sources.length > 0)
  assert.equal(response.body.model, 'test-provider/test-model')
  assert.equal(llmCalls.length, 1)
  assert.equal(llmCalls[0].purpose, 'wiki-manager-search')
  assert.ok(llmCalls[0].messages[0].content[0].text.includes('资料'))
  assert.ok(llmCalls[0].system.includes('只能依据'))
  assert.ok(llmCalls[0].system.includes('知识库查询规则'), 'CLAUDE.md query rules missing')
  assert.ok(llmCalls[0].system.includes('先读 `wiki/index.md`'), 'query workflow rule missing')
  assert.ok(llmCalls[0].messages[0].content[0].text.includes('导航索引：wiki/index.md'), 'index navigation page missing')
  assert.equal(response.body.retrieval.queryRules, true)
  assert.equal(response.body.retrieval.indexIncluded, true)
})

await check('serves the editable architecture prompt templates', async () => {
  const response = await call('GET', '/wiki-manager/api/arch-prompt')
  assert.equal(response.status, 200)
  assert.ok(response.body.template.includes('Karpathy'))
  assert.ok(response.body.template.includes('{{知识库根目录}}'))
  assert.ok(response.body.template.includes('SCHEMA.md'))
  assert.equal(response.body.templateId, 'general')
  assert.ok(response.body.path.endsWith('/templates/wiki-arch-prompt.md'), `unexpected template path: ${response.body.path}`)
  const product = await call('GET', '/wiki-manager/api/arch-prompt?template=product')
  assert.equal(product.status, 200)
  assert.equal(product.body.templateId, 'product')
  assert.ok(product.body.template.includes('features/'), 'product template tree missing')
  assert.ok(product.body.path.endsWith('/templates/wiki-arch-prompt-product.md'), `unexpected product template path: ${product.body.path}`)
  const academic = await call('GET', '/wiki-manager/api/arch-prompt?template=academic')
  assert.equal(academic.status, 200)
  assert.ok(academic.body.template.includes('literature/'), 'academic template tree missing')
  assert.ok(academic.body.path.endsWith('/templates/wiki-arch-prompt-academic.md'), `unexpected academic template path: ${academic.body.path}`)
  const finance = await call('GET', '/wiki-manager/api/arch-prompt?template=finance')
  assert.equal(finance.status, 200)
  assert.ok(finance.body.template.includes('theses/'), 'finance template tree missing')
  const invalid = await call('GET', '/wiki-manager/api/arch-prompt?template=unknown')
  assert.equal(invalid.status, 400)
})

await check('streams AI retrieval with stages and sources', async () => {
  const res = {
    status: 0,
    headers: {},
    written: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(chunk) {
      this.written += chunk
    },
    end() {
      this.writableEnded = true
    },
    destroy() {},
  }
  await route.handler(fakeRequest('POST', '/wiki-manager/api/ask-stream', { kb: kbId, query: '语义层是什么' }), res)
  assert.equal(res.status, 200)
  assert.ok(String(res.headers['content-type']).startsWith('text/event-stream'))
  const events = res.written
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => JSON.parse(block.replace(/^data:\s*/u, '')))
  assert.ok(events.some((event) => event.event === 'stage' && event.stage === 'retrieve'))
  assert.ok(events.some((event) => event.event === 'stage' && event.stage === 'think'))
  assert.ok(events.some((event) => event.event === 'thinking'))
  assert.ok(events.some((event) => event.event === 'thinking-done'))
  const answer = events.filter((event) => event.event === 'delta').map((event) => event.text).join('')
  assert.ok(answer.includes('语义层是契约'), 'streamed answer missing')
  const sources = events.find((event) => event.event === 'sources')
  assert.ok(sources.sources.length > 0, 'sources event missing')
  assert.equal(events[events.length - 1].event, 'done')
  assert.equal(events[events.length - 1].model, 'test-provider/test-model')
  assert.equal(llmCalls[llmCalls.length - 1].purpose, 'wiki-manager-search')
  assert.ok(llmCalls.some((call) => call.purpose === 'wiki-manager-think'), 'thinking call missing')
})

await check('streams the native agent timeline when the agent runtime is enabled', async () => {
  agentTestEnabled = true
  try {
    const streamRes = {
      status: 0,
      headers: {},
      written: '',
      headersSent: false,
      writableEnded: false,
      writeHead(status, headers) {
        this.status = status
        this.headers = headers ?? {}
      },
      write(chunk) {
        this.written += chunk
      },
      end() {
        this.writableEnded = true
      },
      destroy() {},
    }
    await route.handler(fakeRequest('POST', '/wiki-manager/api/ask-stream', { kb: kbId, query: '语义层是什么' }), streamRes)
    assert.equal(streamRes.status, 200)
    const events = streamRes.written
      .split('\n\n')
      .filter((block) => block.trim() !== '')
      .map((block) => JSON.parse(block.replace(/^data:\s*/u, '')))
    assert.equal(agentCreates, 1, 'agent session should be created for WIKI AI questions')
    assert.equal(agentPresetResolves, 1, 'default agent preset should be resolved')
    assert.equal(agentPresetMounts, 1, 'default agent preset should be mounted onto the agent context')
    assert.equal(lastAgentCreateOptions.meta.agentPreset, 'default', 'agent session should record the mounted preset')
    assert.equal(typeof lastAgentCreateOptions.setup, 'function', 'agent session should carry the preset setup callback')
    assert.equal(lastAgentFollowupMessage.role, 'user', 'followup message must carry the user role')
    assert.ok(typeof lastAgentFollowupMessage.id === 'string' && lastAgentFollowupMessage.id !== '', 'followup message must be identified')
    assert.ok(Array.isArray(lastAgentFollowupMessage.content), 'followup message content must be an array')
    assert.ok(events.some((event) => event.event === 'stage' && event.stage === 'agent'), 'agent stage missing')
    assert.ok(events.some((event) => event.event === 'step' && event.tool === 'read'), 'agent tool step missing')
    assert.ok(events.some((event) => event.event === 'step-result'), 'agent tool result missing')
    const unmatched = events.filter((event) => event.event === 'step-result' && event.id === 'call_2')
    assert.equal(unmatched.length, 1, 'tool calls without a result frame must be closed before the turn ends')
    assert.equal(unmatched[0].ok, true, 'unmatched pending tool calls should be settled as ok')
    const answer = events.filter((event) => event.event === 'delta').map((event) => event.text).join('')
    assert.ok(answer.includes('已检查知识库'), 'streamed agent answer missing')
    assert.ok(!answer.includes('外部会话的内容'), 'frames from other agents must be ignored')
    assert.equal(events[events.length - 1].event, 'done')
  } finally {
    agentTestEnabled = false
  }
})

await check('runs the knowledge-base lint tool when asked to check', async () => {
  const res = {
    status: 0,
    headers: {},
    written: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(chunk) {
      this.written += chunk
    },
    end() {
      this.writableEnded = true
    },
    destroy() {},
  }
  await route.handler(fakeRequest('POST', '/wiki-manager/api/ask-stream', { kb: kbId, query: '检查知识库' }), res)
  assert.equal(res.status, 200)
  const events = res.written
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => JSON.parse(block.replace(/^data:\s*/u, '')))
  const steps = events.filter((event) => event.event === 'step')
  assert.ok(steps.length >= 3, 'tool steps missing')
  assert.ok(steps.some((step) => step.tool === 'lint'), 'lint tool missing')
  const scanResult = events.find((event) => event.event === 'step-result' && /个页面（wiki 5/.test(String(event.detail)))
  assert.ok(scanResult, 'scan step must report the vault-wide page count with a folder breakdown')
  assert.ok(events.some((event) => event.event === 'delta'), 'lint report missing')
  assert.equal(llmCalls[llmCalls.length - 1].purpose, 'wiki-manager-lint-report')
})

await check('builds a copy-ready lint task for the Agent', async () => {
  assert.equal(typeof internals.buildLintTask, 'function', 'buildLintTask must exist (plugin activation guard)')
  const response = await call('POST', '/wiki-manager/api/lint-task', { kb: kbId })
  assert.equal(response.status, 200)
  assert.equal(response.body.pages, 6)
  assert.equal(response.body.total, 6)
  assert.equal(response.body.total, graphPageTotal, 'lint task page total must match the graph header')
  assert.equal(response.body.rules, true)
  const task = response.body.instruction
  assert.ok(task.includes('# 知识库健康体检任务'))
  assert.ok(task.includes(vault), 'knowledge-base root missing')
  assert.ok(task.includes('孤立页面'), 'lint rules missing')
  assert.ok(task.includes('## 执行步骤'))
  assert.ok(task.includes('## 输出格式'))
  assert.ok(task.includes('不要修改'), 'read-only constraint missing')
  assert.ok(task.includes('归档'), 'archive question missing')
})

await check('loads the CLAUDE.md lint rules', () => {
  const rules = internals.loadLintRules(vault)
  assert.ok(rules.includes('孤立页面'))
  assert.ok(!rules.includes('归档'), 'lint section must stop at the next heading')
})

await check('updates then deletes the knowledge base', async () => {
  const updated = await call('PATCH', `/wiki-manager/api/kbs/${kbId}`, { name: '改名库', purpose: '生活', description: '数据治理实践', icon: 'target', color: 'green' })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.item.name, '改名库')
  assert.equal(updated.body.item.description, '数据治理实践')
  assert.equal(updated.body.item.icon, 'target')
  assert.equal(updated.body.item.color, 'green')
  const removed = await call('DELETE', `/wiki-manager/api/kbs/${kbId}`)
  assert.equal(removed.status, 200)
  const list = await call('GET', '/wiki-manager/api/kbs')
  assert.equal(list.body.items.length, 0)
  assert.equal(list.body.activeId, null)
})

await check('loads the CLAUDE.md query rules before retrieval', () => {
  const rules = internals.loadQueryRules(vault)
  assert.ok(rules.includes('先读 `wiki/index.md`'))
  assert.ok(rules.includes('答案沉淀'))
  assert.ok(!rules.includes('检查（Lint）'), 'section must stop at the next heading')
})

await check('internals parse frontmatter + tags and links', () => {
  const { meta } = internals.parseFrontmatter('---\ntitle: A\ntags: [x, y]\n---\nbody')
  assert.equal(meta.title, 'A')
  const parsed = internals.parseTagsAndLinks('see [[a/b|c]] and #tag1\n```\n[[ignored]]\n```')
  assert.deepEqual(parsed.links, ['a/b'])
  assert.deepEqual(parsed.tags, ['tag1'])
})

await check('lists a local directory level for the directory picker', async () => {
  const data = await call('GET', `/wiki-manager/api/fs/list?path=${encodeURIComponent(vault)}`)
  assert.equal(data.status, 200)
  assert.equal(data.body.path, vault)
  assert.ok(data.body.entries.some((entry) => entry.name === 'wiki'), 'directories missing')
  assert.ok(data.body.crumbs.length > 0, 'breadcrumbs missing')
})

await check('reports native directory picker availability when the service is absent', async () => {
  const response = await call('POST', '/wiki-manager/api/fs/pick-directory')
  assert.equal(response.status, 200)
  assert.equal(response.body.kind, 'unavailable')
})

await check('returns the native directory picker path through the route', async () => {
  directoryPickerEnabled = true
  const response = await call('POST', '/wiki-manager/api/fs/pick-directory')
  directoryPickerEnabled = false
  assert.equal(response.status, 200)
  assert.equal(response.body.kind, 'native')
  assert.equal(response.body.path, vault)
})

await check('broken-link report lists scan scope and concrete links', async () => {
  const report = internals.buildBrokenLinkReport(vault)
  assert.match(report.text, /## 断链扫描/)
  assert.equal(typeof report.matched, 'number')
  assert.ok(Array.isArray(report.sources))
})

await check('orphan report lists the isolated page', async () => {
  const report = internals.buildOrphanReport(vault)
  assert.match(report.text, /## 孤立页面/)
  assert.ok(report.text.includes('orphan.md') || report.text.includes('没有发现孤立页面'))
  assert.match(report.text, /孤立页构成：/)
  assert.equal(report.matched, 2)
})

await check('weekly report contains overview and recent updates', async () => {
  const report = internals.buildWeeklyReport(vault)
  assert.match(report.text, /## 知识库周报/)
  assert.match(report.text, /页面总数：6（wiki 5 · 根目录 1）/)
  assert.ok(Array.isArray(report.sources))
})


await check('uploads and lists prompt suites with attachments', async () => {
  const empty = await call('GET', '/wiki-manager/api/prompt-suites')
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body.items, [])
  const upload = await callRaw('POST', '/wiki-manager/api/prompt-files?name=note.txt&mime=text/plain', [Buffer.from('hello attachment')], { 'content-type': 'text/plain' })
  assert.equal(upload.status, 200)
  assert.equal(upload.body.attachment.name, 'note.txt')
  assert.equal(upload.body.attachment.size, 16)
  const created = await call('POST', '/wiki-manager/api/prompt-suites', { name: '周报套件', purpose: '生成周报', prompt: '请生成周报', attachments: [upload.body.attachment.id] })
  assert.equal(created.status, 200)
  assert.equal(created.body.item.name, '周报套件')
  assert.equal(created.body.item.attachments.length, 1)
  const listed = await call('GET', '/wiki-manager/api/prompt-suites')
  assert.equal(listed.body.items.length, 1)
  const copy = await call('POST', `/wiki-manager/api/prompt-suites/${created.body.item.id}/copy`)
  assert.equal(copy.status, 200)
  assert.equal(copy.body.item.prompt, '请生成周报')
  assert.equal(copy.body.files[0].name, 'note.txt')
  assert.ok(copy.body.files[0].path.endsWith('note.txt') || copy.body.files[0].path.includes(upload.body.attachment.id))
  const updated = await call('PATCH', `/wiki-manager/api/prompt-suites/${created.body.item.id}`, { name: '周报套件 2', prompt: '请生成更完整的周报' })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.item.name, '周报套件 2')
  const cleared = await call('PATCH', `/wiki-manager/api/prompt-suites/${created.body.item.id}`, { attachments: [] })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.item.attachments.length, 0)
  const removedFile = await call('GET', `/wiki-manager/api/prompt-files/${upload.body.attachment.id}`)
  assert.equal(removedFile.status, 404)
  const removed = await call('DELETE', `/wiki-manager/api/prompt-suites/${created.body.item.id}`)
  assert.equal(removed.status, 200)

  const upload2 = await callRaw('POST', '/wiki-manager/api/prompt-files?name=delete.txt&mime=text/plain', [Buffer.from('delete me')], { 'content-type': 'text/plain' })
  const created2 = await call('POST', '/wiki-manager/api/prompt-suites', { name: '待删除套件', prompt: '删除我', attachments: [upload2.body.attachment.id] })
  assert.equal(created2.status, 200)
  const removed2 = await call('DELETE', `/wiki-manager/api/prompt-suites/${created2.body.item.id}`)
  assert.equal(removed2.status, 200)
  const deletedFile = await call('GET', `/wiki-manager/api/prompt-files/${upload2.body.attachment.id}`)
  assert.equal(deletedFile.status, 404)
  const after = await call('GET', '/wiki-manager/api/prompt-suites')
  assert.deepEqual(after.body.items, [])
})

rmSync(root, { recursive: true, force: true })
console.log(`\n${checks} checks passed.`)
