# BRCA-first Case-level Pathology Agent POC 与演示计划

- 日期：2026-07-31
- 目标：基于现有 PathAssist，在 3 天至 1 周内形成稳定、可重复的 BRCA 病例级多切片演示
- 定位：研究原型 / UX 与系统闭环验证，不是临床诊断或 IHC 判读产品

## 1. POC 的唯一主张

> 对一个已经由病理医师确认含侵袭性乳腺癌的预配置病例，系统能够在同一病例工作区中组织 H&E 与实际 ER/PGR/HER2/Ki-67 切片，保存 H&E/ROI 和定量 artifacts，建议查看下一张**病例内已有**材料，并生成每个重要字段都可点击回到 slide、ROI、统计量和 QC 的 biomarker evidence draft。

这个 POC 证明的是 `case state → viewer/tool → evidence workspace → decision trace → cited draft` 已经形成闭环。它不证明：

- 系统能从未知乳腺切片自主诊断癌、自动完成 Nottingham grade 或 TNM stage；
- 现有 IDC-vs-ILC 模型可用于良性、原位癌、非乳腺或未确认侵袭癌的切片；
- ER/PGR/HER2/Ki-67 能确认 ductal vs lobular histotype；形态难分时应人工复核，并按实际情境考虑 E-cadherin/p120 等材料；
- 自动 IHC 数值已达到 ASCO/CAP analytical validity；
- 病理智能体能够给出治疗方案。

## 2. 演示必须呈现的六项能力

1. **一个病例、多张材料：** 左侧显示 `H&E / ER / PGR / HER2 / Ki-67`，而不是匿名的 `Slide 1/2/3`。
2. **病例级状态：** 换 slide 后 hypothesis、accepted evidence、QC 和运行进度不消失。
3. **H&E 证据：** 保存一个病理医师确认的 invasive-tumor ROI；可选展示现有 breast tissue overlay 和 IDC-vs-ILC research prediction/heatmap。
4. **下一材料选择：** 在侵袭癌已确认后，系统建议查看病例中已有 ER 以完成 biomarker review，并给出 reason code；用户必须确认后才切片。若任务是 histotype discordance，则系统应 abstain 并提示缺少适用材料，不能拿 ER 代替 E-cadherin。
5. **定量 artifact：** 读取至少一个经过预计算和人工复核的 IHC artifact，展示 numerator、denominator、ROI、阈值、QC、模型版本和 overlay。
6. **可审计草稿：** 显示 observation → current state → next material → tool result → draft；报告 citation 可返回正确 slide/ROI。界面不输出不可验证的自由文本 chain-of-thought。

多智能体、自动配准、在线全片 IHC 评分、指南 RAG 和治疗推荐都不是第一版成功的必要条件。

## 3. 三档病例与数据选择

### A. 当天 smoke test：本机 TCGA-BRCA

本机已有同一 patient、同一 `01A` primary-tumor portion 的两张 H&E，合计约 1.05 GB，可立即验证 multi-slide case shell、ROI、workspace、模型卡和 citation：

- `/home/chen/data2/tcga_brca/slides/35904d0b-d932-40f1-8f4c-fd1358a6664e/TCGA-BH-A0DD-01A-03-BSC.c1eded57-13d8-48ff-9389-5467a8455fe6.svs`
- `/home/chen/data2/tcga_brca/slides/af303218-add4-45cf-83ab-eaf4d55edb85/TCGA-BH-A0DD-01A-03-TSC.0088505b-5e18-49c4-bc2b-7946b2780383.svs`

本地 metadata 将该 case 标为 IDC，但仍应由病理医师先核对图像和 provenance。文件名为 `11A` 的 solid-tissue-normal slides 不得并入肿瘤证据。TCGA-BRCA 没有系统配对的实际 ER/PGR/HER2/Ki-67 WSI，因此该档只能演示 H&E case workflow，不能伪装为 multi-IHC case。

`/home/chen/data2/BRCA-TEST` 中已有 10 张 BRACS WSI，适合 viewer smoke test，但本机没有同时核验到这些文件的具体 lesion labels；BRACS 的原始任务空间还包含 benign、atypia、DCIS 和 invasive carcinoma，并不等于 IDC-vs-ILC。未补齐标签和病理复核前，不得在这些 slides 上触发 IDC/ILC task。

### B. 最快有真实 IHC 和 reference 的双片 demo：Warwick HER2

[Warwick HER2 Challenge](https://warwick.ac.uk/fac/cross_fac/tia/data/her2contest/) 提供 86 个 invasive breast carcinoma cases，每例有 H&E + HER2 WSI，并有专家 consensus HER2 score/percentage。它适合先做一条可信的 `H&E → review existing HER2 → artifact/reference → cited draft` 演示。

限制：需要注册，使用条款为 academic/research、禁止商业使用；它没有 ER/PGR/Ki-67，不能宣称完整四标记病例。

### C. 一周正式多染色主路径：ACROBAT 或获授权机构病例

公开数据首选 [ACROBAT dataset](https://researchdata.se/en/catalogue/dataset/2022-190-1) 与其 [Scientific Data paper](https://www.nature.com/articles/s41597-023-02422-6)：1,153 patients、4,212 WSI，每例一张 H&E 和 1–4 张实际 ER/PGR/HER2/Ki-67 serial sections，许可 CC BY 4.0。

只从 **training split** 选择同时具有 `HE/ER/PGR/HER2/KI67` 的一个 `(set, anon_id)`；validation/test 每例只公开一张随机 IHC，不能构造四标记病例。公开 metadata 没有完整报告、biomarker scores、抗体 clone 或 control 状态，且公开图像为 10×层级，所以 ACROBAT 可证明多染色材料管理、配准和 provenance，不能单独证明临床 IHC 评分准确。

ACROBAT 总量约 448.6 GiB，training 被打包成约 69–76 GB 的压缩包，官方未提供便利的逐病例下载。下载前先读取 metadata/ZIP listing，确认五张片位于哪个 archive；这是一周版的真实数据依赖。若已经有获授权且带原报告/score/control 的单个机构病例，应优先使用。

当前 IDC-vs-ILC task 需要 20×、256 px 的 CONCH feature specification。ACROBAT 的公开图像层级约为 10×，因此不能为了演示完整而直接套用当前模型。ACROBAT 主路径可以跳过该模型，只使用病理医师确认的 H&E ROI；若必须同台展示真实 IDC/ILC inference，应选 magnification/task-compatible 的获授权病例，或把 TCGA H&E smoke test 明确作为独立段落，不能把它的模型结果写入 ACROBAT 病例报告。

严禁把 TCGA patient 的 H&E 与 ACROBAT/Warwick 另一 patient 的 IHC 拼成一个“病例”。

## 4. 演示病例材料与 artifacts

正式 BRCA demo 的 material matrix：

| 顺序 | 材料 | 演示中的作用 |
|---|---|---|
| 1 | H&E | 低倍 overview、病理医师确认 invasive-tumor ROI、形态观察 |
| 2 | 可选第二张 H&E | 证明病例级 multi-H&E；ACROBAT 本身不提供此能力 |
| 3 | ER | 肿瘤细胞核 staining evidence；完成 biomarker review，不用于确认 IDC/ILC |
| 4 | PGR | 肿瘤细胞核 staining evidence |
| 5 | HER2 | 膜染色图像证据；临床 score 必须满足适用规则和 QC |
| 6 | Ki-67 | 预计算的 sampling-aware proliferation artifact；不推导治疗 |

最小 artifact 包：

```text
case_manifest.json
source_checksums.json + licenses/CITATION
roi/tumor_he.geojson
roi/{ER,PGR,HER2,KI67}.geojson
registration/transforms.json + registration_qc.json
quant/{ER,PGR,HER2,KI67}.json
overlays/*
trace/events.jsonl
report/biomarker_evidence_draft.json
```

每个 artifact 至少保存 `case_id`、`source_item_id`、`block/section`（若已知）、ROI level-0 坐标、生成工具与版本、参数、输入 hash、输出 hash、review status、QC 和时间。第一版允许 artifacts 由病理医师确认后预计算；页面必须显示 `Precomputed, pathologist-reviewed research artifact`。

### IHC 数值的 POC 边界

临床 ER/PgR 与 HER2 判读应遵循适用实验室流程及 [ASCO/CAP ER/PgR guideline update](https://ascopubs.org/doi/10.1200/JCO.19.02309) 和 [ASCO/CAP HER2 guideline update](https://ascopubs.org/doi/10.1200/JCO.22.02864)；下面仅定义研究演示中允许展示的数据，不实现或替代这些指南的全部 preanalytic、analytic 与 reporting 要求。

- **ER/PGR：** 可展示 tumor ROI 内 positive invasive-tumor nuclei / total invasive-tumor nuclei、强度分布、未分类细胞数和 CI；没有可靠 tumor-cell classification 与 control review 时只显示 exploratory proxy。
- **Ki-67：** 必须显示 counted tumor nuclei、global/hotspot sampling、ROI 间差异和 CI，不能只显示一个无采样说明的百分比。
- **HER2：** 若没有经验证的膜分割、clone/platform/control 与必要的 ISH 信息，只展示膜染色 proxy 和图像证据，不自动输出临床 `0/1+/2+/3+`。可用 Warwick consensus score 做独立 benchmark。
- **跨片：** serial sections 只做 region correspondence；registration QC 不合格时退化为病例级关联，绝不声称 same-cell coexpression。

## 5. 现有项目可直接复用的能力

| 当前能力 | BRCA POC 用法 | 边界 |
|---|---|---|
| DSA / OpenSeadragon viewer、case folder、ROI/overlay | 真实查看、切片、定位和 citation navigation | case/block/stain metadata 先人工配置 |
| BCSS breast tissue segmentation | 在 H&E 上显示 tumor/stroma/inflammatory/necrosis/other overlay | 研究模型；权重 CC-BY-NC-4.0；不是 grade 或侵袭癌确认器 |
| `brca_idc_ilc` ABMIL + CONCH task | 在已确认 invasive breast carcinoma 上显示 IDC-vs-ILC research prediction 与 heatmap | 当前仅二分类；本地记录的 test AUROC 0.895、accuracy 0.878，不能外推到良性/DCIS/其他亚型/不同 stain |
| Trident/CONCH preprocess 与已有 TCGA-BRCA features | 预计算一个真实 H&E inference artifact | CONCH/相关权重许可限制需保留；台上不依赖实时 GPU |
| Copilot SSE/tool cards | 显示 typed case tool results 与 human confirmation | 当前 turn 固定 active-slide scope，跨 slide 必须拆成两轮 |
| 现有 Ki-67 ROI UI/浏览器侧视觉分析 | 仅可借 UI 形态展示 reviewed fixture | 不把通用 VLM 读图百分比当作临床 Ki-67 quantification |

IDC/ILC 输出保持 slide-level。多张 H&E 可以报告“方向一致/冲突”，但不能未经 patient-level calibration 就平均两个概率。当前记录中的 F1 约 0.623，且类别不平衡；演示必须支持 `out-of-scope/discordant/low-confidence → abstain`。

## 6. 最小状态模型与 UI

```json
{
  "schemaVersion": "brca-poc-1",
  "caseId": "BRCA-DEMO-001",
  "mode": "scripted-research-demo",
  "clinicalContext": {
    "confirmedInvasiveCarcinoma": true,
    "confirmationSource": "pathologist-reviewed-demo"
  },
  "slides": [
    {"itemId": "...", "label": "B1 H&E", "block": "B1", "marker": null},
    {"itemId": "...", "label": "B1 ER", "block": "B1", "marker": "ER"},
    {"itemId": "...", "label": "B1 PGR", "block": "B1", "marker": "PGR"},
    {"itemId": "...", "label": "B1 HER2", "block": "B1", "marker": "HER2"},
    {"itemId": "...", "label": "B1 Ki-67", "block": "B1", "marker": "KI67"}
  ],
  "steps": [
    {
      "id": "s1",
      "kind": "observation",
      "text": "Pathologist-confirmed representative invasive-tumor ROI",
      "evidenceIds": ["ev-he-01"]
    },
    {
      "id": "s2",
      "kind": "next_material",
      "status": "pending_approval",
      "targetSlideRole": "ER",
      "reasonCode": "complete_available_biomarker_review"
    }
  ],
  "report": {"status": "not_generated"}
}
```

核心约束：病例状态以 `caseId` 为 scope；`activeItem` 只是当前 WSI。Report compiler 只能读取 `accepted evidence`，不能从隐藏对话创造事实。

紧凑 workspace：

```text
┌ BRCA Case POC · BRCA-DEMO-001 ──────────────┐
│ Materials [H&E ✓] [ER →] [PGR] [HER2] [Ki67]│
├ Current state ───────────────────────────────┤
│ Invasive carcinoma: pathologist-confirmed   │
│ Histotype model: IDC favored · research only│
├ Decision trace ──────────────────────────────┤
│ ✓ Saved H&E invasive-tumor ROI              │
│ ✓ Loaded H&E model/heatmap artifact         │
│ ● Review existing ER — biomarker completion │
│   [Confirm & open ER]                        │
│ ○ Load reviewed quantification              │
│ ○ Compile evidence draft                    │
├ Evidence ────────────────────────────────────┤
│ [H&E ROI] [ER nuclei/QC] [HER2 image/QC]     │
├ Actions [Next] [Generate draft] [Reset]      │
└──────────────────────────────────────────────┘
```

点击 citation 时先用 `openCaseItem(item, caseContext)` 切片，等待 viewer `open` 完成后再导航到该 slide 自己的 ROI。未通过配准 QC 时禁止把 H&E 坐标直接复制到 IHC。

## 7. 哪些是真实、预计算和模拟的

| 能力 | POC 实现 | 台上准确说法 |
|---|---|---|
| 多 WSI 查看/切换 | 真实 DSA/OpenSeadragon | “同一病例上下文管理多张材料。” |
| patient/block/stain mapping | 人工核验 fixture/metadata | “本病例映射已核验；自动 ingestion 尚未完成。” |
| H&E tissue/IDC-vs-ILC model | 可真实运行，演示读取缓存结果 | “受限研究模型输出，不是诊断签署。” |
| H&E tumor ROI | 病理医师预标注/确认 | “侵袭癌前提由人工确认。” |
| next-material policy | 确定性状态机或 fixture-backed tool | “证明可审计的人机接口，尚未证明 policy 优于规则/医生。” |
| IHC quantification | 预计算、人工复核 artifact | “研究性数值；不是实时、临床验证的 IHC score。” |
| report | 确定性模板从 accepted evidence 编译 | “biomarker evidence draft，不是可签署报告。” |
| LLM | 可选解释/调度，关闭后仍可 replay | “事实由 artifacts 提供，LLM 不手算数值。” |

不演示：自动新开 IHC order、Nottingham grade、pT/pN/stage、治疗方案、HER2 2+ 无 ISH 定案、virtual IHC 替代实际染色、same-cell serial-section 共表达、在线训练或多智能体自治。

## 8. 基于当前代码的最小改造

### 前端

| 文件 | 最小改造 |
|---|---|
| `src/components/cases/SecondOpinionPage.jsx` | 将带 stain label 的 items 放入 `caseContext`，默认打开 H&E；同病例切片时保留 conversation/workspace。 |
| `src/store/index.js` | 增加 `caseWorkspace`、`setCaseWorkspace`、`advancePocStep`、`resetPocDemo`。 |
| `src/components/sidebar/LeftSidebar.jsx` | 显示 `B1 H&E / ER / PGR / HER2 / Ki-67` 和 viewed/next 状态。 |
| `src/components/panels/RightPanel.jsx`、`ViewerApp.jsx` | 病例模式显示 `Case Copilot`；避免两个互不相通的诊断会话。 |
| 新增 `src/components/panels/CasePocPanel.jsx` | 显示 material matrix、state、trace、evidence、draft 和 fail-closed 状态。 |
| 新增 `src/demo/brcaPocFixture.js` | fixture/schema、纯状态转换和 deterministic report compiler。 |
| `src/components/panels/CopilotPanel.jsx` | conversation scope 改为 case folder；消费 typed case artifacts。 |
| `src/api/copilotApi.js` | turn payload 增加 `active_item_id` 和 compact `case_context`。 |
| `src/components/panels/PathChatPanel.jsx` | 病例 demo 中隐藏 legacy BRCA button；它声称的旧 5-fold ensemble/AUC 与当前 TaskPanel 的 CONCH fold-0 模型不是同一实现，不能混用。 |

### Agent gateway

| 文件 | 最小改造 |
|---|---|
| `services/agent/src/agent/gateway/routes.py` | 扩展 turn request；验证 active slide 属于 case allowlist。 |
| `services/agent/src/agent/loop/sdk.py` | 注入 case/material summary、research-only 限制和 active slide。 |
| `services/agent/src/agent/loop/tools.py`、`sdk_tools.py` | 注册 `review_case_material`、`recommend_next_material`、`update_case_hypothesis`、`draft_case_report`。 |
| 新增 `services/agent/src/agent/demo/brca.py`、`brca_case.json` | 读取预计算 artifacts，按 accepted evidence 编译 draft。 |

一周版不迁移完整数据库，也不引入多智能体。`CopilotPanel` 暂用 `caseContext.folderId || activeItem._id` 作为 conversation scope。每个 result 都携带 `case_id + source_item_id + source_block_id`。

**跨 slide 必须一张片一轮。** 当前 SDK 在 turn 开始时捕获固定 slide scope，正确交互是：

1. agent 返回 `material_request`；
2. UI 显示 `Confirm & open ER`；
3. 用户确认后前端切片；
4. 新一轮显式携带新的 `active_item_id`；
5. 只在 active slide 与 result 的 `source_item_id` 匹配时绘制 overlay。

LLM/API/GPU 不可用时，`Replay demo` 使用同一 fixture/state machine；模型 artifacts 预先缓存，主路径不得依赖现场推理。

## 9. 5–8 分钟 demonstration 脚本

1. **0:00–0:40，进入病例。** 打开 `BRCA-DEMO-001`，展示 H&E/ER/PGR/HER2/Ki-67 material matrix。
2. **0:40–1:40，H&E。** viewer 导航至人工确认的 invasive-tumor ROI；显示 breast tissue overlay。
3. **1:40–2:30，受限模型（条件步骤）。** 仅当所选病例满足当前 20× task specification 时，加载缓存的 IDC-vs-ILC prediction/heatmap；否则跳过并解释 task applicability gate。ACROBAT 10×病例默认跳过。
4. **2:30–3:20，选择下一材料。** 系统建议查看病例内已有 ER，理由是完成 biomarker review；用户点击确认。强调 ER 不用于确认 IDC/ILC。
5. **3:20–4:40，定量 artifact。** 加载 reviewed ER 或 Ki-67 artifact，显示 ROI、numerator/denominator、overlay、QC 和 source hash；再展示 HER2 的 image evidence 或已审核 reference。
6. **4:40–5:30，fail closed。** 将一个 control 标记为 unknown 或隐藏一个 marker，系统输出 `not interpretable/pending review`，不补造数值。
7. **5:30–6:40，生成草稿。** 编译 morphology evidence、biomarker table、missing/QC/limitations；grade、stage 和 treatment 保持 `not assessed/not generated`。
8. **6:40–7:30，验证 provenance。** 点击 H&E、ER、HER2/Ki-67 citations，viewer 返回各自 slide/ROI。
9. **7:30–8:00，收尾。** 显示 `Research demo — not for clinical use` 和 scripted/realtime 状态。

## 10. 成功标准与时间表

成功标准：

- 8 分钟内完成，连续演练 5 次无失败；
- 同病例跨 2–5 张 slide 时 workspace 不丢失；
- citation 100% 打开正确 slide 及其自己的 ROI；
- 一周 multi-stain case 至少包含一个真实 viewer/ROI artifact 和一个 reviewed IHC quant/reference artifact；H&E model 只有在同一病例满足 task specification 时才计入，不允许用另一个 patient 的模型结果补齐；
- 所有报告事实来自 accepted evidence，fixture 外事实注入被拒绝；
- 缺 marker、control unknown、source mismatch 或 registration QC fail 时正确 abstain；
- 页面持续区分 actual stain、model prediction、precomputed result 和 reference truth。

不以单病例诊断准确率、BLEU、实时 GPU 速度或“像医生一样思考”验收。

| 时间 | 交付 |
|---|---|
| 3 天 | 用本地 TCGA-BRCA 两张 H&E 完成 case shell、stain-aware list、ROI/citation、确定性 report、reset/replay；只能称 H&E case demo。 |
| 1 周 | 锁定获授权机构病例或 ACROBAT 五染色病例；加入 reviewed IHC artifacts、四个 fixture-backed tools、fail-closed、跨片 citations 和录屏。 |
| 2 周 | 轻量 case-run/event 持久化；加入一个真实 IHC deterministic prototype 或 Warwick HER2 benchmark；不加入多智能体、自动配准或指南 RAG。 |

一周执行顺序：Day 1 锁定病例/许可/slide IDs 并标 ROI；Day 2 case workspace/material UI；Day 3 case tools 与人工确认；Day 4 artifacts/citations/report compiler；Day 5 tests、错误态、reset、离线 replay 和录屏。

## 11. Go/no-go

POC 只回答四个问题：

1. 病理医师是否理解并愿意使用 `material → evidence → cited draft`？
2. citation 跳转与 QC 是否明显提高核查效率？
3. next-material 卡片是否比简单 material checklist 更有价值？
4. 在不展示自动临床评分的情况下，这个闭环是否仍有足够说服力？

只有答案积极，才投入真实 ER/PGR/HER2/Ki-67 analytical validation、学习型 planner、自动 registration、机构连续病例和完整报告研究。第一篇工程型展示可以聚焦 **BRCA case workspace + reviewed multi-stain artifacts + auditable reporting**，不要把单病例演示写成 autonomous breast diagnosis。
