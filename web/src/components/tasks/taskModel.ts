import type {
  DiagnosticBundle,
  EventTimelinePage,
  InboxMessage,
  RunInspection,
  RunSummaryRow,
  Terminal,
  TerminalMeta,
  WorkflowEvent,
  WorkflowRunResult,
} from '../../api'

export type TaskKind = 'workflow' | 'direct' | 'live'
export type ReviewVerdict = 'ACCEPT' | 'REJECT' | null

export interface FiveFieldContract {
  goal: string
  effort: string
  scope: string
  stop_when: string
  return: string
}

export interface DirectTaskEvidence {
  contract: FiveFieldContract
  assignmentMessages: InboxMessage[]
  messages: InboxMessage[]
  returnMessages: InboxMessage[]
  reviewMessages: InboxMessage[]
  architectIds: string[]
  implementerIds: string[]
  currentWorkerIds: string[]
  returnedAt: string | null
  reviewedAt: string | null
  binding: 'persisted-task-id' | 'historical-inference'
}

export interface HydratedTerminal extends TerminalMeta {
  name?: string
  session_name?: string
  caller_id?: string | null
  allowed_tools?: string[] | null
  engine?: string | null
  shell_command?: string | null
  group?: string[] | null
  metadata?: Record<string, unknown> | null
  status?: string | null
  /** Whether GET /terminals/{id} still resolves to a live CAO record. */
  reachable?: boolean
}

export interface WorkflowEvidence {
  inspection: RunInspection | null
  timeline: EventTimelinePage
  diagnostics: DiagnosticBundle | null
  result: WorkflowRunResult | null
}

export interface TaskProjection {
  id: string
  kind: TaskKind
  title: string
  subtitle: string
  state: string
  startedAt: string | null
  finishedAt: string | null
  run: RunSummaryRow | null
  evidence: WorkflowEvidence | null
  direct: DirectTaskEvidence | null
  workers: HydratedTerminal[]
  reviewVerdict: ReviewVerdict
}

export interface StageObservation {
  key: 'definition' | 'plan' | 'implementation' | 'review' | 'report'
  label: string
  detail: string
  state: 'observed' | 'active' | 'failed' | 'unobserved'
  timestamp: string | null
}

export interface LaunchFieldObservation {
  value: string | null
  source: 'observed' | 'planned' | 'unobserved'
}

export interface WorkerLaunchObservation {
  model: LaunchFieldObservation
  reasoningEffort: LaunchFieldObservation
}

export type WorkerSessionUse = 'reused' | 'new' | 'unobserved'

const CONTRACT_KEY: Record<string, keyof FiveFieldContract> = {
  GOAL: 'goal',
  EFFORT: 'effort',
  SCOPE: 'scope',
  'STOP WHEN': 'stop_when',
  RETURN: 'return',
}

const CONTRACT_FIELD_LINE = /^\s*(?:#{1,6}\s+)?(?:\*\*|__)?(GOAL|EFFORT|SCOPE|STOP\s+WHEN|RETURN)(?:\*\*|__)?(?:\s*:\s*(.*)|\s*(?:#+\s*)?)$/i

function parseContractLines(message: string): FiveFieldContract | null {
  const values: Record<keyof FiveFieldContract, string[]> = {
    goal: [], effort: [], scope: [], stop_when: [], return: [],
  }
  const seen = new Set<keyof FiveFieldContract>()
  let current: keyof FiveFieldContract | null = null
  message.split(/\r?\n/).forEach(line => {
    const match = line.match(CONTRACT_FIELD_LINE)
    if (match) {
      const header = match[1].toUpperCase().replace(/\s+/g, ' ')
      current = CONTRACT_KEY[header]
      seen.add(current)
      values[current].push(match[2] ?? '')
    } else if (current) {
      values[current].push(line)
    }
  })
  if (seen.size !== 5) return null
  const parsed = Object.fromEntries(
    Object.entries(values).map(([key, lines]) => [key, lines.join('\n').trim()]),
  ) as unknown as FiveFieldContract
  if (!parsed.goal || !parsed.scope || !parsed.stop_when || !parsed.return) return null
  return parsed
}

/** Parse the lightweight GOAL/EFFORT/SCOPE/STOP WHEN/RETURN task packet. */
export function parseFiveFieldContract(message: string): FiveFieldContract | null {
  const parsed = parseContractLines(message)
  if (parsed || !message.includes('\\n')) return parsed

  const normalized = message.replace(/\\r\\n|\\n/g, '\n')
  const firstLine = normalized.split(/\r?\n/).find(line => line.trim())
  if (!firstLine || !CONTRACT_FIELD_LINE.test(firstLine)) return null
  return parseContractLines(normalized)
}

/**
 * Bind inbox rows to the narrowest provenance CAO currently records.
 * Inbox rows do not carry a workflow run id, so a row is admissible only
 * when the receiver, recorded caller, worker lifetime, and task time window
 * all agree. Anything ambiguous is omitted rather than attributed to a task.
 */
export function inboxEvidenceForTask(task: TaskProjection, messages: InboxMessage[]): InboxMessage[] {
  if (task.direct) return task.direct.messages
  const started = Date.parse(task.startedAt || '')
  const finished = Date.parse(task.finishedAt || '')
  if (!Number.isFinite(started)) return []

  const workers = new Map(task.workers.map(worker => [worker.id, worker]))
  return messages.filter(message => {
    const worker = workers.get(message.receiver_id)
    if (!worker?.caller_id || message.sender_id !== worker.caller_id) return false

    const created = Date.parse(message.created_at || '')
    const workerCreated = Date.parse(worker.created_at || '')
    if (!Number.isFinite(created) || created < started) return false
    if (Number.isFinite(workerCreated) && created < workerCreated) return false
    if (Number.isFinite(finished) && created > finished) return false
    return true
  })
}

const TERMINAL_STATE_PRIORITY: Record<string, number> = {
  error: 60,
  waiting_user_answer: 50,
  processing: 40,
  idle: 30,
  completed: 20,
  unknown: 10,
}

export function normalizeState(value: string | null | undefined): string {
  return (value || 'unknown').toLowerCase()
}

export function mergeTerminal(meta: TerminalMeta, detail?: Terminal | null): HydratedTerminal {
  return {
    ...meta,
    ...(detail || {}),
    tmux_session: meta.tmux_session,
    tmux_window: meta.tmux_window,
    created_at: meta.created_at,
    last_active: detail?.last_active ?? meta.last_active,
    agent_profile: detail?.agent_profile ?? meta.agent_profile,
  }
}

function metadataRunId(terminal: HydratedTerminal): string | null {
  const metadata = terminal.metadata
  if (!metadata) return null
  for (const key of ['run_id', 'workflow_run_id', 'workflowRunId']) {
    const value = metadata[key]
    if (typeof value === 'string') return value
  }
  return null
}

function metadataText(terminal: HydratedTerminal, key: string): string | null {
  const value = terminal.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function taskEffort(task: TaskProjection): string | null {
  const normalize = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const match = value.trim().toLowerCase().match(/^(low|medium|high|xhigh|ultra)\b/)
    return match?.[1] || null
  }
  if (task.direct?.contract.effort) return normalize(task.direct.contract.effort)
  const inputs = parseDiagnosticInputs(task.evidence?.diagnostics || null)
  return normalize(inputs?.effort)
}

export function workerDisplayName(worker: HydratedTerminal, task: TaskProjection): string {
  const explicit = metadataText(worker, 'display_name') || metadataText(worker, 'role_name')
  if (explicit) return explicit
  if (task.kind !== 'live' && task.title.trim()) return task.title.trim()
  return worker.name || worker.agent_profile || worker.id
}

export function workerLaunchObservation(
  worker: HydratedTerminal,
  task: TaskProjection,
): WorkerLaunchObservation {
  const observedModel = metadataText(worker, 'launch_model')
  const observedEffort = metadataText(worker, 'launch_reasoning_effort')
  const effort = taskEffort(task)
  const nativeEffort: Record<string, string> = {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'max',
  }
  const text = `${worker.provider} ${worker.agent_profile || ''}`.toLowerCase()
  let plannedModel: string | null = null
  if (text.includes('codex') || text.includes('architect')) plannedModel = 'gpt-5.6-sol'
  if (text.includes('claude') || text.includes('implement')) {
    plannedModel = effort && ['xhigh', 'ultra'].includes(effort)
      ? 'claude-opus-5'
      : effort && ['low', 'medium', 'high'].includes(effort)
      ? 'claude-fable-5'
      : null
  }
  const plannedEffort = effort ? nativeEffort[effort] || null : null
  return {
    model: observedModel
      ? { value: observedModel, source: 'observed' }
      : plannedModel
      ? { value: plannedModel, source: 'planned' }
      : { value: null, source: 'unobserved' },
    reasoningEffort: observedEffort
      ? { value: observedEffort, source: 'observed' }
      : plannedEffort
      ? { value: plannedEffort, source: 'planned' }
      : { value: null, source: 'unobserved' },
  }
}

export function workerSessionUse(worker: HydratedTerminal, task: TaskProjection): WorkerSessionUse {
  if (!task.direct || !worker.created_at) return 'unobserved'
  const assignment = task.direct.assignmentMessages.find(message => (
    message.sender_id === worker.id || message.receiver_id === worker.id
  ))
  if (!assignment?.created_at) return 'unobserved'
  const createdAt = Date.parse(worker.created_at)
  const assignedAt = Date.parse(assignment.created_at)
  if (!Number.isFinite(createdAt) || !Number.isFinite(assignedAt)) return 'unobserved'
  return createdAt < assignedAt ? 'reused' : 'new'
}

export function terminalIdsForRun(evidence: WorkflowEvidence | null): Set<string> {
  const ids = new Set<string>()
  evidence?.inspection?.steps.forEach(step => {
    if (step.terminal_id) ids.add(step.terminal_id)
  })
  evidence?.timeline.events.forEach(event => {
    if (event.terminal_id) ids.add(event.terminal_id)
  })
  evidence?.diagnostics?.references.terminals.forEach(ref => ids.add(ref.terminal_id))
  return ids
}

function readVerdictValue(value: unknown): ReviewVerdict {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase()
  if (normalized === 'ACCEPT') return 'ACCEPT'
  if (normalized === 'REJECT') return 'REJECT'
  return null
}

function verdictFromReviewPayload(value: unknown, depth = 0): ReviewVerdict {
  if (depth > 2 || value == null) return null
  if (typeof value === 'string') {
    const parsed = parseJson(value)
    return parsed === value ? null : verdictFromReviewPayload(parsed, depth + 1)
  }
  if (Array.isArray(value) || typeof value !== 'object') return null
  const object = value as Record<string, unknown>
  for (const key of ['review_verdict', 'verdict']) {
    const verdict = readVerdictValue(object[key])
    if (verdict) return verdict
  }
  // Some providers wrap a structured response in a single `output` field.
  // Inspect only that documented wrapper, never arbitrary nested objects.
  if ('output' in object) return verdictFromReviewPayload(object.output, depth + 1)
  return null
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function isReviewStep(stepId: string | null | undefined): boolean {
  return /(^|[-_:])(review|audit|approve)([-_:]|$)/i.test(stepId || '')
}

/**
 * Fail-closed acceptance detection. Only structured verdict fields and the
 * journal's explicit validation_result column count; prose mentioning ACCEPT
 * is deliberately ignored.
 */
export function explicitReviewVerdict(evidence: WorkflowEvidence | null): ReviewVerdict {
  if (!evidence) return null
  for (let i = evidence.timeline.events.length - 1; i >= 0; i -= 1) {
    const event = evidence.timeline.events[i]
    if (!isReviewStep(event.step_id)) continue
    const verdict = readVerdictValue(event.validation_result)
    if (verdict) return verdict
  }
  const steps = evidence.inspection?.steps || []
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (!isReviewStep(steps[i].id)) continue
    const verdict = verdictFromReviewPayload(parseJson(steps[i].output_json))
    if (verdict) return verdict
  }
  const resultSteps = evidence.result?.steps || []
  for (let i = resultSteps.length - 1; i >= 0; i -= 1) {
    if (!isReviewStep(resultSteps[i].id)) continue
    const verdict = verdictFromReviewPayload(resultSteps[i].output)
    if (verdict) return verdict
  }
  return null
}

export function stateFromWorkers(workers: HydratedTerminal[]): string {
  if (workers.length === 0) return 'unknown'
  return workers
    .map(worker => normalizeState(worker.status))
    .sort((a, b) => (TERMINAL_STATE_PRIORITY[b] || 0) - (TERMINAL_STATE_PRIORITY[a] || 0))[0]
}

function messageTime(message: InboxMessage): number {
  return Date.parse(message.created_at || '') || 0
}

function messageKey(message: InboxMessage): string {
  return String(message.id)
}

function directTaskState(
  assignments: InboxMessage[],
  returns: InboxMessage[],
  implementers: HydratedTerminal[],
  verdict: ReviewVerdict,
  supersededHistorical: boolean,
): string {
  if (verdict === 'REJECT') return 'failed'
  if (verdict === 'ACCEPT') return 'completed'
  if (returns.length) return 'returned'
  if (assignments.some(message => message.status === 'failed')) return 'failed'
  // Old inbox rows had no task_id/reply link. Once a later assignment exists
  // for the same architect/implementer pair, an unpaired historical root is
  // evidence of an incomplete old record, not evidence that work is still
  // running today.
  if (supersededHistorical) return 'historical_unresolved'
  // Session metadata can outlive its tmux pane and retain a stale processing
  // status.  Only terminals that the live terminal endpoint can still resolve
  // may contribute an active state.
  const reachableImplementers = implementers.filter(worker => worker.reachable !== false)
  const states = reachableImplementers.map(worker => normalizeState(worker.status))
  if (states.includes('waiting_user_answer')) return 'waiting_user_answer'
  if (states.includes('processing')) return 'processing'
  if (states.includes('error')) return 'disconnected'
  if (assignments.every(message => message.status === 'pending')) return 'queued'
  // A delivered assignment is not proof that work is quietly continuing.
  // If its terminal vanished, surface the broken live link.  If the provider
  // returned to a ready prompt without a persisted handback, surface the
  // missing handoff instead of inventing activity.  Unknown status remains
  // unknown so the operator can distinguish telemetry gaps from real work.
  if (reachableImplementers.length === 0 && assignments.some(message => message.delivered_at || message.status === 'delivered')) return 'disconnected'
  if (states.some(state => state === 'completed' || state === 'idle')) return 'handoff_missing'
  if (assignments.some(message => message.delivered_at || message.status === 'delivered')) return 'unknown'
  return stateFromWorkers(reachableImplementers)
}

function legacyMessagesForRoot(
  root: InboxMessage,
  allRoots: InboxMessage[],
  messages: InboxMessage[],
): InboxMessage[] {
  const rootTime = messageTime(root)
  const samePair = (message: InboxMessage) => (
    (message.sender_id === root.sender_id && message.receiver_id === root.receiver_id)
    || (message.sender_id === root.receiver_id && message.receiver_id === root.sender_id)
  )
  const next = allRoots
    .filter(candidate => messageTime(candidate) > rootTime && samePair(candidate))
    .sort((a, b) => messageTime(a) - messageTime(b))[0]
  const end = next ? messageTime(next) : Number.POSITIVE_INFINITY
  return messages.filter(message => (
    samePair(message)
    && messageTime(message) >= rootTime
    && messageTime(message) < end
  ))
}

export function buildTaskProjections(
  runs: RunSummaryRow[],
  evidenceByRun: Record<string, WorkflowEvidence>,
  terminals: HydratedTerminal[],
  inboxMessages: InboxMessage[] = [],
): TaskProjection[] {
  const claimed = new Set<string>()
  const structured = runs.map(run => {
    const evidence = evidenceByRun[run.run_id] || null
    const referenced = terminalIdsForRun(evidence)
    const workers = terminals.filter(terminal => {
      const matches = referenced.has(terminal.id) || metadataRunId(terminal) === run.run_id
      if (matches) claimed.add(terminal.id)
      return matches
    })
    return {
      id: run.run_id,
      kind: 'workflow' as const,
      title: run.workflow_name,
      subtitle: run.run_id,
      state: normalizeState(evidence?.inspection?.state || run.state),
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      run,
      evidence,
      direct: null,
      workers,
      reviewVerdict: explicitReviewVerdict(evidence),
    }
  })

  const terminalById = new Map(terminals.map(terminal => [terminal.id, terminal]))
  const orderedMessages = [...inboxMessages].sort((a, b) => messageTime(a) - messageTime(b))
  const taskRoots = orderedMessages.filter(message => parseFiveFieldContract(message.message))
  const rootsByTask = new Map<string, InboxMessage[]>()
  taskRoots.forEach(root => {
    const key = root.task_id || `legacy-message-${messageKey(root)}`
    const group = rootsByTask.get(key) || []
    group.push(root)
    rootsByTask.set(key, group)
  })

  const latestTaskTimeByTerminal = new Map<string, number>()
  taskRoots.forEach(root => {
    const at = messageTime(root)
    for (const id of [root.sender_id, root.receiver_id]) {
      latestTaskTimeByTerminal.set(id, Math.max(latestTaskTimeByTerminal.get(id) || 0, at))
    }
  })

  const direct = [...rootsByTask.entries()].map(([taskId, assignments]) => {
    const rootIds = new Set(assignments.map(messageKey))
    const persisted = Boolean(assignments[0].task_id)
    const historical = !persisted || taskId.startsWith('legacy-')
    const exact = persisted
      ? orderedMessages.filter(message => message.task_id === taskId)
      : assignments
    const inferred = historical
      ? assignments.flatMap(root => legacyMessagesForRoot(root, taskRoots, orderedMessages))
      : []
    const linked = orderedMessages.filter(message => (
      message.reply_to_message_id != null
      && rootIds.has(String(message.reply_to_message_id))
    ))
    const messages = [...new Map([...exact, ...inferred, ...linked].map(message => [messageKey(message), message])).values()]
      .sort((a, b) => messageTime(a) - messageTime(b))
    const architectIds = [...new Set(assignments.map(message => message.sender_id))]
    const implementerIds = [...new Set(assignments.map(message => message.receiver_id))]
    const returnMessages = messages.filter(message => (
      implementerIds.includes(message.sender_id)
      && architectIds.includes(message.receiver_id)
      && !rootIds.has(messageKey(message))
    ))
    const reviewMessages = messages.filter(message => readVerdictValue(message.review_verdict))
    const verdict = [...assignments, ...reviewMessages]
      .map(message => readVerdictValue(message.review_verdict))
      .filter((value): value is Exclude<ReviewVerdict, null> => value !== null)
      .slice(-1)[0] || null
    const reviewedAt = [...assignments, ...reviewMessages]
      .map(message => message.reviewed_at || (message.review_verdict ? message.created_at : null))
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0] || null
    const returnedAt = returnMessages
      .map(message => message.created_at)
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0] || null
    const participantIds = [...new Set([...architectIds, ...implementerIds])]
    const workers = participantIds
      .map(id => terminalById.get(id))
      .filter((worker): worker is HydratedTerminal => Boolean(worker))
    workers.forEach(worker => claimed.add(worker.id))
    const implementers = implementerIds
      .map(id => terminalById.get(id))
      .filter((worker): worker is HydratedTerminal => Boolean(worker))
    const first = assignments[0]
    const contract = parseFiveFieldContract(first.message) as FiveFieldContract
    const latestAssignment = [...assignments].sort((a, b) => messageTime(b) - messageTime(a))[0]
    const supersededHistorical = historical && taskRoots.some(candidate => (
      messageTime(candidate) > messageTime(latestAssignment)
      && candidate.sender_id === latestAssignment.sender_id
      && candidate.receiver_id === latestAssignment.receiver_id
    ))
    const currentWorkerIds = participantIds.filter(id => (
      assignments.some(message => messageTime(message) === latestTaskTimeByTerminal.get(id))
    ))
    const directEvidence: DirectTaskEvidence = {
      contract,
      assignmentMessages: assignments,
      messages,
      returnMessages,
      reviewMessages,
      architectIds,
      implementerIds,
      currentWorkerIds,
      returnedAt,
      reviewedAt,
      binding: historical ? 'historical-inference' : 'persisted-task-id',
    }
    return {
      id: `direct:${taskId}`,
      kind: 'direct' as const,
      title: contract.goal.split(/\r?\n/)[0].slice(0, 90),
      subtitle: `${taskId} · ${historical ? '历史推定关联' : '持久任务关联'}`,
      state: directTaskState(
        assignments,
        returnMessages,
        implementers,
        verdict,
        supersededHistorical,
      ),
      startedAt: first.created_at,
      finishedAt: reviewedAt || returnedAt,
      run: null,
      evidence: null,
      direct: directEvidence,
      workers,
      reviewVerdict: verdict,
    }
  })

  // A terminal without a durable workflow reference is not hidden or guessed
  // into a run. It remains visibly grouped by its real tmux session.
  const bySession = new Map<string, HydratedTerminal[]>()
  terminals.forEach(terminal => {
    if (claimed.has(terminal.id)) return
    const key = terminal.tmux_session || terminal.session_name || 'unknown-session'
    const group = bySession.get(key) || []
    group.push(terminal)
    bySession.set(key, group)
  })

  const live = [...bySession.entries()].map(([session, workers]) => {
    const sorted = [...workers].sort((a, b) => Date.parse(b.last_active || '') - Date.parse(a.last_active || ''))
    return {
      id: `live:${session}`,
      kind: 'live' as const,
      title: '未结构化实时工作',
      subtitle: session,
      state: stateFromWorkers(workers),
      startedAt: workers
        .map(worker => worker.created_at)
        .filter((value): value is string => Boolean(value))
        .sort()[0] || null,
      finishedAt: null,
      run: null,
      evidence: null,
      direct: null,
      workers: sorted,
      reviewVerdict: null,
    }
  })

  return [...direct, ...live, ...structured].sort((a, b) => {
    const aTime = Date.parse(a.finishedAt || a.startedAt || '') || 0
    const bTime = Date.parse(b.finishedAt || b.startedAt || '') || 0
    const aDirect = a.kind === 'direct' ? 2 : a.kind === 'live' ? 1 : 0
    const bDirect = b.kind === 'direct' ? 2 : b.kind === 'live' ? 1 : 0
    const activeStates = ['running', 'processing', 'quiet_running', 'waiting_user_answer', 'queued']
    const aLive = activeStates.includes(a.state) ? 1 : 0
    const bLive = activeStates.includes(b.state) ? 1 : 0
    return bLive - aLive || bDirect - aDirect || bTime - aTime
  })
}

function eventTime(events: WorkflowEvent[], matcher: (event: WorkflowEvent) => boolean): string | null {
  return events.find(matcher)?.ts || null
}

export function deriveStages(task: TaskProjection): StageObservation[] {
  if (task.direct) {
    const direct = task.direct
    const assignment = direct.assignmentMessages[0]
    const deliveredAt = direct.assignmentMessages
      .map(message => message.delivered_at)
      .filter((value): value is string => Boolean(value))[0] || null
    const startedAt = direct.assignmentMessages
      .map(message => message.started_at)
      .filter((value): value is string => Boolean(value))[0] || null
    const hasReturn = direct.returnMessages.length > 0
    const provenance = direct.binding === 'historical-inference' ? '（历史推定关联）' : ''
    return [
      {
        key: 'definition',
        label: '任务已登记',
        detail: `已读取五字段任务定义${provenance}`,
        state: 'observed',
        timestamp: assignment.created_at,
      },
      {
        key: 'plan',
        label: '规划与派发',
        detail: `架构师已向 ${direct.implementerIds.length} 个实现终端派发${provenance}`,
        state: assignment.status === 'failed' ? 'failed' : 'observed',
        timestamp: assignment.created_at,
      },
      {
        key: 'implementation',
        label: '实现 / 实验',
        detail: hasReturn
          ? `已收到 ${direct.returnMessages.length} 份实现者回报`
          : startedAt || deliveredAt
            ? '任务已送入真实终端；安静不等于冻结'
            : '等待 CAO 将任务送入终端',
        state: hasReturn ? 'observed' : assignment.status === 'failed' ? 'failed' : deliveredAt ? 'active' : 'unobserved',
        timestamp: startedAt || deliveredAt,
      },
      {
        key: 'review',
        label: '独立审核',
        detail: task.reviewVerdict
          ? `明确结论：${task.reviewVerdict}`
          : hasReturn ? '实现回报已返回，等待架构师明确 ACCEPT / REJECT' : '尚未进入审核',
        state: task.reviewVerdict === 'REJECT' ? 'failed' : task.reviewVerdict === 'ACCEPT' ? 'observed' : hasReturn ? 'active' : 'unobserved',
        timestamp: direct.reviewedAt,
      },
      {
        key: 'report',
        label: '报告与归档',
        detail: hasReturn ? '实现者原始回报已纳入可下载报告' : '尚未收到实现者回报',
        state: hasReturn ? 'observed' : 'unobserved',
        timestamp: direct.returnedAt,
      },
    ]
  }
  const events = task.evidence?.timeline.events || []
  const steps = task.evidence?.inspection?.steps || []
  const hasPlan = steps.some(step => /plan|architect/i.test(step.id))
  const hasImplementation = steps.some(step => /implement|build|execute/i.test(step.id)) || task.workers.some(worker => /claude|implement/i.test(`${worker.provider} ${worker.agent_profile}`))
  const hasReview = steps.some(step => /review|audit|approve/i.test(step.id))
  const reviewInProgress = steps.some(step => /review|audit|approve/i.test(step.id) && ['running', 'processing', 'pending'].includes(normalizeState(step.state)))
  const active = ['running', 'processing', 'idle', 'waiting_user_answer'].includes(task.state)
  const failed = ['failed', 'error', 'cancelled'].includes(task.state)

  return [
    {
      key: 'definition',
      label: '任务已登记',
      detail: task.kind === 'workflow' ? '持久工作流记录已存在' : '仅观察到实时终端，未绑定工作流',
      state: task.kind === 'workflow' ? 'observed' : 'unobserved',
      timestamp: task.startedAt,
    },
    {
      key: 'plan',
      label: '规划与派发',
      detail: hasPlan ? '观察到架构师规划步骤' : '未观察到独立规划步骤',
      state: hasPlan ? 'observed' : 'unobserved',
      timestamp: eventTime(events, event => /plan|architect/i.test(event.step_id || '')),
    },
    {
      key: 'implementation',
      label: '实现 / 实验',
      detail: hasImplementation ? `已关联 ${task.workers.length || '未观测数量'} 个执行终端` : '未观察到实现步骤',
      state: hasImplementation ? (active ? 'active' : failed ? 'failed' : 'observed') : 'unobserved',
      timestamp: eventTime(events, event => /implement|build|execute/i.test(event.step_id || '')),
    },
    {
      key: 'review',
      label: '独立审核',
      detail: task.reviewVerdict ? `明确结论：${task.reviewVerdict}` : reviewInProgress ? '审核步骤正在运行，尚无结构化结论' : hasReview ? '审核步骤已记录，但没有结构化结论' : '未观察到审核步骤',
      state: task.reviewVerdict === 'REJECT' ? 'failed' : task.reviewVerdict === 'ACCEPT' ? 'observed' : reviewInProgress ? 'active' : 'unobserved',
      timestamp: eventTime(events, event => /review|audit|approve/i.test(event.step_id || '')),
    },
    {
      key: 'report',
      label: '报告与归档',
      detail: task.finishedAt ? '运行已结束，可生成证据报告' : '尚无完成时间',
      state: task.finishedAt ? 'observed' : 'unobserved',
      timestamp: task.finishedAt,
    },
  ]
}

export function parseDiagnosticInputs(diagnostics: DiagnosticBundle | null): Record<string, unknown> | null {
  if (!diagnostics?.inputs) return null
  try {
    const parsed = JSON.parse(diagnostics.inputs)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function observedStepDurations(events: WorkflowEvent[]): Array<{ step: string; durationMs: number }> {
  const durations = new Map<string, number>()
  events.forEach(event => {
    if (!event.step_id || typeof event.elapsed_ms !== 'number' || event.elapsed_ms < 0) return
    durations.set(event.step_id, Math.max(durations.get(event.step_id) || 0, event.elapsed_ms))
  })
  return [...durations.entries()]
    .map(([step, durationMs]) => ({ step, durationMs }))
    .filter(row => row.durationMs > 0)
}

/** Exact direct-task durations; absent timestamps stay absent rather than estimated. */
export function observedDirectDurations(task: TaskProjection): Array<{ step: string; durationMs: number }> {
  if (!task.direct) return []
  const assignment = task.direct.assignmentMessages[0]
  const returnedAt = task.direct.returnedAt ? Date.parse(task.direct.returnedAt) : Number.NaN
  const reviewedAt = task.direct.reviewedAt ? Date.parse(task.direct.reviewedAt) : Number.NaN
  const createdAt = Date.parse(assignment.created_at || '')
  const deliveredAt = Date.parse(assignment.delivered_at || '')
  const startedAt = Date.parse(assignment.started_at || '')
  const rows: Array<{ step: string; durationMs: number }> = []
  if (Number.isFinite(createdAt) && Number.isFinite(deliveredAt) && deliveredAt >= createdAt) {
    rows.push({ step: '派发 → 送达', durationMs: deliveredAt - createdAt })
  }
  if (Number.isFinite(startedAt) && Number.isFinite(returnedAt) && returnedAt >= startedAt) {
    rows.push({ step: '开始 → 返回', durationMs: returnedAt - startedAt })
  }
  if (Number.isFinite(returnedAt) && Number.isFinite(reviewedAt) && reviewedAt >= returnedAt) {
    rows.push({ step: '返回 → 审核', durationMs: reviewedAt - returnedAt })
  }
  return rows
}
