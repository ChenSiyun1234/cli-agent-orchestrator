import { BarChart3 } from 'lucide-react'
import type { WorkflowEvent } from '../../api'
import type { TaskProjection } from './taskModel'
import { observedDirectDurations, observedStepDurations } from './taskModel'

export function EvidenceChart({ events, task }: { events: WorkflowEvent[]; task?: TaskProjection }) {
  const workflowRows = observedStepDurations(events)
  const directRows = task ? observedDirectDurations(task) : []
  const rows = task?.direct ? directRows : workflowRows
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/35 px-5 py-8 text-center">
        <BarChart3 size={24} className="mx-auto mb-2 text-slate-600" aria-hidden="true" />
        <p className="text-sm text-slate-400">没有可绘制的数值型证据</p>
        <p className="mt-1 text-xs text-slate-600">CAO 尚未记录完整的起止时间；不会用估计值补图。</p>
      </div>
    )
  }

  const max = Math.max(...rows.map(row => row.durationMs), 1)
  const width = 720
  const labelWidth = 150
  const chartWidth = width - labelWidth - 80
  const rowHeight = 42
  const height = 46 + rows.length * rowHeight

  return (
    <figure className="rounded-xl border border-slate-700/70 bg-slate-950/55 p-4 overflow-x-auto">
      <figcaption className="mb-3">
        <p className="text-sm font-semibold text-slate-200">步骤耗时证据图</p>
        <p className="text-[11px] text-slate-500">数值直接来自{task?.direct ? '持久 inbox 生命周期时间戳' : '工作流事件 elapsed_ms'}；单位：毫秒。</p>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="min-w-[620px] w-full"
        role="img"
        aria-label="步骤耗时证据图"
      >
        <line x1={labelWidth} y1={18} x2={labelWidth} y2={height - 24} stroke="#475569" strokeWidth="1" />
        {[0, 0.25, 0.5, 0.75, 1].map(mark => {
          const x = labelWidth + chartWidth * mark
          return (
            <g key={mark}>
              <line x1={x} y1={18} x2={x} y2={height - 24} stroke="#1e293b" strokeWidth="1" />
              <text x={x} y={height - 7} fill="#64748b" fontSize="10" textAnchor="middle">
                {Math.round(max * mark).toLocaleString()}
              </text>
            </g>
          )
        })}
        {rows.map((row, index) => {
          const y = 26 + index * rowHeight
          const barWidth = Math.max(2, (row.durationMs / max) * chartWidth)
          return (
            <g key={row.step}>
              <text x={labelWidth - 10} y={y + 16} fill="#cbd5e1" fontSize="11" textAnchor="end">
                {row.step.length > 21 ? `${row.step.slice(0, 20)}…` : row.step}
              </text>
              <rect x={labelWidth} y={y} width={barWidth} height="22" rx="4" fill="#10b981" opacity="0.78" />
              <text x={Math.min(labelWidth + barWidth + 8, width - 72)} y={y + 15} fill="#d1fae5" fontSize="10">
                {row.durationMs.toLocaleString()} ms
              </text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
