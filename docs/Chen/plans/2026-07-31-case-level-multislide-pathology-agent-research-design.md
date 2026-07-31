# 病例级多切片病理智能体：批判性调研与研究设计

- 日期：2026-07-31
- 研究对象：PathAssist / PathAgent v2
- 目标场景：病理医师在环的病例级证据综合、下一证据建议与结构化报告草拟
- 证据口径：优先采用论文原文、官方项目/模型卡、官方数据集页面、学会指南和标准。对仅有预印本、代码未发布或许可证不清楚者均显式标注。

> **当前执行决策（2026-07-31）：** 近期不建设本文描述的完整临床工具，先实现一个 **BRCA-first**、单病例、预计算 evidence、可回放且可演示的研究 POC。它优先复用当前项目已经存在的 breast tissue segmentation、IDC-vs-ILC task、heatmap 和 case viewer；实际 ER/PGR/HER2/Ki-67 先采用经审核的预计算 artifacts。具体范围与 3 天/1 周/2 周方案见 [BRCA-first Case-level Pathology Agent POC 与演示计划](/home/chen/pathassist23/docs/Chen/plans/2026-07-31-case-level-pathology-poc-demo-plan.md)。本文其余 DLBCL 内容保留为长期研究/临床化候选，不是本轮 demo 工程范围。

## 总体结论

这个方向值得做，但必须缩小主张。现有研究已经分别实现了 WSI 报告生成、多张 H&E 聚合、单 WSI 主动导航、多智能体会诊、工具调用、H&E/IHC 表征学习和局部证据定位；因此“多 slide + agent + report”本身不是足够的论文创新。真正尚缺、也更可能产生临床价值的，是：**在真实完整 accession 中，用受约束的 next-best-evidence 策略协调 H&E、真实 IHC、定量工具和临床资料，把每个病例级 claim 绑定到可重读 artifact，并在病理医师审批下形成可回放的报告。**

同时必须纠正三个临床假设：

1. 病理诊断并没有一种适用于所有病例的固定“先看第几张片”顺序；通常先核对材料清单、标本和大体信息，再低倍浏览所有关键 H&E，随后围绕代表性与不一致区域升倍。观察顺序是条件策略，不应被硬编码成一条路径。
2. 连续切片上的 H&E 与 IHC 并不包含完全相同的细胞。配准可支持区域级对应，但在非 multiplex 数据上声称“同一细胞共表达”通常不成立；阴性 IHC 也只有在靶组织存在、内外对照有效且技术质量合格时才有意义。
3. 对 lymphoma，病理切片不能独立给出临床分期；DLBCL 也没有应由模型输出的常规组织学 grade。治疗方案、剂量和疗程属于 oncologist/MDT，病理系统只能提供经审核的诊断、标志物含义、预后/预测性语境和建议补充检查。Lugano 分类把 FDG-PET/CT 纳入分期，而大 B 细胞淋巴瘤指南要求把形态、免疫表型、遗传和临床资料综合解释，见 [Lugano classification](https://ascopubs.org/doi/10.1200/JCO.2013.54.8800)、[WHO-HAEM5 概述](https://www.nature.com/articles/s41375-022-01620-2) 与 [EHA LBCL guideline](https://pmc.ncbi.nlm.nih.gov/articles/PMC12456099/)。

---

## 1. 一句话定义该研究问题

> 构建并验证一个由病理医师监督的病例级多模态病理智能体，使其在一个 accession 的多张 H&E、真实 IHC、标本/组织块关系、临床及可选分子结果之间选择和量化下一项证据，并生成每个关键结论均可追溯到 slide、ROI、统计量或版本化知识来源的结构化报告草稿。

这里的主语应是 **case/accession**，不是含义模糊的 patient；一个 patient 可跨多个 encounter、原发/复发和 accession，不能把它们无条件合并。

---

## 2. 现有工作的分类表

表中“多片”指模型原生接收同一病例的多张 WSI，而非把每张片独立跑完后人工拼接；“IHC”区分真实染色、虚拟染色和仅在预训练中见过 IHC；“证据”要求能定位或保存中间依据，而非 attention heatmap 自动等同于解释。

| 工作 | 输入模态；分析单位 | 多片 / 真实 IHC | 主动选择下一片/检测 | 外部确定性图像工具 | 中间证据与临床报告 | 开放状态 | 主要局限与本研究关系 |
|---|---|---:|---:|---:|---|---|---|
| [WsiCaption / MI-Gen, MICCAI 2024](https://papers.miccai.org/miccai-2024/paper/0761_paper.pdf)；[代码/PathText](https://github.com/cpystan/Wsi-Caption) | H&E WSI；slide | 否 / 否 | 否 | 否 | 报告；无病例 artifact | MIT 代码及 PathText 构建资源公开 | 单片生成；报告常含肉眼、分子或临床信息，不能仅由一张 H&E 证明，是“图像不可见标签”风险的典型例子。 |
| [HistGen, MICCAI 2024](https://arxiv.org/abs/2403.05396)；[代码](https://github.com/dddavid4real/HistGen) | H&E WSI；slide | 否 / 否 | 否 | 否 | 生成报告；无持久证据链 | Apache-2.0；代码、权重/特征/标注资源公开 | 约 7.8k WSI-report 对，仍是单 WSI→文本；可复用 decoder/evaluation baseline，不能覆盖病例推理。 |
| [PMPRG, MICCAI 2024](https://papers.miccai.org/miccai-2024/paper/1738_paper.pdf)；[仓库](https://github.com/hvcl/Clinical-grade-Pathology-Report-Generation) | 多张 H&E；patient | 是 / 未证明 | 否 | 否 | patient-level 报告；弱定位 | 论文称 1,991 patients/7,422 WSIs；仓库截至本报告日期仅 README/TBA，不能视作可复用实现 | 证明多片 patient aggregation 已有先例；不做真实 IHC、主动工具或 claim provenance。 |
| [HistoGPT, Nature Communications 2025](https://www.nature.com/articles/s41467-025-60014-x)；[代码](https://github.com/marrlab/HistoGPT) | 一个皮肤病例的 serial H&E + 文本；patient | 是 / 否 | 否 | 否 | 诊断/报告及 saliency | Apache-2.0 代码和权重；大部分训练数据私有，论文只释放小规模评估集 | 15,129 WSIs、6,705 patients、167 diseases；专家辅助模式仍需病理医师纠正诊断。直接覆盖“多 H&E 病例报告”，但未覆盖 IHC、工具和持久证据。 |
| [PolyPath, 2025 预印本](https://arxiv.org/abs/2502.10536) | 一个 specimen part 的多张 H&E，Gemini；specimen-part | 是 / 否 | 否 | 否 | 自由文本报告；无 artifact | 未确认官方代码/数据 | 可接收约 50 slides，但并非跨多个 specimen/part 的完整患者；性能在 slide 数增多时下降。证明“更多切片”不必然更好。 |
| [Token-efficient multi-WSI case report generation, 2026 预印本](https://arxiv.org/abs/2605.30716) | 每病例多 WSI + slide marker token；case | 是 / 未证明 | 否 | 否 | synoptic report | 代码/数据未确认 | 很接近多片报告基线，但仍是固定抽样与端到端生成，不是 viewer/tool/workspace 闭环；尚未同行评审。 |
| [PRISM, NeurIPS 2024](https://openreview.net/pdf?id=eQuajZB28Q)；[权重](https://huggingface.co/paige-ai/Prism) | H&E WSI + report/caption；slide | 否 / 否 | 否 | 否 | slide representation/文本 | 权重可申请；训练数据私有、使用条款需逐项核验 | 是通用 slide FM，不是病例智能体；训练报告信号不等于能生成可签署报告。 |
| [TITAN, Nature Medicine 2025](https://www.nature.com/articles/s41591-025-03982-3)；[代码](https://github.com/mahmoodlab/TITAN) | WSI + pathology language；slide | 否 / 否（训练数据含部分 IHC） | 否 | 否 | slide caption/representation | gated；CC-BY-NC-ND，研究用途；公共 decoder 曾因潜在 PHI 风险移除 | 训练集中约 7.9% IHC 不等于联合解释一个病例的 H&E/IHC panel；许可与隐私均阻碍直接产品化。 |
| [PathChat, Nature 2024](https://www.nature.com/articles/s41586-024-07618-3) | 医师预选 ROI/patch + 可选临床文本；patch/ROI | 否 / 仅能看单图 | 否 | 否 | 病理问答，无病例报告/artifact | 训练代码限非商用学术；官方权重因 PHI/IP 未公开 | 不是 gigapixel WSI agent，也没有真实 panel 语义；适合作为区域 VLM 先例。 |
| [SlideChat, CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/papers/Chen_SlideChat_A_Large_Vision-Language_Assistant_for_Whole-Slide_Pathology_Image_Understanding_CVPR_2025_paper.pdf)；[代码](https://github.com/uni-medical/SlideChat) | 单 H&E WSI；slide | 否 / 否 | 否 | 否 | caption/VQA，不是临床报告 | Apache-2.0 主仓库、数据/模型开放；CONCH 依赖另有严格条款 | 4.2k caption、176k VQA；可作单片感知模块，不能替代病例编排。 |
| [WSI-LLaVA, ICCV 2025](https://openaccess.thecvf.com/content/ICCV2025/papers/Liang_WSI-LLaVA_A_Multimodal_Large_Language_Model_for_Whole_Slide_Image_ICCV_2025_paper.pdf)；[项目](https://wsi-llava.github.io/) | 单 WSI；slide | 否 / 否 | 否 | 否 | morphology QA/report-like 回答；无 artifact | 项目页的 code/dataset 状态需继续核验，不能默认已完整开放 | 文本 precision/relevance 不等于 slide→ROI provenance；仍是一次性单片问答。 |
| [CPath-Omni, CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/html/Sun_CPath-Omni_A_Unified_Multimodal_Foundation_Model_for_Patch_and_Whole_CVPR_2025_paper.html)；[代码](https://github.com/PathFoundation/CPath-Omni) | patch 与单 WSI；patch/slide | 否 / 否 | 否 | 否 | caption/VQA/referring | 代码/模型公开 | 可用作视觉感知或 referring baseline；不是 case report 或 tool agent。 |
| [PathFinder, ICCV 2025](https://openaccess.thecvf.com/content/ICCV2025/html/Ghezloo_PathFinder_A_Multi-Modal_Multi-Agent_System_for_Medical_Diagnostic_Decision-Making_Applied_ICCV_2025_paper.html)；[项目](https://pathfinder-dx.github.io/) | 单 WSI；四个逻辑 agent | 否 / 否 | 是，迭代多尺度导航 | 否 | patch 访问/描述与诊断解释；非持久病例报告 | 论文称会开放，但截至 2026-07-31 项目页的 code/data/models 仍为 “Coming Soon” | 窄 melanoma benchmark；没有 cell/spatial/IHC 工具。多 agent 在此是分工提示链，不等于完整临床系统。 |
| [CPathAgent, NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/933b5d002cf251b3e854d586e55ac58c-Abstract-Conference.html) | 单 WSI；slide | 否 / 否 | 是，pan/zoom | 否 | 导航轨迹与诊断 summary；无 artifact graph | 官方完整代码/模型未确认 | 证明 agentic navigation 已实现；不处理完整 accession、真实 IHC 或报告签署。 |
| [SlideSeek + PathChat+, 2026 预印本](https://arxiv.org/abs/2506.20964) | 单 WSI；supervisor + explorers | 否 / 否 | 是，层级 ROI 搜索 | 否 | summary 可关联 ROI 坐标 | DDxBench 开放；官方完整代码/权重未确认，依赖 proprietary LLM | 坐标 grounding 强于纯 attention，但 serial sections、IHC、EHR/genomics 被列为未来工作。 |
| [PathFound, Medical Image Analysis 2026](https://www.sciencedirect.com/science/article/pii/S1361841526002690)；[代码](https://github.com/hsymm/PathFound) | 单 H&E WSI + clinical history；slide | 否 / **模拟 IHC 文本** | 是，重看 ROI、提出追加检查 | 部分 | ROI/mask/JSON state；最终诊断而非完整报告 | Apache-2.0 代码，但真实 prototypes 私有，仓库任务原型含占位张量 | 最接近“下一检查”先例，但实验中的附加检查/IHC 由 LLM 模拟，而非读取真实 IHC WSI/LIS，不能证明主动真实 IHC 闭环。 |
| [Pathology-CoT / Pathology-o3, Nature Biomedical Engineering 2026](https://www.nature.com/articles/s41551-026-01739-y)；[仓库](https://github.com/zhihuanglab/Pathology-CoT) | 单 WSI + 专家 viewport/mouse session；slide | 否 / 否 | 是，学习 inspect commands | 否 | 保存 where-to-look 与经医师编辑的 why-it-matters；不做病例报告 | 代码/部分行为数据公开；仓库许可证和部分数据可用性截至本报告日期不完整 | 10.6 小时、8 位病理医师、5,222 rounds，是“显式工作流建模”的强先例；viewport 不是隐藏思维链，也不代表唯一最佳路径。 |
| [NOVA, PMLR 2026](https://proceedings.mlr.press/v297/vaidya26a.html)；[代码](https://github.com/microsoft/nova-agent) | WSI/patch/cell 文件 + 科研问题；analysis task | 可多文件 / 非病例 IHC 语义 | 是，49 个病理工具并可生成 Python | 是 | 工作目录保存 outputs；不生成临床报告 | MIT；SlideQuest 仅 90 个科研任务 | tool registry/execution/artifact 的好参考，但目标是科研分析；生成代码带来安全、复现与验证边界问题。 |
| [TissueLab, 2025 预印本](https://arxiv.org/abs/2509.20279)；[代码](https://github.com/zhihuanglab/TissueLab) | WSI + 可组合图像分析工具；analysis task | 可处理多数据 / 非病例 panel | 是 | 是 | Zarr/workspace outputs；完整诊断支持仍在开发 | Penn Academic Software License；商业需另行许可 | 最接近 tool factory/workspace，但不是已验证的 accession-level 临床报告系统。 |
| [QCAgent, 2026 预印本](https://arxiv.org/abs/2603.01647) | 单 WSI + 报告/检查表；slide | 否 / 否 | 有局部检索/critique | 否 | 把文本 claim 定位到 patch；报告质检 | 官方代码未确认 | 直接覆盖 localized report evidence 的一部分，但无真实 IHC、细胞定量和 durable case workspace；尚未同行评审。 |
| [BioX-CPath, 2025 预印本](https://arxiv.org/abs/2503.20880)；[代码](https://github.com/AmayaGS/BioX-CPath) | 同患者可变数量 H&E/IHC；patient | 是 / 是 | 否 | 否 | patient embedding/分类，无报告与证据链 | MIT 代码公开 | 在 RA/Sjögren 场景证明多染色患者表示可行；不主动选 stain，也不做病理报告。 |
| [DuoHistoNet, Communications Medicine 2025](https://www.nature.com/articles/s43856-025-01045-9) | 同患者配对 H&E/IHC；固定双分支 WSI/patient endpoint | 固定配对 / 是 | 否 | 否 | 分类与 heatmap；无报告/workspace | Caris 队列私有；实现需 DUA/审批，非可直接复现开源系统 | 在部分任务中 dual 分支未超过 IHC-only，直接反驳“多模态一定增益”；不处理 panel、阴性对照、block 对应或空间共表达。 |
| [IHC Matters, 2024 预印本](https://arxiv.org/abs/2405.08197) | 配对 H&E+IHC WSI；slide/patient task | 固定配对 / 是 | 否 | 否 | 双阶段/双线性融合，无报告 | 官方完整代码未确认 | 是固定预测任务融合，不是多 marker sequential decision-making。 |
| [PathoDuet, 2023 预印本](https://arxiv.org/abs/2312.09894)；[代码](https://github.com/openmedlab/PathoDuet) | H&E/IHC patch；patch | 否 / 预训练跨染色 | 否 | 否 | 下游表征，无报告 | CC-BY-NC；代码/部分模型公开 | 是 cross-stain pretraining，不是把一个病例的真实 H&E/IHC 作为证据联合推理。 |
| [HistoStainAlign, American Journal of Pathology 2025](https://pmc.ncbi.nlm.nih.gov/articles/PMC12799405/)；[代码](https://github.com/BMIRDS/HistoStainAlign) | 未配准相邻 H&E/IHC 用于训练；测试时仅 H&E | 否 / 用 IHC 监督 | 否 | 否 | 预测 P53/PD-L1/Ki-67 pattern，无报告 | 代码公开；论文 CC-BY-NC，院内配对数据仅依 IRB/合理请求 | 是 virtual/prescreening，不是联合读取真实 IHC；不能替代染色及 control，也不是病例 agent。 |
| [MADELEINE, ECCV 2024](https://www.ecva.net/papers/eccv_2024/papers_ECCV/html/4788_ECCV_2024_paper.php)；[代码](https://github.com/mahmoodlab/MADELEINE)；[权重](https://huggingface.co/MahmoodLab/madeleine) | 同组织多染色 serial slides；slide representation | 多训练视图 / 是 | 否 | 否 | cross-stain representation，无报告 | repo 标 CC-BY-NC-ND，HF model card 标 MIT，**许可冲突待书面澄清** | 证明 multistain pretraining 已实现；不做可变病例集合、主动检查、工具、workspace 或报告。 |
| [CSCL, IEEE BIBM 2025](https://arxiv.org/abs/2512.03577)；[代码/数据入口](https://github.com/lily-zyz/CSCL) | 配准的 H&E+HER2/KI67/ER/PGR；固定五染色集合 | 固定多染色 / 是 | 否 | 否 | cross-stain attention/MIL，无报告 | 仓库/数据可见，但未见明确 LICENSE/dataset license，不能默认可二开 | 171 个经筛选集合，可能有 registration 选择偏倚；不覆盖真实缺片、主动 panel 或病例 provenance。 |
| [P&SrE, MICCAI 2023](https://conferences.miccai.org/2023/papers/486-Paper0295.html) | patient-slide-patch MIL；patient | 是 / 未证明 | 否 | 否 | 分类，无报告 | 官方代码/数据未确认 | 证明 patient→slide→patch 层级 MIL 不是新概念；不涉及 agent、IHC 选择或 provenance。 |
| [Patho-AgenticRAG, AAAI 2026](https://ojs.aaai.org/index.php/AAAI/article/view/40239)；[代码](https://github.com/Wenchuan-Zhang/Patho-AgenticRAG) | ROI/图像问题 + 教材页多模态知识库；patch/question | 否 / 否 | 主动分解与图文检索 | 否 | 引用检索页面；VQA而非报告 | 代码/router 权重开放 | 可借鉴知识检索，但教材版权、指南版本和适用人群必须进入 citation metadata。 |
| [MedRAX, ICML 2025](https://arxiv.org/abs/2502.02673)；[代码](https://github.com/bowang-lab/medrax) | 胸片/DICOM；影像病例 | — | 是，分类/分割/grounding/report 工具 | 是 | 结构化影像报告 | Apache-2.0 | 非病理，但证明“LLM 编排确定性医学影像工具”可行；不能外推到 WSI、多 block 和 IHC。 |
| [CellViT, Medical Image Analysis 2024](https://arxiv.org/abs/2306.15350)；[代码](https://github.com/TIO-IKIM/CellViT) | H&E patch/ROI；cell | 否 / 否 | 否 | 本身即确定性 cell tool | mask、centroid、class；无报告 | 代码/部分权重公开；Apache-2.0 + Commons Clause | 可生成 cell-level artifact，但通用类别并非 lymphoma phenotype；组件准确不等于病例诊断正确。 |
| [nuclei.io, Nature Biomedical Engineering 2024](https://www.nature.com/articles/s41551-024-01223-5)；[资源](https://huangzhii.github.io/nuclei-HAI/) | WSI/ROI + 人工纠错；cell task | 否 / 否 | 主动学习/反馈 | 是 | cell artifact + HITL；无病例报告 | 资源公开，具体数据/模型条款需按项目核验 | 以 plasma cell 和淋巴结转移 crossover study 证明 HITL 价值；任务固定，不能外推为 LLM case agent。 |
| [Squidpy, Nature Methods 2022](https://www.nature.com/articles/s41592-021-01358-2)；[代码](https://github.com/scverse/squidpy) | 单细胞/空间组学 + 图像；cell/spatial field | 可多区域 / multiplex 数据 | 否 | 是，空间统计库 | graph/statistics/plots；无报告 | BSD-3-Clause，活跃 | 提供邻域和空间统计，不负责细胞身份、临床 cutoff 或 serial-section 共表达假设。 |
| [SISH, Nature Biomedical Engineering 2022](https://www.nature.com/articles/s41551-022-00929-8)；[代码](https://github.com/mahmoodlab/SISH) | WSI/patch query；retrieval | 否 / 否 | 检索而非诊断规划 | 是，索引/搜索 | 返回相似 slide/ROI；无病例报告 | 代码公开；GPL-3 且 README 有非商用学术表述 | 证明相似病例/区域检索已实现；相似性不是因果证据或诊断置信度，并有队列/预训练偏倚。 |

### 对文献版图的严格归纳

**已经被实现：** 单 WSI caption/report；多张 H&E 病例聚合；单 WSI 低倍到高倍导航；逻辑多智能体；局部文本—patch 对齐；病理工具注册/代码执行；跨染色表征；patient-slide-patch MIL。

**单独模块已存在但尚未被可靠整合：** 实际 IHC 定量、serial-section 配准、cell graph/spatial statistics、相似病例检索、指南 RAG、结构化报告 schema、运行 provenance 和 human approval。

**截至 2026-07-31 尚未发现经公开复现并完成临床验证的系统：** 在同一真实 accession 上联合多 block、多 H&E、真实 IHC 与临床资料；依据当前 differential 主动选择下一片或建议下一项实际检测；调用经过验证的细胞/空间工具；把最终每个 claim 链接到可重读 artifact；经过外部/前瞻性病理医师在环评估。若后续发现私有商用系统，应单独比较，但不能凭营销材料认定其完成了这些能力。

---

## 3. 开源组件与复用建议表

下表的“开放”不等于“可临床/可商用”。必须分别审计代码、checkpoint、训练数据、远程代码和衍生输出五层条款；模型性能也必须在预期组织、染色、扫描仪和工作流上重新验证。

| 类别 | 项目与准确来源 | 可解决的系统部分 | 集成成本 | 许可、维护与公开性 | 建议 |
|---|---|---|---:|---|---|
| WSI viewer / annotation | [Digital Slide Archive](https://github.com/DigitalSlideArchive/digital_slide_archive)、[HistomicsUI](https://github.com/DigitalSlideArchive/HistomicsUI)、[large_image](https://github.com/girder/large_image) | 访问控制、WSI tile、ROI/annotation、容器任务 | 低 | Apache-2.0；2026 仍活跃 | **直接保留并扩展**。当前项目原生栈，不应为 MVP 换 viewer。 |
| 标注与人工复核 | [QuPath](https://github.com/qupath/qupath) | 病理医师离线 ROI/cell 标注、算法复核、GeoJSON 导出 | 低 | GPL-3.0；活跃；官方定位 research use | **直接作为标注客户端**；不要把 GPL 桌面代码嵌入闭源 Web 产品。 |
| 多图 viewer 参考 | [Cytomine](https://github.com/cytomine/cytomine)、[OHIF](https://github.com/OHIF/Viewers) | 多图协作 UX；DICOMweb/SM 互操作 | 中高 | Cytomine monorepo Apache-2.0；OHIF MIT；活跃 | 参考 multi-image UX；只有医院 DICOMweb 成为硬需求时再接 OHIF。 |
| WSI 读取/处理 | [OpenSlide](https://openslide.org/)、[TIAToolbox](https://github.com/TissueImageAnalytics/tiatoolbox) | 多格式读取、patching、组织/核分析、AnnotationStore | 低 | LGPL-2.1 / BSD-3-Clause；活跃；具体权重另审 | **直接复用**现有 TIAToolbox 接口，所有输出带版本/checkpoint hash。 |
| FM preprocessing | [TRIDENT](https://github.com/mahmoodlab/TRIDENT) | tissue segmentation、patch/features、多个 FM 统一管线 | 中 | CC-BY-NC-ND-4.0；活跃；下游模型另有条款 | 仅研究 profile/benchmark；不应直接进入潜在商业临床镜像。 |
| 跨切片配准 | [VALIS](https://github.com/MathOnco/valis)、[wsireg](https://github.com/NHPatterson/wsireg) | 刚性/非刚性 WSI 配准、transform ROI/points、误差估计 | 中 | 两者 MIT；公开。维护状态应在锁版前再核验 | **二次开发**：保存 transform、landmarks、TRE、有效覆盖和失败状态；不能把配准当默认成功。 |
| 核分割/分类 | [CellViT](https://github.com/TIO-IKIM/CellViT)、[CellViT++](https://github.com/TIO-IKIM/CellViT-plus-plus) | nuclei instance segmentation、通用 cell classes | 低（已接） | “Apache-2.0 + Commons Clause”，非标准宽松开源；部分权重公开；显存要求高 | 研究可用；**先做法律门禁**。尚未在 lymphoma/IHC 上校准，不能直接称 phenotype ground truth。 |
| 核分割基线 | [HoVer-Net](https://github.com/vqdang/hover_net)、[TIAToolbox 实现](https://github.com/TissueImageAnalytics/tiatoolbox) | nuclei segmentation/classification | 低 | 代码 MIT/BSD；PanNuke-derived 权重可继承 CC-BY-NC-SA，需分开核验 | 当前已有接口，适合作 baseline；代码许可不能代替权重许可。 |
| 核/细胞候选 | [InstanSeg](https://github.com/instanseg/instanseg)、[StarDist](https://github.com/stardist/stardist)、[Cellpose](https://github.com/MouseLand/cellpose) | brightfield/multiplex segmentation、弱标注与交互质控 | 中 | 主体 Apache-2.0 / BSD-3-Clause；个别 Cellpose-SAM 模型另有 NC 条款 | 对 lymphoma/IHC 外部验证后选择；它们不自动提供病理特异 phenotype。 |
| IHC 定量参考 | [DeepLIIF](https://github.com/nadeemlab/DeepLIIF) | brightfield IHC segmentation/quantification、virtual multiplex | 中 | Apache-2.0 + Commons Clause；非商用学术 | 仅研究参考或另行许可；MVP 应优先实现可解释 color deconvolution + 人工阈值/对照确认。 |
| cell/spatial analysis | [Squidpy](https://github.com/scverse/squidpy)、[SpatialData](https://github.com/scverse/spatialdata)、[SCIMAP](https://github.com/labsyspharm/scimap) | 邻域、co-occurrence、Moran、百万细胞表与坐标变换 | 中 | BSD-3 / BSD-3 / MIT；活跃；SpatialData API 仍演化 | **二次开发**成版本化确定性工具；serial-section IHC 不得冒充 multiplex same-cell 共表达。 |
| pathology FM（较宽松候选） | [H-optimus-0](https://huggingface.co/bioptimus/H-optimus-0)、[Hibou-L](https://huggingface.co/histai/hibou-L)、[GPFM](https://huggingface.co/majiabo/GPFM) | ROI/patch embedding、相似性与下游特征 | 中 | 模型卡分别 Apache-2.0、Apache-2.0、MIT；权重公开/门控；均非临床批准 | 用统一 encoder API 做 lymphoma、多站点 benchmark；Hibou 的 remote code 也需审计。 |
| pathology FM（研究隔离） | [UNI/UNI2](https://github.com/mahmoodlab/UNI)、[Virchow2](https://huggingface.co/paige-ai/Virchow2)、[TITAN](https://github.com/mahmoodlab/TITAN)、[CONCH](https://github.com/mahmoodlab/CONCH) | patch/slide/text embedding、ROI 检索、实验对照 | 中 | 门控、NC/ND 或更严格用途限制；Virchow2 明确排除诊断/临床等用途；CONCH 部分 text encoder 不公开 | 只放 research profile；不可默认打入临床/商业产品。 |
| FM（许可待澄清） | [Prov-GigaPath](https://github.com/prov-gigapath/prov-gigapath)、[PLIP](https://github.com/pathologyfoundation/plip)、[Google Path Foundation](https://huggingface.co/google/path-foundation) | WSI/patch embedding | 中 | GigaPath 页面与模型用途表述需同时审；PLIP 未见清晰许可证；Google 受 HAI-DEF 条款 | 取得书面许可结论前不进入发行物；当前计划中的 PLIP Navigator 必须设 legal gate。 |
| pathology VLM/LLM | [MedGemma model card](https://developers.google.com/health-ai-developer-foundations/medgemma/model-card)、[terms](https://developers.google.com/health-ai-developer-foundations/terms) | 受限 ROI 描述、结构化观察草稿、多图文本整合 | 低（已接） | 开放权重但非 OSI 开源；HAI-DEF；明确非临床级 | 保留为非权威观察/报告草拟器；多图输入能力不等于 WSI/case reasoning。 |
| pathology VLM/LLM | [SlideChat](https://github.com/uni-medical/SlideChat)、[HistGen](https://github.com/dddavid4real/HistGen)、[HistoGPT](https://github.com/marrlab/HistoGPT) | 单片 VQA、报告 decoder、多 H&E 报告 baseline | 中高 | 主仓库分别 Apache-2.0；依赖/权重/数据另审 | 作为对照和可替换 perception/report module；不要直接采用其自由文本为签署报告。 |
| pathology agent | [TissueLab](https://github.com/zhihuanglab/TissueLab)、[NOVA](https://github.com/microsoft/nova-agent) | tool registry、工作目录、病理分析编排 | 中 | Penn Academic license / MIT；前者临床功能未完成 | 借鉴 contract 与 artifact 设计；当前项目已有 agent gateway，不建议重写整套。 |
| 通用 agent framework | [LangGraph](https://github.com/langchain-ai/langgraph)、[PydanticAI](https://github.com/pydantic/pydantic-ai)、[Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | typed tools/output、checkpoint/replay、多 agent | 中 | MIT；2026 活跃。[AutoGen](https://github.com/microsoft/autogen) 已进入 maintenance mode | 优先在现有 loop 上补 typed state/event store；只有 durable orchestration 无法满足时再引入。不要新建在 AutoGen 上。 |
| 相似病例检索 | [SISH](https://github.com/mahmoodlab/SISH)、[pgvector](https://github.com/pgvector/pgvector) | WSI/ROI retrieval、病例 metadata 过滤、向量索引 | 中/低 | SISH GPL-3 且非商用学术表述；pgvector PostgreSQL License、活跃 | MVP 先用 pgvector 联合 case metadata/ACL；相似性只是检索证据，不能作为诊断置信度。 |
| RAG / guideline grounding | [Haystack](https://github.com/deepset-ai/haystack)、[Qdrant](https://github.com/qdrant/qdrant)；[CAP lymphoma guideline](https://www.cap.org/cap-guidelines/laboratory-workup-of-lymphoma-in-adults/) | 版本化文献摄取、检索、引用 | 中 | Apache-2.0；活跃；指南内容另受版权/访问条款约束 | 先 Postgres + pgvector；保存来源、版本、发布日期、适用人群与原文 locator。能 RAG 不等于可抓取/再分发 WHO/NCCN/CAP 全文。 |
| 报告/互操作 | [FHIR DiagnosticReport](https://hl7.org/fhir/diagnosticreport.html)、[FHIR Observation](https://hl7.org/fhir/observation.html)、[FHIR Specimen](https://hl7.org/fhir/specimen.html)、[HAPI FHIR](https://github.com/hapifhir/hapi-fhir) | 报告、观察、标本的出口 adapter | 中 | FHIR 标准；HAPI Apache-2.0、活跃 | 用于 validation/export，不要把 FHIR 当内部 cell/ROI evidence graph 或 artifact store。 |
| artifact / provenance | [MLflow](https://github.com/mlflow/mlflow)、[OpenTelemetry Python](https://github.com/open-telemetry/opentelemetry-python)、[W3C PROV-O](https://www.w3.org/TR/prov-o/)、[RO-Crate](https://www.researchobject.org/ro-crate/specification.html) | 模型/运行记录、服务 trace、语义 provenance、便携导出 | 中 | Apache-2.0 与开放标准；活跃 | DSA/Girder + Postgres + immutable object store 才是病例 source of truth；这些项目只补充实验、运维或交换，不能单独替代 clinical workspace。 |

**组件层总建议：** 保留 DSA/HistomicsUI/large_image、Postgres 和现有 typed SSE/tool loop；补充 case domain、不可变 artifact、VALIS/wsireg 配准、经验证的 actual-IHC quantifier、pgvector 和 report validator。不要为了“多智能体”迁移框架，也不要让 non-commercial checkpoint 悄悄进入 production image。建立 SBOM + model BOM，CI 按 `research`/`clinical-candidate` profile 隔离依赖。

---

## 4. 系统架构

### 4.1 结合当前 PathAssist 的真实起点

当前项目是一个很好的**单 WSI 分析工作台骨架**，而不是尚需重建的空白项目：DSA/Girder + OpenSeadragon viewer 已能导航和叠加 ROI；agent 有 viewer/server 两类工具；preprocess DAG、Postgres、CellViT、region VLM 和 ROI retrieval 已存在。应在此基础上升格数据和信任模型。

但以下差距会阻断病例级目标：

| 当前实现 | 证据 | 病例级问题 |
|---|---|---|
| conversation 明确绑定 `(Girder user, slide item)` | [services/agent/README.md](/home/chen/pathassist23/services/agent/README.md:18)、[pg.py](/home/chen/pathassist23/services/agent/src/agent/store/pg.py:17) | 换片即换主语；无法维护 accession-level differential、材料覆盖和 unresolved questions。 |
| Case 是 folder metadata + 扁平 `imageItemIds` | [CaseCreateModal.jsx](/home/chen/pathassist23/src/components/cases/CaseCreateModal.jsx:169)、[image IDs](/home/chen/pathassist23/src/components/cases/CaseCreateModal.jsx:209) | 没有 specimen、part/block、stain、clone、control、serial section、recut 等关系；patient 与 case 易混用。 |
| 打开 case 时默认第一张用户所选 slide | [SecondOpinionPage.jsx](/home/chen/pathassist23/src/components/cases/SecondOpinionPage.jsx:95) | 上传/选择顺序不是临床优先级，agent 也没有材料清单和选择依据。 |
| CompareViewer 同步 viewport | [CompareViewer.jsx](/home/chen/pathassist23/src/components/viewer/CompareViewer.jsx:164) | 同步视野不是图像配准；不能据此声称跨片同 ROI 或同细胞。 |
| tools 是 pan/zoom、ROI、segmentation、description、find-regions、virtual phenotype | [tools.py](/home/chen/pathassist23/services/agent/src/agent/loop/tools.py:74) | 缺 case material、actual IHC、registration、spatial、guideline、report/verification tools。 |
| turn artifact 以 handle/summary 传递，默认 store 仍有 in-memory stub | [artifacts.py](/home/chen/pathassist23/services/agent/src/agent/loop/artifacts.py:1) | 后续 agent 无法可靠重读完整 cell table/mask；没有 claim↔artifact、多父 lineage 和不可变病例快照。 |
| SSE 显示实时 reasoning/tool events，只持久化最终 turn 文本 | [routes.py](/home/chen/pathassist23/services/agent/src/agent/gateway/routes.py:247) | 现有 trace 不是可审计 clinical decision trace；也不应保存隐藏 chain-of-thought 代替结构化审计。 |
| 当前 permission mode 自动执行工具 | [sdk.py](/home/chen/pathassist23/services/agent/src/agent/loop/sdk.py:174) | 追加实体检测、改变最终诊断、签署报告和 oncology 语境需要不同的人类 gate。 |
| GigaTIME marker 是从 H&E 推断的 virtual biomarker | [markers.py](/home/chen/pathassist23/services/biomarker/src/biomarker_service/markers.py:1)、[前端免责声明](/home/chen/pathassist23/src/components/panels/MarkersPanel.jsx:308) | 它“不是染色、不是测量”，绝不能充当已观察的实际 CD20/MYC/Ki-67 IHC。 |
| tissue model 是 breast BCSS；唯一注册 slide task 是 BRCA IDC/ILC | [classes.py](/home/chen/pathassist23/services/tissue/src/tissue_service/classes.py:41)、[tasks.py](/home/chen/pathassist23/services/preprocess/src/preprocess_service/tasks.py:88) | 都不是 lymphoma 工具，必须从 MVP 临床主路径剔除或清晰标为研究 demo。 |
| AskPA 仍支持浏览器侧 `VITE_*_API_KEY` | [pathChatApi.js](/home/chen/pathassist23/src/api/pathChatApi.js:1) | 临床/PHI 场景不能把 provider key 和原始病例提示放进前端 bundle；统一迁到带审计和 egress policy 的 server gateway。 |

此外，仓库内部的早期 architecture review 已提出 `Patient/Case/Specimen/Block/Slide/Region` 和 `Artifact/Observation/Claim`，见 [architecture review](/home/chen/pathassist23/docs/Chen/plans/2026-07-16-pathagent-v2-conversational-copilot-architecture-review.md:844)；orchestrator RFC 也讨论了 tool events、claims 和 blackboard，但明确仍为 draft，见 [orchestrator RFC](/home/chen/pathassist23/docs/Chen/current-implementation/2026-07-20-pathagent-v2-orchestrator-agent-sdk-rfc.md:1)。所以数据层级和 evidence graph 不是本项目内部从未想到的概念，研究贡献必须来自**落地、真实数据和验证**。

最低成本的数据入口也已存在：导入脚本已经能抽取 `case_id/block_id/slide_num`，见 [import_wsi_slide.sh](/home/chen/pathassist23/scripts/import_wsi_slide.sh:57) 和 [embed_slide_images.py](/home/chen/pathassist23/scripts/embed_slide_images.py:76)。应把它们升级为经校验的规范实体，而不是继续埋在 Girder metadata 或文件名中。

### 4.2 权威数据层级

```text
Tenant
└─ Patient
   └─ Encounter
      └─ PathologyCase / Accession
         ├─ Specimen / Part
         │  └─ Block
         │     └─ StainRun / Assay
         │        └─ GlassSlide / WSI
         │           ├─ ROI / ViewEvent
         │           └─ CellSet / Cell / Measurement
         ├─ Flow / FISH / Molecular / ClinicalResult
         ├─ CaseRun
         │  ├─ DecisionEvent
         │  ├─ Hypothesis / Claim / EvidenceLink
         │  └─ Artifact / ArtifactParent
         └─ Report → ReportVersion → Signoff / Amendment
```

必须保存的关系不是只有外键：`same_block_as`、`serial_section_of`、`registered_to`、`derived_from`、`supports/refutes/context_for`、`generated_by`。一项 artifact 可由多张 slide 共同生成，因此 lineage 是多父图，不是单个 `parent_hash`。

建议职责边界：

- **Girder/DSA：** 源 WSI、缩略图、访问控制、人工 annotation；保持现有数据面。
- **Postgres：** patient/case manifest、workflow 状态、hypothesis/claim/evidence graph、审批、报告版本、ACL 和审计索引；作为控制面 source of truth。
- **S3/MinIO 或等价不可变对象存储：** OME-Zarr、Parquet/GeoParquet、mask、patch、heatmap、spatial plot；内容寻址并保存 SHA-256。
- **pgvector：** 只保存可追溯 embedding 与 metadata filter；不能替代病例数据库或原始 artifact。

每个 artifact 至少包含：输入 case-manifest hash、slide/ROI 与 level-0 coordinate frame、tool/schema 版本、代码 commit、container digest、模型与 weights hash、参数、随机种子、QC、创建者、父 artifact、内容 hash、许可 profile。坐标变换必须显式引用 registration artifact；不能悄悄把 A 片坐标用到 B 片。

### 4.3 端到端逻辑架构

```text
LIS / DICOM SM / Girder / clinical + flow/FISH/molecular
                         │
              Case ingestion + identity/QC gate
                         │
                immutable Case Manifest
                         │
┌────────────────────────▼──────────────────────────────────────┐
│ Case workspace / blackboard                                   │
│ material matrix · hypotheses · observations · claims          │
│ artifact graph · unresolved questions · report versions       │
└───────────────┬───────────────────────────────┬────────────────┘
                │                               │
       constrained case planner          versioned knowledge KB
       state machine + LLM policy         WHO/ICC/CAP/local SOP
                │                               │
       typed Tool Registry ─────────────────────┘
                │
  ┌─────────────┼───────────────┬──────────────┬───────────────┐
  │ viewer      │ deterministic │ retrieval    │ report/verify │
  │ pan/zoom    │ QC/register   │ ROI/case     │ schema compile│
  │ open slide  │ cells/IHC     │ guideline    │ claim checker │
  └─────────────┴───────────────┴──────────────┴───────────────┘
                │
       immutable artifacts + append-only decision events
                │
   morphology/IHC checkpoint → new-test approval → sign-out
```

Planner 不应是一个能自由发明临床路径的 LLM。建议采用“**疾病/任务版本化状态机 + 受约束 LLM policy**”：状态机规定允许的 evidence types、前置 QC、停止条件、人工审批和 fallback；LLM 只在允许集合内组织问题、排序候选证据、处理非结构化文本并解释选择。对追加 IHC 的目标函数可定义为：

`expected diagnostic information gain − stain cost − tissue depletion penalty − turnaround penalty − invalid/duplicate-test risk`

但这只是可研究的 policy，不是天然正确的 clinical truth；训练标签必须允许多个专家认可的 action set，而非强迫唯一顺序。

Tool registry 的每项能力必须声明：允许的 case/slide/ROI scope、输入 artifact schema、输出 schema、坐标系、版本/许可 profile、前置 QC、缓存键、最长运行时间、失败/重试、是否研究性、是否需审批。建议的触发规则如下：

| 工具 | 何时调用 | 关键输出与门禁 |
|---|---|---|
| `list_case_materials` / `read_clinical_context` | 每个 run 首步，或新增材料后 | frozen manifest、可见信息时间点、缺失/冲突；identity 冲突立即停止。 |
| `get_slide_overview` | 所有核心 H&E/IHC 初筛 | thumbnail、tissue/QC、coverage；不能用低倍 overview 直接判细胞学。 |
| `open_slide` / `pan_zoom` / `crop_roi` | 验证组织结构、细胞学或 report claim | 精确 slide + level-0 viewport/crop 与浏览器 ack；保存 visited coverage。 |
| `find_regions` / FM ROI retrieval | WSI 太大、需找异质/疑似模式或相似区域 | top-k candidates + similarity + coverage；只作候选生成，医师确认代表性。 |
| `segment_nuclei/cells` | 数量、密度、核形态或后续 IHC 统计确实影响决策时 | mask/cell table/PQ proxy/QC；坏片、OOD 或组织类型不支持则拒绝。 |
| `classify_cell_phenotype` | 需要区分 tumor/background/immune 亚群，且已有适用验证模型 | per-cell label/probability + confusion/calibration metadata；通用 PanNuke 类别不能冒充 lymphoma phenotype。 |
| `register_serial_sections` | 需要把 H&E ROI 映射到同 block IHC，或做区域层关联 | transform、landmarks、local TRE、valid mask；结果是 region association，不是 same-cell identity。 |
| `quantify_actual_ihc` | marker 比例/强度/cutoff 对分类或报告有意义，target cells/control 已确认 | stain deconvolution、cell/area statistic、threshold、CI/QC；无有效 control 输出 `uninterpretable`。 |
| `compute_spatial_statistics` | 明确临床/科研问题涉及邻域、排斥、聚集或共定位，且 phenotype 与坐标可靠 | graph、统计量、null model、多重比较；MVP 不把探索性 spatial p-value 写进签署诊断。 |
| `retrieve_similar_cases` | rare/atypical morphology、教学或质控，不用于替代 gold diagnosis | de-identified matches、ROI、metadata、距离和数据版本；防 PHI/队列偏倚，结果只作 context。 |
| `retrieve_guideline/literature` | 分类、cutoff、推荐检查或 biomarker 含义需要外部知识 | 来源、版本、日期、section/locator、适用人群；无可验证 locator 不得进入报告。 |
| `compile_report` / `verify_claims` | ledger 完成、所有 mandatory fields 和 checkpoints 通过 | schema-valid draft、每条 claim citations、缺项/矛盾清单；compiler 不能读取未验证自由文本作为新事实。 |

### 4.4 LLM、确定性工具和医师的责任矩阵

| 步骤 | LLM/多模态 agent 可负责 | 必须由确定性模型/专业工具负责 | 必须由病理医师确认 |
|---|---|---|---|
| 材料理解 | 解析说明、发现缺失/冲突、生成查看计划 | DICOM/LIS ID、checksum、stain metadata、QC | patient/accession/specimen/block/stain/control 对应；材料充分性 |
| H&E 浏览 | 提出低倍→高倍 ROI、形成结构化 differential、找反例 | tiling、坐标、组织 mask、检索、图像模型 score | 代表 ROI、形态学观察和取材偏倚；关键阴性形态 |
| IHC 选择 | 在允许 panel 中说明要区分的假设与预期结果 | policy constraints、成本/库存、重复检测、组织余量 | **查看已有 stain 可自动；下单新 stain/FISH/flow 必须批准** |
| IHC 解释 | 把 marker、pattern、localization 与 differential 关联 | 色彩分离、cell segmentation/classification、阳性率/强度、空间统计、controls QC | 肿瘤细胞身份、膜/核/胞质 pattern、cutoff、内外对照与坏片 |
| 跨片证据 | 汇总 block/stain 关系和一致/矛盾结果 | registration、transform、TRE、coverage、tissue-dropout | 配准是否足以支持区域关联；不能把 serial sections 当 same-cell multiplex |
| 知识 | 生成检索问题、归纳版本化条款 | 文献/指南检索、版本/locator 验证、规则计算 | 分类适用性、例外、local SOP；最终解释 |
| 诊断/报告 | 从已验证 claims 编译草稿、检查遗漏/矛盾 | report schema、数值复制、citation resolver、terminology validation | integrated diagnosis、必要 ancillary tests、最终 sign-out/amendment |
| oncology 接口 | 输出 biomarker/predictive/prognostic context 与待讨论问题 | guideline eligibility 条件的版本化规则 | pathologist 审核病理含义；oncologist/MDT 决定 regimen、剂量、顺序和患者适用性 |

所有定量结论必须来自工具 artifact，LLM 不得“看起来像是”手算 Ki-67、H-score、密度或邻域统计。反过来，分割器不能决定“这是 DLBCL”或自动解释阴性 IHC；它只生产观测量及 QC。

### 4.5 多智能体：逻辑分工，而非七个聊天机器人

推荐 MVP 只有一个拥有写权限的 **case manager/orchestrator**，加若干无状态 specialist/tool services 和一个独立 verifier：

| 逻辑角色 | 读/写权限 | 适用职责 | 不应做的事 |
|---|---|---|---|
| Case manager/planner | 读全病例；写计划/候选 hypothesis | 材料覆盖、下一证据、冲突升级、checkpoint | 直接创造定量结果或签署报告 |
| H&E morphology specialist | 读指定 H&E/ROI；写 observations | 多尺度描述、候选 ROI、支持/反对证据 | 跨病例记忆、最终诊断 |
| IHC/quant service | 读实际 IHC + ROI；写 measurements/artifacts | control-aware 量化、注册、cell/spatial | 把 virtual marker 说成 actual stain；自主设 cutoff |
| Knowledge retriever | 只读版本化 KB；写 citations | WHO/ICC/CAP/文献检索 | 无来源的治疗建议、抓取并重分发受限全文 |
| Report compiler | 只读 verified claims；写 draft | schema 填充、语言规范化 | 引入 ledger 外的新事实 |
| Independent verifier/critic | 只读 frozen snapshot；写 issues | claim-evidence entailment、数字/citation/矛盾检查 | 自己悄悄修正为另一个未经审核诊断 |

多个 specialist 可以由不同模型实现，但共享一个结构化 blackboard，不能各自维护一份事实。多 agent 的代价是冲突、重复调用、共同模型失误和难以验证；若单 orchestrator + tools 与规则状态机已经达到目标，就没有理由为论文表面复杂度增加 agent 数量。

### 4.6 Clinical decision trace，而非自由文本“思维过程”

每次状态变化写 append-only、hash-linked event；不保存或展示模型隐藏 chain-of-thought。一个最小事件为：

```json
{
  "event_id": "evt-017",
  "case_run_id": "run-...",
  "snapshot_hash": "sha256:...",
  "actor": {"type": "agent|tool|pathologist", "id": "..."},
  "action": "observation|hypothesis_update|tool_call|next_evidence|checkpoint|claim|signoff",
  "scope": {"case_id": "...", "slide_id": "...", "roi_id": "..."},
  "clinical_question": "区分 DLBCL-NOS 与其他大 B 细胞淋巴瘤",
  "hypotheses": [{"code": "...", "status": "candidate", "confidence_bin": "moderate"}],
  "supports": ["evidence-11"],
  "refutes": ["evidence-09"],
  "missing_evidence": ["valid-B-cell-marker", "MYC-FISH-status"],
  "selection": {
    "next": "slide-B1-CD20",
    "reason_code": "confirm-lineage",
    "alternatives": ["PAX5", "flow-cytometry"],
    "expected_information_gain": null
  },
  "tool": {
    "name": "quantify_actual_ihc",
    "version": "1.0.0",
    "params_hash": "sha256:...",
    "artifact_ids": ["artifact-82"],
    "qc": "passed"
  },
  "human": {"required": true, "decision": "approved", "override_reason": null},
  "prev_event_hash": "sha256:...",
  "event_hash": "sha256:..."
}
```

`confidence` 只有经病例级 calibration 后才能是数值概率；此前使用 low/moderate/high ordinal bin，并记录变化来自哪一条证据。必须拆开：**observation（看到了什么）→ interpretation（支持/反对什么）→ decision（下一步做什么）**。

### 4.7 Report schema 与 evidence citation

推荐报告字段：

1. case/specimen/procedure 和材料清单；
2. adequacy/QC/限制；
3. morphology（按 specimen/block）；
4. actual IHC 表：marker、block、localization、intensity、proportion、control、方法/cutoff；
5. flow/FISH/ISH/molecular 结果和状态（present/pending/not performed）；
6. integrated diagnosis + 分类体系/版本；
7. subtype；grade/stage 仅在该疾病与当前材料确实适用，否则明确 `not applicable/not determined from pathology`；
8. prognostic/predictive interpretation；
9. 推荐补充检查及理由，不等同于已下单；
10. limitations/uncertainty/discordance；
11. oncology-facing appendix：只描述 biomarker/guideline context，不给 regimen；
12. claim-level evidence links、审核者、签署和 amendment history。

引用格式不是只贴一张 heatmap，而是 `claim_id → evidence_link → artifact locator`。例如：

```text
claim: “大细胞群 CD20 弥漫膜阳性”
evidence:
  - slide B1-CD20, ROI-04, polygon/version, thumbnail
  - cell-table artifact sha256:..., tumor-cell positivity 92% (CI/QC)
  - pathologist control review event evt-031
knowledge:
  - WHO-HAEM5 chapter/version/section locator
```

最终 signed report 与可探索 workspace 分层：研究性 virtual marker、未经验证模型 score 或检索到的相似病例可以在 research pane 中显示，但不得自动进入 signed claims。

### 4.8 Human checkpoints 和 fail-closed fallback

强制检查点：身份/材料与 control；H&E differential；解释 IHC 前的 tumor/ROI；任何新增实体检测；discordant H&E/IHC；integrated diagnosis；所有 oncology-facing 表述；final sign-out。

以下情况系统应停止自动收敛并保留失败轨迹：

- case/slide/block/stain identity 缺失或冲突；
- 组织不足、折叠/模糊/坏死、target tissue 不在 IHC section；
- IHC 内外对照无效；
- registration 超过预设 TRE 或有效重叠不足；
- OOD scanner/stain/specimen；
- 模型或工具版本不可用、artifact hash 不匹配；
- H&E、IHC、flow、FISH 或 clinical data 严重不一致；
- 低置信且进一步检查不可得；
- 知识库无适用且版本可确认的条款。

fallback 从强到弱依次为：重跑确定性工具/更换经验证模型 → 人工 ROI/人工计数 → 只展示原始证据与 checklist → 请求会诊/追加材料 → 报告中明确 pending/indeterminate。绝不能在工具失败后静默改由 LLM 猜数值。

---

## 5. 一次完整病例工作流

下面描述的是可审计的 DLBCL workup 辅助流程，不是假定所有病例都按同样顺序浏览。

1. **载入与冻结材料。** 从 LIS/DICOM/Girder 创建 accession manifest；核对 patient、specimen/part、block、slide、H&E/IHC marker/clone/control、flow/FISH/molecular 状态、临床问题和 checksum。医师确认后冻结 `case_snapshot_v1`。
2. **材料与 QC 预检。** 工具生成宏观缩略图、组织面积、模糊/折叠/笔迹/空片提示、MPP/scanner 检查；失败的 slide 保留但不进入自动定量。planner 建 material-coverage matrix。
3. **选择初始 H&E。** 不是按文件名或上传顺序。优先核心诊断 block/level，低倍浏览全部关键 H&E：1–2× 看组织、结构和受累范围，4–10× 看生长模式与异质性，20–40× 看核、胞质、核仁、凋亡/有丝分裂及背景。
4. **建立 ROI 集。** 保存代表性 tumor ROI、界面/背景、坏死/压挤等 exclusion、以及与主模式不一致的 discordant ROI；每个 ROI 有 slide/level-0 polygon、截图和选择原因。必要时用 foundation embedding 做候选检索，但医师确认代表性。
5. **形成初步 differential。** agent 写结构化 hypothesis table：候选诊断、支持形态、反对形态、尚缺 evidence、当前置信区间/等级；不能直接生成结论式自由文本。
6. **先看已存在的 ancillary evidence。** planner 先从 manifest 选择能最大区分当前假设的已染 IHC/flow/FISH，而非立即建议新做检查；记录备选项、成本/组织消耗和预期信息增益。
7. **IHC 解释与量化。** 打开实际 IHC，确认 target tissue 和 control；先区域级注册到对应 block H&E，再由医师确认 tumor ROI。工具执行色彩分离、细胞分割/分类、阳性率/强度和空间分布；输出 mask、cell table、QC、阈值和不确定区间。阳性 pattern 需写 membrane/nuclear/cytoplasmic、diffuse/focal、强度与肿瘤/背景定位。
8. **更新 differential。** observation 独立于 interpretation 入账；agent 给每个 hypothesis 添加 supports/refutes，展示哪条 evidence 造成置信度变化。阴性 stain 若 control/adequacy 不合格，标为 uninterpretable 而不是 refuting evidence。
9. **决定下一证据。** 若现有 panel 不足，planner 只提出 `recommended next evidence`；病理医师批准后才进入真实 IHC/FISH/flow order。等待期间 run 为 `pending_external_result`，结果回传后产生新 snapshot，不回写旧事件。
10. **整合跨模态结果。** 结合 morphology、IHC、flow、EBER/FISH/molecular 和 clinical context；registration 只允许区域关联。若需真正 same-cell 共表达，必须使用 multiplex 或其他验证方法。
11. **生成 verified claim ledger。** 数字从 artifact 自动引用；分类和指南条款带版本/locator；未验证模型预测只能列为 research observation。verifier 检查矛盾、数字转录、错片/过期引用、unsupported claims 和关键遗漏。
12. **编译报告草稿。** report compiler 只从 verified claims 填充 schema。对 DLBCL 可给 phenotype/COO surrogate 和是否需 FISH 的提示，但不得把 MYC/BCL2 蛋白 double-expressor 等同于 rearranged/double-hit；Hans algorithm 与基因表达的 concordance 有限，见 [WHO-HAEM5 相关综述](https://jcp.bmj.com/content/78/11/725.full)。
13. **人类审核与边界控制。** hematopathologist 查看证据链接、修正 differential/interpretation 并签署病理报告；oncology appendix 若存在，由 oncologist/MDT 审阅。系统不生成具体药物、剂量、序贯或停换药指令。
14. **签署、导出与回放。** 生成 immutable signed version/FHIR adapter，保留 draft、修改、override reason、模型/tool/KB 版本和全部事件。后续 addendum 产生新版本，不能覆盖旧报告。

病理医师真实查看行为的研究支持“记录 viewport/zoom/停留和共识 ROI”，但也显示专家路径差异显著；因此行为日志适合评估覆盖和效率，不应被误当作隐藏认知真值，见 [J Pathology Informatics 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9576972/)、[Pathology-CoT](https://www.nature.com/articles/s41551-026-01739-y) 与尚属预印本的 [PathoGaze 1.0](https://arxiv.org/abs/2510.24653)。

---

## 6. 关键研究空白与创新性判定

### 6.1 四层判定

| 层级 | 内容 | 对论文 novelty 的含义 |
|---|---|---|
| 已被现有研究实现 | 单 WSI report/caption；多 H&E 病例/part 报告；patient-slide-patch 聚合；单 WSI agentic zoom/pan；多 agent 分工；H&E/IHC 固定融合；工具工作区；局部 patch grounding | 不能再声称“首次 multi-slide”“首次 pathology agent”“首次 multi-agent”“首次 report generation”或“首次 H&E+IHC”。 |
| 模块存在但未闭环 | DSA viewer、serial-section registration、nuclei/cell segmentation、actual-IHC quantification、spatial statistics、FM/相似检索、guideline RAG、structured report、provenance、HITL | 工程整合本身有价值，但若只有 demo，没有新方法、benchmark 或人因证据，通常不足以支持高水平方法论文。 |
| 仍明显缺少 | accession/specimen/block-aware shared state；真实 IHC 的条件式 next-best-evidence；negative/control-aware reasoning；跨片 claim-evidence graph；可回放的完整病例轨迹；端到端 prospective reader study | 这些是可防御的研究空白，但仍须以公开 protocol、机构数据和强 baseline 验证。 |
| 最可能形成创新 | 受约束、成本/组织敏感的下一证据策略；可重读 artifact 驱动的 claim-level report；完整病例 workflow benchmark + human-agent trial | 把 novelty 写成可测量的机制和证据，不写成宽泛系统愿景。 |

### 6.2 对七项拟议创新逐条裁决

| 拟议创新 | 裁决 | 成立所需额外条件 |
|---|---|---|
| 从 single slide 转向 patient-level multi-slide reasoning | **单独不成立** | PMPRG、HistoGPT、PolyPath 和 P&SrE 已有先例；需要真正跨 specimen/block、H&E+实际 IHC、missingness/discordance，并与简单 pooling/late fusion 比较。 |
| agent 主动决定下一张 IHC | **有潜力，但最易伪创新** | 不能把全套 stain 事后暴露给模型，不能用 LLM 模拟结果；要做 sequential hide/reveal、多个可接受 action、组织/成本约束、病理医师审批和 prospective replay。 |
| WSI 导航 + cell quantification + report generation | **整合创新，方法性中等** | 分别已有先例；需证明组合优于固定 state machine 与非 agentic pipeline，并量化错误传播、效率和可维护性。 |
| workspace artifact 驱动的可验证报告 | **强且临床相关** | 每个重要 claim 必须可点击回到正确 slide/ROI/cell table/knowledge locator；要评 citation correctness、provenance completeness 和 stale/wrong-slide rate，而非仅展示 heatmap。 |
| 显式建模病理医师流程 | **部分已有，仍可深化** | Pathology-CoT/PathoGaze 已记录行为；创新应是信息需求、stop rule、hypothesis/evidence 更新和跨片选择，而不是模仿单一 viewport 路径或生成不可验证 CoT。 |
| pathology 与 oncology 协同 | **边界设计有价值，自治治疗不成立** | 必须把 pathology-signed report 与 oncology advisory 分层；只输出版本化 biomarker context，具体治疗由 oncologist/MDT。可参考 [MUSK](https://www.nature.com/articles/s41586-024-08378-w) 的预后/疗效预测和 [oncology agent proof-of-concept](https://www.nature.com/articles/s43018-025-00991-6)，但二者均不证明自治处方安全。 |
| 可回放、可审计病例决策轨迹 | **强潜力** | 审计对象必须是结构化 state/action/evidence/tool/version/approval，不是私有思维链；需证明重放一致性、tamper evidence、故障可解释和医师可用性。 |

## 7. 最有潜力的三项创新

1. **Case evidence graph + claim-level reporting。** 首次将 accession→specimen→block→slide→ROI→cell/measurement 与 morphology/IHC/flow/FISH/knowledge claims 统一为可重读、版本化、可回放图谱；报告每个关键字段均有 machine-resolvable citation。
2. **Human-gated next-best-evidence/IHC policy。** 在真实 stain hide/reveal 环境中，以鉴别诊断的信息增益、组织消耗、成本、TAT、控制有效性和多个专家可接受路径为目标，研究何时看已有 IHC、何时建议新检查、何时停止或 abstain。
3. **完整病例 benchmark + 前瞻性人机验证。** 发布去标识化的 specimen graph、阶段性可见信息、artifact/trace schema、专家 action sets 与多层指标，并以病理医师交叉试验检验时间、修改、重大错误、automation bias 和临床效用。

最安全的论文表述不是“首次 autonomous pathology diagnosis”，而是：**一个受约束、证据可回放的 complete-case copilot，以及证明其增益或失败边界的 benchmark。**

---

## 8. MVP 方案与 18 个月路线

### 8.1 建议的第一阶段疾病与 intended use

推荐限定为：

> **病理医师已确认“疑似 aggressive mature B-cell lymphoma / DLBCL workup”且材料合格后，对一个 accession 中已有 H&E 和固定实际 IHC panel 做证据综合、缺项提示、ROI/定量引用和结构化报告草拟。**

这比“自动诊断所有 lymphoma”现实。CAP 的 [成人 lymphoma 实验室检查指南](https://www.cap.org/cap-guidelines/laboratory-workup-of-lymphoma-in-adults/) 强调形态学与 IHC、flow、FISH/分子等 ancillary studies 的整合；[CAP lymphoid protocol 2025](https://documents.cap.org/protocols/Heme.Lymphoid.Bx.Res_1.0.0.1.REL_CAPCP.pdf) 可作为结构化字段参考，但本院流程和 WHO/ICC 版本仍需管理。

MVP 输入建议：

- 单次 accession、单一主要 specimen，1–3 张代表 H&E；
- 同 block 或明确映射 block 的实际 IHC：CD20/PAX5、CD3、CD10、BCL6、MUM1、BCL2、MYC、Ki-67；按本院 SOP 可选 EBER；
- flow、FISH/分子先作为结构化人工结果，明确 `pending/not performed`；
- 年龄、部位、免疫状态和必要的临床问题，但不给 planner 暴露签署诊断；
- 病理医师确认 slide/block/stain/control 和 tumor ROI。

MVP 输出：形态证据摘要；支持/反对 differential；实际 IHC 表及 artifact；Hans IHC surrogate 的透明计算（明确不是 GEP ground truth）；MYC/BCL2 蛋白证据（明确不等同 rearrangement）；需要确认的 FISH/其他检查；每个字段有 citation 的 draft report；abstention/limitations。

### 8.2 必做、可模拟与推迟

| 现在必须实现 | 第一版可人工/模拟 | 明确推迟 |
|---|---|---|
| 规范 case manifest 与 specimen/block/stain/control；case-scope conversation；material matrix；人工 ROI；actual IHC 与 virtual marker 类型隔离；artifact hash/lineage；structured hypotheses/events；报告 schema/citations；审批与 abstention | 病理医师录入 IHC 百分比/强度/control；预计算 segmentation mask/cell table；oracle slide-to-block mapping；人工 landmark/配准审核；FISH/flow 作为结构化返回；next-action 用规则+专家 acceptable set | 所有 lymphoma taxonomy；自动新检查下单；自治 sign-out；stage/治疗推荐；从 H&E 预测 IHC 代替实际检测；无人工 ROI 的全片 IHC 定量；精确 serial-section same-cell 共表达；原始 flow/NGS 分析；长期 patient memory；在线自学习；七个自治 LLM agent |

当前项目可直接复用 DSA/Girder、viewer/overlay、level-0 坐标约定、SSE loop、Postgres、preprocess DAG；需二次开发 CaseCreate schema、case-scoped memory、artifact store、report UI 和 CellViT/actual-IHC adapter。CONCH/PathVLM 只作候选检索/非权威观察；BCSS breast tissue、BRCA classifier、GigaTIME virtual marker 不进入 MVP signed path。

### 8.3 时间路线

| 时间 | 工程/数据 | 研究退出门 | 可能贡献 |
|---|---|---|---|
| 0–6 个月 | case manifest；specimen/block/stain matrix；immutable workspace；manual ROI；2–3 个工具（overview、actual-IHC/manual quant、citation）；structured trace/report；收集并双读 30–50 个回顾性病例；导入 HTMCP | 100% case/slide linkage 人工核验；所有报告 claim 可解析回 artifact；故障时 fail closed；不比较诊断性能夸大临床效用 | 开源 schema/tool contracts；technical demo；artifact/provenance workshop/system paper |
| 6–12 个月 | VALIS/wsireg + QC；actual-IHC 定量；规则/LLM next-evidence policy；150–300 机构病例；多专家 action sets；外部 silent validation；baseline/ablation | 工具达到预设 analytical performance；agent 优于固定 panel/简单 pooling 或明确显示无增益；校准与 abstention 达标 | multi-stain case benchmark；next-evidence methods paper；evidence-grounded report paper |
| 12–18 个月 | 外院 temporal/multicenter；prospective silent→assisted crossover；模型/KB change control；oncology appendix gate；开放去标识子集/评测容器 | 不增加重大漏诊/unsupported claims；净节省 sign-out 时间；automation bias 可接受；外院性能和 drift 可解释 | clinical workflow/HCI paper；可回放 benchmark；开源 research system；后续 SaMD/QMS 证据包基础 |

如果 6 个月内拿不到机构完整病例和 workflow logging，应主动把第一篇论文改成：**HTMCP + ACROBAT 驱动的 multi-stain ingestion/registration/artifact benchmark**，而不是声称完成 lymphoma diagnostic agent。

---

## 9. 数据与评估方案

### 9.1 公开数据能做什么、不能做什么

目前没有核验到同时拥有“成套多 H&E/多 block + 真实 IHC + 临床/分子 + 原始与最终报告 + 查看/加做顺序 + differential + ROI/cell gold”的开放数据集。公开数据只能拼出组件 benchmark，完整系统必须有机构数据。

| 数据集 | 规模、模态与条款 | 可用于 | 不能证明 |
|---|---|---|---|
| [CGCI-HTMCP-DLBCL, IDC](https://portal.imaging.datacommons.cancer.gov/collections/cgci_htmcp_dlbcl/)；[Zenodo](https://zenodo.org/records/17381413) | 43 名 HIV+ DLBCL-NOS，496 DICOM WSI；H&E 与 BCL2/BCL6/CD10/CD20/CD3/CD79a/Ki-67/MUM1/TP53/EBER 等；>1 TB。按 CGCI/IDC 使用协议，Zenodo 页面许可需单独核验 | **MVP 最贴近**的 patient→multi-stain ingestion、case linkage、hide/reveal、DICOM SM；可连 GDC 多组学 | N=43、强 HIV+ 偏倚，主要每人约一张 H&E；无完整签署报告、ROI/cell gold、真实工作流或 IHC 下单顺序。 |
| [CGCI-BLGSP, IDC](https://portal.imaging.datacommons.cancer.gov/collections/cgci_blgsp/) | 388 Burkitt lymphoma、1,933 H&E/IHC WSI；使用条款需逐项核验 | 第二个 lymphoma 多染色压力测试、missingness/吞吐 | 疾病不同；不能当 DLBCL 泛化集，也没有报告/轨迹/ROI truth。 |
| [DLBCL-Morph](https://www.cancerimagingarchive.net/collection/dlbcl-morphology/)；[代码](https://github.com/stanfordmlgroup/DLBCL-Morph) | 209 cases、42 TMA slides；H&E + CD10/BCL6/MUM1/BCL2/MYC；代表 ROI、核几何、临床/细胞遗传/生存；数据页标 CC0 | ROI/cell geometry、IHC/结局 linkage、quantification baseline | TMA 不是日常完整 WSI；一片含多患者；无诊断流程与报告。 |
| [LyNSeC](https://zenodo.org/records/8065174) | DLBCL H&E/IHC tiles、nuclear instance masks、部分 tumor/non-tumor labels 与 HoVer-Net 权重 | lymphoma nuclei segmentation/classification 工具验证 | patch/ROI 级，不是成套病例；不支持诊断、选 IHC 或报告。 |
| [TCGA-DLBC, GDC](https://portal.gdc.cancer.gov/projects/TCGA-DLBC) | 约 48 subjects；H&E、临床和组学；受 GDC 数据访问/使用规则 | H&E/分子扩展与 baseline | 小、无系统 IHC；GDC 报告和 case/biospecimen 关联不能想当然。 |
| [CAMELYON17](https://camelyon17.grand-challenge.org/Data/) | 200 patients、1,000 H&E WSI（每人 5 个 lymph nodes），slide/patient pN labels，多中心 | 多片聚合、ROI localization、中心外泛化 baseline | 输入不含可供 agent 阅读的 IHC panel；是乳腺癌转移而非 lymphoma，也无病例报告/工具轨迹。 |
| [HISTAI metadata/data collection](https://huggingface.co/datasets/histai/HISTAI-metadata) | 数据卡称 112,801 slides/47,279 cases，其中 92,536 H&E、16,920 IHC；gated，CC-BY-NC-4.0 | 大规模 case metadata、报告预训练和跨专科压力测试 | hematologic 子集仅 214 slides/cases；mapping/标签质量需审计。独立病理复核发现 substantial ambiguity/discordance，见 [critical appraisal](https://pmc.ncbi.nlm.nih.gov/articles/PMC13083215/)；不能把所有文本当 gold。 |
| [ACROBAT](https://www.nature.com/articles/s41597-023-02422-6)；[数据](https://researchdata.se/en/catalogue/dataset/2022-190-1)；[代码](https://github.com/rantalainenGroup/ACROBAT) | 1,153 breast patients、4,212 WSI，每人 H&E + 1–4 ER/PGR/HER2/Ki67，>37k landmarks；CC-BY-4.0 | 最强公开跨 stain registration/TRE benchmark | 癌种/markers 不同、每人一张 H&E；不测病例诊断、报告或检查选择。 |
| [ANHIR](https://anhir.grand-challenge.org/Data/) | 多组织、多染色 set 与 landmarks；CC-BY-NC-SA-4.0 | registration 外部测试 | 混合组织/物种、非商用；无 case reasoning。 |
| [BCI](https://bupt-ai-cz.github.io/BCI/)；[许可](https://github.com/bupt-ai-cz/BCI/blob/main/BCI_LICENSE.md) | 51 breast WSI pairs、4,870 registered H&E/HER2 patches；自定义非商用 | H&E↔IHC patch alignment/translation baseline | patch/乳腺/单 marker；不能测病例或报告。 |
| [Warwick HER2 challenge](https://warwick.ac.uk/fac/cross_fac/tia/data/her2contest/) | 86 breast cases，H&E + HER2 WSI 和 score/%；研究用途 | IHC scoring 与配对分析 | 单 marker/单癌种；无 agent/trace/report。 |
| [IGNITE v2](https://zenodo.org/records/17735903)；[toolkit](https://github.com/DIAGNijmegen/ignite-data-toolkit) | 155 NSCLC patients、887 annotated ROI；H&E 组织类 + PD-L1 IHC cells；CC-BY-NC-SA-4.0 | 多中心 ROI、nuclei、PD-L1 quantification 与 scanner robustness | H&E/PD-L1 ROI 不一定配对；非 lymphoma，不测跨片报告。 |
| [NuCLS](https://github.com/PathologyDataScience/NuCLS) | breast H&E、>220k nuclei、多观察者；数据 CC0、代码 MIT | cell detection/classification、人际一致性与 adjudication 方法 | 非 lymphoma/IHC；不能直接作为业务 gold。 |
| [DLBCL spatial mIF](https://zenodo.org/records/15362450) | 99 patients、197 TMA cores、12 markers + DAPI；单细胞/空间表；当前页面许可未确认 | same-cell multiplex 邻域/共定位 benchmark | mIF TMA 不等于 routine serial-section IHC；无报告/轨迹。 |
| [REG2025 challenge](https://reg2025.grand-challenge.org/reg2025/)；[REG² 2026 data](https://reg2026.grand-challenge.org/data-description/) | WSI report generation/evaluation benchmark；2026 版本含生成式“reasoning”信息 | 报告基线与结构化评价 | 所谓 reasoning 不是病理医师真实 viewer log；不能当 clinical decision trace gold。 |

报告监督还有两类系统性风险：其一，报告包含 gross、临床、分子和先前检查，模型不能从当前图像看出；其二，同一 patient/tissue-source-site 在训练测试中泄漏。可参考 [TCGA Reports](https://pmc.ncbi.nlm.nih.gov/articles/PMC10935496/) 的报告资源与 2026 预印本 [Auditing Data Leakage in WSI Multimodal Benchmarks](https://arxiv.org/abs/2607.12278)；后者尚未同行评议，但提示应做 case/TSS 级去重和预训练污染审计。

### 9.2 必须自建的机构数据

1. **规范关系：** patient→encounter/accession→specimen/part→block→slide→stain/clone/control；保存 level/recut、取材部位、固定/切片/染色 batch、scanner/MPP、失败/重染及物理组织余量。
2. **阶段性可见信息：** 原始 clinical question、H&E、每次已可见 IHC/flow/FISH/分子及时间戳。最终全套 panel 不能在第一步泄露给 planner。
3. **报告与诊断：** 原始 draft、final、addendum；拆成 diagnosis/subtype、适用的 grade/stage、micro、IHC、uncertainty、recommendation 和依据。禁止只拿全文作为 next-token target。
4. **workflow trace：** slide open、pan/zoom/magnification、ROI bookmark、tool call、查看/下单检查、阶段 differential/hypothesis、暂停/会诊/stop reason。行为日志与认知解释分离。
5. **标注：** 至少两位 hematopathologist 独立标注，第三位 adjudication；保留分歧和 acceptable action sets。ROI/cell/IHC 标注必须带 marker clone/platform、control、cutoff、坏片和 target-tissue adequacy。
6. **结局：** 可收诊断修订、MDT、治疗反应和生存，但只在数据成熟后作为二级研究；不能用结局反向污染诊断时点输入。

切分必须按 patient，并同时设置 site/scanner/lab/时间外推；serial section、tile、TMA core 绝不能跨 split。锁定 temporal test 和至少一个外院 external test；所有置信区间用 patient-level bootstrap。

### 9.3 多层评价指标

| 层级 | Primary/关键指标 | 设计要点 |
|---|---|---|
| diagnosis/subtype | exact + hierarchical macro-F1、balanced accuracy、sensitivity；重大/轻微错误分级；Cohen/Fleiss κ 或 Krippendorff α | 与专家 adjudication 比，同时报告病理医师间一致性上限；保留合理 differential，不把唯一字符串当真值。 |
| grade/stage | 适用病例正确率 + 正确 `N/A/not determined` 率 | 不能奖励系统在 DLBCL 上编造 grade，或从 biopsy WSI 猜 clinical stage。 |
| next IHC/test | expert acceptable-set precision/recall、top-k、cost-weighted regret、达到正确结论的 stains/时间、漏掉必需检查率、组织消耗 | 固定 panel、规则 state machine、oracle 和不使用 agent 都是 baseline；hide/reveal 离线实验不能代替 prospective evidence。 |
| ROI/navigation | representative/lesion recall@固定查看预算、point-in-region、IoU/mAP、top-k retrieval、coverage/diversity、导航长度 | 报告 reader ceiling；不能只看模型命中一个容易 ROI。 |
| registration | landmark TRE、成功 coverage、折叠/Jacobian、失败检测率 | 单独报告可配准病例比例；失败不能被均值掩盖。 |
| cell/phenotype | detection F1、PQ/AJI、class macro-F1 | 在 lymphoma、IHC、不同站点/扫描仪分别验证。 |
| IHC quant | positivity/Ki-67/H-score 等 MAE、ICC、Bland–Altman、分类 κ；control-invalid rejection | cutoff 与 intended use 预注册；比较人工 inter/intra-reader variability。 |
| spatial | 合成 golden set 数值一致性、重复测量、邻域/co-occurrence 误差 | 区分 multiplex same-cell 与 serial-section region-level inference。 |
| evidence/provenance | claim–artifact entailment/contradiction、citation precision/recall、坐标可解析率、provenance completeness、wrong/stale slide rate | 从报告一键回到正确 slide/ROI/table；由盲法医师抽查。 |
| report | key-field accuracy/completeness、critical omission、contradiction、unsupported claim rate、否定/不确定性错误、版本化 guideline consistency | BLEU/ROUGE 仅次要；可补充新近 [PathReportEval](https://arxiv.org/abs/2607.18448) / [PathBench code](https://github.com/surykntsingh/PathBench) 的 coverage/hallucination 维度，但其为 2026 预印本且 evaluator 本身也需人工验证。 |
| calibration/safety | Brier、ECE、reliability、selective risk–coverage、OOD/坏片 abstention、high-confidence unsupported claims | 分别校准 diagnosis、tool measurement 和 next action；不混成一个“总体信心”。 |
| tool efficiency | schema/参数错误、失败/重复调用、p50/p95 latency、GPU-minutes、成本、每正确病例调用数、停止质量 | 与固定 deterministic workflow 比，才能证明 agenticity 有增益。 |
| human factors | 随机、counterbalanced crossover：sign-out 时间、净节省、修改字符/关键字段、遗漏/unsafe override、NASA-TLX/SUS；junior/senior 分层 | 有 washout 或 matched disjoint cases；统计模型同时处理 reader 和 case clustering。 |
| clinical utility | TAT、追加 stain/FISH 数、amendment、会诊率、重大错误、pathologist/MDT actionability、decision curve/net benefit | retrospective replay → prospective silent → assisted trial；patient outcome 留给后续有功效的多中心研究。 |

必做 ablation：text-only、单 slide、简单多片 pooling、固定 panel、规则 state machine、无 tool、无 artifact citation、oracle ROI、不同 foundation encoder、同一个模型自检 vs 独立 verifier。只有 agent 相对**非 agentic 多模态流水线**存在增益，才可把 agenticity 当创新。

临床评价应按 [DECIDE-AI](https://www.nature.com/articles/s41591-022-01772-9) 强调早期真实环境、人因和工作流影响，并参考 FDA 的 [Good Machine Learning Practice](https://www.fda.gov/medical-devices/software-medical-device-samd/good-machine-learning-practice-medical-device-development-guiding-principles) 与 [ML-enabled device transparency principles](https://www.fda.gov/medical-devices/software-medical-device-samd/transparency-machine-learning-enabled-medical-devices-guiding-principles)。研究性 MVP 不等于医疗器械获批，也不能以 retrospective AUROC 替代 clinical validation。

---

## 10. 主要失败风险及规避方式

| 风险 | 为什么严重 | 规避/停止规则 |
|---|---|---|
| patient/case/slide/block/stain 误绑定 | 精确分析错误材料是灾难性错误 | 双标识、DICOM/LIS reconciliation、manifest hash、人审 gate；任何冲突 fail closed。 |
| report supervision 含图像不可见事实 | 模型学习猜 gross/分子/临床，表面文本分高但事实不 grounded | source masking、claim modality attribution、字段级监督；只从已暴露模态生成。 |
| stain panel/未来结果泄漏诊断 | 模型从“做了哪些 stain”猜标签，next-action 评价失真 | 时间戳 hide/reveal；训练/评估只暴露当时可见材料；单设 panel-leak baseline。 |
| patient/site/pretraining contamination | serial sections/同一 TSS 跨 split 造成虚高 | patient+TSS+site+time split、感知 hash、重复病例审计、公开 FM contamination sensitivity。 |
| 无效阴性与 target tissue 缺失 | “阴性”可能只是坏片/组织掉失 | control + adequacy 必填；不合格输出 uninterpretable，禁止作为反对证据。 |
| serial-section 配准和组织 dropout | 伪造同细胞共表达/错误 ROI 转移 | TRE/coverage/Jacobian QC、医师确认；只做区域级结论；same-cell 需 multiplex。 |
| domain shift | stain/scanner/lab/specimen 改变 segmentation/quantification | 多站点 calibration、QC/OOD、site-wise 报告、silent monitoring、版本锁定。 |
| tool cascading errors | 错 ROI→错 cell→错 IHC→漂亮但错误报告 | 每层 artifact/QC、oracle-component ablation、独立 verifier、claim fail closed。 |
| LLM overconfidence/guideline hallucination | 造成错误分类或越权建议 | versioned allowlisted KB、locator 验证、无来源不写入 report、selective abstention。 |
| 多 agent 不一致/重复 | 多个模型可能共享同一偏差并增加成本 | single writer/shared ledger、typed contracts、independent frozen-snapshot verifier；MVP 少 agent。 |
| automation bias | 精确数值/热图让错误更难被质疑 | 显示 QC/不确定性/原始图、error-enriched reader study、记录 unsafe override 与是否查看 evidence。 |
| pathology–oncology 越权 | biopsy 缺 stage、PS、器官功能、偏好等，治疗建议不完整 | pathology report 与 oncology appendix 分层；仅 biomarker context；oncologist/MDT gate。 |
| 许可/版权风险 | 可下载代码或权重不等于可商用；WHO/NCCN 等不可任意再分发 | SBOM/model BOM 五层审计；research/production 镜像隔离；必要时书面许可；RAG 只存允许内容/locator。 |
| PHI 泄露 | WSI label、filename、prompt、日志、patch 都可含 PHI | server-side inference、label/macro image de-ID、最小化日志、tenant ACL、加密、审计、禁前端 API key。 |
| mutable provenance/模型漂移 | 同一报告日后无法重放 | immutable objects、content hashes、model/tool/KB/prompt version、signed report snapshot；升级触发再验证。 |
| 时间不降反升 | agent 可能带来过多 review、alerts、工具等待 | 预设 p95 latency/净时间 endpoint；精简 checkpoints；若无净收益，定位为复杂病例/培训工具。 |
| 公开 lymphoma 数据偏倚 | HTMCP HIV+、DLBCL-Morph TMA，难代表常规会诊 | 机构连续病例 + 外院 temporal test；公开集仅模块/压力测试；限制 intended use。 |
| 把 Hans 当真值、double-expressor 当 double-hit | 临床解释错误 | 报告明确 surrogate/蛋白 vs rearrangement；FISH/分子状态独立字段；pathologist sign-off。 |

技术上“能运行”不是临床完成。任何一次 fail-open、错病例引用、高置信 unsupported claim 或静默工具降级，都应作为独立 safety endpoint，而不是藏在平均准确率里。

---

## 11. 推荐优先阅读的论文和代码库

### 第一优先：决定论文定位

1. [HistoGPT](https://www.nature.com/articles/s41467-025-60014-x) / [code](https://github.com/marrlab/HistoGPT)：最直接的多 H&E 病例报告先例，说明“病例报告”不能单独作为 novelty。
2. [PMPRG](https://papers.miccai.org/miccai-2024/paper/1738_paper.pdf) 与 [PolyPath](https://arxiv.org/abs/2502.10536)：patient/part-level 多片聚合、规模退化和开放性边界。
3. [Pathology-CoT](https://www.nature.com/articles/s41551-026-01739-y) / [code](https://github.com/zhihuanglab/Pathology-CoT)：真实 viewport 行为建模、where/why 分离以及 human-edited trace。
4. [PathFound](https://www.sciencedirect.com/science/article/pii/S1361841526002690) / [code](https://github.com/hsymm/PathFound)：与“追加检查”最接近，但其 IHC 是模拟文本，正好界定本研究所需的真实证据闭环。
5. [TissueLab](https://arxiv.org/abs/2509.20279) / [code](https://github.com/zhihuanglab/TissueLab) 与 [NOVA](https://proceedings.mlr.press/v297/vaidya26a.html) / [code](https://github.com/microsoft/nova-agent)：tool registry、artifact workspace 与 HITL 的最强工程先例。
6. [BioX-CPath](https://arxiv.org/abs/2503.20880) / [code](https://github.com/AmayaGS/BioX-CPath) 与 [DuoHistoNet](https://www.nature.com/articles/s43856-025-01045-9)：真实多染色 patient/fixed-pair fusion，及“多模态不必然提高性能”的反例。

### 第二优先：临床与评估边界

7. [CAP Laboratory Workup of Lymphoma in Adults](https://www.cap.org/cap-guidelines/laboratory-workup-of-lymphoma-in-adults/)、[WHO-HAEM5 lymphoid overview](https://www.nature.com/articles/s41375-022-01620-2)、[EHA LBCL guideline](https://pmc.ncbi.nlm.nih.gov/articles/PMC12456099/)：定义 lymphoma 不是纯图像分类任务。
8. [JPI 2022 digital pathology viewing behavior](https://pmc.ncbi.nlm.nih.gov/articles/PMC9576972/)：真实导航日志的含义和限制。
9. [QCAgent](https://arxiv.org/abs/2603.01647) 与 [PathReportEval](https://arxiv.org/abs/2607.18448)：claim localization 和报告事实性评价；两者均为很新的预印本，需持续跟踪代码/同行评审状态。
10. [DECIDE-AI](https://www.nature.com/articles/s41591-022-01772-9)：reader study、真实工作流和早期临床评价。

### 第三优先：当前项目直接可复用代码/数据

11. [DSA](https://github.com/DigitalSlideArchive/digital_slide_archive)、[HistomicsUI](https://github.com/DigitalSlideArchive/HistomicsUI)、[TIAToolbox](https://github.com/TissueImageAnalytics/tiatoolbox)：保留当前 viewer/data plane，建立稳定 tool/artifact contracts。
12. [VALIS](https://github.com/MathOnco/valis)、[wsireg](https://github.com/NHPatterson/wsireg)、[ACROBAT paper/data/code](https://www.nature.com/articles/s41597-023-02422-6)：跨 stain 配准与失败 QC。
13. [CellViT](https://github.com/TIO-IKIM/CellViT)、[CellViT++](https://github.com/TIO-IKIM/CellViT-plus-plus)、[InstanSeg](https://github.com/instanseg/instanseg)：现有 cell tool、许可反例和较宽松候选。
14. [Squidpy](https://github.com/scverse/squidpy) + [SpatialData](https://github.com/scverse/spatialdata)：cell table、coordinate transforms 和 spatial tool 层。
15. [H-optimus-0](https://huggingface.co/bioptimus/H-optimus-0)、[Hibou-L](https://huggingface.co/histai/hibou-L)、[GPFM](https://huggingface.co/majiabo/GPFM)：许可相对清晰的 encoder shortlist；仍需 lymphoma/site benchmark。
16. [CGCI-HTMCP-DLBCL](https://portal.imaging.datacommons.cancer.gov/collections/cgci_htmcp_dlbcl/) 与 [DLBCL-Morph](https://github.com/stanfordmlgroup/DLBCL-Morph)：MVP 的多染色 ingestion 与 ROI/cell/outcome 补充数据。

---

## 结论

建议把项目命名和 intended use 定为 **evidence-grounded complete-case pathology copilot**，而不是 autonomous pathologist。第一篇强论文应回答一个严格问题：

> 在受约束的 DLBCL workup 中，带持久 artifact、真实 IHC hide/reveal 和人工审批的病例级 agent，是否比固定规则多模态流水线，在不增加重大错误与 unsupported claims 的前提下，更快达到完整、可核查的报告？

如果答案是否定的，这仍是有价值的研究结果：它会说明 agenticity 在何处没有超过 deterministic workflow。只有在病例级诊断、证据正确性、校准、工具成本和人因结果同时改善时，才应推进更广癌种、分子原始数据、oncology 协同或更高自治。

在当前代码基线上，近期优先级应是：**case identity/schema → durable evidence workspace → actual-IHC/manual quant vertical slice → claim-linked report → evaluation harness**。多 agent、虚拟 marker、自动分期与治疗推荐都排在这些基础之后。
