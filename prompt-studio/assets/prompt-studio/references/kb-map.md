# 知识库地图与检索策略（DataPilot · WhaleBI 知识库）

> 本文件告诉你：知识库里有什么、该去哪个页面拿依据、怎么引用才不出错。
> 权威规范始终是知识库根目录的 `CLAUDE.md`（Schema）；本文件只做"面向提示词优化"的索引。

---

## 一、这是什么库

参照 Karpathy LLM Wiki 模式构建的个人知识迭代系统，服务于 BI 产品（WhaleBI / ChatBI）设计工作：

```
raw/（原始素材，不可变）──AI 编译──▶ wiki/（结构化页面）──综合──▶ wiki/deliverables/（可交付产出）
```

- **权威入口**：`CLAUDE.md`（Schema，规定目录、frontmatter、口径、工作流）；每次操作知识库都应先读它。
- **符号表**：`wiki/index.md`（全库页面索引）；`wiki/overview.md`（领域总览）。
- **写作模板**：`wiki/templates/`（公司 Word/PPT 母版 + 两份写作规范页，产出 docx/pptx 必用）。
- **知识库规模**（2026-10 现状）：约 148 页 wiki（concepts 53 / sources 45 / entities 22 / comparisons 16 / deliverables 4 / templates 3 / issues 3），5 个领域。

---

## 二、目录职责

| 路径 | 职责 | 提示词优化时的用法 |
|---|---|---|
| `CLAUDE.md` | Schema：域范围、目录、frontmatter、口径铁律、工作流 | 涉及"怎么沉淀/怎么引用/口径"时读相关章节（§2.2 竞品路径、§2.3 模板、§3 页面约定） |
| `wiki/index.md` | 主索引（符号表） | 不知道去哪个页面时先读它；但**不要整页塞进提示词** |
| `wiki/overview.md` | 五域总览与核心论点 | 写"背景/行业判断"时取宏观结论 |
| `wiki/concepts/` | 概念页：方法、框架、术语、技术路线 | 写方案的"理论依据/方法论"主力 |
| `wiki/entities/` | 实体页：我方产品、竞品、公司、技术组件 | 写"我方现状/竞品能力"主力 |
| `wiki/comparisons/` | 对比页：横向矩阵、层级定位、方案之争 | 写"对标/差距/定位"主力 |
| `wiki/sources/` | 每份原始素材的摘要页 | 需要"出处/原始数据"时回溯 |
| `wiki/deliverables/` | 四类产出：design-docs / packaging / prototypes / roadmap | 写同类文档时抄结构与口径；roadmap 是演进叙事素材库 |
| `wiki/templates/` | 公司母版 + 写作规范页 | docx/pptx 的**输出规格**必引 |
| `wiki/issues/` | 现场报错归档（检索入口 / 定位速查表） | 涉及"客户现场问题/缺陷"时用；**口径恒为内部** |
| `raw/` | 原始素材（papers / articles / docs / meeting / competitor / code） | **只读**；引用时写全路径（竞品含厂家目录） |

---

## 三、检索优先级（4 步，别跳）

1. **定位**：`kb.mjs search "<2–6 个关键词>" --top 12`。关键词用产品名/机制名/竞品名，不要整句。
2. **看结构**：`kb.mjs outline <相对路径>` 拿到小节 + 行号。
3. **精读小节**：用文件读取工具按 offset/limit 只读命中章节（一般 3–6 页、每页 1–3 节）。
4. **回溯**（可选）：页面末尾「来源」小节给 `raw/` 路径；数字/结论要更硬的出处时再读 raw。

命中不足时的同义词表：

| 主题 | 可换的关键词 |
|---|---|
| 智能问数 | ChatBI / 智能问数 / 自然语言查数 / NL2SQL / Text2SQL / 问数 |
| 报表 | BI Report / 报表 / 看板 / 仪表板 / 大屏 / WhaleBI |
| 语义层 | 语义层 / 指标语义 / 语义模型 / 度量集 / 口径 |
| 本体 | 本体 / Ontology / 知识图谱 / queryGraph / 图谱 |
| 智能体平台 | Agent 引擎 / Hermes / 多智能体 / MCP / 技能 |
| 自动化任务 | 自动化 / 定时任务 / 主动服务 / 预警 / 订阅 |

---

## 四、域代码与主题

| 域代码 | 领域 | 典型主题 |
|---|---|---|
| `RPT` | BI Report 可视化报表 | 报表设计、图表选型、大屏、仪表板、报表引擎、数据集模型 |
| `AGT` | BI Agent 智能问数 | ChatBI、NL2SQL、明细/汇总问数、Data Agent、自动化任务、智能澄清 |
| `PLT` | 智能体平台 | Agent 引擎、Hermes 框架（**外发隐去**）、MCP、技能/插件、多 Agent 协作 |
| `RAG` | 检索增强生成 | 向量检索、知识库、Embedding、重排、LLM Wiki 编译模式 |
| `ONT` | 本体系统 | 知识图谱、Nebula、本体建模、语义层、schema、实体对齐 |
| `MIXED` | 跨域 | 客户价值叙事、治理、包装口径 |

---

## 五、高价值页面清单（写"知识库依据"段时优先从这里挑）

### 5.1 概念页（方法论/判断框架）

| 页面 | 用途 | 什么时候用 |
|---|---|---|
| `wiki/concepts/语义能力五层级L0-L4.md` | **全库最可操作的一把尺子**：L0 提示词 / L1 描述 / L2 契约 / L3 组装 / L4 过程；三条分界线；PoC 验收三问 | 讲能力定位、方案上限、验收标准 |
| `wiki/concepts/语义层四层分层模型.md` | 数据/指标/对象/行动语义四层 | 讲语义层架构与职责边界 |
| `wiki/concepts/指标语义层.md` | 指标层共识、三代知识库论、设计原则 | 讲指标中心/语义层方案 |
| `wiki/concepts/可组合语义模型.md` | 治理与自助的另一半；Composable Overrides | 讲模型复用与治理 |
| `wiki/concepts/语义天花板与语义泄漏.md` | 表达力上界、逻辑外溢、静默失败 | 讲方案能力边界与风险 |
| `wiki/concepts/口径自动盘点与语义层自举.md` | "配置占 10%，找材料还原口径占 90%" | 讲落地成本与差异化 |
| `wiki/concepts/本体四层建模.md` | 本体建模层次 | 讲本体/知识图谱设计 |
| `wiki/concepts/BI智能问数技术路线演进.md` | 三阶段论、技术路线三代、代际更替 | 讲行业趋势与路线选择 |
| `wiki/concepts/AI-for-BI.md` | Agent 主体论 vs 增强论；对话式 BI 沦为玩具的原因 | 讲产品定位之争 |
| `wiki/concepts/主动式数据服务.md` | 任务视角 vs 指标视角；监控下沉 | 讲自动化/主动服务演进 |
| `wiki/concepts/Headless执行契约.md` | 无人值守成功的契约六条 | 讲自动化任务可靠性 |
| `wiki/concepts/上下文控制工程.md` | 无人值守场景的隐形失败源 | 讲 Agent 可靠性 |
| `wiki/concepts/双引擎架构与查询下推.md` | 架构取舍 | 讲技术方案 |
| `wiki/concepts/时间语义与时区口径.md` | 时间口径陷阱 | 讲口径治理 |
| `wiki/concepts/智能澄清与可干预机制.md` | 澄清与干预 | 讲交互设计 |
| `wiki/concepts/决策溯源与审计链.md` | 可追溯/可阻断 | 讲可信与合规 |
| `wiki/concepts/多形态共生BI体系.md` | BI 四代演进、用户渗透率 | 讲行业与产品形态 |

### 5.2 实体页（我方与竞品事实）

| 页面 | 用途 |
|---|---|
| `wiki/entities/ChatBI智能问数系统.md` | **我方 AGT 产品线入口**：四步引导澄清、Milvus/Lucene/Nebula 三路检索、流式问数、评测运营差距 |
| `wiki/entities/BI-Report可视化报表系统.md` | **我方 RPT 产品线入口**：WhaleBI V7.2.1.0、数据集模型与口径存量、看板运行时、与 ChatBI 集成面、四项缺口 |
| `wiki/entities/Hermes-Agent.md` | 我方 Agent 引擎（PLT）；**外发必须脱敏** |
| `wiki/entities/Tableau.md` | 全球标杆（Semantics + Knowledge 双产品），含官方限制清单 |
| `wiki/entities/Microsoft-PowerBI.md` | 全球标杆（语义模型 + Fabric 指标层） |
| `wiki/entities/帆软.md` / `FineBI.md` / `FineChatBI.md` | 头号国内竞品 |
| `wiki/entities/Aloudata.md` / `网易知数.md` / `QuickBI-智能小Q.md` / `Smartbi-AIChat白泽.md` / `东方国信.md` / `华为云DataArtsInsight.md` / `蚂蚁数科.md` / `DTOntology.md` | 其余竞品 |

### 5.3 对比页（对标与定位）

| 页面 | 用途 |
|---|---|
| `wiki/comparisons/BI智能问数竞品能力矩阵.md` | 10 家外部产品 vs 我方的横向矩阵 + 13 项缺口 + 9 个差异化机会 |
| `wiki/comparisons/语义能力五层级-竞品与自身定位.md` | L0–L4 层级定位表 + 三个结构性风险 + P0 三问 |
| `wiki/comparisons/chatbi-vs-Tableau语义层.md` | 全球标杆三层对照（语义层+知识层+Agent 平台） |
| `wiki/comparisons/chatbi-vs-PowerBI语义模型.md` | 第二标杆；三方对照表 |
| `wiki/comparisons/chatbi-vs-帆软智能问数方案.md` | 头号对手专项对标 |
| `wiki/comparisons/本体论-vs-语义层.md` | 同物种不同路径 + 命名裁决 |
| `wiki/comparisons/五款Agent产品对比矩阵.md` | Agent 产品横向对比 |

### 5.4 产出区（抄结构、抄口径）

| 页面 | 用途 |
|---|---|
| `wiki/deliverables/roadmap/chatbi-自动化任务-演进研究.md` | 自动化任务演进叙事素材库（现状→业界对标→演进选项） |
| `wiki/deliverables/roadmap/chatbi-智能问数-竞品对标研究.md` | 竞品对标研究写法范本 |
| `wiki/deliverables/roadmap/chatbi-本体语义层-演进研究.md` | 本体/语义层演进写法范本 |
| `wiki/deliverables/packaging/chatbi-数据治理与资产化-包装口径.md` | **包装材料格式范本**：外发话术 + 内部依据两段式、通用红线 |

### 5.5 模板与现场问题

| 页面/文件 | 用途 |
|---|---|
| `wiki/templates/README.md` | 模板目录索引 + 默认调用规则 + 通用口径（§三） |
| `wiki/templates/word-文档写作模板.md` | Word 骨架/场景骨架/排版/自检清单/已知缺口 |
| `wiki/templates/ppt-演示文稿写作模板.md` | PPT 页类型/版式/配色字号/场景页序/自检清单/已知缺口 |
| `wiki/templates/Typora-Word2.docx` | 公司 Word 母版（只读） |
| `wiki/templates/浩鲸科技_20周年_ppt中文模板_白.potx` | 公司 PPT 母版（只读） |
| `wiki/issues/README.md` | 现场问题归档规范（选择性判据、编号、根因分类） |
| `wiki/issues/检索入口.md` | 报错关键词 → 问题页；根因 → 问题页 |
| `wiki/issues/定位速查表.md` | 报错关键词 → 代码位置 |

---

## 六、场景 → 推荐页面（提示词"依据"段的快速配方）

| 要写的文档 | 先搜这些词 | 优先引用的页面 |
|---|---|---|
| 需求方案（问数/Agent） | 智能问数 需求 澄清 明细 汇总 | `entities/ChatBI智能问数系统` + `concepts/语义能力五层级L0-L4` + 相关 `concepts/` |
| 需求方案（报表/看板） | 报表 看板 数据集 口径 | `entities/BI-Report可视化报表系统` + `concepts/多形态共生BI体系` |
| 季度/年度规划 | 季度规划 版本 里程碑 演进 | `deliverables/roadmap/*` + `index.md` 的 AGT/RPT 导航 |
| 竞品研究/汇报 | 竞品 对标 矩阵 Tableau PowerBI 帆软 | `comparisons/BI智能问数竞品能力矩阵` + `comparisons/语义能力五层级-竞品与自身定位` |
| 架构/技术方案 | 架构 语义层 本体 检索 下推 | `concepts/语义层四层分层模型` + `concepts/双引擎架构与查询下推` + `entities/Hermes-Agent`（内部） |
| 自动化任务/主动服务 | 自动化任务 定时 触发 预警 | `deliverables/roadmap/chatbi-自动化任务-演进研究` + `concepts/主动式数据服务` + `concepts/Headless执行契约` |
| 客户汇报/包装材料 | 客户价值 治理 资产化 口径 | `deliverables/packaging/chatbi-数据治理与资产化-包装口径` + `templates/README` §3.1 |
| 现场问题复盘 | 报错 异常 根因 定位 | `issues/检索入口.md` + `issues/定位速查表.md`（**口径内部**） |
| 发布说明/复盘 | 版本 发布 验收 复盘 | `entities/` 对应产品页的现状小节 + `templates/word-文档写作模板` §三 |

---

## 七、引用与置信度（提示词里怎么写才可信）

1. **引用写库内相对路径**：`wiki/concepts/语义能力五层级L0-L4.md`；竞品素材写全含厂家目录的 raw 路径（如 `raw/competitor/Tableau/...`）。
2. **结论带置信度**：`【已验证】`（有实现/文档佐证）/`【推断】`（由素材推理）/`【待验证】`（单一来源未交叉确认）。
3. **数字带出处与日期**：`数据来源：<页面/素材>（YYYY-MM-DD）`；竞品自述数据标 `【待验证】` 并保留原始 URL。
4. **口径三档**：`内部` / `外发` / `公开`。外发：隐去 Hermes 等底层框架名 → 统一"自研 Agent 引擎"。
5. **两条铁律**：① 隐去 ≠ 改称自研的不实能力；② 不得删除应有的第三方引用。
6. **页面状态**：`status: draft` 的页面结论可能还在演进，引用时注明"（draft，待确认）"。

---

## 八、常见坑（写提示词时避免）

| 坑 | 说明 |
|---|---|
| 把 raw 当可写目录 | `raw/` 不可变，任何产出都不要写回 raw |
| 外发材料出现内部名 | Hermes、Nebula、ES、源码路径、内部表名一律不能出现在外发版 |
| issues 拿来外发 | 现场问题页口径**恒为内部**，含代码路径与客户环境 |
| 凭记忆写模板规格 | 母版规格（字号/版式/配色）必须来自规范页或 `spec` 输出 |
| Word 母版 Heading 缺口 | styles.xml 未定义 Heading 1–9，导出后必须检查目录与导航层级 |
| PPT 版式靠猜 | 7 个版式未按用途命名，只能按正文占位符数量选 |
| 整篇通读 wiki | 用 `outline` + 行号精读；一次读 3–6 页、只读命中章节 |
| 引用 index.md 当依据 | index 是导航，不是论据；依据要落到具体页面 |
| 单一来源当结论 | 标【待验证】，并在提示词"未决问题"里提醒 |

---

## 九、什么时候提示用户"先摄入素材"

出现以下情况，不要硬写，在交付里建议先入库：

- 主题在知识库搜不到任何相关页（`search` 命中 <3 且不相关）；
- 用户要求的最新事实（新版本发布、新竞品动态、客户现场数据）库里没有；
- 需要具体客户/项目数据，但库里只有通用结论；
- 用户提到的文档是"上一版/上次评审稿"，但库里没有对应页面。

建议话术：「这条结论在知识库里没有依据，建议先把 <素材类型> 摄入知识库（放到 `raw/articles/` 或 `raw/competitor/<厂家>/`），我再据此优化提示词。」**不要编造依据**。

---

## 十、与其他技能的配合

- 产出 `.docx` → 加载 `office-docx`（读规范页、套母版、跑结构检查）。
- 产出 `.pptx` → 加载 `office-pptx`；若要"设计感更强、可浏览器编辑的演示"，可配合 `dashi-ppt`。
- 产出 `.xlsx` → 加载 `office-xlsx`。
- 优化后的提示词本身不依赖任何技能即可执行；技能只在"第 6 步执行"时使用。
