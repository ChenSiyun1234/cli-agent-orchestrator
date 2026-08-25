import { useMemo, useState } from 'react'
import { CircleStop, ExternalLink, MessageSquareMore, MonitorUp, PauseCircle, Send, SquareTerminal } from 'lucide-react'
import { api } from '../../api'
import type { HydratedTerminal, TaskProjection } from './taskModel'
import { normalizeState, workerDisplayName, workerLaunchObservation, workerSessionUse } from './taskModel'

interface WorkerBoardProps {
  task: TaskProjection
  workers: HydratedTerminal[]
  controllableIds: Set<string>
  onOpenTerminal: (worker: HydratedTerminal) => void
  onChanged: () => void
  notify: (type: 'success' | 'error' | 'info', message: string) => void
}

const STATUS_ZH: Record<string, string> = {
  processing: '正在工作',
  idle: '可接收指令',
  waiting_user_answer: '等待人工回答',
  quiet_running: '安静运行中',
  handoff_missing: '本轮停止，但回报未登记',
  returned: '已返回，待审核',
  disconnected: '终端已断开',
  error: '发生错误',
  completed: '本轮已结束',
  unknown: '状态未观测',
}

const STATUS_DOT: Record<string, string> = {
  processing: 'bg-sky-400 animate-pulse',
  idle: 'bg-emerald-400',
  waiting_user_answer: 'bg-amber-400 animate-pulse',
  error: 'bg-rose-400',
  completed: 'bg-violet-400',
  unknown: 'bg-slate-600',
}

function friendlyRole(worker: HydratedTerminal, task: TaskProjection): string {
  const text = `${worker.provider} ${worker.agent_profile || ''}`.toLowerCase()
  const name = workerDisplayName(worker, task)
  if (text.includes('claude') || text.includes('implement')) return `${name} · Claude 实现者`
  if (text.includes('codex') || text.includes('architect')) return `${name} · Codex 架构师 / 审核者`
  return name || worker.provider || '智能体'
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '未观测'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function observedWorkerTimes(worker: HydratedTerminal, task: TaskProjection) {
  if (task.direct) {
    const assignments = task.direct.assignmentMessages.filter(message => (
      message.sender_id === worker.id || message.receiver_id === worker.id
    ))
    const returns = task.direct.returnMessages.filter(message => (
      message.sender_id === worker.id || message.receiver_id === worker.id
    ))
    const isArchitect = task.direct.architectIds.includes(worker.id)
    const latestReturn = returns[returns.length - 1]
    return {
      created: worker.created_at || null,
      assigned: assignments[0]?.created_at || null,
      received: isArchitect ? latestReturn?.created_at || null : assignments[0]?.delivered_at || null,
      started: isArchitect ? null : assignments[0]?.started_at || null,
      returned: latestReturn?.created_at || null,
      reviewed: task.direct.reviewedAt,
      historical: task.direct.binding === 'historical-inference',
    }
  }
  const events = task.evidence?.timeline.events || []
  const own = events.filter(event => event.terminal_id === worker.id)
  const assigned = own.find(event => /assignment\.sent|task\.assigned|task\.dispatched|message\.(queued|sent)/i.test(event.event_type))
  const received = own.find(event => /assignment\.received|task\.received|message\.delivered/i.test(event.event_type))
  const started = own.find(event => /start|running|processing/i.test(`${event.event_type} ${event.state || ''}`))
  const returned = [...own].reverse().find(event => /complete|return|finish/i.test(`${event.event_type} ${event.state || ''}`))
  const review = [...own].reverse().find(event => /review|approve|audit/i.test(`${event.step_id || ''} ${event.event_type}`))
  return {
    created: worker.created_at || null,
    assigned: assigned?.ts || null,
    received: received?.ts || null,
    started: started?.ts || null,
    returned: returned?.ts || null,
    reviewed: task.reviewVerdict ? review?.ts || null : null,
    historical: false,
  }
}

function WorkerCard({
  worker,
  task,
  onOpenTerminal,
  onChanged,
  notify,
  controlsEnabled,
}: {
  worker: HydratedTerminal
  task: TaskProjection
  onOpenTerminal: (worker: HydratedTerminal) => void
  onChanged: () => void
  notify: WorkerBoardProps['notify']
  controlsEnabled: boolean
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const status = normalizeState(worker.status)
  const times = observedWorkerTimes(worker, task)
  const launch = workerLaunchObservation(worker, task)
  const sessionUse = workerSessionUse(worker, task)
  const directTaskId = task.direct?.assignmentMessages[0]?.task_id || null
  // Inbox provenance is immutable evidence. If CAO did not record caller_id,
  // disable queued delivery instead of inventing an architect relationship.
  const senderId = worker.caller_id || null

  const runAction = async (name: string, action: () => Promise<unknown>, success: string) => {
    setBusy(name)
    try {
      await action()
      notify('success', success)
      setMessage('')
      onChanged()
    } catch (error: any) {
      notify('error', error?.detail || error?.message || '操作失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="relative rounded-2xl border border-slate-700/70 bg-slate-950/55 p-4 shadow-[0_16px_50px_rgba(2,6,23,0.16)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[status] || STATUS_DOT.unknown}`} />
            <h4 className="font-semibold text-white">{friendlyRole(worker, task)}</h4>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">
              {STATUS_ZH[status] || STATUS_ZH.unknown}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span className="font-mono">终端 {worker.id}</span>
            <span>{worker.provider}</span>
            <span>{worker.agent_profile || '未设置 Profile'}</span>
            <span>上游：{worker.caller_id || '未观测'}</span>
            <span>
              模型：{launch.model.value || '未观测'}
              {launch.model.source !== 'unobserved' ? `（${launch.model.source === 'observed' ? '已观测' : '计划'}）` : ''}
            </span>
            <span>
              推理：{launch.reasoningEffort.value || '未观测'}
              {launch.reasoningEffort.source !== 'unobserved' ? `（${launch.reasoningEffort.source === 'observed' ? '已观测' : '计划'}）` : ''}
            </span>
            <span>
              会话：{sessionUse === 'reused' ? '复用会话（时间证据）' : sessionUse === 'new' ? '本任务新建（时间证据）' : '未观测'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!controlsEnabled}
            onClick={() => controlsEnabled && onOpenTerminal(worker)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
            title={controlsEnabled ? '打开与真实 tmux pane 双向连接的原生 PTY' : '历史或非当前终端默认只读，避免误操作后来复用该终端的任务'}
          >
            <MonitorUp size={13} /> 打开原生终端
          </button>
          {controlsEnabled ? (
            <a
              href={`unidlq-cao://terminal/${worker.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white"
              title="通过本机协议处理器附加到同一个 tmux 窗口"
            >
              <ExternalLink size={13} /> 用 Windows Terminal 打开
            </a>
          ) : (
            <span className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs text-slate-600" title="历史引用不开放当前终端控制">
              <ExternalLink size={13} /> Windows Terminal 已禁用
            </span>
          )}
          <button
            type="button"
            disabled={!controlsEnabled || busy !== null}
            onClick={() => runAction('interrupt', () => api.sendKey(worker.id, 'C-c'), '已向真实终端发送 Ctrl+C')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-950/25 px-3 py-1.5 text-xs text-rose-200 transition hover:bg-rose-900/35 disabled:opacity-50"
            title="只打断当前前台命令；随后请查看终端确认子进程是否退出"
          >
            <CircleStop size={13} /> 打断当前命令
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {[
          ['终端创建', times.created],
          ['明确派发事件', times.assigned],
          ['明确接收事件', times.received],
          ['开始执行', times.started],
          ['返回结果', times.returned],
          ['审核完成', times.reviewed],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg border border-slate-800 bg-slate-900/65 px-2.5 py-2">
            <p className="text-[10px] text-slate-600">{label}</p>
            <p className={`mt-1 text-[11px] ${value ? 'text-slate-300' : 'text-slate-600'}`}>
              {formatTime(value as string | null)}
              {value && times.historical && !['终端创建', '明确派发事件'].includes(label as string) ? <span className="ml-1 text-amber-500">历史推定</span> : null}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/45 p-3">
        <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
          <MessageSquareMore size={13} /> 实时修改这个智能体的工作
        </div>
        <textarea
          value={message}
          onChange={event => setMessage(event.target.value)}
          rows={2}
          disabled={!controlsEnabled}
          placeholder="用英文写内部补充指令；界面只负责原样送达，不替你改写。"
          className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-700 focus:border-emerald-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!controlsEnabled || !message.trim() || busy !== null}
            onClick={() => runAction('send', () => api.sendInput(worker.id, message.trim()), '补充指令已立即送入终端')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs text-white transition hover:bg-sky-500 disabled:opacity-40"
          >
            <Send size={12} /> 立即补充指令
          </button>
          <button
            type="button"
            disabled={!controlsEnabled || !message.trim() || !senderId || busy !== null}
            onClick={() => senderId && runAction(
              'queue',
              () => directTaskId
                ? api.sendInboxMessage(worker.id, senderId, message.trim(), { taskId: directTaskId })
                : api.sendInboxMessage(worker.id, senderId, message.trim()),
              '修改已排队，将在智能体空闲后送达',
            )}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-950/20 px-3 py-1.5 text-xs text-amber-200 transition hover:bg-amber-900/30 disabled:opacity-40"
            title={senderId ? `发送者：${senderId}` : '未观察到可用的上游终端，不能伪造发送者'}
          >
            <PauseCircle size={12} /> 排队修改后续任务
          </button>
          <span className="text-[10px] text-slate-600">
            {!controlsEnabled ? '历史或非当前终端默认只读；请从当前实时任务进入控制' : senderId ? `排队发送者 ${senderId}` : '排队功能不可用：上游终端未观测'}
          </span>
        </div>
      </div>
    </article>
  )
}

export function WorkerBoard(props: WorkerBoardProps) {
  const ordered = useMemo(() => {
    const ids = new Set(props.workers.map(worker => worker.id))
    return [...props.workers].sort((a, b) => {
      const aRoot = !a.caller_id || !ids.has(a.caller_id) ? 0 : 1
      const bRoot = !b.caller_id || !ids.has(b.caller_id) ? 0 : 1
      return aRoot - bRoot || Date.parse(a.created_at || '') - Date.parse(b.created_at || '')
    })
  }, [props.workers])

  return (
    <section aria-label="智能体实时泳道" className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">智能体实时泳道</h3>
          <p className="mt-1 text-xs text-slate-500">每个 Claude / Codex 终端单独显示；按钮直接作用于真实 tmux 终端。</p>
        </div>
        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] text-slate-400">{ordered.length} 个终端</span>
      </div>
      {ordered.length ? (
        <div className="relative space-y-3 before:absolute before:bottom-5 before:left-[9px] before:top-5 before:w-px before:bg-slate-700">
          {ordered.map(worker => (
            <div key={worker.id} className="relative pl-6 before:absolute before:left-[6px] before:top-7 before:h-2 before:w-2 before:rounded-full before:bg-cyan-400 before:ring-4 before:ring-slate-900">
              <WorkerCard worker={worker} task={props.task} onOpenTerminal={props.onOpenTerminal} onChanged={props.onChanged} notify={props.notify} controlsEnabled={props.controllableIds.has(worker.id)} />
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-8 text-center">
          <SquareTerminal size={22} className="mx-auto mb-2 text-slate-600" />
          <p className="text-sm text-slate-400">没有观察到与此任务绑定的实时终端</p>
          <p className="mt-1 text-xs text-slate-600">不会把同一 Session 中无关联的终端强行归入该任务。</p>
        </div>
      )}
    </section>
  )
}
