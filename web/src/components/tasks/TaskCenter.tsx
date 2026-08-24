import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpenCheck,
  Bot,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  Clock3,
  FileClock,
  GitPullRequestArrow,
  ListFilter,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  DiagnosticBundle,
  EventTimelinePage,
  InboxMessage,
  MemorySummary,
  RunInspection,
  RunSummaryRow,
  TerminalMeta,
  WorkflowRunResult,
} from '../../api'
import { api } from '../../api'
import { useStore } from '../../store'
import { TerminalView } from '../TerminalView'
import { TaskFlow } from './TaskFlow'
import { TaskMemoryMap, TaskReportView } from './TaskEvidence'
import { WorkerBoard } from './WorkerBoard'
import {
  buildTaskProjections,
  inboxEvidenceForTask,
  mergeTerminal,
  normalizeState,
  parseDiagnosticInputs,
  type HydratedTerminal,
  type TaskProjection,
  type WorkflowEvidence,
} from './taskModel'

type DetailTab = 'flow' | 'memory' | 'report'
type TaskFilter = 'all' | 'active' | 'review' | 'direct'

const EMPTY_TIMELINE: EventTimelinePage = { events: [], gaps: [], next_after_seq: null }
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])
const ACTIVE_TASK_STATES = new Set(['running', 'processing', 'quiet_running', 'waiting_user_answer', 'queued'])

const STATE_LABEL: Record<string, string> = {
  running: '正在推进',
  processing: '正在工作',
  idle: '等待 / 可继续',
  waiting_user_answer: '等待你的回答',
  queued: '等待送达',
  quiet_running: '安静运行中',
  returned: '已返回，待审核',
  historical_unresolved: '历史记录未闭环',
  disconnected: '终端已断开',
  completed: '运行已完成',
  failed: '运行失败',
  error: '发生错误',
  cancelled: '已暂停 / 取消',
  unknown: '状态未观测',
}

const STATE_TONE: Record<string, string> = {
  running: 'border-sky-500/40 bg-sky-950/45 text-sky-300',
  processing: 'border-sky-500/40 bg-sky-950/45 text-sky-300',
  idle: 'border-emerald-500/40 bg-emerald-950/35 text-emerald-300',
  waiting_user_answer: 'border-amber-500/40 bg-amber-950/40 text-amber-300',
  queued: 'border-slate-600 bg-slate-900 text-slate-400',
  quiet_running: 'border-cyan-500/40 bg-cyan-950/35 text-cyan-300',
  returned: 'border-amber-500/40 bg-amber-950/35 text-amber-300',
  historical_unresolved: 'border-slate-700 bg-slate-900 text-slate-500',
  disconnected: 'border-rose-500/40 bg-rose-950/35 text-rose-300',
  completed: 'border-violet-500/40 bg-violet-950/35 text-violet-300',
  failed: 'border-rose-500/40 bg-rose-950/35 text-rose-300',
  error: 'border-rose-500/40 bg-rose-950/35 text-rose-300',
  cancelled: 'border-slate-600 bg-slate-800/60 text-slate-300',
  unknown: 'border-slate-700 bg-slate-900 text-slate-500',
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '未观测'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function relativeTime(value: string | null): string {
  if (!value) return '未观测'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function TaskStateBadge({ state }: { state: string }) {
  const normalized = normalizeState(state)
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium ${STATE_TONE[normalized] || STATE_TONE.unknown}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${['running', 'processing', 'waiting_user_answer'].includes(normalized) ? 'animate-pulse bg-current' : 'bg-current'}`} />
      {STATE_LABEL[normalized] || STATE_LABEL.unknown}
    </span>
  )
}

function receiptEvidence(
  inspection: RunInspection | null,
  timeline: EventTimelinePage,
  previous?: WorkflowEvidence,
): WorkflowEvidence {
  return {
    inspection,
    timeline,
    diagnostics: previous?.diagnostics || null,
    result: previous?.result || null,
  }
}

function TaskListCard({ task, selected, onSelect }: { task: TaskProjection; selected: boolean; onSelect: () => void }) {
  const last = task.finishedAt || task.workers[0]?.last_active || task.startedAt
  const needsReview = (task.state === 'completed' || task.state === 'returned') && !task.reviewVerdict
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={`w-full rounded-xl border p-3 text-left transition ${
        selected
          ? 'border-emerald-500/55 bg-emerald-950/25 shadow-[0_0_0_1px_rgba(16,185,129,.08)]'
          : 'border-slate-800 bg-slate-950/35 hover:border-slate-700 hover:bg-slate-900/70'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${task.kind === 'workflow' ? 'bg-cyan-950 text-cyan-300' : task.kind === 'direct' ? 'bg-emerald-950 text-emerald-300' : 'bg-violet-950 text-violet-300'}`}>
          {task.kind === 'workflow' ? <Workflow size={15} /> : task.kind === 'direct' ? <MessageSquareText size={15} /> : <Activity size={15} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-slate-200">{task.title}</p>
            {needsReview && <ShieldAlert size={13} className="shrink-0 text-amber-400" aria-label="等待审核" />}
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] text-slate-600">{task.subtitle}</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <TaskStateBadge state={task.state} />
            <span className="text-[10px] text-slate-600">{relativeTime(last || null)}</span>
          </div>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500">
            <span>{task.workers.length} 个智能体</span>
            <span>{task.direct?.messages.length || task.evidence?.inspection?.steps.length || 0} 个记录</span>
            <span className={task.reviewVerdict === 'ACCEPT' ? 'text-emerald-400' : task.reviewVerdict === 'REJECT' ? 'text-rose-400' : ''}>
              审核 {task.reviewVerdict || '未观测'}
            </span>
          </div>
        </div>
        <ChevronRight size={15} className={`mt-2 shrink-0 ${selected ? 'text-emerald-300' : 'text-slate-700'}`} />
      </div>
    </button>
  )
}

function EventTimeline({ task }: { task: TaskProjection }) {
  const events = task.evidence?.timeline.events || []
  const shown = events.slice(-40).reverse()
  const directMessages = [...(task.direct?.messages || [])].reverse()
  return (
    <section className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-white">实时事件记录</h3>
          <p className="mt-1 text-xs text-slate-500">按 journal seq 排序；不是复制终端输出。</p>
        </div>
        <span className="text-[10px] text-slate-600">{task.direct ? directMessages.length : events.length} 条记录</span>
      </div>
      {task.direct ? (
        <ol className="mt-4 space-y-0 border-l border-slate-800 pl-4">
          {directMessages.map(message => (
            <li key={String(message.id)} className="relative pb-4 before:absolute before:-left-[20.5px] before:top-1 before:h-2 before:w-2 before:rounded-full before:bg-emerald-400 before:ring-4 before:ring-slate-900">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-[10px] text-slate-600">消息 #{message.id}</span>
                <span className="text-xs font-medium text-slate-300">{message.sender_id} → {message.receiver_id}</span>
                <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{message.status}</span>
                {message.review_verdict && <span className="text-[10px] text-amber-300">审核 {message.review_verdict}</span>}
              </div>
              <p className="mt-1 text-[10px] text-slate-600">{formatTime(message.created_at)} · 任务 {message.task_id || '历史推定'}</p>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] text-slate-400">{message.message}</p>
            </li>
          ))}
        </ol>
      ) : shown.length ? (
        <ol className="mt-4 space-y-0 border-l border-slate-800 pl-4">
          {shown.map(event => (
            <li key={event.seq} className="relative pb-4 before:absolute before:-left-[20.5px] before:top-1 before:h-2 before:w-2 before:rounded-full before:bg-sky-400 before:ring-4 before:ring-slate-900">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-[10px] text-slate-600">#{event.seq}</span>
                <span className="text-xs font-medium text-slate-300">{event.event_type}</span>
                <span className="text-[10px] text-cyan-300">{event.step_id || '未绑定步骤'}</span>
                {event.state && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{event.state}</span>}
              </div>
              <p className="mt-1 text-[10px] text-slate-600">
                {formatTime(event.ts)} · 终端 {event.terminal_id || '未观测'}
                {typeof event.elapsed_ms === 'number' ? ` · ${event.elapsed_ms.toLocaleString()} ms` : ''}
              </p>
              {(event.reason || event.error_kind || event.validation_result) && (
                <p className="mt-1 text-[11px] text-slate-400">{event.reason || event.error_kind || event.validation_result}</p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-slate-700 bg-slate-950/30 px-4 py-7 text-center text-xs text-slate-600">
          未观察到持久事件；请通过下方实时终端查看当前智能体。
        </div>
      )}
    </section>
  )
}

interface TaskVersionFields {
  goal: string
  effort: string
  scope: string
  stop_when: string
  return: string
}

const EMPTY_VERSION: TaskVersionFields = { goal: '', effort: 'medium', scope: '', stop_when: '', return: '' }

function VersionEditor({
  fields,
  setFields,
  onSubmit,
  onClose,
  busy,
}: {
  fields: TaskVersionFields
  setFields: React.Dispatch<React.SetStateAction<TaskVersionFields>>
  onSubmit: () => void
  onClose: () => void
  busy: boolean
}) {
  const entries: Array<[keyof TaskVersionFields, string, 'input' | 'textarea']> = [
    ['goal', 'GOAL · 任务目标', 'textarea'],
    ['scope', 'SCOPE · 可修改范围', 'textarea'],
    ['stop_when', 'STOP WHEN · 何时停止', 'textarea'],
    ['return', 'RETURN · 返回内容和验收命令', 'textarea'],
  ]
  const valid = fields.goal.trim() && fields.scope.trim() && fields.stop_when.trim() && fields.return.trim()
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="创建任务新版本">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
          <div>
            <h3 className="font-semibold text-white">创建任务新版本</h3>
            <p className="mt-1 text-xs text-slate-500">旧运行保留为证据；新版本会获得新的 run ID。</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-800 hover:text-white"><X size={17} /></button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="text-xs font-medium text-slate-300">EFFORT · 推理强度</span>
            <select value={fields.effort} onChange={event => setFields(current => ({ ...current, effort: event.target.value }))} className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 focus:outline-none">
              <option value="low">Low · Fable 5 / low</option>
              <option value="medium">Medium · Fable 5 / medium</option>
              <option value="high">High · Fable 5 / high</option>
              <option value="xhigh">XHigh · Opus 5 / xhigh</option>
              <option value="ultra">Ultra · Opus 5 / max（仅大型独立并行研究）</option>
            </select>
          </label>
          {entries.map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs font-medium text-slate-300">{label}</span>
              <textarea rows={key === 'goal' ? 3 : 4} value={fields[key]} onChange={event => setFields(current => ({ ...current, [key]: event.target.value }))} className="mt-1.5 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-700 focus:border-emerald-500 focus:outline-none" />
            </label>
          ))}
          <div className="rounded-xl border border-amber-500/25 bg-amber-950/20 px-4 py-3 text-xs leading-5 text-amber-100/70">
            这不是修改旧日志。CAO 会用原工作流和新的五字段输入提交一个不可变新运行；若工作流输入契约不兼容，服务端会明确拒绝。
          </div>
        </div>
        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">取消</button>
          <button disabled={!valid || busy} onClick={onSubmit} className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <GitPullRequestArrow size={14} />} 提交新版本
          </button>
        </div>
      </div>
    </div>
  )
}

export function TaskCenter({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const connected = useStore(state => state.connected)
  const showSnackbar = useStore(state => state.showSnackbar)
  const [runs, setRuns] = useState<RunSummaryRow[]>([])
  const [evidenceByRun, setEvidenceByRun] = useState<Record<string, WorkflowEvidence>>({})
  const [terminals, setTerminals] = useState<HydratedTerminal[]>([])
  const [allInboxMessages, setAllInboxMessages] = useState<InboxMessage[]>([])
  const [projectMemories, setProjectMemories] = useState<MemorySummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('flow')
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [liveTerminal, setLiveTerminal] = useState<HydratedTerminal | null>(null)
  const [pendingWorkflowAction, setPendingWorkflowAction] = useState<'cancel' | 'resume' | null>(null)
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const [versionOpen, setVersionOpen] = useState(false)
  const [versionFields, setVersionFields] = useState<TaskVersionFields>(EMPTY_VERSION)
  const selectedIdRef = useRef<string | null>(null)
  const evidenceRef = useRef<Record<string, WorkflowEvidence>>({})
  const refreshInFlightRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { evidenceRef.current = evidenceByRun }, [evidenceByRun])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const notify = useCallback((type: 'success' | 'error' | 'info', message: string) => showSnackbar({ type, message }), [showSnackbar])

  const refresh = useCallback(async (quiet = false) => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    if (!quiet) setRefreshing(true)
    try {
      const [sessionRows, runRows] = await Promise.all([
        api.listSessions(),
        api.listWorkflowRuns(),
      ])
      const sessionDetails = await Promise.all(sessionRows.map(session => api.getSession(session.name).catch(() => null)))
      const metas: TerminalMeta[] = sessionDetails.flatMap(detail => detail?.terminals || [])
      const uniqueMetas = [...new Map(metas.map(meta => [meta.id, meta])).values()]
      const hydrated = await Promise.all(uniqueMetas.map(async meta => {
        try {
          return mergeTerminal(meta, await api.getTerminal(meta.id))
        } catch {
          return mergeTerminal(meta)
        }
      }))
      const [inboxGroups, memories] = await Promise.all([
        Promise.all(hydrated.map(terminal => api.getInboxMessages(terminal.id, 100, undefined, true).catch(() => []))),
        api.listMemories({ scope: 'project', limit: 100 }).catch(() => [] as MemorySummary[]),
      ])
      const inboxRows = [...new Map(inboxGroups.flat().map(message => [String(message.id), message])).values()]

      const selectedRunId = selectedIdRef.current && runRows.some(run => run.run_id === selectedIdRef.current)
        ? selectedIdRef.current
        : null
      const liveRunIds = runRows.filter(run => !TERMINAL_STATES.has(normalizeState(run.state))).map(run => run.run_id)
      // Poll every live run, the selected run, and only the six newest archive
      // rows. This keeps the task center responsive without re-reading dozens
      // of immutable historical timelines every five seconds.
      const hydrateIds = [...new Set([...liveRunIds, ...runRows.slice(0, 6).map(run => run.run_id), ...(selectedRunId ? [selectedRunId] : [])])]
      const evidencePairs = await Promise.all(hydrateIds.map(async runId => {
        try {
          const [inspection, timeline] = await Promise.all([
            api.inspectWorkflowRun(runId),
            api.getWorkflowRunEvents(runId),
          ])
          return [runId, receiptEvidence(inspection, timeline, evidenceRef.current[runId])] as const
        } catch {
          return [runId, evidenceRef.current[runId] || receiptEvidence(null, EMPTY_TIMELINE)] as const
        }
      }))

      if (mountedRef.current) {
        setRuns(runRows)
        setTerminals(hydrated)
        setAllInboxMessages(inboxRows)
        setProjectMemories(memories)
        setEvidenceByRun(current => ({ ...current, ...Object.fromEntries(evidencePairs) }))
        setLoadError(null)
        setLastRefresh(new Date().toISOString())
      }
    } catch (error: any) {
      if (mountedRef.current) setLoadError(error?.detail || error?.message || '无法读取 CAO 当前状态')
    } finally {
      refreshInFlightRef.current = false
      if (mountedRef.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  // The refetch callback depends on the current evidence cache to preserve
  // diagnostics/results. A self-resetting timeout avoids overlapping requests
  // and stale setInterval closures.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const loop = async () => {
      await refresh(true)
      if (!cancelled) timer = setTimeout(loop, 5000)
    }
    loop()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [refresh])

  const tasks = useMemo(
    () => buildTaskProjections(runs, evidenceByRun, terminals, allInboxMessages),
    [runs, evidenceByRun, terminals, allInboxMessages],
  )

  useEffect(() => {
    if (!tasks.length) return
    if (!selectedId || !tasks.some(task => task.id === selectedId)) setSelectedId(tasks[0].id)
  }, [tasks, selectedId])

  const selectedTask = tasks.find(task => task.id === selectedId) || null
  const controllableIds = useMemo(() => {
    const ids = new Set<string>()
    if (!selectedTask) return ids
    const isActiveWorker = (worker: HydratedTerminal) => ['processing', 'idle', 'completed', 'waiting_user_answer'].includes(normalizeState(worker.status))

    if (selectedTask.kind === 'live') {
      selectedTask.workers.filter(isActiveWorker).forEach(worker => ids.add(worker.id))
      return ids
    }
    if (selectedTask.direct) {
      const current = new Set(selectedTask.direct.currentWorkerIds)
      selectedTask.workers
        .filter(worker => current.has(worker.id) && isActiveWorker(worker))
        .forEach(worker => ids.add(worker.id))
      return ids
    }
    if (TERMINAL_STATES.has(selectedTask.state)) return ids

    const currentStepId = selectedTask.evidence?.inspection?.current_step_id
    const stepTerminalId = selectedTask.evidence?.inspection?.steps.find(step => step.id === currentStepId)?.terminal_id
    const eventTerminalId = [...(selectedTask.evidence?.timeline.events || [])]
      .reverse()
      .find(event => !currentStepId || event.step_id === currentStepId)?.terminal_id
    const currentTerminalId = stepTerminalId || eventTerminalId
    selectedTask.workers
      .filter(worker => isActiveWorker(worker) && worker.id === currentTerminalId)
      .forEach(worker => ids.add(worker.id))
    return ids
  }, [selectedTask])

  // Load the heavier diagnostics/result only for the task the operator opens.
  useEffect(() => {
    const runId = selectedTask?.run?.run_id
    if (!runId) return
    const current = evidenceByRun[runId]
    if (current?.diagnostics && current?.result) return
    let cancelled = false
    Promise.all([
      current?.inspection ? Promise.resolve(current.inspection) : api.inspectWorkflowRun(runId),
      current?.timeline ? Promise.resolve(current.timeline) : api.getWorkflowRunEvents(runId),
      api.getWorkflowRunDiagnostics(runId).catch(() => null as DiagnosticBundle | null),
      api.getWorkflowRunResult(runId).catch(() => null as WorkflowRunResult | null),
    ]).then(([inspection, timeline, diagnostics, result]) => {
      if (cancelled) return
      setEvidenceByRun(cache => ({
        ...cache,
        [runId]: { inspection, timeline, diagnostics, result },
      }))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selectedTask?.id])

  const inbox = useMemo(
    () => selectedTask ? inboxEvidenceForTask(selectedTask, allInboxMessages) : [],
    [selectedTask, allInboxMessages],
  )

  useEffect(() => {
    if (!versionOpen || !selectedTask) return
    const inputs = parseDiagnosticInputs(selectedTask.evidence?.diagnostics || null)
    setVersionFields({
      goal: typeof inputs?.goal === 'string' ? inputs.goal : '',
      effort: typeof inputs?.effort === 'string' && inputs.effort ? inputs.effort : 'high',
      scope: typeof inputs?.scope === 'string' ? inputs.scope : '',
      stop_when: typeof inputs?.stop_when === 'string' ? inputs.stop_when : '',
      return: typeof inputs?.return === 'string' ? inputs.return : '',
    })
  }, [versionOpen, selectedTask?.id, selectedTask?.evidence?.diagnostics])

  const filteredTasks = useMemo(() => tasks.filter(task => {
    if (filter === 'active' && !ACTIVE_TASK_STATES.has(task.state)) return false
    if (filter === 'review' && !((task.state === 'completed' || task.state === 'returned') && !task.reviewVerdict)) return false
    if (filter === 'direct' && task.kind !== 'direct') return false
    const needle = query.trim().toLowerCase()
    return !needle || `${task.title} ${task.subtitle} ${task.id}`.toLowerCase().includes(needle)
  }), [tasks, filter, query])

  useEffect(() => {
    if (filteredTasks.length && !filteredTasks.some(task => task.id === selectedId)) {
      setSelectedId(filteredTasks[0].id)
      setDetailTab('flow')
    }
  }, [filteredTasks, selectedId])

  const counts = useMemo(() => ({
    total: tasks.length,
    active: tasks.filter(task => ACTIVE_TASK_STATES.has(task.state)).length,
    workers: terminals.length,
    review: tasks.filter(task => (task.state === 'completed' || task.state === 'returned') && !task.reviewVerdict).length,
  }), [tasks, terminals])

  const runWorkflowAction = async () => {
    if (!selectedTask?.run || !pendingWorkflowAction) return
    setWorkflowBusy(true)
    const action = pendingWorkflowAction
    setPendingWorkflowAction(null)
    try {
      if (action === 'cancel') {
        await api.cancelWorkflowRun(selectedTask.run.run_id)
        notify('success', '已停止当前步骤；恢复时会从持久记录重启该步骤')
      } else {
        notify('info', '正在从持久记录重启；请求保持在后台，界面仍可继续使用')
        await api.resumeWorkflowRun(selectedTask.run.run_id)
        notify('success', '恢复运行已返回结果')
      }
      await refresh(true)
    } catch (error: any) {
      notify('error', error?.detail || error?.message || '工作流控制失败')
    } finally {
      setWorkflowBusy(false)
    }
  }

  const submitVersion = async () => {
    if (!selectedTask?.run) return
    setWorkflowBusy(true)
    try {
      const base = parseDiagnosticInputs(selectedTask.evidence?.diagnostics || null) || {}
      const submitted = await api.submitWorkflowRun(selectedTask.run.workflow_name, { ...base, ...versionFields })
      notify('success', `新版本已提交：${submitted.run_id}`)
      setVersionOpen(false)
      await refresh(true)
      setSelectedId(submitted.run_id)
    } catch (error: any) {
      notify('error', error?.detail || error?.message || '提交新版本失败')
    } finally {
      setWorkflowBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-3xl border border-slate-700/70 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,.16),transparent_38%),linear-gradient(145deg,rgba(15,23,42,.96),rgba(2,6,23,.92))] p-5 shadow-[0_28px_80px_rgba(2,6,23,.35)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-emerald-300">
              <Sparkles size={16} />
              <span className="text-xs font-semibold tracking-widest">UNIDLQ · CAO CONTROL ROOM</span>
            </div>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">项目任务中心</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-400">你只需要选择任务。直接派发、实现者回报、审核、记忆证据和原生终端都在同一个页面；原版 CAO 功能仍保留在上方其他标签。</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ${connected ? 'border-emerald-500/35 bg-emerald-950/30 text-emerald-300' : 'border-rose-500/35 bg-rose-950/30 text-rose-300'}`}>
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} /> {connected ? '实时连接' : '连接中断'}
            </span>
            <button disabled={refreshing} onClick={() => refresh(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500 disabled:opacity-50">
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> 刷新
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-2 text-xs md:grid-cols-4">
          {([
            [MessageSquareText, '1. 你在主对话下达目标', '无需理解 CAO 术语'],
            [Workflow, '2. 架构师规划并派发', '过程绑定到任务'],
            [Bot, '3. 实现者各自一条泳道', '可实时打断或修改'],
            [BookOpenCheck, '4. 审核并生成报告', '保存论文可复核证据'],
          ] as Array<[LucideIcon, string, string]>).map(([Icon, title, note], index) => (
            <div key={title as string} className="relative rounded-xl border border-slate-700/60 bg-slate-950/35 p-3">
              <div className="flex items-center gap-2 text-slate-200"><Icon size={14} className="text-emerald-300" /> {title as string}</div>
              <p className="mt-1 text-[10px] text-slate-600">{note as string}</p>
              {index < 3 && <ArrowRight size={13} className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-slate-600 md:block" />}
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          ['任务总数', counts.total, FileClock, 'text-cyan-300'],
          ['正在推进', counts.active, Activity, 'text-sky-300'],
          ['实时智能体', counts.workers, Bot, 'text-violet-300'],
          ['缺少明确审核记录', counts.review, ShieldAlert, 'text-amber-300'],
        ] as Array<[string, number, LucideIcon, string]>).map(([label, value, Icon, tone]) => (
          <div key={label as string} className="rounded-2xl border border-slate-800 bg-slate-900/55 p-4">
            <div className="flex items-center justify-between"><span className="text-xs text-slate-500">{label as string}</span><Icon size={15} className={tone as string} /></div>
            <p className="mt-2 text-2xl font-bold text-white">{value as number}</p>
          </div>
        ))}
      </div>

      {loadError && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-950/25 px-4 py-3 text-sm text-rose-200"><AlertCircle size={15} /> {loadError}</div>
      )}

      <div className="grid min-h-[680px] grid-cols-1 gap-4 xl:grid-cols-[310px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-3 xl:sticky xl:top-28 xl:h-[calc(100vh-8rem)]">
          <div className="flex items-center justify-between px-1 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-white">任务列表</h3>
              <p className="mt-0.5 text-[10px] text-slate-600">最后刷新 {relativeTime(lastRefresh)}</p>
            </div>
            <button onClick={() => onNavigate('workflows')} className="text-[10px] text-slate-500 hover:text-emerald-300">原始记录</button>
          </div>
          <div className="relative mb-2">
            <Search size={13} className="absolute left-2.5 top-2.5 text-slate-600" />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务或 run ID" className="w-full rounded-lg border border-slate-800 bg-slate-950 py-2 pl-8 pr-3 text-xs text-slate-200 placeholder:text-slate-700 focus:border-emerald-500 focus:outline-none" />
          </div>
          <div className="mb-3 flex gap-1 overflow-x-auto pb-1">
            {([
              ['all', '全部'],
              ['active', '推进中'],
              ['review', '待审核'],
              ['direct', '直接任务'],
            ] as Array<[TaskFilter, string]>).map(([key, label]) => (
              <button key={key} onClick={() => setFilter(key)} className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] ${filter === key ? 'border-emerald-500/50 bg-emerald-950/35 text-emerald-300' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`}>{label}</button>
            ))}
          </div>
          <div className="space-y-2 overflow-y-auto xl:h-[calc(100%-7rem)] xl:pr-1">
            {loading && !tasks.length ? (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-500"><Loader2 size={14} className="animate-spin" /> 正在读取 CAO 状态…</div>
            ) : filteredTasks.length ? filteredTasks.map(task => (
              <TaskListCard key={task.id} task={task} selected={task.id === selectedId} onSelect={() => { setSelectedId(task.id); setDetailTab('flow') }} />
            )) : (
              <div className="rounded-xl border border-dashed border-slate-800 px-3 py-10 text-center text-xs text-slate-600"><ListFilter size={20} className="mx-auto mb-2" />没有符合筛选条件的任务</div>
            )}
          </div>
        </aside>

        <main className="min-w-0">
          {selectedTask ? (
            <div className="space-y-4">
              <section className="rounded-2xl border border-slate-700/70 bg-slate-900/55 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <TaskStateBadge state={selectedTask.state} />
                      <span className={`rounded-full border px-2.5 py-1 text-[10px] ${selectedTask.reviewVerdict === 'ACCEPT' ? 'border-emerald-500/40 bg-emerald-950/35 text-emerald-300' : selectedTask.reviewVerdict === 'REJECT' ? 'border-rose-500/40 bg-rose-950/35 text-rose-300' : 'border-amber-500/30 bg-amber-950/25 text-amber-300'}`}>
                        独立审核：{selectedTask.reviewVerdict || '未观测'}
                      </span>
                    </div>
                    <h2 className="mt-3 truncate text-xl font-bold text-white">{selectedTask.title}</h2>
                    <p className="mt-1 break-all font-mono text-xs text-slate-600">{selectedTask.subtitle}</p>
                    <p className="mt-2 text-[11px] text-slate-500">开始 {formatTime(selectedTask.startedAt)} · 结束 {formatTime(selectedTask.finishedAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {selectedTask.run && !TERMINAL_STATES.has(selectedTask.state) && (
                      <button disabled={workflowBusy} onClick={() => setPendingWorkflowAction('cancel')} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-950/25 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900/30 disabled:opacity-50"><CirclePause size={13} /> 暂停工作流</button>
                    )}
                    {selectedTask.run && ['failed', 'cancelled'].includes(selectedTask.state) && (
                      <button disabled={workflowBusy} onClick={() => setPendingWorkflowAction('resume')} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs text-white hover:bg-sky-500 disabled:opacity-50"><Play size={13} /> 从持久记录重启</button>
                    )}
                    {selectedTask.run && (
                      <button disabled={workflowBusy} onClick={() => setVersionOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-xs text-slate-200 hover:border-emerald-500/50"><GitPullRequestArrow size={13} /> 修改为新版本</button>
                    )}
                  </div>
                </div>
                <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/35 px-3 py-2 text-[11px] text-slate-500">
                  {selectedTask.kind === 'workflow'
                    ? '“暂停”会取消当前运行步骤；“重启”从 durable journal 重新执行，不会冻结或恢复 Claude 的内存上下文。'
                    : selectedTask.kind === 'direct'
                      ? '这是持久终端上的直接任务：安静或回到输入框不等于冻结；任务以实现者回报结束，以架构师明确 ACCEPT / REJECT 验收。'
                      : '这是尚无五字段任务记录的实时终端：可逐个打断或补充，但不会伪造成已登记任务。'}
                </div>
              </section>

              <nav className="flex gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 p-1" aria-label="任务详情视图">
                {([
                  ['flow', '流程与实时控制', Activity],
                  ['memory', '记忆 / 证据图', BookOpenCheck],
                  ['report', '详细报告', FileClock],
                ] as Array<[DetailTab, string, typeof Activity]>).map(([key, label, Icon]) => (
                  <button key={key} onClick={() => setDetailTab(key)} className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition ${detailTab === key ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}><Icon size={13} /> {label}</button>
                ))}
              </nav>

              {detailTab === 'flow' && (
                <div className="space-y-4">
                  <TaskFlow task={selectedTask} />
                  <WorkerBoard
                    task={selectedTask}
                    workers={selectedTask.workers}
                    controllableIds={controllableIds}
                    onOpenTerminal={setLiveTerminal}
                    onChanged={() => { void refresh(true) }}
                    notify={notify}
                  />
                  <EventTimeline task={selectedTask} />
                </div>
              )}
              {detailTab === 'memory' && <TaskMemoryMap task={selectedTask} projectMemories={projectMemories} />}
              {detailTab === 'report' && <TaskReportView task={selectedTask} inbox={inbox} projectMemories={projectMemories} />}
            </div>
          ) : (
            <div className="flex h-full min-h-[560px] items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-900/35 text-center">
              <div><Workflow size={30} className="mx-auto text-slate-700" /><p className="mt-3 text-sm text-slate-500">选择左侧任务查看完整流程</p></div>
            </div>
          )}
        </main>
      </div>

      {liveTerminal && <TerminalView terminalId={liveTerminal.id} provider={liveTerminal.provider} agentProfile={liveTerminal.agent_profile} onClose={() => setLiveTerminal(null)} />}

      {pendingWorkflowAction && selectedTask?.run && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={pendingWorkflowAction === 'cancel' ? '暂停工作流确认' : '重启工作流确认'}>
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h3 className="font-semibold text-white">{pendingWorkflowAction === 'cancel' ? '暂停工作流（停止当前步骤）' : '从持久记录重启当前步骤'}</h3>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              {pendingWorkflowAction === 'cancel'
                ? 'CAO 会协作式取消当前运行并保留 journal。当前 Claude 上下文不会被冻结；恢复时该步骤会重新执行。'
                : 'CAO 会读取原始输入与 journal，从最后可恢复位置重新执行。请求可能持续较久，但不会阻塞你查看其他任务。'}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setPendingWorkflowAction(null)} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">返回</button>
              <button onClick={runWorkflowAction} className={`rounded-lg px-4 py-2 text-sm font-semibold ${pendingWorkflowAction === 'cancel' ? 'bg-amber-500 text-slate-950 hover:bg-amber-400' : 'bg-sky-500 text-slate-950 hover:bg-sky-400'}`}>确认</button>
            </div>
          </div>
        </div>
      )}

      {versionOpen && selectedTask?.run && <VersionEditor fields={versionFields} setFields={setVersionFields} onSubmit={submitVersion} onClose={() => setVersionOpen(false)} busy={workflowBusy} />}
    </div>
  )
}
