/**
 * @local/dsh-prompt-studio — Host half.
 *
 * Two responsibilities:
 *   1. registers the embedded `prompt-optimizer` skill (chat-side deep enhancement);
 *   2. serves `POST /prompt-studio/api/generate`: it retrieves relevant pages from
 *      the selected local knowledge base, then asks the configured model to turn
 *      the user's spoken requirement into a structured, format-specific prompt.
 *
 * The generation is a real model call (`ctx.llm.stream`); retrieval runs over the
 * vault on the Host, so the Client only sends options and reads the result.
 *
 * Config (optional): knowledgeBase, assetRoot, language, extraNotes,
 * provider, model, maxOutputTokens, retrievalRerank, rerankCandidates, excerptChars.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin identity. */
export const name = 'prompt-studio'

/** Skills registry + the Host web server that carries the generation API. */
export const inject = ['skills', 'webServer']

const SKILL_NAME = 'prompt-optimizer'
const PROVIDER_NAME = 'prompt-studio'
const BUNDLED_SKILL_RANK = 600
const DEFAULT_KNOWLEDGE_BASE = '/Users/you/Documents/knowledge-base'
const ROUTE_PREFIX = '/prompt-studio/api'
const MAX_CONTEXT_PAGES = 8
const MAX_FINAL_SOURCES = 2
const RERANK_CANDIDATES = 10
const EXCERPT_CHARS = 400
const DEFAULT_MAX_TOKENS = 5000
const DEFAULT_BRIEF_TOKENS = 1200
const SCAN_CACHE_MS = 15_000
const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash', '.dsh'])
const SKIP_FILES = new Set(['log.md'])

/** Supported output formats — mirrors the Client's selector. */
const FORMATS = new Set(['docx', 'pptx', 'md', 'prototype'])

/** The technical architecture table used by prototype "new demo" prompts. */
const TECH_ARCHITECTURE = [
  '| 层级 | 使用技术 | 用途 |',
  '|---|---|---|',
  '| 前端框架 | React 19.2.6、React DOM | 页面、组件与交互 |',
  '| 开发与构建 | Vite 8.0.13 | 本地服务、热更新、生产打包 |',
  '| 开发语言 | JavaScript、JSX | 业务逻辑与页面编写 |',
  '| 样式 | 原生 CSS | 页面布局、响应式、深浅色主题 |',
  '| 图表 | AntV G2 3.5.19 | 折线图、柱状图、饼图等 |',
  '| 图标 | Lucide React | 菜单、按钮和功能图标 |',
  '| 本地数据库 | SQL.js（SQLite + WebAssembly） | 在浏览器中执行取数 SQL |',
  '| 本地存储 | localStorage | 保存会话、报表、任务和语言设置 |',
  '| 国际化 | 自定义中英文翻译机制 | 界面语言切换 |',
].join('\n')

// ---------------------------------------------------------------------------
// Skill registration (unchanged behaviour)
// ---------------------------------------------------------------------------

/**
 * Parse the YAML-ish frontmatter of a SKILL.md.
 * @param {string} raw
 * @param {string} path
 * @returns {{ meta: Record<string, string | string[]>, content: string }}
 */
function parseSkillFile(raw, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) throw new Error(`prompt-studio: ${path} has no YAML frontmatter`)
  const meta = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (kv === null) continue
    const key = kv[1]
    let value = kv[2].trim()
    if (/^[|>][+-]?$/u.test(value)) {
      const block = []
      while (i + 1 < lines.length && (/^\s/u.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[(i += 1)])
      const indents = block.filter((l) => l.trim() !== '').map((l) => (/^\s*/u.exec(l) ?? [''])[0].length)
      const dedent = indents.length > 0 ? Math.min(...indents) : 0
      meta[key] = block.map((l) => l.slice(dedent)).join('\n').trim()
      continue
    }
    if (/^".*"$/u.test(value)) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (/^'.*'$/u.test(value)) {
      value = value.slice(1, -1).replaceAll("''", "'")
    } else if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/gu, ''))
        .filter((item) => item !== '')
    }
    meta[key] = value
  }
  return { meta, content: raw.slice(match[0].length).trim() }
}

function resolveAssets(config) {
  const assetRoot =
    typeof config.assetRoot === 'string' && config.assetRoot.length > 0
      ? config.assetRoot
      : fileURLToPath(new URL('./assets/prompt-studio/', import.meta.url))
  if (!isAbsolute(assetRoot)) throw new Error('prompt-studio: assetRoot must be an absolute path')
  const skillDir = assetRoot.endsWith('/') ? assetRoot.slice(0, -1) : assetRoot
  const skillPath = join(skillDir, 'SKILL.md')
  const scriptPath = join(skillDir, 'scripts', 'kb.mjs')
  if (!statSync(skillPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`prompt-studio: missing skill instructions at ${skillPath} (check assetRoot)`)
  }
  if (!statSync(scriptPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`prompt-studio: missing retrieval script at ${scriptPath} (check assetRoot)`)
  }
  return { skillDir, skillPath, scriptPath }
}

function renderRuntimeSection(config, assets) {
  const knowledgeBase =
    typeof config.knowledgeBase === 'string' && config.knowledgeBase.length > 0
      ? config.knowledgeBase
      : process.env.PROMPT_OPTIMIZER_KB && process.env.PROMPT_OPTIMIZER_KB.length > 0
        ? process.env.PROMPT_OPTIMIZER_KB
        : DEFAULT_KNOWLEDGE_BASE
  let kbStatus
  if (statSync(knowledgeBase, { throwIfNoEntry: false })?.isDirectory() !== true) {
    kbStatus = '⚠️ 无法访问：该目录不存在。请让用户在插件配置里修正 knowledgeBase'
  } else {
    const hasSchema = statSync(join(knowledgeBase, 'CLAUDE.md'), { throwIfNoEntry: false })?.isFile() === true
    const hasIndex = statSync(join(knowledgeBase, 'wiki', 'index.md'), { throwIfNoEntry: false })?.isFile() === true
    kbStatus =
      hasSchema && hasIndex ? '已就绪（检测到 CLAUDE.md 与 wiki/index.md）' : '⚠️ 路径存在但不像 DataPilot 知识库（缺 CLAUDE.md 或 wiki/index.md）'
  }
  const notes = typeof config.extraNotes === 'string' && config.extraNotes.trim() !== '' ? config.extraNotes.trim() : undefined
  return [
    '',
    '## 运行时配置（由 prompt-studio 插件注入）',
    '',
    `- 知识库根目录：\`${knowledgeBase}\``,
    `- 状态：${kbStatus}`,
    `- 检索脚本：\`${assets.scriptPath}\``,
    '',
    '调用方式：',
    '',
    '```bash',
    `node "${assets.scriptPath}" --kb "${knowledgeBase}" info`,
    `node "${assets.scriptPath}" --kb "${knowledgeBase}" search "关键词1 关键词2" --top 12`,
    '```',
    ...(notes === undefined ? [] : ['', '## 附加说明（插件配置注入）', '', notes]),
  ].join('\n')
}


// ---------------------------------------------------------------------------
// Artifact cards: every (format × scene) declares the real deliverable
// ---------------------------------------------------------------------------

const ARTIFACT_CARDS = {
  docx: {
    deliverable: 'Word 文档（.docx）',
    tool: 'office-docx 技能 + 公司 Word 母版（Typora-Word2.docx）',
    capacity: '6–10 章，约 3000–6000 字',
    naming: 'YYYYMMDD-<产品>-<主题>-<版本>.docx',
    requirements: ['文档信息表与修订记录齐全', '三级标题 + 图表编号', '口径与来源标注'],
    structure: {
      '': ['封面', '文档信息表', '修订记录', '目录', '一、背景与问题', '二、目标与范围', '三、方案与结论', '四、关键设计', '五、风险与依赖', '六、待决策事项', '附录'],
      requirement: ['背景与问题', '用户与场景', '需求清单（P0/P1）', '功能设计（流程/状态/交互）', '数据与口径', '非功能要求', '验收标准', '风险与依赖', '排期与里程碑'],
      quarter: ['上季度复盘（目标 vs 结果）', '问题与机会', '本季度目标（OKR）', '重点战役与拆解', '里程碑与排期', '资源与协作', '风险与应对', '度量与复盘机制'],
      year: ['年度回顾', '市场与竞品判断', '年度目标与北极星指标', '路线图（Q1–Q4）', '能力建设（平台/数据/组织）', '资源预算', '风险与依赖', '成功度量'],
      month: ['本月目标', '上期遗留', '迭代范围（需求清单）', '设计与口径变更', '发布计划与灰度', '验证指标', '风险'],
      competitor: ['研究问题与方法', '竞品选择与版本', '能力矩阵（维度 × 竞品）', '关键差异（NL2SQL/语义层/交互）', '定价与商业模式', '对我方启示', '结论与建议', '来源与日期'],
      release: ['版本信息', '新增能力', '优化与修复', '影响范围与升级指引', '已知问题', '回滚方案', '相关文档'],
      'product-material': ['产品定位与价值主张', '目标客户与场景', '能力全景', '差异化优势', '典型案例', '价格与交付', '常见问题', '附录（截图/术语）'],
    },
  },
  pptx: {
    deliverable: 'PPT 演示文稿（.pptx）',
    tool: 'dashi-ppt 技能 + 公司母版（浩鲸科技_20周年_ppt中文模板_白.potx）',
    capacity: '12–20 页（按受众与时长）',
    naming: 'YYYYMMDD-<产品>-<主题>-<版本>.pptx',
    requirements: ['每页标题=结论句', '一页一个观点', '正文 ≤6 行', '图 > 表 > 字', '图表带单位/口径/来源/日期'],
    structure: {
      '': ['封面', '目录', '背景与问题', '目标', '方案总览', '关键设计', '里程碑', '风险', '下一步'],
      requirement: ['封面', '背景/问题', '用户与场景', '需求总览（P0/P1）', '核心方案（2–3 页）', '数据与口径', '验收与里程碑', '风险与决策项'],
      quarter: ['封面', '目录', '本期目标', '重点战役（3–4 页）', '路线图', '资源与依赖', '风险', '总结与下一步'],
      year: ['封面', '市场与竞品', '北极星与目标', '路线图（Q1–Q4）', '能力建设', '资源预算', '风险', '结语'],
      month: ['封面', '本月目标', '迭代范围', '关键需求（2–3 页）', '发布与灰度', '指标验证', '风险'],
      competitor: ['封面', '研究问题', '竞品全景', '能力矩阵', '关键差异（2–3 页）', '商业模式', '对我方启示', '结论'],
      release: ['封面', '版本概览', '新增能力（2–3 页）', '优化与修复', '升级指引', '已知问题', 'Q&A'],
      'product-material': ['封面', '产品定位', '目标客户/场景', '能力全景', '差异化优势', '客户案例', '交付与服务', '结尾页'],
    },
  },
  md: {
    deliverable: 'Markdown 内容源（.md）',
    tool: '直接写文件（无模板）',
    capacity: '800–1500 字（有字数限制则覆盖）',
    naming: 'YYYYMMDD-<产品>-<主题>.md',
    requirements: ['开头一句话结论', '每节带来源与置信度', 'frontmatter（title/type/domain/tags/status）'],
    structure: {
      '': ['一句话结论', '背景与依据', '分点论证', '结论与下一步', '来源'],
      'prompt-enhance': ['一句话目标', '角色与任务', '原始需求（模型重写）', '知识库依据清单', '产物规格', '使用说明（如何粘贴执行）'],
      requirement: ['一句话结论', '背景/问题', '需求清单', '方案要点', '数据口径', '风险', '下一步'],
      quarter: ['结论', '上期复盘', '本季目标', '重点举措', '里程碑', '资源/风险'],
      year: ['结论', '年度判断', '目标与指标', '路线图', '能力建设', '资源'],
      month: ['结论', '本月目标', '迭代清单', '发布计划', '验证指标'],
      competitor: ['结论', '研究问题', '竞品对比（表）', '关键差异', '启示', '来源'],
      release: ['版本', '新增', '优化与修复', '升级指引', '已知问题'],
      'product-material': ['定位', '目标客户', '能力', '差异化', '案例', '交付'],
    },
  },
  prototype: {
    deliverable: '可点击单文件 HTML 原型 + 原型说明 .md',
    tool: '手写 HTML/CSS/JS（无外部依赖）',
    capacity: '8–12 个页面状态',
    naming: 'YYYYMMDD-<产品>-<页面>-原型说明-<版本>.md/.html',
    requirements: ['页面/弹窗清单完整', '状态矩阵（空/加载/正常/错误/无权限）', '每一步可回退', '可离线打开'],
    structure: {
      iterate: ['迭代目标', '受影响页面/组件', '交互与状态差异', '兼容与回退', '验收要点'],
      'new-demo': ['目标与场景', '页面与弹窗清单', '状态矩阵（空/加载/正常/错误/无权限）', '关键交互步骤', '组件与布局', '适配终端', '可点击原型交付', '技术架构'],
    },
  },
}

/** Retrieval profiles: which wiki areas each artifact should prefer. */
const RETRIEVAL_PROFILES = {
  docx: { boostPaths: ['wiki/templates', 'wiki/sources', 'wiki/deliverables'], pathBoost: 3, typeBoost: { template: 4, source: 3, deliverable: 2 }, terms: ['需求', '方案', '模板', '规范'] },
  pptx: { boostPaths: ['wiki/templates', 'wiki/comparisons', 'wiki/sources'], pathBoost: 4, typeBoost: { template: 5, source: 3, comparison: 2 }, terms: ['PPT', '汇报', '母版', '页序', '竞品'] },
  md: { boostPaths: ['wiki/concepts', 'wiki/comparisons', 'wiki/sources'], pathBoost: 2, typeBoost: { concept: 3, comparison: 2, source: 1 }, terms: [] },
}

/** Markers each artifact prompt must contain; missing → retry, then hydrate. */
const ARTIFACT_MARKERS = {
  docx: ['.docx', '修订记录'],
  pptx: ['.pptx', '页序', '页面主题', '展示内容'],
  md: ['.md'],
  prototype: ['页面'],
}

function artifactSkeleton(options) {
  const card = ARTIFACT_CARDS[options.docType]
  return card.structure[options.scene] ?? card.structure[''] ?? []
}

/**
 * PPT prompts must spell out every page: topic (a conclusion sentence) and the
 * content it shows. This is the canonical table the model must fill in.
 */
function pptxPageTable(options) {
  const skeleton = artifactSkeleton(options)
  const rows = skeleton.map((title, index) => {
    const page = index + 1
    const isCover = title === '封面'
    const isClosing = ['结尾页', 'Q&A', '结语', '下一步', '总结与下一步'].includes(title)
    if (isCover) return `| 1 | 封面：主标题 + 副标题 | 产品名、汇报主题、汇报人、日期 | 封面页 |`
    return `| ${page} | 待提炼：${title} | 要点（≤6 行）+ 图表/数据/来源 | ${isClosing ? '结尾页' : '内容页'} |`
  })
  return [
    '| 页码 | 页面主题（结论句） | 展示内容（要点/图表/数据） | 版式 |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/** Full canonical body for the "# 产物规格" section (PPT appends its page table). */
function artifactSpecBlock(options) {
  if (options.docType === 'prototype') return options.withTechArchitecture ? TECH_ARCHITECTURE : ''
  const lines = [artifactSpecLines(options)]
  if (options.docType === 'pptx') {
    lines.push('', '逐页清单（必须逐页提炼页面主题与展示内容）：', pptxPageTable(options))
  }
  return lines.join('\n')
}

/** The canonical "# 产物规格" bullet list for the selected artifact. */
function artifactSpecLines(options) {
  const card = ARTIFACT_CARDS[options.docType]
  const skeleton = artifactSkeleton(options)
  const skeletonLabel = options.docType === 'pptx' ? '页序' : options.docType === 'prototype' ? '页面/状态骨架' : '结构骨架'
  const plan = options.pagePlan ?? null
  const lines = [
    `- 交付物：${card.deliverable}`,
    `- 生成方式：${card.tool}`,
    plan === null
      ? `- ${skeletonLabel}：${skeleton.join(' → ')}`
      : `- 页序（用户指定，必须遵循）：${plan.pages.map((entry) => entry.title).join(' → ')}`,
    plan === null ? `- 容量：${options.length || card.capacity}` : `- 容量：${plan.pages.length} 页（用户指定，不得增减）`,
    `- 命名与落盘：${card.naming}`,
    `- 质量要求：${card.requirements.join('；')}`,
  ]
  if (options.audience) lines.push(`- 受众：${options.audience}`)
  if (options.docType === 'prototype' && options.scene === 'new-demo') lines.push(`- 适配终端：${options.platform || '电脑端+手机端'}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Vault retrieval
// ---------------------------------------------------------------------------

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

function walkMarkdown(dir, out = []) {
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

const scanCache = new Map()

/** Scan a vault's wiki layer into page records (cached briefly). */
function scanVault(kbPath) {
  const cached = scanCache.get(kbPath)
  if (cached !== undefined && Date.now() - cached.at < SCAN_CACHE_MS) return cached.pages
  const wikiDir = existsSync(join(kbPath, 'wiki')) && statSync(join(kbPath, 'wiki')).isDirectory() ? join(kbPath, 'wiki') : kbPath
  const pages = []
  for (const abs of walkMarkdown(wikiDir)) {
    let raw
    try {
      raw = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseFrontmatter(raw)
    pages.push({
      rel: relative(kbPath, abs).split(sep).join('/'),
      title: meta.title || basename(abs).replace(/\.md$/u, ''),
      type: meta.type || 'page',
      domain: meta.domain || 'MIXED',
      tags: String(meta.tags ?? ''),
      body,
      lower: `${meta.title ?? ''} ${meta.tags ?? ''} ${body}`.toLowerCase(),
    })
  }
  scanCache.set(kbPath, { at: Date.now(), pages })
  return pages
}

const QUERY_STOPWORDS = new Set([
  '生成', '要求', '请', '帮我', '一份', '文档', '页面', '表格', '列', '内容', '标题', '要点', '参考',
  '结构', '规范', '需要', '输出', '包含', '进行', '以及', '我们', '我司', '双方', '分别', '给出',
  '说明', '注明', '不得', '可以', '如何', '什么', '哪些', '一个', '这个', '那个', '底部', '上面',
  '如下', '用于', '按照', '根据', '相关', '信息', '时候', '情况',
])
const FORMAT_STOPWORDS = new Set(['ppt', 'pptx', 'docx', 'word', 'markdown', 'md', 'pdf', 'xlsx', '中文', '文档结构'])

function tokenizeQuery(query) {
  const tokens = new Map()
  const add = (token, weight) => {
    if (token.length < 2) return
    if (QUERY_STOPWORDS.has(token) || FORMAT_STOPWORDS.has(token)) return
    tokens.set(token, Math.max(tokens.get(token) ?? 0, weight))
  }
  const cleaned = String(query ?? '')
    .replace(/https?:\/\/\S+/giu, ' ')
    .replace(/[\w\u3400-\u9fff.\-()（）]+\.[A-Za-z0-9]{2,5}\b/gu, ' ')
    .replace(/(?:@)?\/[^\s，。；、,;：:）)\]】]+/gu, ' ')
  for (const word of cleaned.toLowerCase().match(/[a-z][a-z0-9._-]{1,}/gu) ?? []) {
    add(word, 2.5)
    for (const part of word.split(/[._-]/u)) add(part, 1.5)
  }
  for (const run of cleaned.match(/[\u3400-\u9fff]+/gu) ?? []) {
    if (run.length <= 6) add(run, 2)
    for (let i = 0; i + 2 <= run.length; i += 1) add(run.slice(i, i + 2), 1)
    for (let i = 0; i + 3 <= run.length; i += 1) add(run.slice(i, i + 3), 1.4)
    for (let i = 0; i + 4 <= run.length && run.length > 8; i += 1) add(run.slice(i, i + 4), 1.6)
  }
  return tokens
}



const PROTOTYPE_TERMS = ['原型', '交互', '页面', '弹窗', '抽屉', '流程', '组件', '状态', '白皮书', '功能清单', '产品', '看板', '报表', 'demo']
const PROTOTYPE_TYPE_BOOST = { source: 6, entity: 5, deliverable: 7, concept: 2, comparison: 1, template: 0, page: 0 }

function computeIdf(pages, tokens) {
  const idf = new Map()
  for (const token of tokens.keys()) {
    let count = 0
    for (const page of pages) if (page.lower.includes(token)) count += 1
    idf.set(token, Math.min(4, Math.log(1 + pages.length / (1 + count))))
  }
  return idf
}

function scoreCandidate(page, tokens, idf, docType) {
  const title = `${page.title} ${page.rel}`.toLowerCase()
  const tags = page.tags.toLowerCase()
  const body = page.body.toLowerCase()
  const matched = new Set()
  let score = 0
  let strong = false
  for (const [token, base] of tokens) {
    const weight = base * (idf.get(token) ?? 1)
    if (title.includes(token)) {
      score += 8 * weight
      matched.add(token)
      if (token.length >= 3) strong = true
      continue
    }
    if (tags.includes(token)) {
      score += 5 * weight
      matched.add(token)
      continue
    }
    let index = body.indexOf(token)
    let hits = 0
    while (index !== -1 && hits < 3) {
      hits += 1
      score += 1.2 * weight
      index = body.indexOf(token, index + token.length)
    }
    if (hits > 0) matched.add(token)
  }
  // Require two distinct relevant terms, or one strong (title/entity) hit.
  if (matched.size < 2 && !strong) return { score: 0, matched: [] }
  if (docType === 'prototype') {
    const haystack = `${page.title} ${page.rel} ${page.tags}`
    for (const term of PROTOTYPE_TERMS) if (haystack.includes(term)) score += 4
    if (page.rel.includes('prototypes')) score += 10
    if (page.rel.includes('/issues/')) score -= 50
    score += PROTOTYPE_TYPE_BOOST[page.type] ?? 0
    if (page.rel.startsWith('wiki/sources/')) score += 3
    if (page.rel.startsWith('wiki/entities/')) score += 3
  } else {
    const profile = RETRIEVAL_PROFILES[docType] ?? RETRIEVAL_PROFILES.md
    for (const segment of profile.boostPaths) if (page.rel.startsWith(segment)) score += profile.pathBoost
    score += profile.typeBoost[page.type] ?? 0
    const haystack = `${page.title} ${page.rel} ${page.tags}`
    for (const term of profile.terms) if (haystack.includes(term)) score += 2
    if (page.rel.includes('/issues/')) score -= 20
  }
  return { score, matched: [...matched] }
}


/**
 * Structured digest of a page: headings + the sentences that best match the
 * query and carry numbers/phrases. This is what feeds the knowledge brief.
 */
function digestOf(page, tokens, limit = EXCERPT_CHARS) {
  const body = String(page.body ?? '')
  const headings = body
    .split('\n')
    .filter((line) => /^#{1,6}\s+/u.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/u, '').trim())
    .slice(0, 8)
  const sentences = body
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/gu, '$2')
    .replace(/^#{1,6}\s*/gmu, '')
    .split(/(?<=[。！？；])|\n+/u)
    .map((sentence) => sentence.replace(/[*_`>]/gu, '').trim())
    .filter((sentence) => sentence.length >= 18)
  const scored = sentences.map((sentence) => {
    const lower = sentence.toLowerCase()
    let score = 0
    for (const [token, weight] of tokens) if (lower.includes(token)) score += weight
    if (/[0-9０-９%]|\d{4}年/u.test(sentence)) score += 1
    return { sentence, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const picked = []
  for (const item of scored) {
    if (picked.length >= 5) break
    if (item.score <= 0 && picked.length >= 2) break
    picked.push(item.sentence.length > 140 ? `${item.sentence.slice(0, 140)}…` : item.sentence)
  }
  const digest = [headings.length > 0 ? `小节：${headings.join(' / ')}` : null, picked.length > 0 ? `要点：${picked.join(' ')}` : null]
    .filter((line) => line !== null)
    .join('\n')
  return digest.length <= limit ? digest : `${digest.slice(0, limit)}…`
}

/** Score and rank candidates (used for rerank and for the deterministic fallback). */
function retrieveCandidates(kbPath, input, docType, limit = RERANK_CANDIDATES) {
  if (typeof kbPath !== 'string' || kbPath === '') return []
  const stat = statSync(kbPath, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isDirectory()) return []
  const pages = scanVault(kbPath)
  const tokens = tokenizeQuery(input)
  if (tokens.size === 0) return []
  const idf = computeIdf(pages, tokens)
  const seenTitles = new Set()
  return pages
    .map((page) => {
      const { score, matched } = scoreCandidate(page, tokens, idf, docType)
      return { page, score, matched }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((entry) => {
      const key = entry.page.title.toLowerCase()
      if (seenTitles.has(key)) return false
      seenTitles.add(key)
      return true
    })
    .slice(0, limit)
    .map(({ page, score, matched }) => ({
      title: page.title,
      path: page.rel,
      type: page.type,
      domain: page.domain,
      score: Math.round(score * 10) / 10,
      matched,
      excerpt: digestOf(page, tokens, EXCERPT_CHARS),
    }))
}

/** Deterministic "strongly relevant only" shortlist, capped at two. */
function phase1Sources(candidates) {
  if (candidates.length === 0) return []
  const best = candidates[0].score
  const threshold = Math.max(6, best * 0.55)
  return candidates
    .filter((candidate) => candidate.score >= threshold)
    .slice(0, MAX_FINAL_SOURCES)
    .map(({ title, path, type, domain, excerpt, score, matched }) => ({ title, path, type, domain, excerpt, score, matched }))
}

/** Retrieve the pages that become the "知识库依据" of the prompt. */
function retrieveSources(kbPath, input, docType, topN = MAX_FINAL_SOURCES) {
  return phase1Sources(retrieveCandidates(kbPath, input, docType, Math.max(topN, RERANK_CANDIDATES))).slice(0, Math.min(topN, MAX_FINAL_SOURCES))
}



// ---------------------------------------------------------------------------
// Phase 2: LLM rerank (pick at most two genuinely relevant pages, or none)
// ---------------------------------------------------------------------------

function parseJsonObject(text) {
  const start = String(text).indexOf('{')
  const end = String(text).lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(String(text).slice(start, end + 1))
  } catch {
    return null
  }
}

function buildRerankPrompt(input, options, candidates) {
  const system = [
    '你是知识库检索重排器。根据用户需求，从候选页面中挑出**真正相关**的至多 2 篇。',
    '判断标准：页面主题/内容必须能直接支撑本次需求（同产品、同竞品、同场景、同能力域）；泛泛相关或仅命中通用词的不要选。',
    '严格只输出 JSON：{"picks":[{"id":1,"why":"≤30字说明为什么相关"},{"id":2,"why":"..."}]}',
    '若只有 1 篇真正相关，只输出 1 条；若没有一篇真正相关，输出 {"picks":[]}。不要输出其它文字。',
  ].join('\n')
  const user = [
    `【用户需求】\n${input}`,
    '',
    '【候选页面】',
    ...candidates.map(
      (candidate, index) =>
        `${index + 1}. 《${candidate.title}》（${candidate.path}，${candidate.type}/${candidate.domain}）\n摘要：${candidate.excerpt.replace(/\n/gu, ' ').slice(0, 220)}`,
    ),
  ].join('\n')
  return { system, user }
}

/** Returns picked sources, [] for "none relevant", or null when rerank failed. */
async function rerankSources(ctx, config, input, options, candidates, signal) {
  if (candidates.length === 0) return []
  const { system, user } = buildRerankPrompt(input, options, candidates)
  try {
    const result = await askModel(ctx, config, system, user, signal, { maxTokens: 300, purpose: 'prompt-studio-rerank' })
    const parsed = parseJsonObject(result.text)
    if (parsed === null || !Array.isArray(parsed.picks)) return null
    const picks = []
    for (const pick of parsed.picks) {
      const index = Number(pick?.id) - 1
      const candidate = candidates[index]
      if (candidate === undefined) continue
      if (picks.some((entry) => entry.path === candidate.path)) continue
      picks.push({ ...candidate, reason: String(pick?.why ?? '').slice(0, 60) })
      if (picks.length >= MAX_FINAL_SOURCES) break
    }
    return picks
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Explicit user page plan (PPT): "第 1-2 页 … 第 3 页 …" wins over card skeletons
// ---------------------------------------------------------------------------

function parsePagePlan(input) {
  const text = String(input ?? '')
  const marker = /第\s*(\d+)(?:\s*[-–—~至]\s*(\d+))?\s*页/gu
  const matches = [...text.matchAll(marker)]
  if (matches.length === 0) return null
  const entries = new Map()
  matches.forEach((match, index) => {
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    const single = start === end
    const contentStart = (match.index ?? 0) + match[0].length
    const content = text.slice(contentStart, matches[index + 1]?.index ?? text.length).trim()
    for (let page = start; page <= end; page += 1) {
      const existing = entries.get(page)
      if (existing === undefined || (single && !existing.single)) entries.set(page, { page, content, single })
    }
  })
  const pages = [...entries.values()].sort((a, b) => a.page - b.page)
  if (pages.length < 2) return null
  const columnsMatch = /列依次为[：:]\s*([^\n。]+)/u.exec(text)
  const columns =
    columnsMatch === null
      ? []
      : columnsMatch[1]
          .split(/[、，,]/u)
          .map((item) => item.trim().replace(/[；;。.]+$/u, ''))
          .filter((item) => item !== '')
  const parsed = pages.map(({ page, content }) => {
    const firstLine = (content.split('\n')[0] ?? '').replace(/^[\s:：、-]+/u, '')
    const rawTitle = firstLine.includes('：') ? firstLine.split('：')[0] : firstLine
    const title = rawTitle.slice(0, 40).trim() || `第 ${page} 页`
    return { page, title, requirement: content.replace(/\s+/gu, ' ').slice(0, 220) }
  })
  const columnPages = parsed.filter((entry) => /列依次为|差异表/u.test(entry.requirement)).map((entry) => entry.page)
  return { pages: parsed, columns, columnPages }
}


// ---------------------------------------------------------------------------
// User-provided references (URLs / local document paths) must survive verbatim
// ---------------------------------------------------------------------------

function parseReferences(input) {
  const text = String(input ?? '')
  const cleanPath = (raw) => {
    let cleaned = raw.replace(/^@\s*/u, '').trim()
    const ext = /\.(?:docx?|pptx?|pdf|md|xlsx?)/iu.exec(cleaned)
    if (ext !== null) cleaned = cleaned.slice(0, ext.index + ext[0].length)
    return cleaned.replace(/[，。；、,;：:）)\]】]+$/u, '').replace(/\s+$/u, '')
  }
  const urls = []
  for (const match of text.matchAll(/https?:\/\/[^\s，。；、,;：:）)\]】]+/gu)) {
    const cleaned = match[0].replace(/[，。；、,;：:）)\]】]+$/u, '')
    if (cleaned.length >= 8 && !urls.some((entry) => entry.value === cleaned)) urls.push({ value: cleaned, index: match.index ?? 0 })
  }
  // Paths may contain spaces ("01 BI团队") and several may share a line; scan
  // manually and resume after the first extension so the next path is not swallowed.
  const scanPaths = (regex) => {
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
    const matches = []
    let match
    while ((match = re.exec(text)) !== null) {
      const raw = match[0]
      const ext = /\.(?:docx?|pptx?|pdf|md|xlsx?)/iu.exec(raw)
      matches.push({ raw, index: match.index })
      const advance = ext === null ? raw.length : ext.index + ext[0].length
      re.lastIndex = Math.max(match.index + advance, match.index + 1)
    }
    return matches
  }
  const candidates = []
  for (const regex of [
    /(?:@\s*)?(?:~\/|\/Users\/|\/Volumes\/|\/home\/|[A-Za-z]:\\)[^\n，。；、,;：:）)\]】]+/gu,
    /\/[^\s，。；、,;：:）)\]】]+\.(?:docx?|pptx?|pdf|md|xlsx?)\b/giu,
  ]) {
    for (const match of scanPaths(regex)) {
      const cleaned = cleanPath(match.raw)
      if (cleaned.length >= 8) candidates.push({ value: cleaned, index: match.index })
    }
  }
  const paths = []
  for (const candidate of [...candidates].sort((a, b) => b.value.length - a.value.length)) {
    if (paths.some((kept) => kept.value.includes(candidate.value))) continue
    const duplicate = [...paths].reverse().find((kept) => candidate.value.includes(kept.value))
    if (duplicate !== undefined) paths.splice(paths.indexOf(duplicate), 1)
    paths.push(candidate)
  }
  return [...urls, ...paths].sort((a, b) => a.index - b.index).map((entry) => entry.value)
}



// ---------------------------------------------------------------------------
// Prompt construction for the model
// ---------------------------------------------------------------------------

const SCENE_LABELS = {
  requirement: '需求方案',
  quarter: '季度规划',
  year: '年度规划',
  month: '月度迭代',
  competitor: '竞品研究',
  release: '发布说明',
  'product-material': '产品材料',
  'prompt-enhance': '提示词增强',
  iterate: '迭代',
  'new-demo': '新demo',
  '': '未指定',
}

const FORMAT_LABELS = {
  docx: 'Word 文档（.docx）',
  pptx: 'PPT 演示文稿（.pptx）',
  md: 'Markdown 内容源（.md）',
  prototype: '交互原型',
}


/** Each artifact has its own definition of a "professionally enriched requirement". */
/** Prototype inputs sometimes spell out extra content blocks: 场景说明 / 使用流程. */
function parsePrototypeBlocks(input) {
  const text = String(input ?? '')
  return {
    sceneNote: /(场景说明|场景描述|业务场景|使用场景)/u.test(text),
    useFlow: /(使用流程|操作流程|核心流程|业务流程)/u.test(text),
  }
}

/** Historical/generated content must never leak into the requirement section. */
const HISTORY_BANNED = {
  default: ['上次生成', '历史版本', '往期结论', '上期结论'],
  pptx: ['上期', '往期', '上次生成', '历史版本'],
}

const REQUIREMENT_SPECS = {
  docx: {
    minChars: 500,
    citations: 3,
    numbers: 2,
    tokens: ['背景', '目标', '范围', '关键能力', '约束'],
    contract:
      '# 原始需求：500–800 字，用三级小标题组织：### 业务背景与问题（≥3 条知识库事实/数字，句末标（依据：wiki/…））、### 目标与成功度量（量化指标）、### 需求范围（包含/不包含）、### 关键能力与产品术语、### 约束与依赖。',
  },
  pptx: {
    minChars: 350,
    citations: 3,
    numbers: 2,
    tokens: ['汇报', '目标', '范围'],
    contract:
      '# 原始需求：350–500 字，按「汇报命题」写：### 汇报对象与目标、### 本次背景与问题（≥3 条本次检索到的事实/数字并标依据，不回顾上期/历史）、### 本次要回答的问题、### 核心主张（一句话结论）、### 范围与成功标准。',
  },
  md: {
    minChars: 300,
    citations: 2,
    numbers: 1,
    tokens: ['结论'],
    contract:
      '# 原始需求：300–400 字：### 一句话结论、### 背景事实（≥2 条依据）、### 关键判断、### 边界、### 待验证。',
  },
  prototype: {
    minChars: 220,
    citations: 2,
    numbers: 1,
    tokens: ['场景', '页面', '状态'],
    contract:
      '# 原始需求：220–360 字：### 用户与场景、### 目标流程、### 页面范围（入口→结果）、### 状态与异常要求。',
  },
}

function requirementContract(options) {
  const spec = REQUIREMENT_SPECS[options.docType]
  if (options.docType !== 'prototype') return spec.contract
  const blocks = options.prototypeBlocks ?? {}
  const headings = ['### 用户与场景']
  if (blocks.sceneNote) headings.push('### 场景说明（业务/使用场景、触发条件、参与角色、目标与边界）')
  headings.push('### 目标流程')
  if (blocks.useFlow) headings.push('### 使用流程（入口 → 分步骤操作与结果 → 结束/异常分支）')
  headings.push('### 页面范围（入口→结果）', '### 状态与异常要求')
  const min = blocks.sceneNote || blocks.useFlow ? 260 : 220
  return `# 原始需求：${min}–${min + 140} 字：${headings.join('、')}。`
}

function buildSystemPrompt(options, brief = '') {
  const card = ARTIFACT_CARDS[options.docType]
  const sceneLabel = (SCENE_LABELS[options.scene] ?? options.scene) || '未指定'
  const isPrototype = options.docType === 'prototype'
  const outlineRequirement =
    options.docType === 'pptx'
      ? 'table 页码 | 页面主题（结论句） | 展示内容（3–5 条具体信息） | 版式 | 依据'
      : options.docType === 'docx'
        ? 'table 章节 | 要呈现的信息（3–5 条） | 图表/数据 | 依据'
        : options.docType === 'md'
          ? 'table 小节 | 要呈现的信息（3–5 条） | 来源'
          : 'table 页面/状态 | 信息架构与元素 | 交互与状态 | 依据'
  const sections = ['# 角色', '# 任务', '# 原始需求']
  if (!isPrototype) sections.push('# 知识库依据')
  if (!isPrototype || options.withTechArchitecture) sections.push('# 产物规格')
  sections.push('# 内容大纲')
  const guide = [
    '1. # 角色：一行，说明执行者身份与擅长方向（与产物匹配）。',
    '2. # 任务：一到两句，说明产物类型（如 Word 文档 / PPT / Markdown / 交互原型）与核心目标；**不要写文件格式、工具、页数或技术细节**。',
    `3. ${requirementContract(options)}` + '禁止空话、禁止整段照抄资料。',
  ]
  let guideIndex = 4
  if (!isPrototype) {
    guide.push(`${guideIndex}. # 知识库依据：只使用下方资料条目，逐条写 \`- 《标题》（wiki/相对路径）— 一句话说明支撑什么\`。资料为空时写【待验证】。不得编造。`)
    guideIndex += 1
  }
  if (!isPrototype) {
    guide.push(`${guideIndex}. # 产物规格：**逐项写出**交付物、生成方式、结构骨架/页序、容量、命名与落盘、质量要求，不许删减/改写产物定义。`)
    guideIndex += 1
  } else if (options.withTechArchitecture) {
    guide.push(`${guideIndex}. # 产物规格：**只放技术架构表格**（逐行原样输出下方表格），不要写交付物/生成方式/页序/命名/质量要求。`)
    guideIndex += 1
  }
  guide.push(
    isPrototype
      ? `${guideIndex}. # 内容大纲：**必须逐行填写**，用 ${outlineRequirement}。每行"展示内容"写 3–5 条具体信息（字段、组件、交互、状态、来源），禁止空话。`
      : `${guideIndex}. # 内容大纲：**必须逐行填写**，用 ${outlineRequirement}。每一行的"展示内容/要呈现的信息"必须写 3–5 条**具体信息**（指标、图表、数据、字段、来源、结论），禁止"要点≤6行""相关内容""视情况"等空话。`,
  )
  const lines = [
    '你是「提示词增强器」。你的任务：把用户的口语需求，结合知识库资料与界面选项，改写成一段可直接执行的专业提示词。',
    '',
    `本次要交付的**产物**是：${card.deliverable}｜场景：${sceneLabel}` +
      `${options.audience ? `｜受众：${options.audience}` : ''}${options.length ? `｜容量：${options.length}` : `｜容量：${card.capacity}`}` +
      `${options.docType === 'prototype' && options.scene === 'new-demo' ? `｜适配终端：${options.platform || '电脑端+手机端'}` : ''}。`,
    '提示词必须围绕**该产物**组织：章节骨架、页序/页面清单、每页/每章要呈现的信息、命名与生成方式都要与产物一致。',
    '',
    '输出必须只包含以下 Markdown 章节，按顺序、不增不减：',
    ...sections,
    '',
    '章节要求：',
    ...guide,
    '禁止输出这些章节：验收清单、未决问题、交付方式、写作与证据规范。',
    '只输出提示词正文：不要解释、不要回答问题本体、不要用代码围栏包裹整体。用简体中文。',
    '',
    `【本次界面选项】输出格式=${FORMAT_LABELS[options.docType]}；场景=${sceneLabel}` +
      `${options.audience ? `；受众=${options.audience}` : ''}${options.length ? `；篇幅/字数=${options.length}` : ''}` +
      `${options.platform ? `；适配终端=${options.platform}` : ''}。`,
    '',
    ...(options.pagePlan === null || options.pagePlan === undefined
      ? []
      : [
          '',
          '【用户逐页规划（最高优先级，必须严格遵守）】',
          `总页数：${options.pagePlan.pages.length} 页。不得增减页面，不得套用模板默认页序；每页主题必须对应用户规划。`,
          ...options.pagePlan.pages.map((entry) => `- 第 ${entry.page} 页：${entry.title}｜${entry.requirement.slice(0, 180)}`),
          ...(options.pagePlan.columns.length === 0
            ? []
            : [`- 指定表格列（列顺序保持不变）：${options.pagePlan.columns.join(' | ')}`]),
        ]),
    '',
    ...((options.references ?? []).length === 0
      ? []
      : [
          '',
          '【用户参考资料（必须在 # 原始需求 的 ### 参考资料（原文保留） 中原样输出）】',
          ...(options.references ?? []).map((reference, index) => `${index + 1}. ${reference}`),
          '执行提示词时需读取上述网页/本地文档；引用其中结论时仍需标注来源。',
        ]),
    '',
    ...(isPrototype
      ? options.withTechArchitecture
        ? ['【技术架构（写入 # 产物规格 章节，逐行原样输出）】', TECH_ARCHITECTURE]
        : []
      : ['【本次交付产物与产物规格（写入 # 产物规格 章节）】', artifactSpecBlock(options)]),
    '',
    '【内容大纲要求（写入 # 内容大纲 章节）】',
    outlineTable(options),
  ]
  if (brief !== '') {
    lines.push('', '【知识素材包（来自本次检索资料；优先用它丰富原始需求与内容大纲，不要输出"补充背景"之类的额外小节）】', brief)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Knowledge brief (stage 1) + content-outline helpers
// ---------------------------------------------------------------------------

function buildBriefPrompt(input, options, sources) {
  const card = ARTIFACT_CARDS[options.docType]
  const system = [
    `你是知识提炼助手。请阅读给定资料，为撰写「${card.deliverable}」的提示词准备素材。`,
    '',
    '只输出 Markdown，且只包含以下小节（无内容写「（无）」）：',
    '## 关键事实与数字（每条尽量带来源 `（wiki/路径）`）',
    '## 术语与定义',
    '## 能力与功能清单',
    '## 结构与模板要点',
    '## 约束与口径',
    '## 风险与待验证',
    '## 需求增强素材（背景 / 目标与度量 / 范围 / 关键能力与术语 / 约束，每条尽量带来源）',
    '',
    '规则：只使用给定资料，不编造；优先保留与本次需求相关的具体数字、日期、产品术语与可复用结论；不要提炼上期/往期/历史版本结论，不要写建议或提示词正文。',
  ].join('\n')
  return { system, user: buildUserPrompt(input, sources) }
}

function outlineRows(options) {
  if (options.pagePlan !== null && options.pagePlan !== undefined) return options.pagePlan.pages.map((entry) => entry.title)
  if (options.docType === 'prototype') {
    return options.scene === 'new-demo' ? ['入口页', '主流程页', '结果页', '异常/无权限页'] : ['受影响页面', '交互与状态差异', '兼容与回退']
  }
  return artifactSkeleton(options)
}

function outlineTable(options) {
  const rows = outlineRows(options)
  const plan = options.pagePlan ?? null
  if (options.docType === 'pptx') {
    if (plan === null) {
      return [
        '| 页码 | 页面主题（结论句） | 展示内容（具体信息 3–5 条） | 版式 | 依据 |',
        '|---|---|---|---|---|',
        ...rows.map((row, index) => `| ${index + 1} | 待提炼：${row} | 待补充：指标/图表/数据/来源 | 待定 | 待补 |`),
      ].join('\n')
    }
    const columnHint = plan.columns.length === 0 ? '' : `；表格列按用户要求：${plan.columns.join(' / ')}`
    return [
      '| 页码 | 页面主题（结论句） | 展示内容（具体信息 3–5 条） | 版式 | 依据 |',
      '|---|---|---|---|---|',
      ...rows.map(
        (row, index) =>
          `| ${index + 1} | 待提炼：${row} | 待补充（用户要求：${plan.pages[index].requirement.slice(0, 120)}${columnHint}） | 待定 | 待补 |`,
      ),
    ].join('\n')
  }
  if (options.docType === 'docx') {
    return ['| 章节 | 要呈现的信息（3–5 条） | 图表/数据 | 依据 |', '|---|---|---|---|', ...rows.map((row) => `| 待提炼：${row} | 待补充：要点 | 待补 | 待补 |`)].join('\n')
  }
  if (options.docType === 'md') {
    return ['| 小节 | 要呈现的信息（3–5 条） | 来源 |', '|---|---|---|', ...rows.map((row) => `| 待提炼：${row} | 待补充：要点 | 待补 |`)].join('\n')
  }
  return ['| 页面/状态 | 信息架构与元素 | 交互与状态 | 依据 |', '|---|---|---|---|', ...rows.map((row) => `| 待提炼：${row} | 待补充：字段/组件 | 待补充：交互/状态 | 待补 |`)].join('\n')
}

function headingLevel(line) {
  const match = /^(#{1,6})\s+/u.exec(line)
  return match === null ? 0 : match[1].length
}

/** End index of the section starting at `index` (stops at same/higher level). */
function sectionEnd(lines, index) {
  const level = headingLevel(lines[index])
  for (let i = index + 1; i < lines.length; i += 1) {
    const next = headingLevel(lines[i])
    if (next !== 0 && next <= level) return i
  }
  return lines.length
}

function sectionText(prompt, name) {
  const lines = String(prompt).split('\n')
  const index = lines.findIndex((line) => new RegExp(`^#{1,6}\\s*${name}`, 'u').test(line))
  if (index === -1) return ''
  return lines.slice(index + 1, sectionEnd(lines, index)).join('\n')
}

function countTableRows(text) {
  const lines = text.split('\n').filter((line) => /^\|/u.test(line.trim()))
  return Math.max(0, lines.length - 2)
}

function hasContentOutline(prompt, options) {
  const text = sectionText(prompt, '内容大纲')
  if (text === '') return false
  const required = outlineRows(options).length
  const plan = options.pagePlan ?? null
  if (plan !== null) {
    if (countTableRows(text) !== required) return false
    if (plan.columns.some((column) => !prompt.includes(column))) return false
  } else if (countTableRows(text) < required) {
    return false
  }
  const dataRows = text.split('\n').filter((line) => /^\|/u.test(line.trim())).slice(2)
  const concrete = dataRows.filter(
    (row) => row.replace(/\|/gu, '').length >= 40 && /[0-9]|图表|指标|来源|依据|数据|字段|状态/u.test(row),
  ).length
  return concrete >= Math.ceil(required * 0.6)
}

function hasHistoricalContent(prompt, options) {
  const banned = HISTORY_BANNED[options.docType] ?? HISTORY_BANNED.default
  const text = sectionText(prompt, '原始需求')
  return banned.filter((word) => text.includes(word))
}

function hasRichRequirement(prompt, options) {
  if (hasHistoricalContent(prompt, options).length > 0) return false
  const spec = REQUIREMENT_SPECS[options.docType]
  const text = sectionText(prompt, '原始需求')
  const compact = text.replace(/\s/gu, '')
  const citations = text.match(/依据/gu)?.length ?? 0
  const numbers = text.match(/[0-9０-９]/gu)?.length ?? 0
  const tokens = spec.tokens.filter((token) => text.includes(token))
  return compact.length >= spec.minChars && citations >= spec.citations && numbers >= spec.numbers && tokens.length === spec.tokens.length
}

function insertBeforeTech(prompt, block) {
  const lines = prompt.split('\n')
  const techIndex = lines.findIndex((line) => /^#{1,3}\s*技术架构/u.test(line))
  if (techIndex === -1) return `${prompt.trimEnd()}\n\n${block}\n`
  const head = lines.slice(0, techIndex).join('\n').replace(/\s+$/u, '')
  const tail = lines.slice(techIndex).join('\n').replace(/^\s+/u, '')
  return `${head}\n\n${block}\n\n${tail}\n`
}

function ensureContentOutline(prompt, options) {
  if (hasContentOutline(prompt, options)) return prompt
  const block = `# 内容大纲\n\n${outlineTable(options)}`
  if (/^#{1,3}\s*内容大纲/mu.test(prompt)) return upsertSection(prompt, /^#{1,3}\s*内容大纲/u, block)
  return insertBeforeTech(prompt, block)
}

function briefBulletsFrom(brief) {
  return String(brief)
    .split('\n')
    .map((line) => /^[-*]\s+(.+)$/u.exec(line.trim()))
    .filter((match) => match !== null && match[1].length >= 10)
    .slice(0, 6)
    .map((match) => match[1].trim())
}

function ensureRichRequirement(prompt, brief, options) {
  // Prototype requirements must stay short and self-contained: no appended "补充背景".
  if (options.docType === 'prototype') return prompt
  if (hasRichRequirement(prompt, options)) return prompt
  const bullets = briefBulletsFrom(brief)
  if (bullets.length === 0) return prompt
  const addition = `\n\n补充背景（来自知识素材包，写作时可直接引用）：\n${bullets.map((bullet) => `- ${bullet}`).join('\n')}`
  const lines = prompt.split('\n')
  const index = lines.findIndex((line) => /^#{1,3}\s*原始需求/u.test(line))
  if (index === -1) return `${prompt.trimEnd()}${addition}\n`
  const end = sectionEnd(lines, index)
  const updated = [...lines.slice(0, end)]
  updated.push(addition)
  updated.push(...lines.slice(end))
  return updated.join('\n')
}

function hasReferences(prompt, options) {
  const references = options.references ?? []
  if (references.length === 0) return true
  const text = sectionText(prompt, '原始需求')
  if (!text.includes('参考资料')) return false
  return references.every((reference) => text.includes(reference))
}

function ensureReferences(prompt, options) {
  const references = options.references ?? []
  if (hasReferences(prompt, options)) return prompt
  if (references.length === 0) return prompt
  const block = ['### 参考资料（原文保留）', ...references.map((reference) => `- ${reference} — 用户提供的参考资料，执行时需读取`)]
  const lines = prompt.split('\n')
  const requirementIndex = lines.findIndex((line) => /^#{1,6}\s*原始需求/u.test(line))
  if (requirementIndex === -1) return `${prompt.trimEnd()}\n\n${block.join('\n')}\n`
  const requirementEnd = sectionEnd(lines, requirementIndex)
  const subsection = lines.findIndex((line, index) => index > requirementIndex && index < requirementEnd && /^#{1,6}\s*参考资料/u.test(line))
  if (subsection === -1) {
    const before = lines.slice(0, requirementEnd)
    while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
    return [...before, '', ...block, '', ...lines.slice(requirementEnd)].join('\n')
  }
  const subsectionEnd = sectionEnd(lines, subsection)
  const before = lines.slice(0, subsection)
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
  return [...before, '', ...block, '', ...lines.slice(subsectionEnd)].join('\n')
}


function ensurePrototypeBlocks(prompt, options) {
  const blocks = options.prototypeBlocks ?? {}
  const requirement = sectionText(prompt, '原始需求')
  const additions = []
  if (blocks.sceneNote && !requirement.includes('场景说明')) {
    additions.push('### 场景说明', '（按用户输入补充：业务/使用场景、触发条件、参与角色、目标与边界）')
  }
  if (blocks.useFlow && !requirement.includes('使用流程')) {
    additions.push('### 使用流程', '（按用户输入补充：入口 → 分步骤操作与结果 → 结束/异常分支）')
  }
  if (additions.length === 0) return prompt
  const lines = prompt.split('\n')
  const index = lines.findIndex((line) => /^#{1,6}\s*原始需求/u.test(line))
  if (index === -1) return `${prompt.trimEnd()}\n\n${additions.join('\n')}\n`
  const end = sectionEnd(lines, index)
  const before = lines.slice(0, end)
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
  return [...before, '', ...additions, '', ...lines.slice(end)].join('\n')
}

/** Prototype prompts have no "# 知识库依据" section; required content blocks are added. */
function ensurePrototypeSections(prompt, options) {
  if (options.docType !== 'prototype') return prompt
  let text = removeSection(prompt, /^#{1,3}\s*知识库依据/u)
  text = text.replace(/\n*补充背景（来自知识素材包[\s\S]*?(?=\n#{1,3}\s|$)/gu, '\n')
  return ensurePrototypeBlocks(text, options)
}

function ensureTaskWording(prompt, options) {
  if (options.docType !== 'prototype') return prompt
  const task = sectionText(prompt, '任务')
  if (!/html|\.md|单文件|技术栈|技术架构/i.test(task)) return prompt
  const scene = options.scene === 'new-demo' ? '新 demo' : '迭代'
  return upsertSection(prompt, /^#{1,3}\s*任务/u, `# 任务\n\n产出一个交互原型（${scene}），并达成其核心目标。`)
}

function promptIssues(prompt, options) {
  const issues = []
  if (!hasArtifactSpec(prompt, options)) {
    issues.push(`缺少 # 产物规格 章节，或产物关键标记不全（应有：${(ARTIFACT_MARKERS[options.docType] ?? []).join('、')}）`)
  }
  if (!hasContentOutline(prompt, options)) {
    issues.push(`缺少 # 内容大纲，或逐页/逐章信息不足（需覆盖 ${outlineRows(options).length} 行，每行 3–5 条具体信息）`)
  }
  if (!hasReferences(prompt, options)) {
    const missing = (options.references ?? []).filter((reference) => !sectionText(prompt, '原始需求').includes(reference))
    issues.push(`# 原始需求 未原样保留用户参考资料（缺：${missing.join('；')}），请在 ### 参考资料（原文保留） 中逐条保留`)
  }
  if (options.docType === 'prototype') {
    const blocks = options.prototypeBlocks ?? {}
    const requirement = sectionText(prompt, '原始需求')
    if (blocks.sceneNote && !requirement.includes('场景说明')) issues.push('# 原始需求 缺少 ### 场景说明（用户输入提到了场景说明）')
    if (blocks.useFlow && !requirement.includes('使用流程')) issues.push('# 原始需求 缺少 ### 使用流程（用户输入提到了使用流程）')
    const task = sectionText(prompt, '任务').toLowerCase()
    if (/html|\.md|单文件|技术栈|技术架构/.test(task)) {
      issues.push('# 任务 只写“交互原型”即可，不要写 HTML / 单文件 / .md 等技术细节')
    }
    if (/^#{1,3}\s*技术架构/mu.test(prompt)) {
      issues.push('技术架构必须放在 # 产物规格 内，不要单独设 # 技术架构 章节')
    }
  }
  const historical = hasHistoricalContent(prompt, options)
  if (historical.length > 0) {
    issues.push(`# 原始需求 含历史内容（${historical.join('、')}），只需描述本次需求，不得回顾上期/历史版本`)
  }
  if (!hasRichRequirement(prompt, options)) {
    const spec = REQUIREMENT_SPECS[options.docType]
    issues.push(
      `# 原始需求 未达到 ${options.docType} 的专业要求（≥${spec.minChars} 字、引用「依据」≥${spec.citations} 处、含数字 ≥${spec.numbers} 个、覆盖：${spec.tokens.join('/')}）`,
    )
  }
  return issues
}

/** True when the prompt covers the artifact section and its key markers. */
function removeSection(prompt, headingPattern) {
  const lines = prompt.split('\n')
  const index = lines.findIndex((line) => headingPattern.test(line))
  if (index === -1) return prompt
  const end = sectionEnd(lines, index)
  const before = lines.slice(0, index)
  while (before.length > 0 && before[before.length - 1].trim() === '') before.pop()
  const after = lines.slice(end)
  while (after.length > 0 && after[0].trim() === '') after.shift()
  return [...before, ...after].join('\n')
}

function hasArtifactSpec(prompt, options) {
  if (options.docType === 'prototype') {
    if (!options.withTechArchitecture) return true
    const spec = sectionText(prompt, '产物规格')
    return spec.includes('React 19.2.6') && spec.includes('SQL.js')
  }
  if (!/^#{1,3}\s*产物规格/mu.test(prompt)) return false
  const markers = ARTIFACT_MARKERS[options.docType] ?? []
  return markers.every((marker) => prompt.includes(marker))
}

/** Replace/extend a section by heading, or append it. */
function upsertSection(text, headingPattern, block) {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => headingPattern.test(line))
  if (index === -1) return `${text.trimEnd()}\n\n${block}\n`
  const end = sectionEnd(lines, index)
  const before = lines.slice(0, index).join('\n').replace(/\s+$/u, '')
  const after = lines.slice(end).join('\n').replace(/^\s+/u, '').replace(/\s+$/u, '')
  return `${before}\n\n${block}${after === '' ? '' : `\n\n${after}`}\n`
}

/** Guarantee the "# 产物规格" section (prototype keeps only the tech table inside it). */
function ensureArtifactSpec(prompt, options) {
  // Normalise older model output that uses the "# 输出规格" heading.
  prompt = prompt.replace(/^#{1,3}\s*输出规格/mu, '# 产物规格')
  if (options.docType === 'prototype') {
    // Any standalone "# 技术架构" section is merged into "# 产物规格".
    let cleaned = removeSection(prompt, /^#{1,3}\s*技术架构/u)
    if (!options.withTechArchitecture) return removeSection(cleaned, /^#{1,3}\s*产物规格/u)
    if (hasArtifactSpec(cleaned, options)) return cleaned
    const block = `# 产物规格\n\n${TECH_ARCHITECTURE}`
    return upsertSection(cleaned, /^#{1,3}\s*产物规格/u, block)
  }
  if (hasArtifactSpec(prompt, options)) return prompt
  const block = `# 产物规格\n\n${artifactSpecBlock(options)}`
  if (/^#{1,3}\s*产物规格/mu.test(prompt)) return upsertSection(prompt, /^#{1,3}\s*产物规格/u, block)
  return insertBeforeTech(prompt, block)
}

function buildUserPrompt(input, sources) {
  const listing =
    sources.length === 0
      ? '（本次未检索到知识库资料）'
      : sources
          .map(
            (source, index) =>
              `${index + 1}. 《${source.title}》（${source.path}，${source.type}/${source.domain}）${source.reason ? ` — ${source.reason}` : ''}\n摘录：${source.excerpt.replace(/\n/gu, ' ').slice(0, 600)}`,
          )
          .join('\n\n')
  return `【用户原始需求】\n${input}\n\n【知识库资料（仅这些可作为依据）】\n${listing}`
}

/** Guarantee the canonical tech-architecture table when the option requires it. */
function ensureTechArchitecture(text, required) {
  if (!required) return text
  const block = `# 技术架构\n\n${TECH_ARCHITECTURE}`
  const lines = text.split('\n')
  const headingIndex = lines.findIndex((line) => /^#{1,3}\s*技术架构/u.test(line))
  if (headingIndex === -1) return `${text.replace(/\s+$/u, '')}\n\n${block}\n`
  const end = sectionEnd(lines, headingIndex)
  const before = lines.slice(0, headingIndex).join('\n').replace(/\s+$/u, '')
  const after = lines.slice(end).join('\n').replace(/^\s+/u, '').replace(/\s+$/u, '')
  return `${before}\n\n${block}${after === '' ? '' : `\n\n${after}`}\n`
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

function messageFor(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-prompt-studio' } }
}

async function askModel(ctx, config, system, user, signal, settings = {}) {
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.stream !== 'function') throw httpError(503, '当前 profile 没有可用的模型服务（ctx.llm）')
  const selection =
    typeof config.provider === 'string' && typeof config.model === 'string'
      ? { provider: config.provider, model: config.model }
      : ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selection === undefined || selection === null || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw httpError(503, '没有解析到默认模型：请在插件配置里设置 provider/model，或在设置里选择模型')
  }
  const maxTokens =
    Number.isInteger(settings.maxTokens) && settings.maxTokens > 0
      ? settings.maxTokens
      : Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens > 0
        ? config.maxOutputTokens
        : DEFAULT_MAX_TOKENS
  let answer = ''
  let failure
  let finishKind = 'unknown'
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    messages: [messageFor(user)],
    maxTokens,
    purpose: settings.purpose ?? 'prompt-studio-generate',
    signal,
  })) {
    if (chunk.type === 'text-delta') answer += chunk.text
    else if (chunk.type === 'finish') {
      const reason = chunk.reason
      finishKind = reason?.kind ?? 'unknown'
      if (reason !== undefined && reason.kind !== 'stop') failure = reason.failure
    }
  }
  if (failure !== undefined) throw httpError(502, `模型调用失败：${failure.code ?? 'unknown'}${failure.message ? ` · ${failure.message}` : ''}`)
  return { text: answer.trim(), model: `${selection.provider}/${selection.model}`, finishKind }
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
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 10 * 1024 * 1024) throw httpError(413, '请求体过大（>10MB）')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, '请求体不是合法 JSON')
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const assets = resolveAssets(config)
  const raw = readFileSync(assets.skillPath, 'utf8')
  const { meta, content } = parseSkillFile(raw, assets.skillPath)
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (description === '') throw new Error(`prompt-studio: ${assets.skillPath} has no description`)
  const whenToUse = typeof meta.whenToUse === 'string' ? meta.whenToUse.trim() : undefined
  const runtime = renderRuntimeSection(config, assets)

  const candidate = {
    name: SKILL_NAME,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: assets.skillDir },
    locator: assets.skillPath,
    path: assets.skillPath,
  }

  ctx.skills.registerProvider(() => ({
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    async get(hit, options) {
      const current = await readFile(hit.locator, { encoding: 'utf8', signal: options?.signal })
      const parsed = parseSkillFile(current, hit.locator)
      const { rank: _rank, locator: _locator, ...summary } = hit
      return { ...summary, content: parsed.content + runtime }
    },
  }))

  // -- generation API -------------------------------------------------------
  const generate = async (body) => {
    const input = typeof body.input === 'string' ? body.input.trim() : ''
    if (input === '') throw httpError(400, '请输入原始需求')
    const docType = typeof body.docType === 'string' ? body.docType : 'md'
    if (!FORMATS.has(docType)) throw httpError(400, `不支持的输出格式：${docType}`)
    const options = {
      docType,
      scene: typeof body.scene === 'string' ? body.scene : '',
      audience: typeof body.audience === 'string' ? body.audience : '',
      length: typeof body.length === 'string' ? body.length.trim() : '',
      platform: typeof body.platform === 'string' ? body.platform : '',
      withTechArchitecture: docType === 'prototype' && body.scene === 'new-demo' && body.withTechArchitecture !== false,
      pagePlan: docType === 'pptx' ? parsePagePlan(input) : null,
      prototypeBlocks: docType === 'prototype' ? parsePrototypeBlocks(input) : null,
      references: parseReferences(input),
    }
    const kbPath = typeof body.kbPath === 'string' ? body.kbPath : ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 180_000)
    try {
      // Retrieval: score (IDF + gating) → optional LLM rerank → at most two sources.
      const candidateLimit =
        Number.isInteger(config.rerankCandidates) && config.rerankCandidates > 0 ? config.rerankCandidates : RERANK_CANDIDATES
      const candidates = retrieveCandidates(kbPath, input, docType, candidateLimit)
      let sources
      if (config.retrievalRerank === false || candidates.length <= 1) {
        sources = phase1Sources(candidates)
      } else {
        const reranked = await rerankSources(ctx, config, input, options, candidates, controller.signal)
        sources = reranked === null ? phase1Sources(candidates) : reranked
      }

      // Stage 1 — distil the retrieved pages into a knowledge brief.
      const briefPrompt = buildBriefPrompt(input, options, sources)
      const briefTokens = Number.isInteger(config.briefMaxTokens) && config.briefMaxTokens > 0 ? config.briefMaxTokens : DEFAULT_BRIEF_TOKENS
      let brief = ''
      let briefUsed = false
      if (config.knowledgeBrief !== false) {
        try {
          const briefResult = await askModel(ctx, config, briefPrompt.system, briefPrompt.user, controller.signal, {
            maxTokens: briefTokens,
            purpose: 'prompt-studio-brief',
          })
          brief = briefResult.text
          briefUsed = brief !== ''
        } catch {
          brief = ''
          briefUsed = false
        }
      }

      // Stage 2 — write the prompt around the artifact + brief.
      const system = buildSystemPrompt(options, brief)
      const user = buildUserPrompt(input, sources)
      const configuredBudget =
        Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens > 0 ? config.maxOutputTokens : DEFAULT_MAX_TOKENS
      const recoveryBudget = Math.min(16000, Math.max(8000, configuredBudget * 2))
      const callMain = (sys, maxTokens) =>
        askModel(ctx, config, sys, user, controller.signal, maxTokens === undefined ? {} : { maxTokens })
      let result = await callMain(system)
      let emptyRetry = false
      if (result.text === '') {
        // A reasoning model can spend the whole budget on thinking and return no
        // visible text; retry once with a larger output budget before failing.
        emptyRetry = true
        console.warn(`[prompt-studio] empty completion (finish=${result.finishKind}), retrying with maxTokens=${recoveryBudget}`)
        result = await callMain(system, recoveryBudget)
        if (result.text === '') {
          throw httpError(
            502,
            `模型没有返回内容（finish=${result.finishKind ?? 'unknown'}、模型=${result.model}、maxTokens=${recoveryBudget}）。可点击重试，或在插件配置里调高 maxOutputTokens`,
          )
        }
      }
      let attempts = 1
      let recovered = false
      const issues = promptIssues(result.text, options)
      if (issues.length > 0) {
        const corrective = `${system}\n\n【重试要求】上一次输出存在以下问题，请全部修复后重写：\n- ${issues.join('\n- ')}`
        const retry = await callMain(corrective)
        if (retry.text === '') {
          // Keep the first answer and repair it deterministically instead of failing.
          recovered = true
          console.warn(`[prompt-studio] corrective retry returned no content (finish=${retry.finishKind}); hydrating the first answer`)
        } else {
          result = retry
          attempts = 2
        }
      }
      let prompt = ensureArtifactSpec(result.text, options)
      prompt = ensurePrototypeSections(prompt, options)
      prompt = ensureTaskWording(prompt, options)
      prompt = ensureContentOutline(prompt, options)
      prompt = ensureRichRequirement(prompt, brief, options)
      prompt = ensureReferences(prompt, options)
      return {
        prompt,
        sources: sources.map(({ excerpt: _excerpt, ...rest }) => rest),
        model: result.model,
        options,
        attempts,
        briefUsed,
        recovered,
        emptyRetry,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/u, '') || '/'
    if (req.method === 'POST' && path === '/generate') return sendJson(res, 200, await generate(await readJson(req)))
    return sendJson(res, 404, { error: `未知接口：${req.method} ${path}` })
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) =>
        handler(req, res).catch((error) => {
          const status = Number.isInteger(error?.status) ? error.status : 500
          if (res.headersSent) {
            res.destroy()
            return
          }
          sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }),
    })
    return () => dispose()
  }, 'prompt-studio: /prompt-studio/api routes')
}

/** Exported for tests only. */
export const internals = {
  TECH_ARCHITECTURE,
  buildSystemPrompt,
  buildUserPrompt,
  retrieveSources,
  scanVault,
  tokenizeQuery,
  ARTIFACT_CARDS,
  ARTIFACT_MARKERS,
  RETRIEVAL_PROFILES,
  artifactSpecBlock,
  artifactSpecLines,
  artifactSkeleton,
  buildBriefPrompt,
  ensureContentOutline,
  ensureRichRequirement,
  hasContentOutline,
  hasRichRequirement,
  outlineRows,
  outlineTable,
  pptxPageTable,
  HISTORY_BANNED,
  REQUIREMENT_SPECS,
  buildRerankPrompt,
  ensureReferences,
  ensurePrototypeBlocks,
  ensurePrototypeSections,
  ensureTaskWording,
  parsePrototypeBlocks,
  requirementContract,
  hasReferences,
  phase1Sources,
  rerankSources,
  retrieveCandidates,
  parseReferences,
  hasHistoricalContent,
  parsePagePlan,
  promptIssues,
  buildSystemPrompt,
  ensureArtifactSpec,
  ensureTechArchitecture,
  hasArtifactSpec,
  upsertSection,
}
