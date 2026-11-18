#!/usr/bin/env node
/**
 * DataPilot 知识库检索助手 —— prompt-optimizer 技能专用。
 *
 * 零依赖（只用 Node 内置模块），Node >= 18。
 *
 * 命令：
 *   node kb.mjs [--kb <path>] info
 *   node kb.mjs [--kb <path>] search "<查询词>" [--top 10] [--type concept,entity] [--domain AGT]
 *   node kb.mjs [--kb <path>] outline <页面路径或唯一片段>
 *   node kb.mjs [--kb <path>] spec <docx|pptx|md|auto>
 *   node kb.mjs [--kb <path>] recent [--n 8]
 *
 * 设计取向：只做"定位 + 给行号 + 给规范摘要"，正文始终由 agent 用文件读取工具按行号精读，
 * 避免把整页 wiki 倒进上下文。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const DEFAULT_KB = '/Users/you/Documents/knowledge-base'
const ASCII = (s) => s.replace(/[\u0300-\u036f]/gu, '')

// ---------------------------------------------------------------------------
// CLI 解析
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    const [key, inline] = arg.slice(2).split('=')
    if (inline !== undefined) flags.set(key, inline)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(key, argv[(i += 1)])
    else flags.set(key, 'true')
  } else {
    positional.push(arg)
  }
}

const command = positional[0] ?? 'info'
const KB = resolve(flags.get('kb') ?? process.env.PROMPT_OPTIMIZER_KB ?? DEFAULT_KB)
const WIKI = join(KB, 'wiki')

function usage(code = 0) {
  const text = `用法：
  node kb.mjs --kb <知识库路径> info
  node kb.mjs --kb <知识库路径> search "<关键词>" [--top 10] [--type concept,entity] [--domain AGT]
  node kb.mjs --kb <知识库路径> outline <页面路径或片段>
  node kb.mjs --kb <知识库路径> spec <docx|pptx|md|auto>
  node kb.mjs --kb <知识库路径> recent [--n 8]

默认知识库：${DEFAULT_KB}`
  console.log(text)
  process.exit(code)
}

function fail(message, code = 1) {
  console.error(`错误：${message}`)
  process.exit(code)
}

if (command === 'help' || command === '-h' || command === '--help') usage(0)

if (!statSync(KB, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`知识库目录不存在：${KB}\n请检查插件配置中的 knowledgeBase，或用 --kb 指定正确路径。`, 2)
}

// ---------------------------------------------------------------------------
// 页面模型
// ---------------------------------------------------------------------------

/** @typedef {{ rel: string, abs: string, meta: Record<string, string>, body: string, lines: string[], headings: { level: number, title: string, line: number }[] }} Page */

function readFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (match === null) return { meta: {}, body: raw, bodyOffset: 0 }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line)
    if (kv === null) continue
    meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/gu, '')
  }
  return { meta, body: raw.slice(match[0].length), bodyOffset: match[0].split(/\r?\n/u).length - 1 }
}

function parsePage(abs) {
  const raw = readFileSync(abs, 'utf8')
  const { meta, body } = readFrontmatter(raw)
  const lines = raw.split(/\r?\n/u)
  const headings = []
  for (let i = 0; i < lines.length; i += 1) {
    const h = /^(#{1,4})\s+(.*)$/u.exec(lines[i])
    if (h !== null) headings.push({ level: h[1].length, title: h[2].trim(), line: i + 1 })
  }
  return { rel: relative(KB, abs).split(sep).join('/'), abs, meta, body, lines, headings }
}

const SKIP_DIRS = new Set(['.obsidian', '.git', 'node_modules', '.trash'])
const SKIP_FILES = new Set(['log.md'])

/** @returns {string[]} */
function walkWiki(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...walkWiki(abs))
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(abs)
    }
  }
  return out
}

function loadPages() {
  if (!statSync(WIKI, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`找不到 wiki 目录：${WIKI}`, 2)
  }
  return walkWiki(WIKI).map(parsePage)
}

function titleOf(page) {
  return page.meta.title ?? page.headings.find((h) => h.level === 1)?.title ?? page.rel.split('/').pop().replace(/\.md$/u, '')
}

function typeOf(page) {
  if (page.meta.type) return page.meta.type
  const top = page.rel.split('/')[0]
  return { concepts: 'concept', entities: 'entity', comparisons: 'comparison', sources: 'source', templates: 'template', issues: 'issue', deliverables: 'deliverable' }[top] ?? 'page'
}

function tagsOf(page) {
  return page.meta.tags ?? ''
}

// ---------------------------------------------------------------------------
// 分词与打分
// ---------------------------------------------------------------------------

function tokenize(query) {
  /** @type {Map<string, number>} */
  const tokens = new Map()
  const add = (token, weight) => {
    if (token.length < 1) return
    tokens.set(token, Math.max(tokens.get(token) ?? 0, weight))
  }
  for (const word of query.match(/[A-Za-z][A-Za-z0-9._-]{1,}/gu) ?? []) {
    const lower = word.toLowerCase()
    add(lower, 2)
    for (const part of lower.split(/[._-]/u)) if (part.length >= 2) add(part, 1.5)
  }
  for (const run of query.match(/[\u3400-\u9fff]+/gu) ?? []) {
    if (run.length <= 6) add(run, 3)
    for (let i = 0; i + 2 <= run.length; i += 1) add(run.slice(i, i + 2), 1)
    for (let i = 0; i + 3 <= run.length && run.length > 6; i += 1) add(run.slice(i, i + 3), 1.2)
  }
  return tokens
}

function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1 && count < 6) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function scorePage(page, tokens, query) {
  const title = `${titleOf(page)} ${page.rel}`.toLowerCase()
  const tags = String(tagsOf(page)).toLowerCase()
  const headingText = page.headings.map((h) => h.title).join(' ').toLowerCase()
  const body = page.body.toLowerCase()
  let score = 0
  const matchedHeadings = []
  for (const [token, weight] of tokens) {
    if (title.includes(token)) score += 7 * weight
    if (tags.includes(token)) score += 4.5 * weight
    if (headingText.includes(token)) score += 2.5 * weight
    score += countOccurrences(body, token) * weight
  }
  for (const h of page.headings) {
    const lower = h.title.toLowerCase()
    let hits = 0
    for (const token of tokens.keys()) if (lower.includes(token)) hits += 1
    if (hits > 0) matchedHeadings.push({ title: h.title, hits, line: h.line })
  }
  matchedHeadings.sort((a, b) => b.hits - a.hits)

  const type = typeOf(page)
  if (/(对比|竞品|横向|对标|vs)/iu.test(query)) {
    if (type === 'comparison') score *= 1.3
    if (type === 'entity') score *= 1.1
  }
  if (/(研究|演进|路线|roadmap)/iu.test(query) && type === 'deliverable') score *= 1.2
  if (/(方案|设计|需求)/iu.test(query) && (type === 'concept' || type === 'deliverable')) score *= 1.1
  if (/(模板|规范|格式|排版|ppt|幻灯片|演示|docx|word|文档)/iu.test(query) && type === 'template') score *= 1.45
  if (/(报错|异常|根因|定位)/iu.test(query) && (type === 'issue' || page.rel.includes('issues/'))) score *= 1.4
  if (page.meta.status === 'stable') score *= 1.03
  // The index and overview are pointer hubs: useful but they match almost every
  // query through their link lists, so keep them off the top of ordinary searches.
  if (/\/(index|overview)\.md$/u.test(page.rel)) score *= 0.4
  return { score, matchedHeadings: matchedHeadings.slice(0, 2) }
}

function excerpt(page, tokens) {
  const text = page.body
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/gu, '$2')
    .replace(/[`*_>#]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  let best = -1
  let bestToken = ''
  for (const [token, weight] of tokens) {
    const at = text.toLowerCase().indexOf(token)
    if (at !== -1 && weight > best) {
      best = weight
      bestToken = token
      if (weight >= 3) break
    }
  }
  const at = bestToken === '' ? 0 : text.toLowerCase().indexOf(bestToken)
  const start = Math.max(0, at - 70)
  const slice = text.slice(start, start + 150)
  return `${start > 0 ? '…' : ''}${slice}${start + 150 < text.length ? '…' : ''}`
}

// ---------------------------------------------------------------------------
// 命令：search
// ---------------------------------------------------------------------------

function commandSearch() {
  const query = positional.slice(1).join(' ').trim()
  if (query === '') fail('search 需要一个查询词，例如：search "季度规划 ChatBI 自动化任务"')
  const top = Number.parseInt(flags.get('top') ?? '10', 10)
  const typeFilter = (flags.get('type') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const domainFilter = (flags.get('domain') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const tokens = tokenize(query)
  const pages = loadPages()
  const scored = []
  for (const page of pages) {
    if (typeFilter.length > 0 && !typeFilter.includes(typeOf(page))) continue
    if (domainFilter.length > 0 && page.meta.domain && !domainFilter.includes(page.meta.domain.toUpperCase())) continue
    const { score, matchedHeadings } = scorePage(page, tokens, query)
    if (score >= 5) scored.push({ page, score, matchedHeadings })
  }
  scored.sort((a, b) => b.score - a.score)
  const shown = scored.slice(0, Number.isFinite(top) && top > 0 ? top : 10)

  console.log(`知识库检索 · ${KB}`)
  console.log(`查询：「${query}」 · 候选 ${scored.length} / ${pages.length} 页 · 显示前 ${shown.length} 条`)
  if (shown.length === 0) {
    console.log('\n没有命中。建议：换用更短的产品名/机制名作为关键词（2–4 个词），或先用 info 看知识库覆盖哪些主题。')
    return
  }
  console.log('')
  shown.forEach((item, index) => {
    const page = item.page
    const meta = [typeOf(page), page.meta.domain ?? '', page.meta.status ?? ''].filter(Boolean).join('·')
    console.log(`[${index + 1}] ${item.score.toFixed(1)}  ${page.rel}  (${meta})`)
    console.log(`    标题：${titleOf(page)}${page.meta.last_updated ? `（更新 ${page.meta.last_updated}）` : ''}`)
    if (item.matchedHeadings.length > 0) {
      console.log(`    命中：${item.matchedHeadings.map((h) => `L${h.line} ${h.title}`).join(' ｜ ')}`)
    }
    console.log(`    摘录：${excerpt(page, tokens)}`)
  })
  console.log('')
  console.log('下一步：node kb.mjs outline <上面的相对路径>   # 看小节行号，再用文件读取工具按 offset/limit 精读命中小节')
}

// ---------------------------------------------------------------------------
// 命令：outline
// ---------------------------------------------------------------------------

function resolvePage(query) {
  if (query === '') fail('outline 需要一个页面路径或唯一片段')
  const direct = resolve(KB, query)
  if (statSync(direct, { throwIfNoEntry: false })?.isFile()) return parsePage(direct)
  const needle = query.replace(/\.md$/u, '').toLowerCase()
  const pages = loadPages()
  const byName = pages.filter((p) => p.rel.toLowerCase().endsWith(`${needle}.md`))
  if (byName.length === 1) return byName[0]
  const byPart = pages.filter((p) => p.rel.toLowerCase().includes(needle))
  if (byPart.length === 1) return byPart[0]
  if (byPart.length > 1) {
    fail(`片段「${query}」匹配到多页，请写得更具体：\n${byPart.map((p) => `  - ${p.rel}`).join('\n')}`)
  }
  fail(`找不到页面「${query}」。先跑 search 拿到准确的相对路径。`)
}

function commandOutline() {
  const page = resolvePage(positional[1] ?? '')
  const size = (statSync(page.abs).size / 1024).toFixed(1)
  console.log(`# ${page.rel} · ${page.lines.length} 行 · ${size} KB`)
  const metaKeys = ['type', 'domain', 'status', 'last_updated', 'tags']
  console.log(metaKeys.filter((k) => page.meta[k]).map((k) => `${k}=${page.meta[k]}`).join('  '))
  console.log('')
  for (const h of page.headings) console.log(`${'  '.repeat(h.level - 1)}L${h.line}\t${h.title}`)
  console.log('')
  console.log(`精读示例：用文件读取工具读 ${page.rel}，offset=<小节起始行> limit=40`)
}

// ---------------------------------------------------------------------------
// 命令：spec（写作规范摘要）
// ---------------------------------------------------------------------------

const SPECS = {
  docx: `Word 文档规范摘要（硬性细节以规范页为准）
  规范页：wiki/templates/word-文档写作模板.md
  母版：  wiki/templates/Typora-Word2.docx（公司 Word 母版，只读；另存产出，不在母版上改）
  通用骨架：封面 → 文档信息表（版本/日期/作者/口径/状态）→ 修订记录 → 目录
             → 一、背景与问题 → 二、目标与范围 → 三、方案/结论 → 四、关键设计
             → 五、风险与依赖 → 六、待决策事项 → 附录A 术语表 → 附录B 来源
  场景骨架（第三节展开方式）：
    需求方案设计：需求描述 → 用户场景 → 功能设计 → 数据与技术设计 → 验收标准 → 遗留决策点
    年度规划：年度目标 → 主题/战役拆解 → 季度节奏 → 资源与依赖 → 风险
    季度规划：上季度回顾 → 本季度目标 → 需求/版本清单（版本轴）→ 里程碑 → 依赖与风险
    月度迭代：本月范围 → 需求清单与状态 → 发布计划 → 遗留问题
    竞品研究：定位 → 功能架构 → 技术架构 → 能力对照 → 对我方启示 → 局限与风险
    发布说明：版本概览 → 新增/优化/修复 → 影响与兼容 → 升级与回滚 → 已知问题
    验证复盘：目标与验收标准 → 实测结果 → 偏差与根因 → 结论 → 后续动作
    会议纪要：议题 → 结论 → 待办（负责人/截止）→ 未决事项
  排版要点：正文 Normal 10.5pt；标题最多三级；每节先结论后论据；图表按章编号（图3-1/表3-2）＋标题＋单位；
            强调只用加粗；表格用 Table Grid。
  ⚠️ 已测缺口：母版 styles.xml 未定义 Heading 1–9 → 导出后必须检查导航窗格标题层级与目录。
  篇幅：方案类 8–20 页；规划类 10–25 页；竞品研究 6–15 页。
  命名：YYYYMMDD-<产品>-<主题>-<版本>.docx（如 20261019-chatbi-需求方案-D2.0.2-V0.9.docx；定稿才 V1.0）
  自检清单：封面/文档信息表（含口径）/修订记录齐全；标题层级正确且目录可更新；数字与结论有出处、转引标【待验证】；
            置信度标注齐全；口径合规（外发隐去 Hermes，不得改称不实归属，保留第三方引用）；图表编号/单位/口径齐全；
            遗留决策点含优先级/关闭条件/负责人；术语统一；排版四项检查；命名合规。`,
  pptx: `PPT 演示文稿规范摘要（硬性细节以规范页为准）
  规范页：wiki/templates/ppt-演示文稿写作模板.md
  母版：  wiki/templates/浩鲸科技_20周年_ppt中文模板_白.potx（中文默认白版；1 母版 / 7 版式）
  页类型（每页一个任务）：封面 / 目录 / 章节过渡 / 观点页 / 数据页 / 对比页 / 方案页 / 路线图页 / 总结页 / 附录页
  硬约束：★ 页面标题必须是「结论句」，不写"现状分析"这类无信息量词；一页一个结论；正文 ≤6 行、每行 ≤2 分句；
          图 > 表 > 字，正文不出现整段文字；使用母版版式，不手工堆文本框。
  场景页序（20 分钟 ≈ 15–20 页）：
    季度/年度规划汇报：封面 → 目录 → 上期回顾(1-2) → 本期目标(1) → 重点战役(3-4) → 版本/里程碑路线图(1-2) → 资源与依赖(1) → 风险(1) → 总结与下一步(1) → 附录
    需求方案评审：封面 → 目录 → 问题与证据(1-2) → 目标与范围(1) → 方案总览(1) → 关键流程(2-3) → 交互/原型(2) → 验收标准(1) → 待决策(1) → 附录
    竞品分析汇报：封面 → 目录 → 市场与定位(1) → 竞品架构(2) → 能力对照矩阵(1-2) → 我方定位与差距(1-2) → 启示与建议(1) → 附录(来源)
    产品发布/对外赋能：封面 → 目录 → 客户痛点(1-2) → 能力总览(1) → 场景演示(3-4) → 价值与案例(2) → 落地路径(1) → 总结(1)
  版式选用：按正文占位符数量选（观点页/结论页=×1，对比页/双列=×2，三要点页=×3）；数据页图占正文区。
  配色：主色 accent4 #0082FF 或 accent3 #00B4FF；正向 accent2 #00F0BE；风险 accent6 #FF6E00；
        文字 dk1 #2E2E32 / 次要 lt2 #595757；单页主色 ≤2 个；同一指标跨页同色。
  字号：封面主标题 40–44pt；页面标题 24–28pt；正文要点 16–18pt；脚注 10–12pt。
  字体：主题字体 Roboto / 方正兰亭细黑简体，不另设字体。
  自检清单：每页标题为结论句；一页一论点、≤6 行；使用母版版式且页码正常；无杂字体；主色 ≤2 且同指标同色；
            图表有标题/单位/口径/来源/日期；涨跌配色已显式标注；外发已脱敏且无未公开客户信息；
            总结页含下一步动作+负责方+时间；页数与时长匹配；命名合规。`,
  md: `Markdown 内容源规范摘要
  用途：wiki 只存 Markdown 内容源，成品（docx/pptx）另行存放，不入库。
  骨架：按目标成品类型复用 Word / PPT 的章节骨架（见 spec docx / spec pptx）。
  存放：过程稿放工作区；定稿结论回写知识库 wiki/deliverables/<类型>/，命名 YYYYMMDD-<产品>-<主题>.md。
  必备：frontmatter（title/type: deliverable/domain/tags/source_count/created/last_updated/status）；
        结尾「来源」小节列 raw/ 或 wiki 路径。
  写作规范：同 Word——先结论后论据、数字带出处与日期、置信度标注、术语首次给全称。`,
}

function commandSpec() {
  const requested = (positional[1] ?? 'auto').toLowerCase()
  const key = { word: 'docx', doc: 'docx', ppt: 'pptx', pptx: 'pptx', docx: 'docx', md: 'md', markdown: 'md' }[requested]
  if (requested === 'auto') {
    console.log(`如何判断产出格式：
  - 用户说"PPT/汇报/评审/演示/幻灯片" → pptx
  - 用户说"文档/方案/规划/报告/说明/纪要/docx/Word" → docx
  - 用户只要"整理成 md / 内容源 / 研究稿" → md
  - 两者都要（如季度规划：Word 详版 + PPT 汇报版）→ 两份分别按 docx 和 pptx 处理，PPT 只放结论，细节回挂 Word
确定后重新执行：node kb.mjs spec <docx|pptx|md>`)
    return
  }
  if (!key || !SPECS[key]) fail(`未知格式「${requested}」，可用：docx | pptx | md | auto`)
  console.log(SPECS[key])
  console.log('')
  console.log(`母版/规范页绝对路径：`)
  console.log(`  ${join(KB, 'wiki/templates/README.md')}`)
  if (key === 'docx') {
    console.log(`  ${join(KB, 'wiki/templates/word-文档写作模板.md')}`)
    console.log(`  ${join(KB, 'wiki/templates/Typora-Word2.docx')}`)
  } else if (key === 'pptx') {
    console.log(`  ${join(KB, 'wiki/templates/ppt-演示文稿写作模板.md')}`)
    console.log(`  ${join(KB, 'wiki/templates/浩鲸科技_20周年_ppt中文模板_白.potx')}`)
  }
  console.log('')
  console.log('写正文前仍需读规范页对应小节（场景骨架 / 自检清单 / 已知缺口）；本摘要只用于把「输出规格」写进提示词。')
}

// ---------------------------------------------------------------------------
// 命令：info / recent
// ---------------------------------------------------------------------------

function commandInfo() {
  const pages = loadPages()
  const counts = new Map()
  for (const page of pages) {
    const top = page.rel.replace(/^wiki\//u, '').split('/')[0]
    const bucket = top.endsWith('.md') ? '根目录' : top
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const schema = join(KB, 'CLAUDE.md')
  const schemaStat = statSync(schema, { throwIfNoEntry: false })
  console.log(`DataPilot 知识库 · ${KB}`)
  console.log(`- Schema：${schemaStat ? `CLAUDE.md (${(schemaStat.size / 1024).toFixed(1)} KB，mtime ${schemaStat.mtime.toISOString().slice(0, 10)})` : '⚠️ 缺 CLAUDE.md'}`)
  console.log(`- wiki 页面：${pages.length} 页`)
  console.log(`- 分布：${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  const templates = ['word-文档写作模板.md', 'ppt-演示文稿写作模板.md', 'README.md']
  console.log(`- 写作规范：${templates.join(' / ')}`)
  console.log(`- 公司母版：Typora-Word2.docx / 浩鲸科技_20周年_ppt中文模板_白.potx`)
  const recent = pages
    .map((p) => ({ rel: p.rel, date: p.meta.last_updated ?? '', title: titleOf(p) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/u.test(p.date))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 5)
  if (recent.length > 0) {
    console.log(`- 最近更新：${recent.map((p) => `${p.date} ${p.rel}`).join(' | ')}`)
  }
}

function commandRecent() {
  const n = Number.parseInt(flags.get('n') ?? '8', 10)
  const pages = loadPages()
    .map((p) => ({ rel: p.rel, title: titleOf(p), date: p.meta.last_updated ?? statSync(p.abs).mtime.toISOString().slice(0, 10), type: typeOf(p) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, Number.isFinite(n) && n > 0 ? n : 8)
  for (const page of pages) console.log(`${page.date}  ${page.rel}  (${page.type})  ${page.title}`)
}

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

switch (command) {
  case 'info':
    commandInfo()
    break
  case 'search':
    commandSearch()
    break
  case 'outline':
    commandOutline()
    break
  case 'spec':
    commandSpec()
    break
  case 'recent':
    commandRecent()
    break
  default:
    fail(`未知命令「${command}」。`)
}
