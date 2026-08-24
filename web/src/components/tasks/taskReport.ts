import type { InboxMessage, MemorySummary, WorkflowEvent } from '../../api'
import type { HydratedTerminal, TaskProjection } from './taskModel'
import { inboxEvidenceForTask, observedDirectDurations, observedStepDurations, parseDiagnosticInputs, workerDisplayName, workerLaunchObservation, workerSessionUse } from './taskModel'

export interface TaskReportRecord {
  schema: 'cao-task-report/v1'
  generated_at: string
  task: {
    id: string
    kind: string
    title: string
    state: string
    started_at: string | null
    finished_at: string | null
  }
  contract: {
    goal: string
    effort: string
    scope: string
    stop_when: string
    return: string
  }
  execution: {
    steps: Array<{
      id: string
      state: string
      attempts: number
      terminal_id: string
      error: string
      output: unknown
    }>
    workers: Array<{
      terminal_id: string
      display_name: string
      provider: string
      profile: string
      launch_model: string
      launch_model_source: string
      launch_reasoning_effort: string
      launch_reasoning_effort_source: string
      session_use: string
      caller_id: string
      status: string
      created_at: string
      last_active: string
    }>
    chronology: Array<{
      timestamp: string
      event: string
      step: string
      terminal_id: string
      state: string
    }>
    queued_messages: Array<{
      id: string
      sender_id: string
      receiver_id: string
      status: string
      created_at: string
      delivered_at: string
      started_at: string
      reviewed_at: string
      task_id: string
      reply_to_message_id: string
      review_verdict: string
      message: string
    }>
  }
  provenance: {
    spec_id: string
    spec_content_hash: string
    capture_enabled: boolean | string
    providers: string[]
    agent_profiles: string[]
    engines: string[]
    inbox_binding: string
  }
  verification: {
    verdict: string
    completion_is_acceptance: false
    step_durations_ms: Array<{ step: string; duration_ms: number }>
    declared_event_gaps: number
  }
  artifacts: string[]
  project_memory: Array<{
    key: string
    type: string
    scope: string
    scope_id: string
    updated_at: string
  }>
  unresolved_risks: string[]
  evidence_notes: string[]
}

const UNOBSERVED = '未观测'

function textField(inputs: Record<string, unknown> | null, key: string): string {
  if (!inputs) return UNOBSERVED
  const value = inputs[key]
  return typeof value === 'string' && value.trim() ? value.trim() : UNOBSERVED
}

function terminalRow(worker: HydratedTerminal, task: TaskProjection) {
  const launch = workerLaunchObservation(worker, task)
  const sessionUse = workerSessionUse(worker, task)
  return {
    terminal_id: worker.id,
    display_name: workerDisplayName(worker, task),
    provider: worker.provider || UNOBSERVED,
    profile: worker.agent_profile || UNOBSERVED,
    launch_model: launch.model.value || UNOBSERVED,
    launch_model_source: launch.model.source,
    launch_reasoning_effort: launch.reasoningEffort.value || UNOBSERVED,
    launch_reasoning_effort_source: launch.reasoningEffort.source,
    session_use: sessionUse,
    caller_id: worker.caller_id || UNOBSERVED,
    status: worker.status || UNOBSERVED,
    created_at: worker.created_at || UNOBSERVED,
    last_active: worker.last_active || UNOBSERVED,
  }
}

function chronology(events: WorkflowEvent[]) {
  return events.map(event => ({
    timestamp: event.ts || UNOBSERVED,
    event: event.event_type || UNOBSERVED,
    step: event.step_id || UNOBSERVED,
    terminal_id: event.terminal_id || UNOBSERVED,
    state: event.state || UNOBSERVED,
  }))
}

function directChronology(task: TaskProjection) {
  if (!task.direct) return []
  const rows: Array<{ timestamp: string; event: string; step: string; terminal_id: string; state: string }> = []
  task.direct.assignmentMessages.forEach(message => {
    rows.push({
      timestamp: message.created_at || UNOBSERVED,
      event: 'task.dispatched',
      step: 'direct-task',
      terminal_id: message.receiver_id,
      state: message.status,
    })
    if (message.delivered_at) rows.push({ timestamp: message.delivered_at, event: 'message.delivered', step: 'direct-task', terminal_id: message.receiver_id, state: 'delivered' })
    if (message.started_at) rows.push({ timestamp: message.started_at, event: 'task.started', step: 'direct-task', terminal_id: message.receiver_id, state: 'processing' })
  })
  task.direct.returnMessages.forEach(message => rows.push({
    timestamp: message.created_at || UNOBSERVED,
    event: 'task.returned',
    step: 'implementer-report',
    terminal_id: message.sender_id,
    state: 'returned',
  }))
  if (task.direct.reviewedAt) rows.push({
    timestamp: task.direct.reviewedAt,
    event: 'task.reviewed',
    step: 'architect-review',
    terminal_id: task.direct.architectIds[0] || UNOBSERVED,
    state: task.reviewVerdict || UNOBSERVED,
  })
  return rows.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0))
}

function parseStepOutput(value: string | null | undefined): unknown {
  if (!value) return UNOBSERVED
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed) } catch { return parsed }
    }
    return parsed
  } catch {
    return value
  }
}

function evidenceSnapshotTime(task: TaskProjection, events: WorkflowEvent[]): string {
  const candidates = [
    task.finishedAt,
    task.startedAt,
    ...events.map(event => event.ts),
    ...task.workers.map(worker => worker.last_active),
  ].filter((value): value is string => Boolean(value))
  return candidates.sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0] || UNOBSERVED
}

export function buildTaskReport(
  task: TaskProjection,
  inbox: InboxMessage[],
  projectMemories: MemorySummary[] = [],
): TaskReportRecord {
  const evidence = task.evidence
  const inputs = parseDiagnosticInputs(evidence?.diagnostics || null)
  const steps = evidence?.inspection?.steps || []
  const events = evidence?.timeline.events || []
  const gaps = evidence?.timeline.gaps || []
  const artifacts = evidence?.diagnostics?.references.artifacts || []
  const resultSteps = new Map((evidence?.result?.steps || []).map(step => [step.id, step]))
  const boundInbox = inboxEvidenceForTask(task, inbox)
  const risks: string[] = []

  if (task.kind === 'live') risks.push('该终端组没有五字段任务或持久工作流记录；任务定义和正式验收可能缺失。')
  if (task.direct?.binding === 'historical-inference') risks.push('该直接任务来自旧版 inbox；回报关联按双向终端和相邻任务时间窗历史推定。')
  if (!task.reviewVerdict) risks.push('没有观察到结构化 ACCEPT/REJECT 审核结论；完成状态不能视为通过。')
  if (gaps.length > 0) risks.push(`事件时间线声明了 ${gaps.length} 个缺口，报告不推断缺失内容。`)
  if (steps.some(step => step.error)) risks.push('至少一个步骤记录了错误；请查看步骤详情和诊断包。')
  if (task.workers.length === 0) risks.push('没有观察到与该任务绑定的终端。')
  if (artifacts.length === 0) risks.push('没有结构化产物索引；直接任务的文件和测试仍保留在实现者原始回报中。')

  const durationRows = task.direct ? observedDirectDurations(task) : observedStepDurations(events)
  if (durationRows.length === 0 && !task.direct) risks.push('没有可用于绘图的步骤耗时证据，因此未生成数值图。')

  const directSteps = (task.direct?.returnMessages || []).map(message => ({
    id: `implementer-report-${message.id}`,
    state: 'returned',
    attempts: 1,
    terminal_id: message.sender_id,
    error: UNOBSERVED,
    output: message.message,
  }))

  return {
    schema: 'cao-task-report/v1',
    // Use the newest observed evidence timestamp so identical evidence exports
    // produce identical reports. The browser's wall clock is not evidence.
    generated_at: evidenceSnapshotTime(task, events),
    task: {
      id: task.id,
      kind: task.kind,
      title: task.title,
      state: task.state,
      started_at: task.startedAt,
      finished_at: task.finishedAt,
    },
    contract: {
      goal: task.direct?.contract.goal || textField(inputs, 'goal'),
      effort: task.direct?.contract.effort || textField(inputs, 'effort'),
      scope: task.direct?.contract.scope || textField(inputs, 'scope'),
      stop_when: task.direct?.contract.stop_when || textField(inputs, 'stop_when'),
      return: task.direct?.contract.return || textField(inputs, 'return'),
    },
    execution: {
      steps: task.direct ? directSteps : steps.map(step => ({
        id: step.id,
        state: step.state,
        attempts: step.attempts,
        terminal_id: step.terminal_id || UNOBSERVED,
        error: step.error || UNOBSERVED,
        output: step.output_json ? parseStepOutput(step.output_json) : resultSteps.get(step.id)?.output ?? UNOBSERVED,
      })),
      workers: task.workers.map(worker => terminalRow(worker, task)),
      chronology: task.direct ? directChronology(task) : chronology(events),
      queued_messages: boundInbox.map(message => ({
        id: message.id,
        sender_id: message.sender_id,
        receiver_id: message.receiver_id,
        status: message.status,
        created_at: message.created_at || UNOBSERVED,
        delivered_at: message.delivered_at || UNOBSERVED,
        started_at: message.started_at || UNOBSERVED,
        reviewed_at: message.reviewed_at || UNOBSERVED,
        task_id: message.task_id || UNOBSERVED,
        reply_to_message_id: message.reply_to_message_id == null ? UNOBSERVED : String(message.reply_to_message_id),
        review_verdict: message.review_verdict || UNOBSERVED,
        message: message.message,
      })),
    },
    provenance: {
      spec_id: task.direct ? task.id.replace(/^direct:/, '') : evidence?.diagnostics?.spec_id || UNOBSERVED,
      spec_content_hash: evidence?.diagnostics?.spec_content_hash || UNOBSERVED,
      capture_enabled: evidence?.diagnostics?.capture_enabled ?? UNOBSERVED,
      providers: evidence?.diagnostics?.environment.providers || [],
      agent_profiles: evidence?.diagnostics?.environment.agent_profiles || [],
      engines: evidence?.diagnostics?.environment.engines || [],
      inbox_binding: task.direct
        ? task.direct.binding === 'persisted-task-id'
          ? 'persisted task_id + reply_to_message_id + exact sender/receiver records'
          : 'legacy five-field root + bidirectional terminal pair + adjacent-task time window; labelled historical inference'
        : task.kind === 'workflow'
        ? 'receiver terminal + recorded caller + worker lifetime + workflow time window; inbox API has no run_id'
        : 'receiver terminal + recorded caller + worker lifetime + live-session time window; not a durable workflow binding',
    },
    verification: {
      verdict: task.reviewVerdict || UNOBSERVED,
      completion_is_acceptance: false,
      step_durations_ms: durationRows.map(row => ({ step: row.step, duration_ms: row.durationMs })),
      declared_event_gaps: gaps.length,
    },
    artifacts,
    project_memory: projectMemories.map(memory => ({
      key: memory.key,
      type: memory.memory_type,
      scope: memory.scope,
      scope_id: memory.scope_id || UNOBSERVED,
      updated_at: memory.updated_at || UNOBSERVED,
    })),
    unresolved_risks: risks,
    evidence_notes: [
      '本报告只使用 CAO 持久工作流记录、诊断包、终端元数据和收件箱状态。',
      '“未观测”表示接口没有提供证据，不代表事件一定没有发生。',
      '终端完成与架构师验收是两个独立状态。',
      '报告时间取最新可观测证据时间；不会用浏览器当前时间制造不可复现差异。',
      task.direct
        ? '新版直接任务使用持久 task_id/reply_to；旧记录的时间窗关联始终标注为历史推定。'
        : '工作流收件箱消息没有 run_id；仅保留接收终端、明确上游、工作者生命周期和任务时间窗口同时匹配的记录。',
    ],
  }
}

function mdCell(value: unknown): string {
  return String(value ?? UNOBSERVED).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

export function taskReportMarkdown(report: TaskReportRecord): string {
  const lines: string[] = [
    `# CAO 任务报告：${report.task.title}`,
    '',
    `- 任务 ID：\`${report.task.id}\``,
    `- 类型：${report.task.kind === 'workflow' ? '持久工作流' : report.task.kind === 'direct' ? '持久直接任务' : '未结构化实时工作'}`,
    `- 运行状态：${report.task.state}`,
    `- 独立审核：${report.verification.verdict}`,
    `- 开始：${report.task.started_at || UNOBSERVED}`,
    `- 结束：${report.task.finished_at || UNOBSERVED}`,
    `- 报告生成：${report.generated_at}`,
    '',
    '## 五字段任务契约',
    '',
    `### GOAL\n\n${report.contract.goal}`,
    '',
    `### EFFORT\n\n${report.contract.effort}`,
    '',
    `### SCOPE\n\n${report.contract.scope}`,
    '',
    `### STOP WHEN\n\n${report.contract.stop_when}`,
    '',
    `### RETURN\n\n${report.contract.return}`,
    '',
    '## 步骤结果',
    '',
    '| 步骤 | 状态 | 尝试 | 终端 | 错误 |',
    '|---|---:|---:|---|---|',
    ...report.execution.steps.map(step => `| ${mdCell(step.id)} | ${mdCell(step.state)} | ${step.attempts} | ${mdCell(step.terminal_id)} | ${mdCell(step.error)} |`),
    '',
    '## 智能体步骤原始报告',
    '',
    ...report.execution.steps.flatMap(step => {
      const rendered = typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2)
      return [`### ${step.id}`, '', ...(rendered || UNOBSERVED).split(/\r?\n/).map(line => `    ${line}`), '']
    }),
    '',
    '## 智能体与终端',
    '',
    '| 名称 | 终端 | Provider | Profile | 模型（来源） | 推理档位（来源） | 会话 | 上游终端 | 状态 | 创建 | 最近活动 |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.execution.workers.map(worker => `| ${mdCell(worker.display_name)} | ${mdCell(worker.terminal_id)} | ${mdCell(worker.provider)} | ${mdCell(worker.profile)} | ${mdCell(worker.launch_model)} (${mdCell(worker.launch_model_source)}) | ${mdCell(worker.launch_reasoning_effort)} (${mdCell(worker.launch_reasoning_effort_source)}) | ${mdCell(worker.session_use)} | ${mdCell(worker.caller_id)} | ${mdCell(worker.status)} | ${mdCell(worker.created_at)} | ${mdCell(worker.last_active)} |`),
    '',
    '## 来源与运行环境',
    '',
    `- 工作流定义：${report.provenance.spec_id}`,
    `- 定义内容哈希：${report.provenance.spec_content_hash}`,
    `- 捕获启用：${report.provenance.capture_enabled}`,
    `- Providers：${report.provenance.providers.join(', ') || UNOBSERVED}`,
    `- Profiles：${report.provenance.agent_profiles.join(', ') || UNOBSERVED}`,
    `- Engines：${report.provenance.engines.join(', ') || UNOBSERVED}`,
    `- 收件箱绑定边界：${report.provenance.inbox_binding}`,
    '',
    '## 收件箱消息证据（按绑定边界筛选）',
    '',
    '| 消息 | 任务 | 回复 | 发送者 | 接收者 | 状态 | 派发 | 送达/开始 | 审核 | 内容 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...(report.execution.queued_messages.length
      ? report.execution.queued_messages.map(message => `| ${mdCell(message.id)} | ${mdCell(message.task_id)} | ${mdCell(message.reply_to_message_id)} | ${mdCell(message.sender_id)} | ${mdCell(message.receiver_id)} | ${mdCell(message.status)} | ${mdCell(message.created_at)} | ${mdCell(message.delivered_at)} / ${mdCell(message.started_at)} | ${mdCell(message.review_verdict)} @ ${mdCell(message.reviewed_at)} | ${mdCell(message.message)} |`)
      : [`| ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} | ${UNOBSERVED} |`]),
    '',
    '## 验证与科研证据',
    '',
    `- 明确审核结论：${report.verification.verdict}`,
    '- 完成是否自动等于验收：否',
    `- 声明的事件缺口：${report.verification.declared_event_gaps}`,
    `- 可绘制耗时记录：${report.verification.step_durations_ms.length}`,
    '',
    '## 产物',
    '',
    ...(report.artifacts.length ? report.artifacts.map(item => `- ${item}`) : [`- ${UNOBSERVED}`]),
    '',
    '## 项目长期记忆索引',
    '',
    ...(report.project_memory.length
      ? report.project_memory.map(memory => `- ${memory.key} · ${memory.type} · ${memory.scope} · ${memory.updated_at}`)
      : [`- ${UNOBSERVED}`]),
    '',
    '## 未解决风险',
    '',
    ...(report.unresolved_risks.length ? report.unresolved_risks.map(item => `- ${item}`) : ['- 未观察到额外风险。']),
    '',
    '## 证据边界',
    '',
    ...report.evidence_notes.map(item => `- ${item}`),
    '',
  ]
  return lines.join('\n')
}

export function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function safeReportFilename(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'cao-task'
}
