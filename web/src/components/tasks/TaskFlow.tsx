import { AlertTriangle, Check, CircleDashed, Clock3, GitBranch, Loader2, X } from 'lucide-react'
import type { TaskProjection } from './taskModel'
import { deriveStages } from './taskModel'

function formatTime(value: string | null): string {
  if (!value) return '未观测'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

const STAGE_STYLE = {
  observed: { ring: 'border-emerald-500/60 bg-emerald-950/35', icon: Check, iconClass: 'text-emerald-300' },
  active: { ring: 'border-sky-500/60 bg-sky-950/35', icon: Loader2, iconClass: 'text-sky-300 animate-spin' },
  failed: { ring: 'border-rose-500/60 bg-rose-950/35', icon: X, iconClass: 'text-rose-300' },
  unobserved: { ring: 'border-slate-700 bg-slate-950/35', icon: CircleDashed, iconClass: 'text-slate-600' },
}

function StepCard({ id, state, attempts, terminalId }: { id: string; state: string; attempts: number; terminalId?: string | null }) {
  const normalized = state.toLowerCase()
  const tone = normalized.includes('fail') || normalized.includes('error')
    ? 'border-rose-500/45 bg-rose-950/25'
    : normalized.includes('complete')
      ? 'border-emerald-500/45 bg-emerald-950/25'
      : 'border-sky-500/45 bg-sky-950/25'
  return (
    <div className={`min-w-[185px] rounded-xl border px-4 py-3 ${tone}`}>
      <div className="flex items-center gap-2">
        <GitBranch size={13} className="text-slate-400" aria-hidden="true" />
        <span className="truncate text-sm font-semibold text-slate-200">{id}</span>
      </div>
      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex justify-between gap-3"><dt className="text-slate-500">状态</dt><dd className="text-slate-300">{state}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-slate-500">尝试</dt><dd className="text-slate-300">{attempts}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-slate-500">终端</dt><dd className="font-mono text-slate-400">{terminalId ? terminalId.slice(0, 8) : '未观测'}</dd></div>
      </dl>
    </div>
  )
}

export function TaskFlow({ task }: { task: TaskProjection }) {
  const stages = deriveStages(task)
  const steps = task.evidence?.inspection?.steps || []

  return (
    <div className="space-y-5">
      <section aria-label="任务阶段流程图" className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">从下达任务到最终汇报</h3>
            <p className="mt-1 text-xs text-slate-500">每一格都来自当前可观察证据；缺失信息明确显示“未观测”。</p>
          </div>
          <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] text-slate-400">
            {task.kind === 'workflow' ? '持久工作流' : task.kind === 'direct' ? '持久直接任务' : '临时实时工作'}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
          {stages.map((stage, index) => {
            const style = STAGE_STYLE[stage.state]
            const Icon = style.icon
            return (
              <div key={stage.key} className="relative flex min-w-0 items-stretch">
                <div className={`w-full rounded-xl border p-3 ${style.ring}`}>
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-950/60">
                      <Icon size={13} className={style.iconClass} aria-hidden="true" />
                    </span>
                    <span className="text-xs font-semibold text-slate-200">{stage.label}</span>
                  </div>
                  <p className="mt-2 min-h-8 text-[11px] leading-4 text-slate-400">{stage.detail}</p>
                  <p className="mt-2 flex items-center gap-1 text-[10px] text-slate-600" title={stage.timestamp || undefined}>
                    <Clock3 size={10} aria-hidden="true" /> {formatTime(stage.timestamp)}
                  </p>
                </div>
                {index < stages.length - 1 && (
                  <span className="absolute -right-2 top-1/2 z-10 hidden -translate-y-1/2 text-slate-600 md:block">›</span>
                )}
              </div>
            )
          })}
        </div>
      </section>

      <section aria-label="原生工作流步骤" className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <GitBranch size={15} className="text-cyan-300" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-white">{task.direct ? 'CAO 直接任务消息链' : 'CAO 原生步骤'}</h3>
          <span className="text-[10px] text-slate-500">执行顺序以持久记录为准</span>
        </div>
        {task.direct ? (
          <div className="flex items-stretch gap-2 overflow-x-auto pb-2">
            {task.direct.messages.map((message, index) => {
              const isAssignment = task.direct?.assignmentMessages.some(item => String(item.id) === String(message.id))
              const isReturn = task.direct?.returnMessages.some(item => String(item.id) === String(message.id))
              const label = isAssignment ? '任务派发' : message.review_verdict ? `审核 ${message.review_verdict}` : isReturn ? '实现者回报' : '任务补充'
              return (
                <div key={String(message.id)} className="flex items-center gap-2">
                  <div className="min-w-[205px] rounded-xl border border-cyan-500/35 bg-cyan-950/20 px-4 py-3">
                    <p className="text-xs font-semibold text-slate-200">{label}</p>
                    <p className="mt-2 font-mono text-[10px] text-slate-500">{message.sender_id} → {message.receiver_id}</p>
                    <p className="mt-1 text-[10px] text-slate-600">{formatTime(message.created_at)}</p>
                  </div>
                  {index < (task.direct?.messages.length || 0) - 1 && <span className="text-xl text-slate-600">→</span>}
                </div>
              )
            })}
          </div>
        ) : steps.length ? (
          <div className="flex items-stretch gap-2 overflow-x-auto pb-2">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center gap-2">
                <StepCard id={step.id} state={step.state} attempts={step.attempts} terminalId={step.terminal_id} />
                {index < steps.length - 1 && <span className="text-xl text-slate-600">→</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-7 text-center">
            <AlertTriangle size={20} className="mx-auto mb-2 text-amber-400/70" aria-hidden="true" />
            <p className="text-sm text-slate-400">未观察到持久步骤记录</p>
            <p className="mt-1 text-xs text-slate-600">这通常表示它是直接派发的实时工作，或旧运行没有完整日志。</p>
          </div>
        )}
      </section>
    </div>
  )
}
