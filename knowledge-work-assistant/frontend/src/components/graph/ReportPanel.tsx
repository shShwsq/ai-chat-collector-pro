/**
 * Work 工作报告生成面板（Task 15）。
 *
 * 从内容区右侧滑入的浮层，承载报告生成 / 预览 / 导出 / 打印流程：
 *
 *   ① **配置与生成**：选择报告周期（weekly 周报 / monthly 月报），
 *      点「生成报告」调 ``store.generateReport`` → Agent 基于当前 work 图谱
 *      生成结构化 Markdown 报告（进展 / 下周计划 / 风险 / 承诺跟进）。
 *
 *   ② **HTML 预览**：把 Markdown 渲染为 HTML 展示在面板内，支持
 *      标题 / 列表 / 段落 / 加粗等基础语法；降级报告显示橙色提示条。
 *
 *   ③ **导出 .docx**：点「导出 Word」调 ``store.exportReportDocx``，
 *      后端用 python-docx 生成 .docx 文件流并触发浏览器下载。
 *
 *   ④ **打印为 PDF**：点「打印 / PDF」打开新窗口写入报告 HTML，
 *      调用浏览器原生打印对话框（用户可选「另存为 PDF」）。
 *
 * 数据流：
 * - 报告结果缓存在 ``store.reportResult``，切换周期后需重新生成。
 * - 导出依赖已生成的 Markdown（后端 export-docx 接口内部会重新生成，
 *   与前端 reportResult 保持一致即可）。
 *
 * 交互：
 * - 面板由 ``store.workActivePanel === 'report'`` 控制显隐。
 * - 生成 / 导出进行中显示加载态并禁用按钮。
 * - 降级（``degraded``）时显示提示，报告仍可预览与导出（含结构化骨架）。
 */

import { useMemo } from 'react'

import { Icon } from '../Icon'
import { useAppStore } from '../../store/useAppStore'
import type { ReportPeriod } from '../../lib/types'

/** 周期显示名映射。 */
const PERIOD_LABELS: Record<ReportPeriod, string> = {
  weekly: '周报',
  monthly: '月报',
}

/**
 * 轻量 Markdown → HTML 渲染（无需引入第三方库）。
 *
 * 支持：# / ## / ### 标题、- / * 无序列表、1. 有序列表、
 * 空行分段、**加粗**、行内 `code`。
 * 不支持的语法原样输出为段落文本，保证降级报告也能展示。
 */
function renderMarkdown(md: string): string {
  if (!md) return '<p class="report-empty">（报告内容为空）</p>'
  const lines = md.split(/\r?\n/)
  const html: string[] = []
  let inUl = false
  let inOl = false

  const closeLists = () => {
    if (inUl) {
      html.push('</ul>')
      inUl = false
    }
    if (inOl) {
      html.push('</ol>')
      inOl = false
    }
  }

  const inline = (text: string): string => {
    // 转义 HTML 特殊字符
    let s = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    // 加粗 **text**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // 行内代码 `code`
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
    return s
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      closeLists()
      continue
    }
    // 标题
    let m: RegExpMatchArray | null
    if ((m = /^###\s+(.+)$/.exec(line))) {
      closeLists()
      html.push(`<h3>${inline(m[1])}</h3>`)
    } else if ((m = /^##\s+(.+)$/.exec(line))) {
      closeLists()
      html.push(`<h2>${inline(m[1])}</h2>`)
    } else if ((m = /^#\s+(.+)$/.exec(line))) {
      closeLists()
      html.push(`<h1>${inline(m[1])}</h1>`)
    } else if ((m = /^\s*[-*]\s+(.+)$/.exec(line))) {
      // 无序列表
      if (!inUl) {
        closeLists()
        html.push('<ul>')
        inUl = true
      }
      html.push(`<li>${inline(m[1])}</li>`)
    } else if ((m = /^\s*\d+\.\s+(.+)$/.exec(line))) {
      // 有序列表
      if (!inOl) {
        closeLists()
        html.push('<ol>')
        inOl = true
      }
      html.push(`<li>${inline(m[1])}</li>`)
    } else {
      // 普通段落
      closeLists()
      html.push(`<p>${inline(line)}</p>`)
    }
  }
  closeLists()
  return html.join('\n')
}

export function ReportPanel() {
  const open = useAppStore((s) => s.workActivePanel === 'report')
  const setWorkPanel = useAppStore((s) => s.setWorkPanel)
  const reportPeriod = useAppStore((s) => s.reportPeriod)
  const reportResult = useAppStore((s) => s.reportResult)
  const reportGenerating = useAppStore((s) => s.reportGenerating)
  const reportExporting = useAppStore((s) => s.reportExporting)
  const setReportPeriod = useAppStore((s) => s.setReportPeriod)
  const generateReport = useAppStore((s) => s.generateReport)
  const exportReportDocx = useAppStore((s) => s.exportReportDocx)
  const currentGraphId = useAppStore((s) => s.currentGraphId)

  // 渲染 Markdown 为 HTML（仅在报告结果变化时重算）
  const reportHtml = useMemo(
    () => (reportResult ? renderMarkdown(reportResult.markdown) : ''),
    [reportResult],
  )

  if (!open) return null

  const handleClose = () => setWorkPanel('none')

  const handleGenerate = async () => {
    if (reportGenerating) return
    await generateReport()
  }

  const handleExport = async () => {
    if (reportExporting) return
    await exportReportDocx()
  }

  const handlePrint = () => {
    if (!reportResult) return
    // 打开新窗口写入报告 HTML，调用浏览器打印
    const win = window.open('', '_blank', 'width=820,height=900')
    if (!win) {
      // 弹窗被拦截：回退到当前窗口打印
      window.print()
      return
    }
    const periodLabel = PERIOD_LABELS[reportResult.period as ReportPeriod] ?? reportResult.period
    win.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>工作${periodLabel}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.7; color: #1d1d1f; max-width: 760px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 22px; border-bottom: 2px solid #b45309; padding-bottom: 8px; }
  h2 { font-size: 18px; margin-top: 28px; color: #b45309; }
  h3 { font-size: 15px; margin-top: 20px; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
  code { background: #f5f5f7; padding: 1px 6px; border-radius: 4px; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 0.9em; }
  strong { color: #1d1d1f; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
${reportHtml}
</body>
</html>`)
    win.document.close()
    // 等待内容渲染后触发打印
    win.focus()
    setTimeout(() => {
      win.print()
    }, 300)
  }

  const periods: ReportPeriod[] = ['weekly', 'monthly']

  return (
    <>
      {/* 遮罩：点击关闭面板 */}
      <div
        className="work-panel-overlay"
        onClick={handleClose}
        aria-hidden="true"
      />

      <aside
        className="work-panel report-panel"
        role="dialog"
        aria-label="工作报告生成"
        aria-modal="false"
      >
        {/* 头部 */}
        <header className="work-panel__header">
          <div className="work-panel__title-row">
            <h2 className="work-panel__title">工作报告</h2>
            <button
              type="button"
              className="work-panel__close"
              onClick={handleClose}
              aria-label="关闭面板"
              title="关闭"
            >
              ×
            </button>
          </div>
          <p className="work-panel__subtitle">
            基于当前 work 图谱生成结构化报告（进展 / 计划 / 风险 / 承诺跟进），
            可预览、导出 Word 或打印为 PDF。
          </p>
        </header>

        {/* 主体（可滚动） */}
        <div className="work-panel__body">
          {/* 配置区：周期选择 + 生成按钮 */}
          <section className="work-section">
            <div className="work-field">
              <label className="work-field__label">报告周期</label>
              <div className="report-period-toggle" role="radiogroup">
                {periods.map((p) => {
                  const active = reportPeriod === p
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`report-period-toggle__btn${active ? ' is-active' : ''}`}
                      onClick={() => setReportPeriod(p)}
                      disabled={reportGenerating}
                    >
                      {PERIOD_LABELS[p]}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="work-actions">
              <button
                type="button"
                className="work-actions__btn work-actions__btn--primary"
                onClick={handleGenerate}
                disabled={reportGenerating || !currentGraphId}
                title={
                  !currentGraphId
                    ? '请先选中一个 work 图谱'
                    : reportGenerating
                      ? '正在生成…'
                      : '生成工作报告'
                }
              >
                {reportGenerating ? '生成中…' : '生成报告'}
              </button>
            </div>
          </section>

          {/* 报告预览 */}
          {reportResult && (
            <section className="work-section report-preview-section">
              <div className="work-section__head">
                <h3 className="work-section__title">
                  报告预览 · {PERIOD_LABELS[reportResult.period as ReportPeriod] ?? reportResult.period}
                </h3>
                <div className="report-export-actions">
                  <button
                    type="button"
                    className="work-actions__btn work-actions__btn--ghost report-export-btn"
                    onClick={handleExport}
                    disabled={reportExporting || reportGenerating}
                    title="导出为 .docx 文件"
                  >
                    {reportExporting ? '导出中…' : '⬇ 导出 Word'}
                  </button>
                  <button
                    type="button"
                    className="work-actions__btn work-actions__btn--ghost report-export-btn"
                    onClick={handlePrint}
                    disabled={reportGenerating}
                    title="打印或另存为 PDF"
                  >
                    ⎙ 打印 / PDF
                  </button>
                </div>
              </div>

              {reportResult.degraded && (
                <div className="report-degraded-tip" role="status">
                  <strong>降级提示：</strong>
                  {reportResult.degrade_reason ||
                    'AI 服务不可用，已生成结构化骨架报告，可预览与导出。'}
                </div>
              )}

              {/* 结构化分段速览（折叠式，便于快速跳转） */}
              {(reportResult.sections.progress.length > 0 ||
                reportResult.sections.plan.length > 0 ||
                reportResult.sections.risks.length > 0 ||
                reportResult.sections.commitments.length > 0) && (
                <div className="report-sections-grid">
                  <ReportSectionBlock
                    title="进展"
                    items={reportResult.sections.progress}
                  />
                  <ReportSectionBlock
                    title="计划"
                    items={reportResult.sections.plan}
                  />
                  <ReportSectionBlock
                    title="风险"
                    items={reportResult.sections.risks}
                  />
                  <ReportSectionBlock
                    title="承诺跟进"
                    items={reportResult.sections.commitments}
                  />
                </div>
              )}

              {/* Markdown 渲染为 HTML */}
              <div
                className="report-preview"
                dangerouslySetInnerHTML={{ __html: reportHtml }}
              />
            </section>
          )}

          {/* 未生成报告时的空状态 */}
          {!reportResult && (
            <div className="work-empty">
              {reportGenerating
                ? '正在生成工作报告…'
                : currentGraphId
                  ? '暂无报告。选择周期后点「生成报告」基于当前图谱生成。'
                  : (<><Icon name="warning" size={16} /> 请先在左侧选中一个 work 图谱</>)}
            </div>
          )}
        </div>

        {/* 底部状态条 */}
        <footer className="work-panel__footer">
          <span className="work-panel__footer-text">
            {currentGraphId
              ? '报告基于图谱中的工作对象（线索/承诺/风险等）综合生成'
              : (<><Icon name="warning" size={14} /> 未选中图谱，请先在左侧选择一个 work 图谱</>)}
          </span>
        </footer>
      </aside>
    </>
  )
}

// ============================================================================
// 结构化分段速览子组件
// ============================================================================

interface ReportSectionBlockProps {
  title: string
  items: string[]
}

function ReportSectionBlock({ title, items }: ReportSectionBlockProps) {
  if (items.length === 0) return null
  return (
    <div className="report-section-block">
      <h5 className="report-section-block__title">{title}</h5>
      <ul className="report-section-block__list">
        {items.map((item, i) => (
          <li key={i} className="report-section-block__item">
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}
