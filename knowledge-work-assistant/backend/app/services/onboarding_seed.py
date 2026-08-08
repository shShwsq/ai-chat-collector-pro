"""新手引导种子图谱。

首次启动（数据库无任何图谱）时自动创建两个内置图谱：
- **Study**「对话回声使用指南」：教用户如何使用软件各项功能
- **Work**「神秘人的委托」：情景式图谱，神秘人引导用户了解 Work 模式用途

触发条件：``list_graphs("study")`` 与 ``list_graphs("work")`` **都为空**时才注入。
用户删除引导图谱后若已有其他图谱，不会重复注入。
"""

from __future__ import annotations

import logging
from typing import Any

from app.services.graph_store import GraphStore

logger = logging.getLogger(__name__)

# ============================================================================
# Study 种子图谱：「对话回声使用指南」
# 节点 type=general，detail_payload 用 STUDY_TEMPLATE_DEFAULT 的 key
# ============================================================================

STUDY_ONBOARDING: dict[str, Any] = {
    "name": "对话回声使用指南",
    "nodes": [
        {
            "title": "欢迎来到对话回声",
            "summary": "双模式知识图谱软件，帮你在学习和工作中组织知识",
            "detail_payload": {
                "what_is": "对话回声是一款双模式（Study/Work）知识图谱软件，帮助你将碎片化的知识结构化为可视化的图谱。",
                "why_important": "传统的笔记工具以线性文本为主，难以表达知识间的关联。图谱结构让你一眼看清知识点之间的脉络，发现盲区与关联。",
                "key_points": "右上角切换 Study/Work 模式；左侧栏管理图谱；中间区域展示图谱可视化；最左侧导航条切换对话/图谱/设置。",
                "common_cases": "学习场景：整理学科知识点体系；工作场景：梳理项目线索与人物关系。",
                "extensions": "试试切换到 Work 模式，查看「神秘人的委托」图谱了解工作模式用途。",
            },
        },
        {
            "title": "如何创建与管理图谱",
            "summary": "左侧栏新建图谱，切换模式查看不同类型图谱",
            "detail_payload": {
                "what_is": "在左侧图谱列表顶部点击「+」按钮创建新图谱，输入名称后自动选中并加载。",
                "why_important": "图谱是组织知识的基本单位，不同模式（Study/Work）的图谱互不干扰，数据隔离。",
                "key_points": "点击「+」新建；右键图谱可重命名/删除；切换 Study/Work 模式时图谱列表自动过滤。",
                "common_cases": "创建一个「高等数学」图谱整理微积分知识；创建一个「Q3 项目」图谱梳理工作线索。",
                "extensions": "一个图谱可以包含任意多个节点和边，建议按主题/项目划分。",
            },
        },
        {
            "title": "节点与详情卡",
            "summary": "点击节点弹出详情卡，查看与编辑知识点详情",
            "detail_payload": {
                "what_is": "节点是图谱中的知识卡片，显示标题和一句话概括。悬停弹出详情卡，单击固定显示。",
                "why_important": "详情卡展示节点的完整信息：概括、重要点、关键材料、延伸方向，以及用户留白区。",
                "key_points": "悬停 → 临时查看详情；单击 → 固定详情卡（可编辑）；双击 → 全部延伸；详情卡内可切换节点类型。",
                "common_cases": "悬停查看概念定义；单击固定后编辑详情；在留白区记录疑问或联想。",
                "extensions": "留白区支持 5 种类型：疑问、联想、考点、易错点、笔记。点击「保存并延伸」可基于留白内容生成延伸节点。",
            },
        },
        {
            "title": "延伸与扩展",
            "summary": "双击节点全部延伸，或单击单点延伸生成关联节点",
            "detail_payload": {
                "what_is": "延伸功能基于当前节点，由 AI 自动生成关联的子知识点，以灰色节点形式添加到图谱中。",
                "why_important": "延伸帮你快速拓展知识体系，发现你可能忽略的关联领域。",
                "key_points": "双击节点 → 全部延伸（生成多个方向）；详情卡内点击延伸方向 → 单点延伸；灰色节点 = AI 延伸生成；可撤销延伸。",
                "common_cases": "学习「微积分」时延伸出「极限」「导数」「积分」等子概念；工作线索延伸出相关风险与关键人。",
                "extensions": "工具栏「撤销延伸」可回退最近一次延伸操作。",
            },
        },
        {
            "title": "测验功能",
            "summary": "Study 模式下可生成测验，检验知识点掌握程度",
            "detail_payload": {
                "what_is": "测验功能基于图谱节点自动生成题目，支持选择题与简答题，AI 费曼式批改给出评分与反馈。",
                "why_important": "主动回忆比被动阅读更有效。测验帮你检验是否真正掌握了知识点，而非只是「看过」。",
                "key_points": "工具栏点击「开始测验」；选择题型与数量；答题后 AI 批改并给出费曼式反馈；可回顾历史测验。",
                "common_cases": "考前复习时生成一套选择题自测；学完一章后用简答题检验理解深度。",
                "extensions": "费曼式批改会指出你的理解偏差，并建议重点复习的节点。",
            },
        },
        {
            "title": "对话首页",
            "summary": "「对话」tab 展示推荐卡片瀑布流，点击展开详情",
            "detail_payload": {
                "what_is": "点击最左侧导航条的「对话」图标进入对话首页，展示按复习优先级排序的推荐卡片瀑布流。",
                "why_important": "推荐算法结合复习时间、提及次数、星标等智能排序，帮你聚焦最需要关注的知识点。",
                "key_points": "卡片从下方错落飞入；点击卡片 FLIP 动画展开为大卡；Work 模式输入框居中，回车发送触发 Agent 对话。",
                "common_cases": "Study 模式按标题搜索知识点；Work 模式提问触发多轮对话与工具调用。",
                "extensions": "大卡内点击「延伸方向」「编辑」「保存并延伸」可无缝切换到图谱视图继续操作。",
            },
        },
        {
            "title": "插件采集",
            "summary": "浏览器插件采集 AI 对话，自动推送至后端待抽取",
            "detail_payload": {
                "what_is": "安装浏览器插件（web-ai-chat-collector）后，在 ChatGPT/DeepSeek/Kimi/元宝等平台采集对话，自动推送到本软件。",
                "why_important": "AI 对话中常含值得记录的知识。插件采集 + Agent 抽取让你一键将对话中的知识点导入图谱。",
                "key_points": "支持 ChatGPT/DeepSeek/Kimi/豆包/元宝等多平台；插件推送后在图谱视图「待抽取」面板查看；一键抽取入图。",
                "common_cases": "在 ChatGPT 学了一个概念，用插件采集对话，Agent 自动抽取知识点并添加到图谱。",
                "extensions": "插件支持语义搜索与相似度徽章，方便在历史对话中快速定位。",
            },
        },
    ],
    # 边以 (src_title, dst_title, relation) 定义，创建时解析为 ID
    "edges": [
        ("欢迎来到对话回声", "如何创建与管理图谱", "related"),
        ("如何创建与管理图谱", "节点与详情卡", "related"),
        ("节点与详情卡", "延伸与扩展", "related"),
        ("延伸与扩展", "测验功能", "related"),
        ("欢迎来到对话回声", "对话首页", "related"),
        ("欢迎来到对话回声", "插件采集", "related"),
    ],
}


# ============================================================================
# Work 种子图谱：「神秘人的委托」
# 节点用 Work 工作对象类型，detail_payload 用 WORK_TEMPLATE_DEFAULT 的 key
# ============================================================================

WORK_ONBOARDING: dict[str, Any] = {
    "name": "神秘人的委托",
    "nodes": [
        {
            "title": "神秘人",
            "type": "key_person",
            "summary": "一位不愿透露姓名的人通过加密渠道联系了你",
            "detail_payload": {
                "summary": "神秘人自称「K」，通过端到端加密的消息应用联系你，声称掌握一份涉及多平台的数据异常报告。",
                "key_info": "匿名通信；自称安全研究员；拒绝语音/视频；仅通过文字交流。",
                "related_persons": "可能与多个 AI 平台的安全团队有联系，但未确认。",
                "related_commitments": "承诺完成委托后提供独家行业报告作为回报。",
                "risks": "身份不明，动机未知。可能是在利用你收集情报，也可能确实是吹哨人。",
                "extensions": "可以尝试通过通信模式、用词习惯推断其背景。",
            },
        },
        {
            "title": "神秘人的委托",
            "type": "thread",
            "summary": "调查一起跨平台数据异常事件，梳理事件脉络",
            "detail_payload": {
                "summary": "神秘人提供线索：多个 AI 平台近期出现相似的数据泄露痕迹，疑为同一源头。委托你调查并梳理脉络。",
                "key_info": "涉及 3+ 平台；时间跨度约 2 周；数据痕迹高度相似；优先级：高。",
                "related_persons": "神秘人 K（线索提供者）；各平台安全负责人（待接触）。",
                "risks": "调查可能引起平台注意；时间紧迫，线索可能随时消失。",
                "extensions": "可从数据痕迹的技术特征入手，交叉比对各平台日志。",
            },
        },
        {
            "title": "承诺的回报",
            "type": "commitment",
            "summary": "完成委托后，神秘人承诺提供一份独家行业报告",
            "detail_payload": {
                "summary": "K 承诺：完成调查并提交脉络报告后，提供一份涵盖 AI 行业数据安全现状的独家报告。",
                "key_info": "报告内容：AI 平台数据安全审计；预计价值：高；交付方式：加密传输。",
                "related_persons": "K（承诺方）。",
                "related_commitments": "与委托本身构成对价关系。",
                "risks": "承诺可信度未知；报告可能带有偏见或误导；K 可能在调查完成后失联。",
                "extensions": "可以要求 K 先提供报告摘要作为诚意证明。",
            },
        },
        {
            "title": "神秘人的期望",
            "type": "expectation",
            "summary": "3 天内梳理出事件脉络与关键人物关系",
            "detail_payload": {
                "summary": "K 期望你在 3 天内完成调查，产出一份包含时间线、关键人物关系、技术分析的事件脉络报告。",
                "key_info": "时限：3 天（72 小时）；交付物：脉络报告 + 关系图谱；格式：Markdown。",
                "related_persons": "K（期望方）；你（执行方）。",
                "related_commitments": "完成后 K 兑现独家报告承诺。",
                "risks": "时间压力可能导致调查不充分；匆忙产出可能遗漏关键细节。",
                "extensions": "可与 K 协商分阶段交付：先出初步框架，再逐步补充细节。",
            },
        },
        {
            "title": "关键事件：多平台数据泄露",
            "type": "event",
            "summary": "多个 AI 平台同时出现相似的数据泄露痕迹",
            "detail_payload": {
                "summary": "近 2 周内，ChatGPT、DeepSeek、Kimi 等平台先后出现异常的数据访问记录，特征高度相似。",
                "key_info": "首次发现：2 周前；涉及平台：≥3 个；共同特征：非授权 API 调用 + 异常数据导出。",
                "related_persons": "各平台安全团队；可能的攻击者（身份未知）。",
                "related_commitments": "各平台尚未公开承认。",
                "risks": "事件可能比表面更严重；可能涉及国家级 APT 组织。",
                "extensions": "可分析攻击手法（TTP）判断是否同一攻击者。",
            },
        },
        {
            "title": "潜在风险",
            "type": "risk",
            "summary": "调查可能触碰到某些平台的数据安全底线",
            "detail_payload": {
                "summary": "深入调查各平台的数据异常，可能触发平台的安全监控，导致账号被封或法律风险。",
                "key_info": "法律风险：可能违反平台 ToS；账号风险：封号；人身风险：低（但不可忽视）。",
                "related_persons": "平台法务团队（潜在对抗方）。",
                "related_commitments": "K 未提供任何法律保护承诺。",
                "risks": "高风险。建议使用匿名身份与代理网络进行调查。",
                "extensions": "可咨询法律顾问评估合规边界后再行动。",
            },
        },
        {
            "title": "你的决策",
            "type": "decision",
            "summary": "是否接受委托？如何分配调查优先级？",
            "detail_payload": {
                "summary": "决策点：1) 接受/拒绝委托；2) 若接受，优先调查哪个平台；3) 是否要求 K 提供更多保障。",
                "key_info": "选项 A：拒绝（安全优先）；选项 B：接受但要求预付部分报告；选项 C：全盘接受。",
                "related_persons": "K（委托方）；你（决策方）。",
                "related_commitments": "若接受，需在 3 天内交付报告。",
                "risks": "无论接受与否都有风险：拒绝可能错过重要情报；接受可能陷入法律困境。",
                "extensions": "可以先用 24 小时做初步 reconnaissance 再决定。",
            },
        },
        {
            "title": "任务复盘",
            "type": "review",
            "summary": "无论结果如何，复盘调查过程与学到的工作方法",
            "detail_payload": {
                "summary": "任务结束后（无论完成与否），复盘整个过程：调查方法是否高效？信息来源是否可靠？决策是否合理？",
                "key_info": "复盘维度：方法论、信息质量、决策逻辑、时间管理。",
                "related_persons": "自己（复盘人）；K（若仍在联系可获取反馈）。",
                "related_commitments": "复盘记录可作为未来类似任务的参考。",
                "risks": "不复盘则无法从经验中学习，下次遇到类似情况仍会踩坑。",
                "extensions": "可将复盘结论沉淀为 Work 模式的工作方法论节点。",
            },
        },
    ],
    "edges": [
        ("神秘人", "神秘人的委托", "source_of"),
        ("神秘人", "承诺的回报", "committed_to"),
        ("神秘人的委托", "神秘人的期望", "related"),
        ("神秘人的委托", "关键事件：多平台数据泄露", "involves"),
        ("关键事件：多平台数据泄露", "潜在风险", "related"),
        ("潜在风险", "你的决策", "influences"),
        ("神秘人的期望", "你的决策", "related"),
        ("你的决策", "任务复盘", "related"),
        ("承诺的回报", "你的决策", "related"),
    ],
}


async def seed_onboarding_if_empty(store: GraphStore) -> None:
    """数据库无图谱时自动创建新手引导图谱。

    仅当 ``list_graphs("study")`` 与 ``list_graphs("work")`` **都为空**时触发。
    创建两个内置图谱（Study 使用指南 + Work 神秘人委托），各含预设节点与边。

    Args:
        store: GraphStore 单例。
    """
    study_graphs = await store.list_graphs("study")
    work_graphs = await store.list_graphs("work")
    if study_graphs or work_graphs:
        # 已有图谱，不重复注入
        return

    logger.info("首次启动：开始创建新手引导图谱…")

    # === Study 图谱 ===
    study_graph = await store.create_graph(
        name=STUDY_ONBOARDING["name"], graph_type="study"
    )
    study_graph_id = study_graph["id"]
    study_title_to_id: dict[str, str] = {}
    for node_data in STUDY_ONBOARDING["nodes"]:
        node = await store.create_node(
            graph_id=study_graph_id,
            node_type="general",
            title=node_data["title"],
            summary=node_data["summary"],
            detail_payload=node_data["detail_payload"],
            source="user",
        )
        study_title_to_id[node_data["title"]] = node["id"]
    for src_title, dst_title, relation in STUDY_ONBOARDING["edges"]:
        await store.create_edge(
            graph_id=study_graph_id,
            src_id=study_title_to_id[src_title],
            dst_id=study_title_to_id[dst_title],
            relation=relation,
        )
    logger.info(
        "Study 引导图谱已创建: id=%s, nodes=%d, edges=%d",
        study_graph_id,
        len(STUDY_ONBOARDING["nodes"]),
        len(STUDY_ONBOARDING["edges"]),
    )

    # === Work 图谱 ===
    work_graph = await store.create_graph(
        name=WORK_ONBOARDING["name"], graph_type="work"
    )
    work_graph_id = work_graph["id"]
    work_title_to_id: dict[str, str] = {}
    for node_data in WORK_ONBOARDING["nodes"]:
        node = await store.create_node(
            graph_id=work_graph_id,
            node_type=node_data["type"],
            title=node_data["title"],
            summary=node_data["summary"],
            detail_payload=node_data["detail_payload"],
            source="user",
        )
        work_title_to_id[node_data["title"]] = node["id"]
    for src_title, dst_title, relation in WORK_ONBOARDING["edges"]:
        await store.create_edge(
            graph_id=work_graph_id,
            src_id=work_title_to_id[src_title],
            dst_id=work_title_to_id[dst_title],
            relation=relation,
        )
    logger.info(
        "Work 引导图谱已创建: id=%s, nodes=%d, edges=%d",
        work_graph_id,
        len(WORK_ONBOARDING["nodes"]),
        len(WORK_ONBOARDING["edges"]),
    )

    logger.info("新手引导图谱创建完成。")
