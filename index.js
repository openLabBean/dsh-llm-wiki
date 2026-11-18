/**
 * @local/dsh-llm-wiki — Host half.
 *
 * Serves the "WIKI 管理" panel over named HTTP routes on the Host's web server:
 *   - knowledge-base registry (add / edit / delete / activate)
 *   - vault validation on registration
 *   - graph data (pages + tags + wikilink edges)
 *   - page content for the node viewer
 *   - a page catalog + template paths for other panels (prompt studio)
 *   - AI retrieval: keyword retrieval over the vault, then one LLM call whose
 *     answer cites the pages it used
 *
 * The Desktop renderer forwards every same-origin path to the Host, so the
 * Client half only needs `fetch('/wiki-manager/api/…')`; no generated RPC code.
 *
 * Optional services (`llm`, `agentDefaultModel`) are looked up per request, so
 * the plugin still activates on profiles without them.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { basename, dirname, extname, isAbsolute, join, normalize, parse as parsePath, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const name = 'wiki-manager'
export const inject = ['webServer', 'skills']

const ROUTE_PREFIX = '/wiki-manager/api'
const MCP_PREFIX = '/wiki-manager/mcp'
const MCP_PROTOCOL_VERSION = '2025-06-18'
const REGISTRY_VERSION = 1
const KB_COLORS = new Set(['blue', 'purple', 'green', 'teal', 'orange', 'pink', 'gray'])
const KB_ICONS = new Set([
  'network',
  'book',
  'folder',
  'layers',
  'bulb',
  'beaker',
  'database',
  'globe',
  'pen',
  'briefcase',
  'star',
  'chart',
  'code',
  'target',
  'cloud',
  'shield',
  'bolt',
  'cube',
  'compass',
  'bookmark',
  'flag',
  'chat',
  'image',
  'pin',
  'library',
  'bookOpen',
  'notebook',
  'file',
  'graduation',
  'archive',
  'graph',
  'nodes',
  'hierarchy',
  'flow',
  'microscope',
  'telescope',
  'search',
  'brain',
  'puzzle',
  'key',
  'bookStack',
  'bookMarked',
  'books',
  'brainPulse',
  'mind',
  'sparkles',
  'wand',
  'idea',
])
const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.dsh'])
const SKIP_FILES = new Set(['log.md'])
const MAX_GRAPH_NODES = 900
const ARCH_PROMPT_DIR = fileURLToPath(new URL('./templates/', import.meta.url))
const ARCH_PROMPT_FILE = join(ARCH_PROMPT_DIR, 'wiki-arch-prompt.md')
const ARCH_PROMPT_TEMPLATES = new Map([
  ['general', 'wiki-arch-prompt.md'],
  ['product', 'wiki-arch-prompt-product.md'],
  ['academic', 'wiki-arch-prompt-academic.md'],
  ['finance', 'wiki-arch-prompt-finance.md'],
])
const MAX_PAGE_BYTES = 512 * 1024
const SCAN_CACHE_MS = 20_000

// ---------------------------------------------------------------------------
// Registry storage
// ---------------------------------------------------------------------------

function defaultDataFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'wiki-manager', 'knowledge-bases.json')
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, activeId: null, items: [] }
}

function readRegistry(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.items)) return emptyRegistry()
    return {
      version: REGISTRY_VERSION,
      activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
      items: raw.items.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string'),
    }
  } catch {
    return emptyRegistry()
  }
}

let writeChain = Promise.resolve()
function writeRegistry(file, data) {
  const next = writeChain.then(() => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ ...data, version: REGISTRY_VERSION }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  })
  writeChain = next.catch(() => {})
  return next
}

const kbView = (item) => {
  const { mcp: _mcp, ...rest } = item
  return { ...rest, mcpEnabled: _mcp?.enabled === true }
}

const PROMPT_LIBRARY_LIMIT = 50 * 1024 * 1024
const PROMPT_ATTACHMENT_LIMIT = 30

function promptLibraryRoot(dataFile) {
  return join(dirname(dataFile), 'prompt-library')
}

function readPromptSuites(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.items)) return { version: 1, items: [] }
    return { version: 1, items: raw.items.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string') }
  } catch {
    return { version: 1, items: [] }
  }
}

function writePromptSuites(file, data) {
  const next = writeChain.then(() => {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ version: 1, items: data.items }, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  })
  writeChain = next.catch(() => {})
  return next
}

function attachmentMetaPath(root, id) {
  return join(root, 'files', `${id}.json`)
}

function attachmentFilePath(root, meta) {
  return join(root, 'files', meta.storedName)
}

function readAttachmentMeta(root, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) throw httpError(400, `附件标识不合法：${id}`)
  try {
    const meta = JSON.parse(readFileSync(attachmentMetaPath(root, id), 'utf8'))
    if (meta === null || typeof meta !== 'object' || typeof meta.storedName !== 'string') throw new Error('bad')
    return meta
  } catch {
    throw httpError(404, `附件不存在：${id}`)
  }
}

function resolveAttachmentIds(root, ids) {
  if (!Array.isArray(ids)) return []
  if (ids.length > PROMPT_ATTACHMENT_LIMIT) throw httpError(400, `单个套件最多 ${PROMPT_ATTACHMENT_LIMIT} 个附件`)
  return [...new Set(ids.map((id) => String(id)))].map((id) => readAttachmentMeta(root, id))
}

function attachmentView(meta) {
  return { id: meta.id, name: meta.name, size: meta.size, mime: meta.mime }
}

function deleteAttachmentFiles(root, attachments) {
  for (const meta of attachments) {
    for (const file of [attachmentFilePath(root, meta), attachmentMetaPath(root, meta.id)]) {
      try { unlinkSync(file) } catch {}
    }
  }
}

async function persistAttachment(req, root, rawName, mime) {
  const decoded = (() => { try { return decodeURIComponent(rawName) } catch { return rawName } })()
  const name = basename(String(decoded || '附件')).replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_').slice(0, 180) || '附件'
  const ext = extname(name).toLowerCase().slice(0, 16)
  const id = randomUUID()
  const storedName = `${id}${ext}`
  const filesDir = join(root, 'files')
  mkdirSync(filesDir, { recursive: true })
  const tmp = join(filesDir, `${id}.uploading`)
  const target = join(filesDir, storedName)
  let size = 0
  try {
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > PROMPT_LIBRARY_LIMIT) {
          callback(httpError(413, '单个附件不能超过 50 MB'))
          return
        }
        callback(null, chunk)
      },
    })
    await pipeline(req, limiter, createWriteStream(tmp))
    renameSync(tmp, target)
  } catch (error) {
    try { unlinkSync(tmp) } catch {}
    if (error && error.status === 413) throw error
    throw httpError(500, `附件保存失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const meta = {
    id,
    name,
    size,
    mime: String(mime || 'application/octet-stream').replace(/[\r\n]/gu, '').slice(0, 120) || 'application/octet-stream',
    storedName,
    createdAt: new Date().toISOString(),
  }
  writeFileSync(attachmentMetaPath(root, id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return meta
}

function serveAttachment(res, root, id) {
  const meta = readAttachmentMeta(root, id)
  const file = attachmentFilePath(root, meta)
  if (!existsSync(file)) throw httpError(404, `附件文件不存在：${meta.name}`)
  const stat = statSync(file)
  res.writeHead(200, {
    'content-type': meta.mime,
    'content-length': String(stat.size),
    'cache-control': 'private, max-age=60',
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
  })
  createReadStream(file).pipe(res)
  return true
}


// ---------------------------------------------------------------------------
// Vault scanning
// ---------------------------------------------------------------------------

/** @typedef {{ rel: string, abs: string, title: string, type: string, domain: string, tags: string[], links: string[], body: string }} VaultPage */

function parseFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  const meta = {}
  if (match === null) return { meta, body: raw }
  for (const line of match[1].split(/\r?\n/u)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (kv !== null) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/gu, '')
  }
  return { meta, body: raw.slice(match[0].length) }
}

function walkMarkdown(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkMarkdown(abs, out)
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(abs)
    }
  }
  return out
}

function wikiDirectory(root) {
  const nested = join(root, 'wiki')
  return existsSync(nested) && statSync(nested).isDirectory() ? nested : root
}

/** Parse tags + links of one page body (fences are stripped so code samples do not create edges). */
function parseTagsAndLinks(body) {
  const text = body.replace(/```[\s\S]*?```/gu, '').replace(/`[^`\n]*`/gu, '')
  const links = new Set()
  for (const match of text.matchAll(/\[\[([^\]\n]+?)\]\]/gu)) {
    const target = match[1].split('|')[0].split('#')[0].trim()
    if (target !== '') links.add(target)
  }
  const tags = new Set()
  for (const match of text.matchAll(/(?:^|[\s(（])#([\p{L}\p{N}_/-]{2,40})/gu)) tags.add(match[1])
  return { links: [...links], tags: [...tags] }
}

const scanCache = new Map()

function scanVault(root) {
  const cached = scanCache.get(root)
  if (cached !== undefined && Date.now() - cached.at < SCAN_CACHE_MS) return cached.pages
  const dir = wikiDirectory(root)
  const files = walkMarkdown(dir, []).sort()
  const pages = []
  for (const abs of files) {
    let raw
    try {
      raw = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseFrontmatter(raw)
    const parsed = parseTagsAndLinks(body)
    const declared = String(meta.tags ?? '')
      .replace(/^\[|\]$/gu, '')
      .split(',')
      .map((tag) => tag.trim().replace(/^#/u, ''))
      .filter((tag) => tag !== '')
    pages.push({
      rel: relative(root, abs).split(sep).join('/'),
      abs,
      title: meta.title || basename(abs).replace(/\.md$/u, ''),
      type: meta.type || 'page',
      domain: meta.domain || 'MIXED',
      status: meta.status || '',
      lastUpdated: meta.last_updated || '',
      tags: [...new Set([...declared, ...parsed.tags])],
      links: parsed.links,
      body,
    })
  }
  scanCache.set(root, { at: Date.now(), pages })
  return pages
}

// ---------------------------------------------------------------------------
// Validation, graph, catalog
// ---------------------------------------------------------------------------

function normalizePath(input) {
  if (typeof input !== 'string' || input.trim() === '') throw httpError(400, '知识库路径不能为空')
  if (!isAbsolute(input.trim())) throw httpError(400, '请填写绝对路径（以 / 开头）')
  const abs = resolve(input.trim())
  const stat = statSync(abs, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isDirectory()) throw httpError(400, `目录不存在：${abs}`)
  return abs
}

function validateVault(root) {
  const pages = scanVault(root)
  const templates = join(root, 'wiki', 'templates')
  const hasTemplates = existsSync(templates) && statSync(templates).isDirectory()
  const hasSchema = existsSync(join(root, 'CLAUDE.md'))
  return {
    path: root,
    isVault: hasSchema || hasTemplates,
    hasSchema,
    hasTemplates,
    pageCount: pages.length,
    tagCount: new Set(pages.flatMap((page) => page.tags)).size,
    title: basename(root),
  }
}

function resolveLinkTarget(target, indices, sourceRel) {
  const clean = target
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/#.*$/u, '')
    .replace(/\.md$/iu, '')
    .replace(/\/+$/u, '')
    .trim()
    .toLowerCase()
  if (clean === '') return undefined
  const withoutPrefix = clean.replace(/^wiki\//u, '')
  const candidates = [clean, withoutPrefix, `wiki/${clean}`]
  if (sourceRel) {
    const dir = dirname(String(sourceRel).replace(/\\/gu, '/'))
    candidates.push(normalize(join(dir, clean)), normalize(join(dir, '..', clean)))
  }
  for (const candidate of candidates) {
    const hit = indices.byPath.get(candidate)
    if (hit !== undefined) return hit
  }
  return indices.byName.get(basename(withoutPrefix)) ?? undefined
}

/** A wiki link may point at a skipped page (log.md, CLAUDE.md) or a non-md asset. */
function linkTargetExists(root, link, sourceRel) {
  const clean = link
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/#.*$/u, '')
    .replace(/\.md$/iu, '')
    .replace(/\/+$/u, '')
    .trim()
  if (clean === '') return true
  const dir = sourceRel ? dirname(String(sourceRel).replace(/\\/gu, '/')) : ''
  const candidates = [clean, `wiki/${clean}`]
  if (dir !== '' && dir !== '.') {
    candidates.push(normalize(join(dir, clean)), normalize(join(dir, '..', clean)))
  }
  for (const candidate of candidates) {
    if (candidate.startsWith('..') || isAbsolute(candidate)) continue
    const abs = join(root, candidate)
    if (existsSync(abs) || existsSync(`${abs}.md`) || existsSync(`${abs}.MD`)) return true
  }
  return false
}

const MAX_TREE_ENTRIES = 3000
const TREE_SKIP = new Set(['.git', 'node_modules', '.trash', '.DS_Store', '.dsh'])

function resolveTreeDir(root, rel) {
  const base = resolve(root)
  const target = rel === '' ? base : resolve(base, rel)
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw httpError(403, '路径越界')
  let real = target
  let realRoot = base
  try {
    real = realpathSync(target)
    realRoot = realpathSync(base)
  } catch {
    /* keep the unresolved path for the stat check below */
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) throw httpError(403, '路径越界')
  const stat = statSync(target, { throwIfNoEntry: false })
  if (stat === undefined) throw httpError(404, '目录不存在')
  if (!stat.isDirectory()) throw httpError(400, '不是目录')
  return target
}

/** One level of the knowledge-base installation tree (lazy-loaded per folder). */
function listTreeLevel(root, rel) {
  const dir = resolveTreeDir(root, rel)
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (TREE_SKIP.has(entry.name)) continue
    const abs = join(dir, entry.name)
    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()
    if (entry.isSymbolicLink()) {
      try {
        const stat = statSync(abs)
        isDirectory = stat.isDirectory()
        isFile = stat.isFile()
      } catch {
        continue
      }
    }
    if (isDirectory) dirs.push({ name: entry.name, abs })
    else if (isFile) files.push({ name: entry.name, abs })
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh')
  dirs.sort(byName)
  files.sort(byName)
  const relativePath = (abs) => relative(root, abs).split(sep).join('/')
  const children = [
    ...dirs.map((entry) => ({ name: entry.name, path: relativePath(entry.abs), type: 'dir', hasChildren: true })),
    ...files.map((entry) => {
      const ext = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase() : ''
      return { name: entry.name, path: relativePath(entry.abs), type: 'file', ext }
    }),
  ]
  return { path: rel, children: children.slice(0, MAX_TREE_ENTRIES), truncated: children.length >= MAX_TREE_ENTRIES }
}

const scanAllCache = new Map()

/** Every Markdown file in the vault, including raw sources and deliverables. */
function scanAllVault(root) {
  const cached = scanAllCache.get(root)
  if (cached !== undefined && Date.now() - cached.at < SCAN_CACHE_MS) return cached.pages
  const files = walkMarkdown(root, []).sort()
  const pages = []
  for (const abs of files) {
    let raw
    try {
      raw = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseFrontmatter(raw)
    const parsed = parseTagsAndLinks(body)
    const declared = String(meta.tags ?? '')
      .replace(/^\[|\]$/gu, '')
      .split(',')
      .map((tag) => tag.trim().replace(/^#/u, ''))
      .filter((tag) => tag !== '')
    pages.push({
      rel: relative(root, abs).split(sep).join('/'),
      abs,
      title: meta.title || basename(abs).replace(/\.md$/u, ''),
      type: meta.type || 'page',
      domain: meta.domain || 'MIXED',
      status: meta.status || '',
      lastUpdated: meta.last_updated || '',
      tags: [...new Set([...declared, ...parsed.tags])],
      links: parsed.links,
      body,
    })
  }
  scanAllCache.set(root, { at: Date.now(), pages })
  return pages
}

function buildGraph(root) {
  // Graph mirrors the whole vault (notes + raw sources + deliverables), like
  // Obsidian's graph; the AI/health-check pipeline still uses scanVault(wiki).
  const pages = scanAllVault(root)
  const indices = { byPath: new Map(), byName: new Map() }
  for (const page of pages) {
    const rel = page.rel.replace(/\.md$/iu, '').toLowerCase()
    indices.byPath.set(rel, page)
    indices.byPath.set(rel.replace(/^wiki\//u, ''), page)
    const key = basename(rel)
    if (!indices.byName.has(key)) indices.byName.set(key, page)
  }

  const degree = new Map()
  const edgeKeys = new Set()
  const edges = []
  const pushEdge = (source, target) => {
    const key = `${source}\u0000${target}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ source, target })
    degree.set(source, (degree.get(source) ?? 0) + 1)
    degree.set(target, (degree.get(target) ?? 0) + 1)
  }

  const tagCount = new Map()
  for (const page of pages) for (const tag of page.tags) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
  // Keep the tag layer readable: only recurring tags, capped by frequency.
  const visibleTags = new Set(
    [...tagCount.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 160)
      .map(([tag]) => tag),
  )

  for (const page of pages) {
    for (const target of page.links) {
      const hit = resolveLinkTarget(target, indices, page.rel)
      if (hit !== undefined && hit.rel !== page.rel) pushEdge(page.rel, hit.rel)
    }
    for (const tag of page.tags) if (visibleTags.has(tag)) pushEdge(page.rel, `#${tag}`)
  }

  let nodes = pages.map((page) => ({
    id: page.rel,
    kind: 'page',
    label: page.title,
    type: page.type,
    domain: page.domain,
    rel: page.rel,
    degree: degree.get(page.rel) ?? 0,
  }))
  const tags = [...visibleTags].map((tag) => ({
    id: `#${tag}`,
    kind: 'tag',
    label: `#${tag}`,
    type: 'tag',
    domain: 'MIXED',
    degree: tagCount.get(tag) ?? 0,
  }))
  nodes = nodes.concat(tags)

  if (nodes.length > MAX_GRAPH_NODES) {
    nodes = nodes.sort((a, b) => b.degree - a.degree).slice(0, MAX_GRAPH_NODES)
    const keep = new Set(nodes.map((node) => node.id))
    edges.length = 0
    for (const [key] of edgeKeys) {
      const [source, target] = key.split('\u0000')
      if (keep.has(source) && keep.has(target)) edges.push({ source, target })
    }
  }

  const linked = new Set()
  for (const edge of edges) {
    linked.add(edge.source)
    linked.add(edge.target)
  }
  return {
    nodes,
    edges,
    stats: {
      pages: pages.length,
      tags: tags.length,
      links: edges.filter((edge) => !edge.target.startsWith('#')).length,
      isolated: nodes.filter((node) => node.kind === 'page' && !linked.has(node.id)).length,
    },
  }
}

function keywordsOf(page) {
  const words = new Set(page.tags)
  for (const run of page.title.match(/[\u3400-\u9fff]{2,8}/gu) ?? []) words.add(run)
  for (const word of page.title.toLowerCase().match(/[a-z][a-z0-9.]{2,}/gu) ?? []) words.add(word)
  return [...words].slice(0, 10)
}

function buildCatalog(root) {
  const pages = scanVault(root)
  const templates = join(root, 'wiki', 'templates')
  const fileIfExists = (candidate) => (existsSync(candidate) ? candidate : null)
  return {
    root,
    catalog: pages.map((page) => ({
      p: page.rel,
      t: page.title,
      y: page.type,
      d: page.domain,
      k: keywordsOf(page),
    })),
    templates: {
      dir: existsSync(templates) ? templates : null,
      wordSpec: fileIfExists(join(templates, 'word-文档写作模板.md')),
      pptSpec: fileIfExists(join(templates, 'ppt-演示文稿写作模板.md')),
      wordMaster: fileIfExists(join(templates, 'Typora-Word2.docx')),
      pptMaster: fileIfExists(join(templates, '浩鲸科技_20周年_ppt中文模板_白.potx')),
      readme: fileIfExists(join(templates, 'README.md')),
    },
  }
}

// ---------------------------------------------------------------------------
// Retrieval + AI answer
// ---------------------------------------------------------------------------

function tokenizeQuery(query) {
  const tokens = new Map()
  const add = (token, weight) => {
    if (token.length >= 2) tokens.set(token, Math.max(tokens.get(token) ?? 0, weight))
  }
  for (const word of String(query).toLowerCase().match(/[a-z][a-z0-9._-]{1,}/gu) ?? []) {
    add(word, 2)
    for (const part of word.split(/[._-]/u)) add(part, 1.5)
  }
  for (const run of String(query).match(/[\u3400-\u9fff]+/gu) ?? []) {
    if (run.length <= 6) add(run, 3)
    for (let i = 0; i + 2 <= run.length; i += 1) add(run.slice(i, i + 2), 1)
    for (let i = 0; i + 3 <= run.length && run.length > 6; i += 1) add(run.slice(i, i + 3), 1.2)
  }
  return tokens
}

const QUERY_RULES_CACHE = new Map()

/**
 * Read the "查询（Query）" section of <root>/CLAUDE.md before any retrieval.
 * Those workflow rules (read wiki/index.md first, cite pages, ask before
 * archiving) are injected into the answer prompt.
 */
function loadQueryRules(root) {
  const cached = QUERY_RULES_CACHE.get(root)
  if (cached !== undefined && Date.now() - cached.at < SCAN_CACHE_MS) return cached.text
  const file = join(root, 'CLAUDE.md')
  if (!existsSync(file)) {
    QUERY_RULES_CACHE.set(root, { at: Date.now(), text: '' })
    return ''
  }
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    raw = ''
  }
  const lines = raw.split('\n')
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+.*查询\s*[（(]\s*Query\s*[）)]/iu.test(line))
  if (headingIndex === -1) {
    QUERY_RULES_CACHE.set(root, { at: Date.now(), text: '' })
    return ''
  }
  const level = (/^(#+)/u.exec(lines[headingIndex]) ?? ['', '#'])[1].length
  let end = lines.length
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const next = /^(#{1,6})\s+/u.exec(lines[i])
    if (next !== null && next[1].length <= level) {
      end = i
      break
    }
  }
  const text = lines
    .slice(headingIndex + 1, end)
    .join('\n')
    .replace(/\n---\s*$/u, '')
    .trim()
  QUERY_RULES_CACHE.set(root, { at: Date.now(), text })
  return text
}

const LINT_RULES_CACHE = new Map()

/** Read the "检查（Lint）" section of <root>/CLAUDE.md (cached 20s). */
function loadLintRules(root) {
  const cached = LINT_RULES_CACHE.get(root)
  if (cached !== undefined && Date.now() - cached.at < SCAN_CACHE_MS) return cached.text
  const file = join(root, 'CLAUDE.md')
  let text = ''
  if (existsSync(file)) {
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      raw = ''
    }
    const lines = raw.split('\n')
    const headingIndex = lines.findIndex((line) => /^#{1,6}\s+.*检查\s*[（(]\s*Lint\s*[）)]/iu.test(line))
    if (headingIndex !== -1) {
      const level = (/^(#+)/u.exec(lines[headingIndex]) ?? ['', '#'])[1].length
      let end = lines.length
      for (let i = headingIndex + 1; i < lines.length; i += 1) {
        const next = /^(#{1,6})\s+/u.exec(lines[i])
        if (next !== null && next[1].length <= level) {
          end = i
          break
        }
      }
      text = lines
        .slice(headingIndex + 1, end)
        .join('\n')
        .replace(/\n---\s*$/u, '')
        .trim()
    }
  }
  LINT_RULES_CACHE.set(root, { at: Date.now(), text })
  return text
}

function retrievePages(root, query, limit) {
  const pages = scanVault(root)
  const tokens = tokenizeQuery(query)
  const scored = []
  for (const page of pages) {
    const title = `${page.title} ${page.rel}`.toLowerCase()
    const tags = page.tags.join(' ').toLowerCase()
    const body = page.body.toLowerCase()
    let score = 0
    for (const [token, weight] of tokens) {
      if (title.includes(token)) score += 7 * weight
      if (tags.includes(token)) score += 4 * weight
      let index = body.indexOf(token)
      let hits = 0
      while (index !== -1 && hits < 6) {
        hits += 1
        score += weight
        index = body.indexOf(token, index + token.length)
      }
    }
    if (score > 0) scored.push({ page, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((item) => item.page)
}

function excerptFor(page, limit = 1600) {
  const text = page.body
    .replace(/^---[\s\S]*?---/u, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/gu, '$2')
    .replace(/```[\s\S]*?```/gu, '（代码块省略）')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function buildAnswerPrompt(query, pages, { rules = '', indexPage = null, thinking = '' } = {}) {
  const context = pages
    .map((page, index) => `### 资料 ${index + 1}：${page.rel}\n标题：${page.title}\n领域：${page.domain}\n\n${excerptFor(page)}`)
    .join('\n\n')
  const system = [
    '你是个人知识库（Obsidian / LLM Wiki）的检索助手。',
    '只能依据用户提供的「资料」回答；不得编造资料中没有的事实、数字或结论。',
    '回答结构：先用 1–3 句话给结论，再用要点列出依据；每条依据后用 [[页面相对路径]] 标注来源。',
    '如果资料不足以回答，明确说"知识库中未找到直接依据"，并指出还需要补充什么素材。',
    '用简体中文，控制在 400 字以内。',
  ]
  if (rules !== '') {
    system.push(
      '',
      '【知识库查询规则（来自根目录 CLAUDE.md 的「查询（Query）」章节，必须遵守）】',
      rules,
      '',
      '执行要求：先参考【导航索引】定位相关页面，再深入具体页面综合；引用必须指向 wiki 页面；',
      '若本次回答产出了有复用价值的分析/对比/结论（尤其是设计决策、包装口径、演进判断），在答案末尾用一句话询问用户是否归档回 wiki。',
    )
  }
  const indexBlock = indexPage === null ? '' : `### 导航索引：${indexPage.rel}\n标题：${indexPage.title}\n\n${excerptFor(indexPage, 2400)}`
  const user = [
    `【问题】\n${query}`,
    '',
    '【资料】',
    ...(indexBlock === '' ? [] : [indexBlock, '']),
    context,
    ...(thinking === '' ? [] : ['', '【前期分析（仅供组织答案，不要照抄）】', thinking]),
  ].join('\n')
  return { system: system.join('\n'), user }
}

function buildThinkingPrompt(query, pages, { rules = '', indexPage = null } = {}) {
  const context = pages
    .map((page, index) => `### 资料 ${index + 1}：${page.rel}\n标题：${page.title}\n领域：${page.domain}\n\n${excerptFor(page, 800)}`)
    .join('\n\n')
  const system = [
    '你是知识库检索助手。当前阶段只做检索分析与思考，不要输出最终答案。',
    '输出简体中文 Markdown，固定小节：',
    '## 问题拆解',
    '- 用户真正要回答什么；需要哪些概念/实体/对比',
    '## 相关资料',
    '- 哪些资料与该问题相关、各自能提供什么证据',
    '## 回答提纲',
    '- 最终回答的要点顺序与引用页面',
    '## 风险与缺口',
    '- 资料不足、冲突或需要人工确认的地方',
    '只依据给定资料，不得编造；控制在 300 字以内。',
  ].join('\n')
  const indexBlock = indexPage === null ? '' : `### 导航索引：${indexPage.rel}\n标题：${indexPage.title}\n\n${excerptFor(indexPage, 1200)}`
  const user = [
    `【问题】\n${query}`,
    '',
    ...(rules === '' ? [] : ['【知识库查询规则（来自 CLAUDE.md）】', rules, '']),
    '【资料】',
    ...(indexBlock === '' ? [] : [indexBlock, '']),
    context,
  ].join('\n')
  return { system, user }
}

function buildLintFindings(root) {
  // The health check must see the same page set as the graph (whole vault), so
  // its totals match the "N 页" header instead of only the wiki/ subtree.
  const pages = scanAllVault(root)
  const graph = buildGraph(root)
  const degree = new Map()
  for (const edge of graph.edges) {
    if (edge.source.startsWith('#')) continue
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  const orphans = pages.filter((page) => (degree.get(page.rel) ?? 0) === 0).map((page) => page.rel)
  const broken = []
  const indices = { byPath: new Map(), byName: new Map() }
  for (const page of pages) {
    const rel = page.rel.replace(/\.md$/iu, '').toLowerCase()
    indices.byPath.set(rel, page)
    indices.byPath.set(rel.replace(/^wiki\//u, ''), page)
    const key = basename(rel)
    if (!indices.byName.has(key)) indices.byName.set(key, page)
  }
  for (const page of pages) {
    for (const link of page.links) {
      if (resolveLinkTarget(link, indices, page.rel) === undefined && !linkTargetExists(root, link, page.rel)) broken.push({ rel: page.rel, link })
    }
  }
  const stale = pages
    .filter((page) => /deliverables\//iu.test(page.rel))
    .filter((page) => page.status === '' || /draft|wip|todo|停滞|待补充|待确认/iu.test(page.status))
    .map((page) => page.rel)
  const byTitle = new Map()
  for (const page of pages) {
    const key = page.title.trim().toLowerCase()
    if (key === '') continue
    byTitle.set(key, [...(byTitle.get(key) ?? []), page.rel])
  }
  const duplicates = [...byTitle.entries()].filter(([, list]) => list.length > 1).map(([title, list]) => ({ title, pages: list }))
  const wikiPages = pages.filter((page) => page.rel.startsWith('wiki/'))
  const wikiOrphans = orphans.filter((rel) => rel.startsWith('wiki/'))
  return {
    total: pages.length,
    wikiTotal: wikiPages.length,
    otherTotal: pages.length - wikiPages.length,
    totalBreakdown: folderBreakdown(pages.map((page) => page.rel)),
    orphans,
    wikiOrphans,
    orphanBreakdown: folderBreakdown(orphans),
    broken,
    stale,
    duplicates,
  }
}

function pageUpdatedAt(page) {
  const declared = String(page.lastUpdated ?? '').trim()
  if (declared !== '') {
    const parsed = Date.parse(declared)
    if (Number.isFinite(parsed)) return parsed
  }
  try {
    return statSync(page.abs).mtimeMs
  } catch {
    return 0
  }
}

function quickSources(rels, pages) {
  return [...new Set(rels)].slice(0, 8).map((rel) => {
    const page = pages.find((entry) => entry.rel === rel)
    return { rel, title: page?.title ?? rel, domain: page?.domain ?? 'MIXED' }
  })
}

function folderBreakdown(rels) {
  const counts = new Map()
  for (const rel of rels) {
    const folder = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '根目录'
    counts.set(folder, (counts.get(folder) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([folder, count]) => `${folder} ${count}`).join(' · ')
}

function buildBrokenLinkReport(root) {
  const findings = buildLintFindings(root)
  const graph = buildGraph(root)
  const pages = scanAllVault(root)
  const lines = [
    '## 断链扫描',
    '',
    `- 检查范围：${findings.total} 个页面（${findings.totalBreakdown}）· ${graph.stats.links} 条链接`,
    `- 发现断链：${findings.broken.length} 处`,
    '',
  ]
  if (findings.broken.length === 0) {
    lines.push(`没有发现断链。全库 ${findings.total} 个页面里的 wiki 链接都能解析到实际页面。`)
  } else {
    lines.push('### 断链清单', '')
    for (const item of findings.broken.slice(0, 40)) {
      lines.push(`- \`${item.rel}\` → \`${item.link}\`（目标不存在）`)
    }
    if (findings.broken.length > 40) lines.push(`- …另有 ${findings.broken.length - 40} 处未列出`)
    lines.push('', '### 建议', '', '1. 逐个核对上面的目标路径，补建缺失页面或修正链接。', '2. 优先处理 `wiki/index.md` 和导航页里的断链，它们影响整个库的入口。', '3. 修复后再次执行「扫描断链」复查。')
  }
  return {
    text: lines.join('\n'),
    sources: quickSources(findings.broken.map((item) => item.rel), pages),
    matched: findings.broken.length,
  }
}

function buildOrphanReport(root) {
  const findings = buildLintFindings(root)
  const pages = scanAllVault(root)
  const lines = [
    '## 孤立页面',
    '',
    `- 页面总数：${findings.total}（${findings.totalBreakdown}）`,
    `- 孤立页面：${findings.orphans.length} 个（没有出链或入链）`,
    '',
  ]
  if (findings.orphans.length > 0) lines.push(`- 孤立页构成：${findings.orphanBreakdown}`, '')
  if (findings.orphans.length === 0) {
    lines.push('没有发现孤立页面，所有页面都至少参与了一条链接。')
  } else {
    lines.push('### 页面清单', '')
    for (const rel of findings.orphans.slice(0, 60)) {
      const page = pages.find((entry) => entry.rel === rel)
      lines.push(`- \`${rel}\`${page?.title ? `（${page.title}）` : ''}`)
    }
    if (findings.orphans.length > 60) lines.push(`- …另有 ${findings.orphans.length - 60} 个未列出`)
    lines.push('', '### 建议', '', '1. 从 `wiki/index.md` 或对应领域的总览页加一条指向它的链接。', '2. 如果页面是归档或临时稿，在 frontmatter 标注状态，避免被误判为有效知识。', '3. 修复后在关系图谱里确认节点已经有边。')
  }
  return { text: lines.join('\n'), sources: quickSources(findings.orphans, pages), matched: findings.orphans.length }
}

function buildWeeklyReport(root, days = 7) {
  const pages = scanAllVault(root)
  const findings = buildLintFindings(root)
  const graph = buildGraph(root)
  const now = Date.now()
  const since = now - days * 24 * 60 * 60 * 1000
  const recent = pages
    .map((page) => ({ page, at: pageUpdatedAt(page) }))
    .filter((item) => item.at >= since)
    .sort((a, b) => b.at - a.at)
  const domains = new Map()
  for (const page of pages) domains.set(page.domain, (domains.get(page.domain) ?? 0) + 1)
  const domainLine = [...domains.entries()].sort((a, b) => b[1] - a[1]).map(([domain, count]) => `${domain} ${count}`).join(' · ')
  const dateOf = (time) => new Date(time).toISOString().slice(0, 10)
  const lines = [
    `## 知识库周报（近 ${days} 天）`,
    '',
    '### 概览',
    `- 页面总数：${findings.total}（${findings.totalBreakdown}）`,
    `- 标签：${new Set(pages.flatMap((page) => page.tags)).size}`,
    `- 链接：${graph.stats.links}`,
    `- 近 ${days} 天更新：${recent.length} 个页面`,
    '',
    '### 本周更新',
  ]
  if (recent.length === 0) {
    lines.push(`近 ${days} 天没有页面更新。`, '', '### 最近更新的页面')
    const latest = pages.map((page) => ({ page, at: pageUpdatedAt(page) })).sort((a, b) => b.at - a.at).slice(0, 8)
    for (const item of latest) lines.push(`- ${dateOf(item.at)} \`${item.page.rel}\`（${item.page.title}）`)
  } else {
    for (const item of recent.slice(0, 15)) lines.push(`- ${dateOf(item.at)} \`${item.page.rel}\`（${item.page.title}）`)
    if (recent.length > 15) lines.push(`- …另有 ${recent.length - 15} 个页面`)
  }
  lines.push('', '### 结构与质量', `- 领域分布：${domainLine || '暂无'}`, `- 断链：${findings.broken.length} 处`, `- 孤立页面：${findings.orphans.length} 个`, `- 停滞 deliverables：${findings.stale.length} 个`, '', '### 建议关注')
  let action = 0
  if (findings.broken.length > 0) lines.push(`${++action}. 修复 ${findings.broken.length} 处断链，优先处理导航页与索引页。`)
  if (findings.orphans.length > 0) lines.push(`${++action}. 把 ${findings.orphans.length} 个孤立页面接入索引或领域总览。`)
  if (recent.length === 0) lines.push(`${++action}. 本周没有内容更新；如果知识库仍在维护，建议补充本周的进展或决策记录。`)
  lines.push(`${++action}. 挑 1–2 个核心主题补充「结论 + 依据 + 适用边界」，让周报下期能体现知识增量。`)
  return { text: lines.join('\n'), sources: quickSources(recent.slice(0, 8).map((item) => item.page.rel), pages), matched: recent.length }
}

function buildLintReportPrompt(root, rules, findings, context) {
  const system = [
    '你是知识库健康体检助手。严格按照 CLAUDE.md 的「检查（Lint）」规则和给定页面清单执行体检，输出可执行的 Markdown 报告。',
    '只依据给定清单和确定性检查结果，不得编造页面、链接或事实；信息不足时写“数据不足，建议人工复核”。',
    '不要询问用户是否归档，直接输出报告正文。',
  ].join('\n')
  const user = [
    '# 知识库健康体检任务',
    '',
    `【知识库根目录】${root}`,
    `【规模】共 ${context?.total ?? findings.total} 页（${context?.breakdown ?? findings.totalBreakdown}），本次清单 ${context?.included ?? findings.total} 页`,
    '',
    '【CLAUDE.md 检查（Lint）要求】',
    rules === '' ? '（未找到「检查（Lint）」章节，按通用检查项：孤立页面、缺失交叉引用、疑似矛盾、过时内容、停滞 deliverables）' : rules,
    '',
    '【确定性检查结果】',
    `- 页面总数：${findings.total}（${findings.totalBreakdown}）`,
    `- 孤立页面（${findings.orphans.length}${findings.orphans.length > 0 ? `；${findings.orphanBreakdown}` : ''}）：${findings.orphans.slice(0, 30).join('、') || '无'}`,
    `- 断链（${findings.broken.length}）：${findings.broken.slice(0, 30).map((item) => `${item.rel} → [[${item.link}]]`).join('；') || '无'}`,
    `- 停滞 deliverables（${findings.stale.length}）：${findings.stale.slice(0, 20).join('、') || '无'}`,
    `- 重复标题（${findings.duplicates.length}）：${findings.duplicates.slice(0, 10).map((item) => `${item.title}（${item.pages.length}）`).join('；') || '无'}`,
    '',
    '【页面清单】',
    context?.lines?.length ? context.lines.join('\n') : '（清单不可用，请依据确定性检查结果）',
    '',
    '【输出要求】',
    '## 体检摘要',
    '- 页面数、孤立页数、缺失交叉引用、疑似矛盾、过时内容、停滞 deliverables 等计数',
    '## 问题清单',
    '- 每条：页面（wiki/路径）｜问题｜判断依据｜修复建议｜严重程度（高/中/低）',
    '## 优先修复建议',
    '- 按优先级列出前 5 条可执行动作',
  ].join('\n')
  return { system, user }
}

function excerptOfBody(body, limit = 160) {
  const text = String(body ?? '')
    .replace(/^---[\s\S]*?---/u, '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/gu, '$2')
    .replace(/^#{1,6}\s*/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** Knowledge-base inventory for the health check (same page set as the graph). */
function buildLintContext(root, limit = 200) {
  // Same page set as the graph: the whole vault (wiki/ plus raw sources and root docs).
  const allPages = scanAllVault(root)
  // 体检清单优先收录 wiki/ 正式页面，其次 raw 素材与根目录文档，避免页面数超过上限时把正文页面挤出样本。
  const orderedPages = allPages
    .slice()
    .sort((a, b) => Number(a.rel.startsWith('wiki/') ? 0 : 1) - Number(b.rel.startsWith('wiki/') ? 0 : 1))
  const pages = orderedPages.slice(0, limit)
  const graph = buildGraph(root)
  const outDegree = new Map()
  const inDegree = new Map()
  for (const edge of graph.edges) {
    if (edge.source.startsWith('#')) continue
    outDegree.set(edge.source, (outDegree.get(edge.source) ?? 0) + 1)
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
  }
  const folders = new Map()
  for (const page of allPages) {
    const folder = page.rel.includes('/') ? page.rel.slice(0, page.rel.lastIndexOf('/')) : '.'
    folders.set(folder, (folders.get(folder) ?? 0) + 1)
  }
  const lines = pages.map(
    (page) =>
      `- ${page.rel}｜${page.title}｜${page.type}/${page.domain}｜status=${page.status || '-'}｜tags=${page.tags.join(',') || '-'}｜出链=${outDegree.get(page.rel) ?? 0}｜入链=${inDegree.get(page.rel) ?? 0}｜摘要：${excerptOfBody(page.body)}`,
  )
  return {
    total: allPages.length,
    included: pages.length,
    breakdown: folderBreakdown(allPages.map((page) => page.rel)),
    folders: [...folders.entries()].sort((a, b) => b[1] - a[1]),
    graph: graph.stats,
    lines,
  }
}

/** Generate the copy-ready Agent task (no model call from the plugin). */
function buildLintTask(root, rules, context) {
  const folderLines = context.folders.slice(0, 30).map(([folder, count]) => `- ${folder}：${count} 页`)
  return [
    '# 知识库健康体检任务',
    '',
    '你是知识库健康体检助手。请**分步执行**本次体检：先读规则与目录，再逐页检查，最后汇总报告。',
    '',
    '## 知识库',
    `- 根目录：${root}`,
    `- 规模：共 ${context.total} 页（本次最多检查 ${context.included} 页）`,
    `- 页面构成：${context.breakdown}（与关系图谱口径一致）`,
    '- 主要目录：',
    ...folderLines,
    '',
    '## CLAUDE.md 检查（Lint）要求',
    rules === ''
      ? '（CLAUDE.md 中未找到「检查（Lint）」章节，按通用检查项执行：孤立页面、缺失交叉引用、疑似矛盾、过时内容、停滞 deliverables。）'
      : rules,
    '',
    '## 执行步骤（必须按顺序）',
    '1. 读取知识库根目录 `CLAUDE.md` 与 `wiki/index.md`，确认检查范围与导航。',
    '2. 列出知识库目录结构与页面清单（含 title/type/domain/status/tags）。',
    '3. 逐页检查并按类别记录：页面间矛盾、孤立页面、被提及但缺少独立页面的概念、过时内容、缺失交叉引用、停滞 deliverables。',
    '4. 汇总去重，按严重程度排序，给出优先修复建议。',
    '',
    '## 输出格式（Markdown）',
    '## 体检摘要',
    '- 页面数、孤立页数、缺失交叉引用、疑似矛盾、过时内容、停滞 deliverables 等计数',
    '## 问题清单',
    '- 每条：页面（wiki/路径）｜问题｜判断依据｜修复建议｜严重程度（高/中/低）',
    '## 优先修复建议',
    '- 按优先级列出前 5 条可执行动作',
    '',
    '## 约束',
    '- 只读：不要修改、删除或新建知识库文件；先只输出体检报告。',
    '- 只能依据知识库真实内容判断，不得编造页面或事实；数据不足写"数据不足，建议人工复核"。',
    '- 引用页面使用 `wiki/相对路径`；如知识库存在矛盾结论，注明冲突页面。',
    '- 报告完成后询问用户：是否将体检报告归档到 wiki（如 `wiki/deliverables/` 或 `log.md`）。',
  ].join('\n')
}

/** Resolve provider/model for LLM calls (shared by ask and lint). */
function resolveModelSelection(ctx, config) {
  const selection =
    typeof config.provider === 'string' && typeof config.model === 'string'
      ? { provider: config.provider, model: config.model }
      : ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection === undefined || selection === null || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw httpError(503, '没有解析到默认模型：请在插件配置里设置 provider/model，或在设置里选择模型')
  }
  return selection
}

function messageFor(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-wiki-manager' },
  }
}

async function askModel(ctx, config, system, user, signal) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') throw httpError(503, '当前 profile 没有可用的模型服务（ctx.llm）')
  const selection = resolveModelSelection(ctx, config)
  const maxTokens = Number.isInteger(config.maxAnswerTokens) && config.maxAnswerTokens > 0 ? config.maxAnswerTokens : 900
  let answer = ''
  let failure
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    messages: [messageFor(user)],
    maxTokens,
    purpose: 'wiki-manager-search',
    signal,
  })) {
    if (chunk.type === 'text-delta') answer += chunk.text
    else if (chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason !== undefined && reason.kind !== 'stop') failure = reason.failure
    }
  }
  if (failure !== undefined) throw httpError(502, `模型调用失败：${failure.code ?? 'unknown'}${failure.message ? ` · ${failure.message}` : ''}`)
  return { answer: answer.trim(), model: `${selection.provider}/${selection.model}` }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw httpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, '请求体不是合法 JSON')
  }
}

function decodeQuery(url, key) {
  const value = url.searchParams.get(key)
  return value === null ? '' : value
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function listDirectoryLevel(rawPath) {
  const requested = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (requested !== '' && !isAbsolute(requested)) {
    const error = new Error('目录必须是绝对路径')
    error.status = 400
    throw error
  }
  const target = requested === '' ? homedir() : resolve(requested)
  const stat = statSync(target)
  if (!stat.isDirectory()) {
    const error = new Error('该路径不是目录')
    error.status = 400
    throw error
  }
  const root = parsePath(target).root || sep
  const crumbs = [{ name: root === sep ? '/' : root, path: root }]
  let current = root
  if (target !== root) {
    for (const segment of target.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, segment)
      crumbs.push({ name: segment, path: current })
    }
  }
  const entries = []
  try {
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const entryPath = join(target, entry.name)
      let directory = entry.isDirectory()
      if (!directory && entry.isSymbolicLink()) {
        try { directory = statSync(entryPath).isDirectory() } catch { directory = false }
      }
      if (!directory) continue
      entries.push({ name: entry.name, path: entryPath, hidden: entry.name.startsWith('.') })
      if (entries.length >= 500) break
    }
  } catch (error) {
    const wrapped = new Error(`目录读取失败：${error.message}`)
    wrapped.status = 400
    throw wrapped
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
  const parent = dirname(target)
  return {
    path: target,
    parent: parent === target ? '' : parent,
    home: homedir(),
    entries,
    truncated: entries.length >= 500,
    crumbs: crumbs.slice(-20),
  }
}

function applyWikiManager(ctx, config = {}) {
  const agentSessions = new Map()
  ctx.effect(() => () => {
    for (const entry of agentSessions.values()) {
      entry.handle.dispose().catch(() => {})
    }
    agentSessions.clear()
  })

  const dataFile =
    typeof config.dataFile === 'string' && config.dataFile.length > 0 ? resolve(config.dataFile) : defaultDataFile()
  const promptRoot = promptLibraryRoot(dataFile)
  const promptSuitesFile = join(promptRoot, 'suites.json')

  const listRegistry = () => readRegistry(dataFile)

  const findKb = (registry, id) => {
    const item = registry.items.find((candidate) => candidate.id === id)
    if (item === undefined) throw httpError(404, `未登记的知识库：${id}`)
    return item
  }

  const makeMcpToken = () => `mcp_${randomBytes(24).toString('base64url')}`

  const tokenEquals = (provided, expected) => {
    const left = Buffer.from(String(provided))
    const right = Buffer.from(String(expected))
    return left.length === right.length && timingSafeEqual(left, right)
  }

  const mcpPublicBase = (origin = '') => {
    const configured = typeof config.publicBaseUrl === 'string' ? config.publicBaseUrl.trim() : ''
    if (configured !== '') return configured.replace(/\/+$/u, '')
    const candidate = String(origin ?? '').trim().replace(/\/+$/u, '')
    return /^https?:\/\//iu.test(candidate) ? candidate : ''
  }

  /** Derive a reachable HTTP origin from the request; dsh-app:// is a renderer-only scheme. */
  const originForRequest = (req) => {
    const forwarded = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
    const protocol = forwarded === 'https' ? 'https' : 'http'
    const host = String(req?.headers?.host ?? '').trim()
    if (host !== '') {
      if (/^https?:\/\//iu.test(host)) return host.replace(/\/+$/u, '')
      if (!/^dsh-app(?::|\/)/iu.test(host)) return `${protocol}://${host}`
    }
    const localPort = Number(req?.socket?.localPort)
    if (Number.isInteger(localPort) && localPort > 0) return `${protocol}://127.0.0.1:${localPort}`
    return ''
  }

  const mcpEndpointPath = (id) => `${MCP_PREFIX}/${encodeURIComponent(id)}`

  const mcpView = (kb, origin = '') => {
    const mcp = kb.mcp
    const path = mcpEndpointPath(kb.id)
    const base = mcpPublicBase(origin)
    const enabled = mcp?.enabled === true
    return {
      kbId: kb.id,
      enabled,
      endpointPath: path,
      endpoint: base === '' ? path : `${base}${path}`,
      token: enabled ? mcp.token : '',
      tokenPreview: enabled ? `mcp_…${String(mcp.token).slice(-4)}` : '',
      createdAt: enabled ? mcp.createdAt ?? null : null,
      lastUsedAt: enabled ? mcp.lastUsedAt ?? null : null,
    }
  }

  const enableMcp = async (id, origin = '') => {
    const registry = listRegistry()
    const kb = findKb(registry, id)
    if (kb.mcp?.enabled !== true) {
      kb.mcp = { enabled: true, token: makeMcpToken(), createdAt: new Date().toISOString(), lastUsedAt: null }
      await writeRegistry(dataFile, registry)
    }
    return mcpView(kb, origin)
  }

  const rotateMcp = async (id, origin = '') => {
    const registry = listRegistry()
    const kb = findKb(registry, id)
    kb.mcp = { enabled: true, token: makeMcpToken(), createdAt: new Date().toISOString(), lastUsedAt: null }
    await writeRegistry(dataFile, registry)
    return mcpView(kb, origin)
  }

  const disableMcp = async (id, origin = '') => {
    const registry = listRegistry()
    const kb = findKb(registry, id)
    if (kb.mcp !== undefined) {
      delete kb.mcp
      await writeRegistry(dataFile, registry)
    }
    return mcpView(kb, origin)
  }

  const kbFromRequest = (registry, url) => {
    const id = decodeQuery(url, 'kb')
    if (id === '') throw httpError(400, '缺少 kb 参数')
    return findKb(registry, id)
  }

  /** Guard a page path so only files under the registered vault can be read. */
  const readPage = (kb, rel) => {
    if (rel === '') throw httpError(400, '缺少 rel 参数')
    const root = resolve(kb.path)
    const abs = resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + sep)) throw httpError(403, '页面路径越界')
    const stat = statSync(abs, { throwIfNoEntry: false })
    if (stat === undefined || !stat.isFile()) throw httpError(404, `页面不存在：${rel}`)
    if (stat.size > MAX_PAGE_BYTES) throw httpError(413, '页面文件过大')
    const raw = readFileSync(abs, 'utf8')
    const { meta, body } = parseFrontmatter(raw)
    return {
      rel: relative(root, abs).split(sep).join('/'),
      title: meta.title || basename(abs).replace(/\.md$/u, ''),
      meta,
      markdown: raw,
      bodyLength: body.length,
    }
  }

  const registerKb = async (body) => {
    const name = String(body.name ?? '').trim()
    const purpose = String(body.purpose ?? '').trim()
    const description = String(body.description ?? body.domain ?? '').trim()
    const iconInput = String(body.icon ?? '').trim()
    const colorInput = String(body.color ?? '').trim()
    const icon = KB_ICONS.has(iconInput) ? iconInput : 'network'
    const color = KB_COLORS.has(colorInput) ? colorInput : 'blue'
    const path = normalizePath(body.path)
    if (name === '') throw httpError(400, '请填写知识库名称')
    if (name.length > 60) throw httpError(400, '名称过长（≤60 字）')
    const registry = listRegistry()
    if (registry.items.some((item) => resolve(item.path) === path)) throw httpError(409, '该路径已经登记过了')
    const now = new Date().toISOString()
    const item = {
      id: `kb_${randomUUID().slice(0, 8)}`,
      name,
      purpose: purpose === '' ? '未分类' : purpose,
      description: description.slice(0, 500),
      icon,
      color,
      path,
      createdAt: now,
      updatedAt: now,
    }
    registry.items.push(item)
    registry.activeId = item.id
    await writeRegistry(dataFile, registry)
    return { item: kbView(item), validation: validateVault(path) }
  }

  const updateKb = async (id, body) => {
    const registry = listRegistry()
    const item = findKb(registry, id)
    if (body.name !== undefined) {
      const name = String(body.name).trim()
      if (name === '') throw httpError(400, '名称不能为空')
      if (name.length > 60) throw httpError(400, '名称过长（≤60 字）')
      item.name = name
    }
    if (body.purpose !== undefined) item.purpose = String(body.purpose).trim() || '未分类'
    if (body.description !== undefined || body.domain !== undefined) {
      item.description = String(body.description ?? body.domain ?? '').trim().slice(0, 500)
    }
    if (body.icon !== undefined) {
      const icon = String(body.icon).trim()
      if (KB_ICONS.has(icon)) item.icon = icon
    }
    if (body.color !== undefined) {
      const color = String(body.color).trim()
      if (KB_COLORS.has(color)) item.color = color
    }
    if (body.path !== undefined) {
      const path = normalizePath(body.path)
      if (registry.items.some((candidate) => candidate.id !== id && resolve(candidate.path) === path)) {
        throw httpError(409, '该路径已经登记过了')
      }
      if (item.path !== path) {
        item.path = path
        await disposeAgentSession(id)
      } else {
        item.path = path
      }
    }
    item.updatedAt = new Date().toISOString()
    await writeRegistry(dataFile, registry)
    return { item: kbView(item), validation: validateVault(item.path) }
  }

  const removeKb = async (id) => {
    const registry = listRegistry()
    findKb(registry, id)
    registry.items = registry.items.filter((item) => item.id !== id)
    if (registry.activeId === id) registry.activeId = registry.items[0]?.id ?? null
    await writeRegistry(dataFile, registry)
    await disposeAgentSession(id)
    return { removed: id }
  }

  const AGENT_TOOL_LABELS = {
    read: '读取文件',
    read_file: '读取文件',
    write: '写入文件',
    edit: '修改文件',
    multi_edit: '批量修改文件',
    bash: '执行命令',
    shell: '执行命令',
    grep: '搜索内容',
    search: '搜索内容',
    glob: '查找文件',
    list: '浏览目录',
    ls: '浏览目录',
    todo: '更新执行计划',
    update_plan: '更新执行计划',
    web_search: '搜索网络',
    web_fetch: '读取网页',
  }

  const agentToolLabel = (name) => AGENT_TOOL_LABELS[name] ?? `调用工具 ${name}`
  const clipText = (value, max = 180) =>
    String(value ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, max)
  const toolResultText = (data) => {
    const content = data?.message?.content
    if (Array.isArray(content)) {
      const text = content
        .map((block) => (typeof block?.text === 'string' ? block.text : ''))
        .filter((item) => item !== '')
        .join('\n')
      if (text !== '') return text
    }
    if (typeof data?.message?.text === 'string') return data.message.text
    if (typeof data?.error?.message === 'string') return data.error.message
    return ''
  }
  const disposeAgentSession = async (kbId) => {
    const entry = agentSessions.get(kbId)
    if (entry === undefined) return
    agentSessions.delete(kbId)
    entry.disposed = true
    try {
      await entry.handle.dispose()
    } catch {
      /* best effort */
    }
  }

  /**
   * Flatten an error chain into one readable line, so a provider transport
   * failure surfaces its real cause instead of the outer wrapper message.
   */
  const describeError = (error) => {
    const parts = []
    let current = error
    let depth = 0
    while (current !== undefined && current !== null && depth < 5) {
      const isError = current instanceof Error
      const message = isError ? current.message : String(current)
      const code = !isError && typeof current === 'object' && typeof current.code === 'string' ? ` [${current.code}]` : ''
      const detail = `${isError ? current.name : typeof current}: ${message}${code}`
      if (!parts.includes(detail)) parts.push(detail)
      current = isError ? current.cause : undefined
      depth += 1
    }
    return parts.length === 0 ? String(error) : parts.join(' ← ')
  }

  /**
   * Drive the real DSH Agent Runtime for one chat message. The agent session is
   * reused per knowledge base so the conversation keeps its own context, cwd and
   * tool history; the Session event log is projected into the WIKI timeline.
   * Returns false when the profile has no agent runtime so the caller can fall
   * back to the retrieval pipeline.
   */
  const streamAgentAnswer = async (res, kb, query, history = []) => {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.create !== 'function') return false
    const selection = resolveModelSelection(ctx, config)
    const existing = agentSessions.get(kb.id)
    if (existing?.busy) throw httpError(409, 'WIKI Agent 正在处理上一条请求，请稍候')
    let entry = existing
    let fresh = false
    if (entry === undefined || entry.disposed) {
      // Mirror the GUI/ACP session path: mount the default agent preset so the
      // agent gets the standard tool plane and model wiring instead of a bare
      // factory agent (a bare agent fails the very first model request).
      const presets = ctx.get('agentPresets')
      let presetSetup = null
      if (presets !== undefined && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
        try {
          const resolved = await presets.resolve(undefined)
          const presetId = resolved !== undefined && resolved !== null && typeof resolved.id === 'string' ? resolved.id : undefined
          if (presetId !== undefined && presetId !== '') {
            presetSetup = {
              id: presetId,
              setup: async (agentCtx) => {
                await presets.mount(agentCtx, presetId)
              },
            }
          }
        } catch (error) {
          console.warn(`[wiki-manager] agent preset resolve failed: ${describeError(error)}`)
        }
      }
      let handle
      try {
        handle = await agents.create({
          sessionId: `session-${randomUUID()}`,
          meta: {
            cwd: kb.path,
            ...(presetSetup !== null ? { agentPreset: presetSetup.id } : {}),
          },
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
            ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
              ? { reasoningEffort: selection.reasoningEffort }
              : {}),
          },
          ...(presetSetup !== null ? { setup: presetSetup.setup } : {}),
        })
      } catch (error) {
        console.warn(`[wiki-manager] agent runtime unavailable: ${describeError(error)}`)
        return false
      }
      entry = { handle, busy: false, disposed: false, createdAt: Date.now() }
      agentSessions.set(kb.id, entry)
      fresh = true
    }
    entry.busy = true
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders?.()
    const send = (event, payload) => {
      if (typeof res.write === 'function') res.write(`data: ${JSON.stringify({ event, ...payload })}\n\n`)
    }
    let answer = ''
    let thinking = ''
    const startedAt = Date.now()
    const disposers = []
    const pendingCalls = new Map()
    // `agent/assistant-stream` is dispatched on the shared event bus, so frames from
    // other agents (e.g. a concurrent GUI session) can arrive while our turn runs.
    const isOwnAgent = (payload) => payload?.agent?.id === entry.handle.agent.id
    const onFrame = (payload) => {
      if (!isOwnAgent(payload)) return
      const frame = payload?.frame
      if (frame?.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta') {
        answer += chunk.text ?? ''
        send('delta', { text: chunk.text ?? '' })
      } else if (chunk?.type === 'reasoning-delta') {
        thinking += chunk.text ?? ''
        send('thinking', { text: chunk.text ?? '' })
      }
    }
    let settleTurn
    let failTurn
    const turnDone = new Promise((resolve, reject) => {
      settleTurn = resolve
      failTurn = reject
    })
    const onSessionEvent = (subject, event) => {
      if (subject === undefined || subject === null || subject.id !== entry.handle.agent.id) return
      if (event.type === 'turn/end') settleTurn(event)
      if (event.type === 'tool/call') {
        const name = event.data?.name ?? 'tool'
        const callId = event.data?.callId ?? randomUUID()
        const rawArgs = event.data?.arguments
        let detail = ''
        try {
          const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
          detail = args?.command ?? args?.path ?? args?.query ?? args?.pattern ?? args?.file_path ?? ''
          detail = clipText(detail, 120)
        } catch {
          detail = ''
        }
        pendingCalls.set(callId, name)
        send('step', { id: callId, tool: name, label: agentToolLabel(name), detail, status: 'running' })
      }
      if (event.type === 'tool/result') {
        const callId = event.data?.message?.callId ?? event.data?.callId ?? ''
        const name = pendingCalls.get(callId) ?? ''
        pendingCalls.delete(callId)
        const isError = event.data?.message?.isError === true || event.data?.error !== undefined
        send('step-result', {
          id: callId,
          tool: name,
          ok: !isError,
          output: clipText(toolResultText(event.data), 220),
        })
      }
    }
    disposers.push(entry.handle.agent.ctx.on('agent/assistant-stream', onFrame))
    disposers.push(entry.handle.agent.ctx.on('agent/error', (payload) => { if (!isOwnAgent(payload)) return; const error = payload?.error; failTurn(error instanceof Error ? error : new Error(String(error))) }))
    disposers.push(ctx.on('session/event', onSessionEvent))
    const timer = setTimeout(() => {
      entry.handle.agent.cancel({ kind: 'user' })
      failTurn(new Error('Agent 执行超时（240s）'))
    }, 240_000)
    try {
      send('stage', { stage: 'agent' })
      const requestText = fresh
        ? [
            `你是「${kb.name}」本地知识库的 WIKI AI。知识库根目录：${kb.path}`,
            ...(Array.isArray(history) && history.length > 0
              ? ['以下是最近对话（供理解上下文）：', ...history.slice(-6).map((message) => `${message.role === 'user' ? '用户' : '助手'}：${String(message.text ?? '').slice(0, 800)}`), '']
              : []),
            '开始前先读取根目录的 CLAUDE.md / AGENTS.md / SCHEMA.md（若存在），严格遵循其中的规则；',
            '只在该知识库范围内操作；需要执行任务时直接使用你的工具（读文件、搜索、bash 等）；',
            '回答使用简体中文，引用知识库页面时使用 [[wiki/相对路径]] 格式；不要编造。',
            '',
            `用户请求：${query}`,
          ].join('\n')
        : `用户请求：${query}`
      // The agent inbox stores messages verbatim and the session validator rejects
      // user/message events without an explicit user role, so send a complete message.
      entry.handle.agent.followup({
        id: `message-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: requestText }],
        source: { kind: 'user' },
      })
      await turnDone
      // A tool call whose result frame never arrived would leave its step card
      // spinning forever; close every pending call before finishing the turn.
      for (const [callId, name] of pendingCalls) send('step-result', { id: callId, tool: name, ok: true, output: '' })
      pendingCalls.clear()
      if (thinking !== '') send('thinking-done', {})
      const links = [...answer.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu)].map((match) => match[1].trim())
      const pages = scanVault(kb.path)
      const sources = [...new Set(links)]
        .map((link) => {
          const clean = link.replace(/^wiki\//iu, '').replace(/\.md$/iu, '').toLowerCase()
          return pages.find((page) => page.rel.replace(/^wiki\//iu, '').replace(/\.md$/iu, '').toLowerCase() === clean)
        })
        .filter((page) => page !== undefined)
        .slice(0, 8)
        .map((page) => ({ rel: page.rel, title: page.title, domain: page.domain }))
      send('sources', { sources })
      send('done', { model: `${selection.provider}/${selection.model}`, matched: sources.length, elapsedMs: Date.now() - startedAt })
    } catch (error) {
      for (const [callId, name] of pendingCalls) send('step-result', { id: callId, tool: name, ok: false, output: '' })
      pendingCalls.clear()
      const agentMessage = describeError(error)
      console.warn(`[wiki-manager] agent turn failed: ${agentMessage}`)
      if (answer === '') {
        // The Agent Runtime request failed before any answer (e.g. provider
        // transport errors). Fall back to a local, deterministic result so the
        // assistant still answers instead of showing a dead-end error.
        if (/检查|体检|\blint\b|健康/iu.test(query)) {
          const findings = buildLintFindings(kb.path)
          const allPages = scanAllVault(kb.path)
          const refs = [...new Set([...findings.orphans, ...findings.broken.map((item) => item.rel), ...findings.stale])]
          send('step', { id: `fallback_${randomUUID()}`, tool: 'lint', label: 'Agent 不可用，执行本地规则检查', detail: agentMessage.slice(0, 80), status: 'done' })
          send('delta', {
            text: [
              '## 体检摘要',
              `- 页面总数：${findings.total}（${findings.totalBreakdown}）`,
              `- 孤立页面：${findings.orphans.length}${findings.orphans.length > 0 ? `（${findings.orphanBreakdown}）` : ''}`,
              `- 断链：${findings.broken.length}`,
              `- 停滞 deliverables：${findings.stale.length}`,
              `- 重复标题：${findings.duplicates.length}`,
              '',
              '## 问题清单',
              ...findings.orphans.slice(0, 20).map((rel) => `- 孤立页：\`${rel}\`（无入站/出站链接）`),
              ...findings.broken.slice(0, 20).map((item) => `- 断链：\`${item.rel}\` → [[${item.link}]]`),
              ...findings.stale.slice(0, 20).map((rel) => `- 停滞 deliverables：\`${rel}\``),
              '',
              '## 说明',
              `Agent Runtime 本次调用失败：${agentMessage}。以上由本地规则检查生成，可重试 Agent 深度体检。`,
            ].join('\n'),
          })
          send('sources', {
            sources: refs.slice(0, 8).map((rel) => {
              const page = allPages.find((entry) => entry.rel === rel)
              return { rel, title: page?.title ?? rel, domain: page?.domain ?? 'MIXED' }
            }),
          })
          send('done', { model: 'local-lint', matched: findings.total, elapsedMs: Date.now() - startedAt })
        } else {
          const pages = retrievePages(kb.path, query, 4)
          send('delta', {
            text:
              pages.length === 0
                ? `Agent Runtime 调用失败：${agentMessage}。知识库中也没有检索到直接相关内容，请稍后重试。`
                : [
                    `Agent Runtime 调用失败：${agentMessage}。已回退到知识库检索，以下是最相关的页面：`,
                    '',
                    ...pages.map((page) => `- [[${page.rel}]]：${excerptOfBody(page.body, 140)}`),
                  ].join('\n'),
          })
          send('sources', {
            sources: pages.map((page) => ({ rel: page.rel, title: page.title, domain: page.domain })),
          })
          send('done', { model: 'local-retrieval', matched: pages.length, elapsedMs: Date.now() - startedAt })
        }
        // A failed runtime should start fresh on the next attempt.
        await disposeAgentSession(kb.id)
      } else {
        send('error', { message: agentMessage })
        await disposeAgentSession(kb.id)
      }
    } finally {
      clearTimeout(timer)
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
      const current = agentSessions.get(kb.id)
      if (current !== undefined) current.busy = false
      res.end()
    }
    return true
  }



  const MCP_TOOLS = [
    {
      name: 'kb_info',
      description: 'Return knowledge-base name, page/tag counts and last update time. Use this first to understand the base.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'kb_search',
      description: 'Search pages in this knowledge base and return title, relative path, tags and a short excerpt. Prefer this over reading files blindly.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language or keyword query' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 8)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'kb_read',
      description: 'Read one Markdown page by its relative path, returning frontmatter and body.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative page path, e.g. wiki/concepts/语义层.md' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
    {
      name: 'kb_list',
      description: 'List page paths, optionally filtered by a relative path prefix.',
      inputSchema: {
        type: 'object',
        properties: {
          prefix: { type: 'string', description: 'Optional relative path prefix, e.g. wiki/concepts/' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max pages (default 100)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'kb_related',
      description: 'Return graph neighbours (wikilinks and tags) of a page.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative page path' },
          depth: { type: 'integer', minimum: 1, maximum: 2, description: 'Neighbour depth (default 1)' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ]

  const resourceUri = (kb, rel) => `wiki://${encodeURIComponent(kb.id)}/${encodeURI(rel)}`

  const mcpToolResult = (value) => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    isError: false,
  })

  const findPageByRel = (root, rel) => {
    const wanted = String(rel ?? '').replace(/^\.\/+/u, '').split(sep).join('/')
    return scanVault(root).find((page) => page.rel === wanted) ?? null
  }

  const runMcpTool = async (kb, name, args = {}) => {
    if (name === 'kb_info') {
      const pages = scanVault(kb.path)
      const tags = new Set(pages.flatMap((page) => page.tags))
      return {
        id: kb.id,
        name: kb.name,
        pageCount: pages.length,
        tagCount: tags.size,
        updatedAt: kb.updatedAt ?? null,
        description: kb.description || '',
      }
    }
    if (name === 'kb_search') {
      const query = String(args.query ?? '').trim()
      if (query === '') throw httpError(400, 'query 不能为空')
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 8))
      const pages = retrievePages(kb.path, query, limit)
      return {
        query,
        count: pages.length,
        items: pages.map((page) => ({
          path: page.rel,
          title: page.title,
          domain: page.domain,
          tags: page.tags,
          excerpt: excerptFor(page, 360),
        })),
      }
    }
    if (name === 'kb_read') {
      const page = findPageByRel(kb.path, args.path)
      if (page === null) throw httpError(404, `页面不存在：${args.path ?? ''}`)
      const content = readPage(kb, page.rel)
      const markdown = String(content.markdown)
      return {
        path: content.rel,
        title: content.title,
        meta: content.meta,
        markdown: markdown.length > 60_000 ? `${markdown.slice(0, 60_000)}…` : markdown,
        truncated: markdown.length > 60_000,
      }
    }
    if (name === 'kb_list') {
      const prefix = String(args.prefix ?? '').replace(/^\.\/+/u, '').split(sep).join('/')
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 100))
      const pages = scanVault(kb.path)
        .filter((page) => prefix === '' || page.rel.startsWith(prefix))
        .slice(0, limit)
        .map((page) => ({ path: page.rel, title: page.title, domain: page.domain, tags: page.tags }))
      return { prefix, count: pages.length, items: pages }
    }
    if (name === 'kb_related') {
      const graph = buildGraph(kb.path)
      const wanted = String(args.path ?? '').trim()
      const target = graph.nodes.find((node) => node.kind === 'page' && (node.id === wanted || node.rel === wanted))
      if (target === undefined) throw httpError(404, `页面不存在：${wanted}`)
      const depth = Math.max(1, Math.min(2, Number(args.depth) || 1))
      const byId = new Map(graph.nodes.map((node) => [node.id, node]))
      const seen = new Map([[target.id, { id: target.id, kind: target.kind, label: target.label, rel: target.rel ?? null, domain: target.domain, depth: 0 }]])
      let frontier = [target.id]
      for (let level = 1; level <= depth; level += 1) {
        const next = []
        for (const edge of graph.edges) {
          const other = edge.source === frontier[0] || frontier.includes(edge.source)
            ? edge.target
            : frontier.includes(edge.target)
              ? edge.source
              : null
          if (other === null || seen.has(other)) continue
          const node = byId.get(other)
          if (node === undefined) continue
          seen.set(other, { id: node.id, kind: node.kind, label: node.label, rel: node.rel ?? null, domain: node.domain, depth: level })
          next.push(other)
        }
        frontier = next
        if (frontier.length === 0) break
      }
      const neighbours = [...seen.values()].filter((item) => item.id !== target.id).slice(0, 60)
      return {
        path: target.rel ?? target.id,
        title: target.label,
        neighbours,
        tags: neighbours.filter((item) => item.kind === 'tag').map((item) => item.label),
      }
    }
    throw httpError(404, `未知 MCP 工具：${name}`)
  }

  const mcpRpcError = (id, code, message) => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  })

  const mcpRpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

  const handleMcpMessage = async (kb, message) => {
    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return mcpRpcError(message?.id, -32600, 'Invalid Request')
    }
    const id = message.id
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return null
    try {
      if (message.method === 'initialize') {
        const requested = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : MCP_PROTOCOL_VERSION
        return mcpRpcResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
          serverInfo: { name: `wiki-${kb.id}`, version: '1.0.0' },
        })
      }
      if (message.method === 'ping') return mcpRpcResult(id, {})
      if (message.method === 'tools/list') return mcpRpcResult(id, { tools: MCP_TOOLS })
      if (message.method === 'tools/call') {
        const name = String(message.params?.name ?? '')
        try {
          const result = await runMcpTool(kb, name, message.params?.arguments ?? {})
          return mcpRpcResult(id, mcpToolResult(result))
        } catch (error) {
          return mcpRpcResult(id, {
            content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          })
        }
      }
      if (message.method === 'resources/list') {
        const pages = scanVault(kb.path).slice(0, 200)
        return mcpRpcResult(id, {
          resources: pages.map((page) => ({
            uri: resourceUri(kb, page.rel),
            name: page.title,
            description: page.rel,
            mimeType: 'text/markdown',
          })),
        })
      }
      if (message.method === 'resources/read') {
        const uri = String(message.params?.uri ?? '')
        const page = scanVault(kb.path).find((candidate) => resourceUri(kb, candidate.rel) === uri)
        if (page === undefined) throw httpError(404, `资源不存在：${uri}`)
        const content = readPage(kb, page.rel)
        return mcpRpcResult(id, {
          contents: [{ uri, mimeType: 'text/markdown', text: String(content.markdown) }],
        })
      }
      return mcpRpcError(id, -32601, `Method not found: ${message.method}`)
    } catch (error) {
      return mcpRpcError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  const mcpHandler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(MCP_PREFIX.length).replace(/\/+$/u, '')
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
      })
      res.end()
      return
    }
    const match = /^\/([^/]+)$/u.exec(path)
    if (match === null) return sendJson(res, 404, { error: 'MCP endpoint 需要 /wiki-manager/mcp/<kbId>' })
    const id = decodeURIComponent(match[1])
    const registry = listRegistry()
    const kb = findKb(registry, id)
    if (kb.mcp?.enabled !== true) return sendJson(res, 403, { error: '该知识库的 MCP 共享未启用' })
    const authorization = String(req.headers.authorization ?? '')
    const provided = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : (url.searchParams.get('token') ?? '')
    if (provided === '' || !tokenEquals(provided, kb.mcp.token)) {
      return sendJson(res, 401, { error: 'MCP token 无效' })
    }
    const lastUsed = kb.mcp.lastUsedAt === null || kb.mcp.lastUsedAt === undefined ? 0 : Date.parse(kb.mcp.lastUsedAt)
    if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > 60_000) {
      kb.mcp.lastUsedAt = new Date().toISOString()
      writeRegistry(dataFile, registry).catch(() => {})
    }
    if (method !== 'POST') {
      res.writeHead(405, { allow: 'POST, OPTIONS', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'MCP tools require POST' } }))
      return
    }
    const body = await readJson(req)
    const messages = Array.isArray(body) ? body : [body]
    const responses = []
    for (const message of messages) {
      const response = await handleMcpMessage(kb, message)
      if (response !== null) responses.push(response)
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
      res.end()
      return
    }
    sendJson(res, 200, Array.isArray(body) ? responses : responses[0])
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = req.method ?? 'GET'

    if (method === 'POST' && path === '/fs/pick-directory') {
      const picker = typeof ctx.get === 'function' ? ctx.get('directoryPicker') : undefined
      let capability = null
      try { capability = picker && typeof picker.capability === 'function' ? picker.capability() : null } catch (_error) { capability = null }
      if (capability && capability.kind === 'native' && typeof capability.pick === 'function') {
        try {
          const picked = await capability.pick(new AbortController().signal)
          return sendJson(res, 200, { kind: 'native', path: typeof picked === 'string' ? picked : '', canceled: !picked })
        } catch (error) {
          return sendJson(res, 200, { kind: 'native-error', error: error.message })
        }
      }
      return sendJson(res, 200, { kind: capability && typeof capability.kind === 'string' ? capability.kind : 'unavailable' })
    }

    if (method === 'GET' && path === '/fs/list') {
      try {
        return sendJson(res, 200, listDirectoryLevel(url.searchParams.get('path') ?? ''))
      } catch (error) {
        return sendJson(res, error.status || 400, { error: error.message })
      }
    }

    if (method === 'GET' && path === '/prompt-suites') {
      return sendJson(res, 200, { items: readPromptSuites(promptSuitesFile).items })
    }

    if (method === 'POST' && path === '/prompt-suites') {
      const body = await readJson(req)
      const name = String(body.name ?? '').trim()
      const purpose = String(body.purpose ?? '').trim().slice(0, 2000)
      const prompt = String(body.prompt ?? '').trim()
      const attachments = resolveAttachmentIds(promptRoot, body.attachments)
      if (name === '') throw httpError(400, '请输入套件名称')
      if (prompt.length > 100_000) throw httpError(400, '提示词内容过长（最多 10 万字符）')
      if (prompt === '' && attachments.length === 0) throw httpError(400, '请输入提示词或上传附件')
      const suites = readPromptSuites(promptSuitesFile)
      const now = new Date().toISOString()
      const item = {
        id: `ps_${randomUUID()}`,
        name,
        purpose,
        prompt,
        attachments: attachments.map(attachmentView),
        createdAt: now,
        updatedAt: now,
      }
      suites.items.unshift(item)
      await writePromptSuites(promptSuitesFile, suites)
      return sendJson(res, 200, { item })
    }

    const promptSuiteMatch = /^\/prompt-suites\/([^/]+)$/u.exec(path)
    if (promptSuiteMatch !== null) {
      const id = decodeURIComponent(promptSuiteMatch[1])
      const suites = readPromptSuites(promptSuitesFile)
      const current = suites.items.find((item) => item.id === id)
      if (current === undefined) throw httpError(404, `提示词套件不存在：${id}`)
      if (method === 'PATCH') {
        const body = await readJson(req)
        const attachments = body.attachments === undefined ? current.attachments : resolveAttachmentIds(promptRoot, body.attachments)
        const next = {
          ...current,
          name: body.name === undefined ? current.name : String(body.name).trim(),
          purpose: body.purpose === undefined ? current.purpose : String(body.purpose).trim().slice(0, 2000),
          prompt: body.prompt === undefined ? current.prompt : String(body.prompt).trim(),
          attachments: attachments.map((meta) => (meta.id ? attachmentView(meta) : meta)),
          updatedAt: new Date().toISOString(),
        }
        if (next.name === '') throw httpError(400, '请输入套件名称')
        if (next.prompt.length > 100_000) throw httpError(400, '提示词内容过长（最多 10 万字符）')
        if (next.prompt === '' && next.attachments.length === 0) throw httpError(400, '请输入提示词或上传附件')
        suites.items = suites.items.map((item) => (item.id === id ? next : item))
        await writePromptSuites(promptSuitesFile, suites)
        const nextAttachmentIds = new Set(next.attachments.map((attachment) => attachment.id))
        const removedAttachments = (current.attachments ?? [])
          .filter((attachment) => !nextAttachmentIds.has(attachment.id))
          .map((attachment) => readAttachmentMeta(promptRoot, attachment.id))
        deleteAttachmentFiles(promptRoot, removedAttachments)
        return sendJson(res, 200, { item: next })
      }
      if (method === 'DELETE') {
        suites.items = suites.items.filter((item) => item.id !== id)
        await writePromptSuites(promptSuitesFile, suites)
        deleteAttachmentFiles(promptRoot, current.attachments.map((attachment) => readAttachmentMeta(promptRoot, attachment.id)))
        return sendJson(res, 200, { deleted: true })
      }
    }

    const promptCopyMatch = /^\/prompt-suites\/([^/]+)\/copy$/u.exec(path)
    if (method === 'POST' && promptCopyMatch !== null) {
      const id = decodeURIComponent(promptCopyMatch[1])
      const suites = readPromptSuites(promptSuitesFile)
      const item = suites.items.find((candidate) => candidate.id === id)
      if (item === undefined) throw httpError(404, `提示词套件不存在：${id}`)
      return sendJson(res, 200, {
        item,
        files: item.attachments.map((attachment) => {
          const meta = readAttachmentMeta(promptRoot, attachment.id)
          return {
            ...attachmentView(meta),
            path: attachmentFilePath(promptRoot, meta),
            url: `${ROUTE_PREFIX}/prompt-files/${meta.id}`,
          }
        }),
      })
    }

    if (method === 'POST' && path === '/prompt-files') {
      const rawName = url.searchParams.get('name') ?? '附件'
      const mime = url.searchParams.get('mime') ?? req.headers['content-type'] ?? 'application/octet-stream'
      const meta = await persistAttachment(req, promptRoot, rawName, mime)
      return sendJson(res, 200, { attachment: attachmentView(meta) })
    }

    const promptFileMatch = /^\/prompt-files\/([^/]+)$/u.exec(path)
    if (method === 'GET' && promptFileMatch !== null) {
      return serveAttachment(res, promptRoot, decodeURIComponent(promptFileMatch[1]))
    }

    const requestOrigin = originForRequest(req)
    const mcpRouteMatch = /^\/kbs\/([^/]+)\/mcp$/u.exec(path)
    if (mcpRouteMatch !== null) {
      const id = decodeURIComponent(mcpRouteMatch[1])
      if (method === 'GET') return sendJson(res, 200, mcpView(findKb(listRegistry(), id), requestOrigin))
      if (method === 'POST') return sendJson(res, 200, await enableMcp(id, requestOrigin))
      if (method === 'DELETE') return sendJson(res, 200, await disableMcp(id, requestOrigin))
      return sendJson(res, 405, { error: `不支持的方法：${method}` })
    }
    const mcpRotateMatch = /^\/kbs\/([^/]+)\/mcp\/rotate$/u.exec(path)
    if (mcpRotateMatch !== null) {
      if (method !== 'POST') return sendJson(res, 405, { error: `不支持的方法：${method}` })
      const id = decodeURIComponent(mcpRotateMatch[1])
      return sendJson(res, 200, await rotateMcp(id, requestOrigin))
    }

    if (method === 'GET' && path === '/kbs') {
      const registry = listRegistry()
      return sendJson(res, 200, {
        items: registry.items.map((item) => {
          // 列表卡片与关系图谱同源：pages/tags 取 buildGraph 的统计，避免 wiki-only 口径造成数字对不上。
          let stats = null
          try {
            stats = buildGraph(item.path).stats
          } catch (error) {
            stats = null
          }
          try {
            return { ...kbView(item), validation: validateVault(item.path), stats }
          } catch (error) {
            return { ...kbView(item), validation: { path: item.path, isVault: false, pageCount: 0, error: error.message }, stats }
          }
        }),
        activeId: registry.activeId,
      })
    }

    if (method === 'POST' && path === '/kbs') return sendJson(res, 200, await registerKb(await readJson(req)))

    const kbMatch = /^\/kbs\/([^/]+)$/u.exec(path)
    if (kbMatch !== null) {
      const id = decodeURIComponent(kbMatch[1])
      if (method === 'PATCH') return sendJson(res, 200, await updateKb(id, await readJson(req)))
      if (method === 'DELETE') return sendJson(res, 200, await removeKb(id))
    }

    if (method === 'POST' && path === '/active') {
      const body = await readJson(req)
      const registry = listRegistry()
      const item = findKb(registry, String(body.id ?? ''))
      registry.activeId = item.id
      await writeRegistry(dataFile, registry)
      return sendJson(res, 200, { activeId: item.id })
    }

    if (method === 'POST' && path === '/validate') {
      const body = await readJson(req)
      const root = normalizePath(body.path)
      return sendJson(res, 200, validateVault(root))
    }

    if (method === 'GET' && path === '/graph') {
      const registry = listRegistry()
      const kb = kbFromRequest(registry, url)
      const graph = buildGraph(kb.path)
      return sendJson(res, 200, { kb: kbView(kb), ...graph })
    }

    if (method === 'GET' && path === '/node') {
      const registry = listRegistry()
      const kb = kbFromRequest(registry, url)
      return sendJson(res, 200, { kb: kbView(kb), page: readPage(kb, decodeQuery(url, 'rel')) })
    }

    if (method === 'GET' && path === '/catalog') {
      const registry = listRegistry()
      const kb = kbFromRequest(registry, url)
      return sendJson(res, 200, { kb: kbView(kb), ...buildCatalog(kb.path) })
    }

    if (method === 'GET' && path === '/tree') {
      const registry = listRegistry()
      const kb = kbFromRequest(registry, url)
      const rel = decodeQuery(url, 'rel')
      const level = listTreeLevel(kb.path, rel)
      return sendJson(res, 200, { kb: kbView(kb), name: basename(kb.path), root: kb.path, ...level })
    }

    if (method === 'GET' && path === '/arch-prompt') {
      const templateId = (decodeQuery(url, 'template') ?? 'general').trim() || 'general'
      const fileName = ARCH_PROMPT_TEMPLATES.get(templateId)
      if (fileName === undefined) throw httpError(400, `不支持的 WIKI 架构模板：${templateId}`)
      const filePath = join(ARCH_PROMPT_DIR, fileName)
      if (!existsSync(filePath)) throw httpError(500, `架构提示词模板不存在：${filePath}`)
      const template = readFileSync(filePath, 'utf8')
      return sendJson(res, 200, { template, path: filePath, templateId })
    }

    if (method === 'POST' && path === '/agent-reset') {
      const body = await readJson(req)
      const kb = findKb(listRegistry(), String(body.kb ?? ''))
      await disposeAgentSession(kb.id)
      return sendJson(res, 200, { reset: true })
    }

    if (method === 'POST' && path === '/lint-task') {
      const body = await readJson(req)
      const kb = findKb(listRegistry(), String(body.kb ?? ''))
      const rules = loadLintRules(kb.path)
      const maxPages = Number.isInteger(config.maxLintPages) && config.maxLintPages > 0 ? config.maxLintPages : 200
      const context = buildLintContext(kb.path, maxPages)
      const instruction = buildLintTask(kb.path, rules, context)
      return sendJson(res, 200, {
        kb: kbView(kb),
        instruction,
        pages: context.included,
        total: context.total,
        rules: rules !== '',
      })
    }

    if (method === 'POST' && path === '/ask-stream') {
      const body = await readJson(req)
      const query = String(body.query ?? '').trim()
      if (query === '') throw httpError(400, '请输入要检索或总结的内容')
      const kb = findKb(listRegistry(), String(body.kb ?? ''))
      if (config.agentRuntime !== false) {
        const served = await streamAgentAnswer(res, kb, query, Array.isArray(body.history) ? body.history : [])
        if (served) return
      }
      const llm = ctx.get('llm')
      const selection = resolveModelSelection(ctx, config)
      const rules = config.useQueryRules === false ? '' : loadQueryRules(kb.path)
      const allPages = scanVault(kb.path)
      const indexPage = allPages.find((page) => page.rel === 'wiki/index.md') ?? null
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
      const send = (event, payload) => {
        if (typeof res.write === 'function') res.write(`data: ${JSON.stringify({ event, ...payload })}\n\n`)
      }
      const beginStep = (id, tool, label, detail) => send('step', { id, tool, label, detail, status: 'running' })
      const endStep = (id, detail) => send('step-result', { id, status: 'done', ...(detail === undefined ? {} : { detail }) })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 90_000)
      try {
        if (/断链|broken\s*links?/iu.test(query)) {
          send('stage', { stage: 'scan' })
          beginStep('scan', 'scan', '扫描知识库页面', '')
          const report = buildBrokenLinkReport(kb.path)
          endStep('scan', `${report.matched} 处断链`)
          send('stage', { stage: 'generate' })
          beginStep('report', 'edit', '生成断链清单', '')
          send('delta', { text: report.text })
          endStep('report', '已完成')
          send('sources', { sources: report.sources })
          send('done', { model: null, matched: report.matched })
          return
        }
        if (/孤立|orphan/iu.test(query)) {
          send('stage', { stage: 'scan' })
          beginStep('scan', 'scan', '扫描知识库页面', '')
          const report = buildOrphanReport(kb.path)
          endStep('scan', `${report.matched} 个孤立页面`)
          send('stage', { stage: 'generate' })
          beginStep('report', 'edit', '生成孤立页面清单', '')
          send('delta', { text: report.text })
          endStep('report', '已完成')
          send('sources', { sources: report.sources })
          send('done', { model: null, matched: report.matched })
          return
        }
        if (/周报|周报|weekly\s*report|知识库报告/iu.test(query)) {
          send('stage', { stage: 'scan' })
          beginStep('scan', 'scan', '汇总页面与链接数据', '')
          const report = buildWeeklyReport(kb.path)
          endStep('scan', `${report.matched} 个近期更新`)
          send('stage', { stage: 'generate' })
          beginStep('report', 'edit', '生成知识库周报', '')
          send('delta', { text: report.text })
          endStep('report', '已完成')
          send('sources', { sources: report.sources })
          send('done', { model: null, matched: report.matched })
          return
        }
        if (llm === undefined || typeof llm.stream !== 'function') {
          send('delta', { text: '当前 profile 没有可用的模型服务（ctx.llm），无法生成自由回答；内置的「扫描断链」「找出孤立页面」「生成知识库周报」仍可直接使用。' })
          send('done', { model: null, matched: 0 })
          return
        }
        send('stage', { stage: 'rules', rules: rules !== '', indexIncluded: indexPage !== null })
        if (/检查|体检|\blint\b|健康/iu.test(query)) {
          beginStep('rules', 'read_rules', '读取 CLAUDE.md 检查规则', rules === '' ? '未找到章节，使用通用检查项' : '已加载')
          endStep('rules', rules === '' ? '使用通用检查项' : '已加载 CLAUDE.md')
          send('stage', { stage: 'scan' })
          beginStep('scan', 'scan', '扫描知识库目录与页面', '')
          const findings = buildLintFindings(kb.path)
          endStep('scan', `${findings.total} 个页面（${findings.totalBreakdown}）`)
          const orphanSummary = findings.orphans.length === 0 ? '0 个孤立页' : `${findings.orphans.length} 个孤立页（${findings.orphanBreakdown}）`
          beginStep('link_graph', 'link_graph', '构建页面链接关系', `${orphanSummary} · ${findings.broken.length} 个断链`)
          endStep('link_graph', `${orphanSummary} · ${findings.broken.length} 个断链`)
          const findingCount = findings.orphans.length + findings.broken.length + findings.stale.length + findings.duplicates.length
          beginStep('lint', 'lint', '执行 CLAUDE.md 检查规则', `${findingCount} 个问题`)
          endStep('lint', `${findingCount} 个问题`)
          send('stage', { stage: 'generate' })
          const lintRules = loadLintRules(kb.path)
          const lintContext = buildLintContext(kb.path, Number(config.maxLintPages) || 200)
          const lintPrompt = buildLintReportPrompt(kb.path, lintRules, findings, lintContext)
          const lintPages = scanAllVault(kb.path)
          const lintSources = [...new Set([
            ...findings.orphans,
            ...findings.broken.map((item) => item.rel),
            ...findings.stale,
            ...findings.duplicates.flatMap((item) => item.pages),
          ])].slice(0, 8).map((rel) => {
            const page = lintPages.find((entry) => entry.rel === rel)
            return { rel, title: page?.title ?? rel, domain: page?.domain ?? 'MIXED' }
          })
          let failure
          let answerLength = 0
          for await (const chunk of llm.stream({
            provider: selection.provider,
            model: selection.model,
            system: lintPrompt.system,
            messages: [messageFor(lintPrompt.user)],
            maxTokens: 4000,
            purpose: 'wiki-manager-lint-report',
            signal: controller.signal,
          })) {
            if (chunk.type === 'text-delta') {
              answerLength += chunk.text.length
              send('delta', { text: chunk.text })
            } else if (chunk.type === 'finish') {
              const reason = chunk.reason
              if (reason !== undefined && reason.kind !== 'stop') failure = reason.failure
            }
          }
          if (answerLength === 0) {
            const fallback = [
              '## 体检摘要',
              `- 页面总数：${findings.total}（${findings.totalBreakdown}）`,
              `- 孤立页面：${findings.orphans.length}${findings.orphans.length > 0 ? `（${findings.orphanBreakdown}）` : ''}`,
              `- 断链：${findings.broken.length}`,
              `- 停滞 deliverables：${findings.stale.length}`,
              `- 重复标题：${findings.duplicates.length}`,
            ].join('\n')
            send('delta', { text: fallback })
          }
          if (failure !== undefined) throw new Error(`模型调用失败：${failure.code ?? 'unknown'}`)
          beginStep('report', 'edit', '生成体检报告', '')
          endStep('report', '已完成')
          send('sources', { sources: lintSources })
          send('done', { model: `${selection.provider}/${selection.model}`, matched: findings.total })
          return
        }
        const maxPages = Number.isInteger(config.maxContextPages) && config.maxContextPages > 0 ? config.maxContextPages : 6
        const pages = retrievePages(kb.path, query, maxPages)
        const sources = pages.map((page) => ({ rel: page.rel, title: page.title, domain: page.domain }))
        beginStep('retrieve', 'search', '检索知识库', `${pages.length} 个页面`)
        endStep('retrieve', pages.length === 0 ? '未直接命中，参考索引' : `${pages.length} 个页面`)
        send('stage', { stage: 'retrieve', matched: pages.length, sources })
        if (pages.length === 0 && indexPage === null) {
          send('delta', {
            text: '知识库中没有检索到与该问题直接相关的内容。可以换用更具体的关键词（产品名、机制名、竞品名），或先把相关素材写入这个知识库。',
          })
          send('sources', { sources: [] })
          send('done', { model: null, matched: 0 })
          return
        }
        send('stage', { stage: 'think' })
        beginStep('think', 'brain', '梳理回答策略', '')
        let thinking = ''
        try {
          const thinkPrompt = buildThinkingPrompt(query, pages, { rules, indexPage })
          for await (const chunk of llm.stream({
            provider: selection.provider,
            model: selection.model,
            system: thinkPrompt.system,
            messages: [messageFor(thinkPrompt.user)],
            maxTokens: 600,
            purpose: 'wiki-manager-think',
            signal: controller.signal,
          })) {
            if (chunk.type === 'text-delta') {
              thinking += chunk.text
              send('thinking', { text: chunk.text })
            }
          }
        } catch {
          /* thinking is best-effort: continue with the answer */
        }
        send('thinking-done', {})
        endStep('think', thinking === '' ? '已完成检索判断' : '已生成思考摘要')
        send('stage', { stage: 'generate' })
        beginStep('answer', 'edit', '生成回答', '')
        const { system, user } = buildAnswerPrompt(query, pages, { rules, indexPage, thinking })
        let failure
        let answerLength = 0
        for await (const chunk of llm.stream({
          provider: selection.provider,
          model: selection.model,
          system,
          messages: [messageFor(user)],
          maxTokens: Number.isInteger(config.maxAnswerTokens) && config.maxAnswerTokens > 0 ? config.maxAnswerTokens : 900,
          purpose: 'wiki-manager-search',
          signal: controller.signal,
        })) {
          if (chunk.type === 'text-delta') {
            answerLength += chunk.text.length
            send('delta', { text: chunk.text })
          } else if (chunk.type === 'finish') {
            const reason = chunk.reason
            if (reason !== undefined && reason.kind !== 'stop') failure = reason.failure
          }
        }
        if (failure !== undefined) throw new Error(`模型调用失败：${failure.code ?? 'unknown'}`)
        if (answerLength === 0) {
          const titles = pages.map((page) => `- ${page.rel}`).join('\n')
          send('delta', { text: `模型本次没有返回回答，但已检索到以下页面，可缩小问题范围后重试：\n\n${titles}` })
        }
        endStep('answer', `${answerLength} 字`)
        send('sources', { sources })
        send('done', { model: `${selection.provider}/${selection.model}`, matched: pages.length })
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : String(error) })
      } finally {
        clearTimeout(timer)
        res.end()
      }
      return
    }

    if (method === 'POST' && path === '/ask') {
      const body = await readJson(req)
      const query = String(body.query ?? '').trim()
      if (query === '') throw httpError(400, '请输入要检索或总结的内容')
      const registry = listRegistry()
      const kb = findKb(registry, String(body.kb ?? ''))
      // Rule §5.2: read CLAUDE.md's 查询（Query） section before retrieval.
      const rules = config.useQueryRules === false ? '' : loadQueryRules(kb.path)
      const allPages = scanVault(kb.path)
      const indexPage = allPages.find((page) => page.rel === 'wiki/index.md') ?? null
      const maxPages = Number.isInteger(config.maxContextPages) && config.maxContextPages > 0 ? config.maxContextPages : 6
      const pages = retrievePages(kb.path, query, maxPages)
      if (pages.length === 0 && indexPage === null) {
        return sendJson(res, 200, {
          answer: '知识库中没有检索到与该问题直接相关的内容。可以换用更具体的关键词（产品名、机制名、竞品名），或先把相关素材写入这个知识库。',
          sources: [],
          model: null,
          retrieval: { matched: 0, queryRules: rules !== '', indexIncluded: false },
        })
      }
      const { system, user } = buildAnswerPrompt(query, pages, { rules, indexPage })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 90_000)
      try {
        const result = await askModel(ctx, config, system, user, controller.signal)
        return sendJson(res, 200, {
          answer: result.answer,
          sources: pages.map((page) => ({ rel: page.rel, title: page.title, domain: page.domain })),
          model: result.model,
          retrieval: { matched: pages.length, queryRules: rules !== '', indexIncluded: indexPage !== null },
        })
      } finally {
        clearTimeout(timer)
      }
    }

    return sendJson(res, 404, { error: `未知接口：${method} ${path}` })
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        return handler(req, res).catch((error) => {
          const status = Number.isInteger(error?.status) ? error.status : 500
          if (res.headersSent) {
            res.destroy()
            return
          }
          sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        })
      },
    })
    return () => dispose()
  }, 'wiki-manager: /wiki-manager/api routes')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: MCP_PREFIX,
      handler: (req, res) => {
        return mcpHandler(req, res).catch((error) => {
          const status = Number.isInteger(error?.status) ? error.status : 500
          if (res.headersSent) {
            res.destroy()
            return
          }
          sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
        })
      },
    })
    return () => dispose()
  }, 'wiki-manager: /wiki-manager/mcp endpoint')
}

/**
 * Entry: mounts the WIKI manager host.
 */
export async function apply(ctx, config = {}) {
  applyWikiManager(ctx, config)
}

/** Exported for tests only. */
export const internals = { buildGraph, buildLintFindings, buildBrokenLinkReport, buildOrphanReport, buildWeeklyReport, buildCatalog, listTreeLevel, loadQueryRules, loadLintRules, buildAnswerPrompt, buildLintContext, buildLintTask, retrievePages, validateVault, parseFrontmatter, parseTagsAndLinks }
