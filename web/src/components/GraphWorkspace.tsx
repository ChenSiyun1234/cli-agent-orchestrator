import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bot,
  Brain,
  CheckCircle2,
  CircleStop,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  GitCommitHorizontal,
  Loader2,
  Maximize2,
  MemoryStick,
  MessageSquareText,
  Network,
  PauseCircle,
  Play,
  RefreshCw,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  TestTube2,
  X,
} from 'lucide-react'
import type {
  EventTimelinePage,
  InboxMessage,
  MemorySummary,
  RunInspection,
  RunSummaryRow,
  TerminalMeta,
} from '../api'
import { api } from '../api'
import { useStore } from '../store'
import { TerminalView } from './TerminalView'
import { relatedInboxEndpointIds } from './tasks/TaskCenter'
import {
  buildTaskProjections,
  deriveStages,
  mergeTerminal,
  normalizeState,
  workerLaunchObservation,
  type HydratedTerminal,
  type TaskProjection,
  type WorkflowEvidence,
} from './tasks/taskModel'

type Tone = 'active' | 'done' | 'idle' | 'warn' | 'error' | 'unknown'
type NodeKind = 'task' | 'architect' | 'handoff' | 'implementer' | 'report' | 'review' | 'publish' | 'contract' | 'memory' | 'artifact' | 'system' | 'stage'

interface DetailNode {
  id: string
  kind: NodeKind
  title: string
  subtitle: string
  status: string
  tone: Tone
  timestamp?: string | null
  body: string
  meta?: Record<string, string>
  terminal?: HydratedTerminal
  memory?: MemorySummary
  task?: TaskProjection
}

interface PositionedNode extends DetailNode {
  x: number
  y: number
  width: number
  height: number
}

interface GraphEdge {
  id: string
  source: string
  target: string
  label: string
  tone: Tone
}

interface GraphSnapshot {
  nodes: PositionedNode[]
  edges: GraphEdge[]
  width: number
  height: number
}

const EMPTY_TIMELINE: EventTimelinePage = { events: [], gaps: [], next_after_seq: null }
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled'])
const ACTIVE_STATES = new Set(['running', 'processing', 'waiting_user_answer', 'queued', 'returned'])

const TONE_CLASS: Record<Tone, string> = {
  active: 'border-sky-400/70 bg-sky-950/85 text-sky-100 shadow-[0_0_28px_rgba(56,189,248,.16)]',
  done: 'border-emerald-400/60 bg-emerald-950/75 text-emerald-100',
  idle: 'border-violet-400/50 bg-violet-950/70 text-violet-100',
  warn: 'border-amber-400/65 bg-amber-950/75 text-amber-100',
  error: 'border-rose-400/65 bg-rose-950/75 text-rose-100',
  unknown: 'border-slate-600 bg-slate-900/90 text-slate-300',
}

const DOT_CLASS: Record<Tone, string> = {
  active: 'bg-sky-300 animate-pulse',
  done: 'bg-emerald-300',
  idle: 'bg-violet-300',
  warn: 'bg-amber-300',
  error: 'bg-rose-300',
  unknown: 'bg-slate-500',
}

const STATE_LABEL: Record<string, string> = {
  processing: '正在推理 / 执行',
  running: '正在运行',
  waiting_user_answer: '等待你的回答',
  queued: '等待送达',
  returned: '已回报，等待审核',
  handoff_missing: '本轮停止，但回报未登记',
  completed: '已完成',
  idle: '已空闲',
  failed: '失败',
  error: '终端不可用',
  disconnected: '终端已退出',
  cancelled: '已暂停 / 取消',
  historical_unresolved: '历史记录未闭环',
  unknown: '状态未观测',
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '未观测'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return '从未同步'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 8) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

function short(value: string, max = 38): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

function toneFromState(value: string | null | undefined): Tone {
  const state = normalizeState(value)
  if (['processing', 'running'].includes(state)) return 'active'
  if (['completed', 'returned'].includes(state)) return 'done'
  if (state === 'idle') return 'idle'
  if (['waiting_user_answer', 'queued', 'handoff_missing'].includes(state)) return 'warn'
  if (['failed', 'error', 'disconnected', 'cancelled'].includes(state)) return 'error'
  return 'unknown'
}

function statusLabel(value: string | null | undefined): string {
  const state = normalizeState(value)
  return STATE_LABEL[state] || STATE_LABEL.unknown
}

function metadataText(terminal: HydratedTerminal | undefined, key: string): string | null {
  const value = terminal?.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function terminalRole(terminal: HydratedTerminal | undefined, fallbackId: string): { role: string; kind: NodeKind } {
  const text = `${terminal?.provider || ''} ${terminal?.agent_profile || ''}`.toLowerCase()
  const explicit = metadataText(terminal, 'display_name') || metadataText(terminal, 'role_name')
  if (text.includes('architect') || text.includes('codex')) return { role: explicit || 'Codex 架构师 / 审核者', kind: 'architect' }
  if (text.includes('claude') || text.includes('implement')) return { role: explicit || 'Claude 实现者', kind: 'implementer' }
  return { role: explicit || terminal?.agent_profile || `智能体 ${fallbackId.slice(0, 8)}`, kind: 'implementer' }
}

function terminalNode(
  task: TaskProjection,
  terminalId: string,
  terminal: HydratedTerminal | undefined,
  x: number,
  y: number,
  hasPersistedHandback = false,
): PositionedNode {
  const { role, kind } = terminalRole(terminal, terminalId)
  if (!terminal) {
    return {
      id: `terminal:${terminalId}`,
      kind,
      title: role,
      subtitle: `终端 ${terminalId}`,
      status: '终端记录不存在',
      tone: 'error',
      body: '任务记录引用了这个终端，但当前 CAO session 已无法返回该终端。它不能被打开，也不应显示为“安静运行中”；历史消息与报告仍保留为证据。',
      meta: { 终端: terminalId, 可打开: '否', 原因: '当前 session 未返回终端记录' },
      x, y, width: 206, height: 98,
    }
  }
  const launch = workerLaunchObservation(terminal, task)
  const reachable = terminal.reachable !== false && normalizeState(terminal.status) !== 'error'
  const displayedState = hasPersistedHandback ? 'returned' : terminal.status
  return {
    id: `terminal:${terminal.id}`,
    kind,
    title: role,
    subtitle: `${terminal.provider} · ${terminal.id.slice(0, 8)}`,
    status: reachable ? statusLabel(displayedState) : '终端已退出，证据保留',
    tone: reachable ? toneFromState(displayedState) : 'error',
    timestamp: terminal.last_active,
    body: reachable
      ? hasPersistedHandback
        ? '该实现者已经产生与本任务绑定的持久最终回报。即使终端状态采样仍短暂显示 processing，工作流节点也以最终回报事件为准；点击“打开真实终端”仍会连接同一 tmux pane。'
        : '这是 CAO 当前返回的真实终端节点。点击“打开真实终端”会建立到同一 tmux pane 的双向 PTY，不复制终端内容到本图。'
      : 'CAO 仍保留这条终端记录，但对应 tmux pane 已不存在。实时终端无法打开；任务消息、报告和审计证据不会因此删除。',
    meta: {
      终端: terminal.id,
      Session: terminal.tmux_session || terminal.session_name || '未观测',
      Provider: terminal.provider,
      Profile: terminal.agent_profile || '未观测',
      模型: launch.model.value || '未观测',
      推理强度: launch.reasoningEffort.value || '未观测',
      上游终端: terminal.caller_id || '无 / 未观测',
      终端原始状态: statusLabel(terminal.status),
      持久最终回报: hasPersistedHandback ? '已观测' : '未观测',
      最近活动: formatTime(terminal.last_active),
      可打开: reachable ? '是' : '否',
    },
    terminal,
    x, y, width: 206, height: 98,
  }
}

function taskNode(task: TaskProjection, x: number, y: number): PositionedNode {
  const contract = task.direct?.contract
  return {
    id: `task:${task.id}`,
    kind: 'task',
    title: short(task.title, 34),
    subtitle: task.subtitle,
    status: statusLabel(task.state),
    tone: toneFromState(task.state),
    timestamp: task.startedAt,
    body: contract
      ? `GOAL\n${contract.goal}\n\nEFFORT\n${contract.effort}\n\nSCOPE\n${contract.scope}\n\nSTOP WHEN\n${contract.stop_when}\n\nRETURN\n${contract.return}`
      : `任务：${task.title}\n运行：${task.subtitle}`,
    meta: {
      类型: task.kind === 'direct' ? '持久直接任务' : task.kind === 'workflow' ? '持久工作流' : '未结构化实时工作',
      状态: statusLabel(task.state),
      开始: formatTime(task.startedAt),
      结束: formatTime(task.finishedAt),
      审核: task.reviewVerdict || '未观测',
    },
    task,
    x, y, width: 220, height: 108,
  }
}

function makeEdge(source: string, target: string, label: string, tone: Tone = 'unknown'): GraphEdge {
  return { id: `${source}->${target}:${label}`, source, target, label, tone }
}

export function buildWorkflowGraph(task: TaskProjection | null): GraphSnapshot {
  if (!task) return { nodes: [], edges: [], width: 1180, height: 430 }

  if (!task.direct) {
    const stages = deriveStages(task)
    const nodes: PositionedNode[] = stages.map((stage, index) => ({
      id: `stage:${stage.key}`,
      kind: 'stage',
      title: stage.label,
      subtitle: short(stage.detail, 42),
      status: stage.state === 'active' ? '当前阶段' : stage.state === 'observed' ? '已有证据' : stage.state === 'failed' ? '失败' : '未观测',
      tone: stage.state === 'active' ? 'active' : stage.state === 'observed' ? 'done' : stage.state === 'failed' ? 'error' : 'unknown',
      timestamp: stage.timestamp,
      body: stage.detail,
      task,
      x: 40 + index * 250,
      y: 155,
      width: 205,
      height: 98,
    }))
    const edges = nodes.slice(1).map((node, index) => makeEdge(nodes[index].id, node.id, formatTime(node.timestamp), node.tone))
    task.workers.forEach((worker, index) => {
      const node = terminalNode(task, worker.id, worker, 540 + index * 225, 310)
      nodes.push(node)
      edges.push(makeEdge('stage:implementation', node.id, worker.caller_id ? `由 ${worker.caller_id.slice(0, 8)} 派发` : '终端关联', node.tone))
    })
    return { nodes, edges, width: Math.max(1300, 790 + task.workers.length * 225), height: task.workers.length ? 460 : 360 }
  }

  const direct = task.direct
  const assignments = direct.assignmentMessages.length ? direct.assignmentMessages : direct.messages.slice(0, 1)
  const rows = Math.max(1, assignments.length)
  const height = Math.max(440, rows * 150 + 170)
  const middleY = height / 2 - 54
  const taskVisual = taskNode(task, 24, middleY)
  taskVisual.width = 145
  const nodes: PositionedNode[] = [taskVisual]
  const edges: GraphEdge[] = []

  const architectId = direct.architectIds[0] || 'architect-unobserved'
  const architect = task.workers.find(worker => worker.id === architectId)
  const architectVisual = terminalNode(task, architectId, architect, 185, middleY)
  architectVisual.width = 160
  nodes.push(architectVisual)
  edges.push(makeEdge(`task:${task.id}`, architectVisual.id, '进入规划', architectVisual.tone))

  assignments.forEach((assignment, index) => {
    const y = 75 + index * 150
    const handoffId = `handoff:${assignment.id}`
    const handoffTone: Tone = assignment.status === 'failed' ? 'error' : assignment.delivered_at ? 'done' : 'warn'
    nodes.push({
      id: handoffId,
      kind: 'handoff',
      title: `派发消息 #${assignment.id}`,
      subtitle: `${assignment.sender_id.slice(0, 8)} → ${assignment.receiver_id.slice(0, 8)}`,
      status: assignment.status === 'pending' ? '等待送达' : assignment.started_at ? '实现者已开始' : assignment.delivered_at ? '实现者已接收' : assignment.status,
      tone: handoffTone,
      timestamp: assignment.started_at || assignment.delivered_at || assignment.created_at,
      body: assignment.message,
      meta: {
        创建: formatTime(assignment.created_at),
        送达: formatTime(assignment.delivered_at),
        开始执行: formatTime(assignment.started_at),
        状态: assignment.status,
        任务ID: assignment.task_id || '历史记录无 task_id',
      },
      task,
      x: 360, y, width: 145, height: 98,
    })
    edges.push(makeEdge(architectVisual.id, handoffId, '正式派发', handoffTone))

    const report = direct.returnMessages.find(message => (
      message.sender_id === assignment.receiver_id
      && (message.reply_to_message_id == null || String(message.reply_to_message_id) === String(assignment.id))
    ))
    const worker = task.workers.find(item => item.id === assignment.receiver_id)
    const workerVisual = terminalNode(task, assignment.receiver_id, worker, 520, y, Boolean(report))
    workerVisual.width = 155
    if (!report && assignment.status === 'pending' && workerVisual.tone !== 'error') {
      workerVisual.status = '等待接收本轮指令'
      workerVisual.tone = 'warn'
      workerVisual.body = '本轮五字段任务包已经持久化，但 CAO 尚未把它送入这个终端。终端上一轮的原始状态不代表本轮已经开始。'
    }
    nodes.push(workerVisual)
    edges.push(makeEdge(handoffId, workerVisual.id, assignment.started_at ? '已开始' : assignment.delivered_at ? '已接收' : '尚未接收', workerVisual.tone))

    const reportId = `report:${assignment.id}`
    nodes.push({
      id: reportId,
      kind: 'report',
      title: report ? `实现者回报 #${report.id}` : '实现者最终回报',
      subtitle: report ? `${report.sender_id.slice(0, 8)} → ${report.receiver_id.slice(0, 8)}` : '尚未形成持久回报事件',
      status: report ? '已交付给架构师' : normalizeState(worker?.status) === 'processing' ? '实现仍在进行' : '回报未观测',
      tone: report ? 'done' : normalizeState(worker?.status) === 'processing' ? 'active' : worker ? 'warn' : 'unknown',
      timestamp: report?.created_at || null,
      body: report?.message || '没有收到与这次派发绑定的实现者回报。若终端已经回到输入框，这里会明确显示“回报未观测”，而不是把任务伪装成安静运行。',
      meta: report ? { 回报时间: formatTime(report.created_at), 消息ID: String(report.id), 状态: report.status } : { 回报时间: '未观测' },
      task,
      x: 690, y, width: 155, height: 98,
    })
    edges.push(makeEdge(workerVisual.id, reportId, report ? '最终交付' : '等待交付', report ? 'done' : 'unknown'))
  })

  const amendmentOpen = assignments.some((assignment, index) => (
    index > 0
    && assignment.reply_to_message_id != null
    && !direct.returnMessages.some(message => (
      message.sender_id === assignment.receiver_id
      && (message.reply_to_message_id == null || String(message.reply_to_message_id) === String(assignment.id))
    ))
  ))
  const reviewId = `review:${task.id}`
  nodes.push({
    id: reviewId,
    kind: 'review',
    title: '架构师独立审核',
    subtitle: amendmentOpen && task.reviewVerdict === 'REJECT' ? '上一轮 REJECT，修订包已建立' : task.reviewVerdict ? `明确结论 ${task.reviewVerdict}` : '只在实现者最终回报后开始',
    status: amendmentOpen ? '修订轮次等待 / 正在执行' : task.reviewVerdict ? `审核 ${task.reviewVerdict}` : direct.returnMessages.length ? '等待 / 正在审核' : '尚未进入审核',
    tone: amendmentOpen ? 'warn' : task.reviewVerdict === 'ACCEPT' ? 'done' : task.reviewVerdict === 'REJECT' ? 'error' : direct.returnMessages.length ? 'warn' : 'unknown',
    timestamp: direct.reviewedAt,
    body: direct.reviewMessages.map(message => message.message).join('\n\n') || '未观察到结构化 ACCEPT / REJECT。审核节点不会根据终端安静或任务文本自行猜测。',
    meta: { 审核结论: task.reviewVerdict || '未观测', 审核时间: formatTime(direct.reviewedAt) },
    task,
    x: 860, y: middleY, width: 145, height: 98,
  })
  assignments.forEach(assignment => edges.push(makeEdge(`report:${assignment.id}`, reviewId, direct.returnedAt ? '提交审核' : '等待回报', direct.returnMessages.length ? 'done' : 'unknown')))

  // Publication evidence must come from the worker handback/review, never
  // from the assignment packet (which often names the base commit).
  const allText = [...direct.returnMessages, ...direct.reviewMessages].map(message => message.message).join('\n')
  const publicationCommit = extractPublicationCommit(allText)
  const publishId = `publish:${task.id}`
  nodes.push({
    id: publishId,
    kind: 'publish',
    title: '提交与远端发布',
    subtitle: publicationCommit ? short(publicationCommit, 44) : '没有结构化 Git 发布证据',
    status: amendmentOpen ? '等待修订轮次通过审核' : task.reviewVerdict === 'ACCEPT' ? publicationCommit ? '提交 / 推送证据已观测' : '已验收，发布未观测' : '审核通过后执行',
    tone: amendmentOpen ? 'unknown' : task.reviewVerdict === 'ACCEPT' ? publicationCommit ? 'done' : 'warn' : task.reviewVerdict === 'REJECT' ? 'error' : 'unknown',
    timestamp: direct.reviewedAt,
    body: publicationCommit || '界面不会把“base commit / accepted commit / no commit / no push”误认成发布。只有持久报告明确声明新提交、已提交或已推送并给出哈希时，此节点才会变绿。',
    meta: { 审核: task.reviewVerdict || '未观测', Git发布证据: publicationCommit || '未观测' },
    task,
    x: 1020, y: middleY, width: 145, height: 98,
  })
  edges.push(makeEdge(reviewId, publishId, task.reviewVerdict || '等待审核', task.reviewVerdict === 'ACCEPT' ? 'done' : 'unknown'))
  return { nodes, edges, width: 1185, height }
}

interface EvidenceItem { kind: 'commit' | 'hash' | 'test' | 'run'; value: string }

export function extractEvidence(text: string): EvidenceItem[] {
  const found: EvidenceItem[] = []
  const seen = new Set<string>()
  const add = (kind: EvidenceItem['kind'], value: string) => {
    const clean = value.trim().replace(/[),.;]+$/, '')
    const key = `${kind}:${clean.toLowerCase()}`
    if (!clean || seen.has(key)) return
    seen.add(key)
    found.push({ kind, value: clean })
  }
  for (const match of text.matchAll(/(?:commit|\bHEAD\b|revision|提交|推送)[^\r\n0-9a-f]{0,28}([0-9a-f]{7,40})\b/gi)) add('commit', match[1])
  for (const match of text.matchAll(/\b[0-9a-f]{64}\b/gi)) add('hash', match[0])
  for (const match of text.matchAll(/\b\d+\s+(?:passed|failed|skipped|xfailed|xpassed)(?:[^\r\n]{0,72})/gi)) add('test', match[0])
  for (const match of text.matchAll(/\b(?:augr|unidlq|cao)[a-z0-9_-]*(?:20\d{6,})[a-z0-9_-]*\b/gi)) add('run', match[0])
  return found.slice(0, 12)
}

export function extractPublicationCommit(text: string): string | null {
  // A handback commonly records the accepted/base commit while explicitly
  // saying that it did not commit or push.  Such lineage is useful evidence,
  // but it is not publication evidence.
  const patterns = [
    /\b(?:created|produced|resulting|new|final)\s+commit(?:\s+(?:is|as))?\s*[:#-]?\s*([0-9a-f]{7,40})\b/i,
    /\bcommitted(?:\s+and\s+pushed)?(?:\s+(?:as|commit))?\s*[:#-]?\s*([0-9a-f]{7,40})\b/i,
    /\b(?:pushed|published)(?:\s+commit)?\s*[:#-]?\s*([0-9a-f]{7,40})\b/i,
    /\bHEAD\s+(?:is\s+now|now|advanced\s+to)\s*[:#-]?\s*([0-9a-f]{7,40})\b/i,
    /(?:已提交|已推送|提交并推送)[^0-9a-f]{0,24}([0-9a-f]{7,40})\b/i,
  ]
  const negative = /\b(?:no|without)\s+(?:new\s+)?commit\b|\bnot\s+committed\b|\b(?:no|without)\s+push\b|\bnot\s+pushed\b|未提交|未推送/i
  for (const line of text.split(/\r?\n/).reverse()) {
    if (negative.test(line)) continue
    for (const pattern of patterns) {
      const match = line.match(pattern)
      if (match) return match[1]
    }
  }
  return null
}

export function buildEvidenceGraph(
  task: TaskProjection | null,
  memories: MemorySummary[],
  system: { sessions: number; terminals: number; runs: number; connected: boolean; lastSync: string | null },
): GraphSnapshot {
  if (!task) return { nodes: [], edges: [], width: 1280, height: 690 }
  const center = taskNode(task, 520, 280)
  center.width = 230
  center.height = 112
  const nodes: PositionedNode[] = [center]
  const edges: GraphEdge[] = []
  const root = center.id
  const contract = task.direct?.contract
  const contractRows = [
    ['GOAL', contract?.goal || task.title],
    ['EFFORT', contract?.effort || '未观测'],
    ['SCOPE', contract?.scope || '未观测'],
    ['STOP WHEN', contract?.stop_when || '未观测'],
    ['RETURN', contract?.return || '未观测'],
  ]
  contractRows.forEach(([label, value], index) => {
    const id = `contract:${label}`
    nodes.push({
      id, kind: 'contract', title: label, subtitle: short(value, 34), status: value === '未观测' ? '未观测' : '已绑定任务',
      tone: value === '未观测' ? 'unknown' : 'done', body: value, task,
      x: 30, y: 35 + index * 112, width: 210, height: 90,
    })
    edges.push(makeEdge(id, root, '任务约束', value === '未观测' ? 'unknown' : 'done'))
  })

  const relevantMemories = [...memories]
    .sort((a, b) => {
      const aRelevant = /unidlq|research|project-stage|collaboration-protocol/i.test(a.key) ? 1 : 0
      const bRelevant = /unidlq|research|project-stage|collaboration-protocol/i.test(b.key) ? 1 : 0
      return bRelevant - aRelevant || Date.parse(b.updated_at || '') - Date.parse(a.updated_at || '')
    })
    .slice(0, 4)
  if (relevantMemories.length) {
    relevantMemories.forEach((memory, index) => {
      const id = `memory:${memory.scope}:${memory.scope_id || ''}:${memory.key}`
      nodes.push({
        id, kind: 'memory', title: short(memory.key, 28), subtitle: `${memory.memory_type} · ${memory.scope}`,
        status: '项目记忆已观测', tone: 'done', timestamp: memory.updated_at,
        body: '点击节点后从 CAO memory API 读取正文。正文按纯文本显示，不会当作指令执行。',
        meta: { 范围: memory.scope, 范围ID: memory.scope_id || '无', 类型: memory.memory_type, 更新时间: formatTime(memory.updated_at) },
        memory, task, x: 300 + index * 225, y: 35, width: 200, height: 90,
      })
      edges.push(makeEdge(root, id, '项目记忆', 'done'))
    })
  } else {
    const id = 'memory:empty'
    nodes.push({
      id, kind: 'memory', title: '项目记忆库目前为空', subtitle: '这不是“没有发生任何工作”', status: '缺少持久 memory 节点', tone: 'warn',
      body: 'CAO memory API 没有返回 project 节点。任务消息、报告、实验和 Git 证据仍会显示在本图其他节点；这里明确标出缺口，避免整张图空白。',
      task, x: 505, y: 35, width: 240, height: 90,
    })
    edges.push(makeEdge(root, id, 'memory API', 'warn'))
  }

  const reports = task.direct?.returnMessages || []
  if (reports.length) {
    reports.slice(-4).forEach((message, index) => {
      const id = `evidence-report:${message.id}`
      nodes.push({
        id, kind: 'report', title: `实现报告 #${message.id}`, subtitle: short(message.message, 36), status: '持久回报', tone: 'done',
        timestamp: message.created_at, body: message.message,
        meta: { 发送者: message.sender_id, 接收者: message.receiver_id, 时间: formatTime(message.created_at), task_id: message.task_id || '未观测' },
        task, x: 1010, y: 95 + index * 118, width: 220, height: 94,
      })
      edges.push(makeEdge(root, id, formatTime(message.created_at), 'done'))
    })
  } else {
    const id = 'evidence-report:empty'
    nodes.push({
      id, kind: 'report', title: '最终报告尚未形成', subtitle: '等待实现者单次最终交付事件', status: '未观测', tone: ACTIVE_STATES.has(task.state) ? 'active' : 'warn',
      body: '这里等待结构化回报，而不是读取终端是否安静来猜测完成。实现者回到输入框但没有发送回报时，本节点仍会明确保持未观测。',
      task, x: 1010, y: 220, width: 220, height: 94,
    })
    edges.push(makeEdge(root, id, '等待持久事件', 'unknown'))
  }

  const text = [
    task.direct?.messages.map(message => message.message).join('\n') || '',
    task.evidence?.result ? JSON.stringify(task.evidence.result) : '',
    task.evidence?.diagnostics ? JSON.stringify(task.evidence.diagnostics) : '',
  ].join('\n')
  const artifacts = extractEvidence(text).slice(0, 4)
  artifacts.forEach((item, index) => {
    const iconLabel = item.kind === 'commit' ? 'Git 提交引用' : item.kind === 'hash' ? 'SHA-256 证据' : item.kind === 'test' ? '测试结果' : '实验 / 运行'
    const id = `artifact:${item.kind}:${index}`
    nodes.push({
      id, kind: 'artifact', title: iconLabel, subtitle: short(item.value, 34), status: '从持久任务证据提取', tone: item.kind === 'test' && /failed/i.test(item.value) ? 'warn' : 'done',
      body: item.value, meta: { 来源: '当前任务的持久消息 / workflow 结果', 类别: item.kind }, task,
      x: 285 + index * 235, y: 565, width: 210, height: 90,
    })
    edges.push(makeEdge(root, id, iconLabel, item.kind === 'test' && /failed/i.test(item.value) ? 'warn' : 'done'))
  })
  if (!artifacts.length) {
    const id = 'artifact:empty'
    nodes.push({
      id, kind: 'artifact', title: '提交 / 实验 / 测试证据', subtitle: '当前持久报告尚未提供可识别记录', status: '未观测', tone: 'unknown',
      body: '此节点不会根据 ACCEPT 或终端输出自行伪造提交、实验或测试结果。最终报告出现 commit、run/attempt ID、SHA-256 或测试计数后会自动拆成独立节点。',
      task, x: 510, y: 565, width: 250, height: 90,
    })
    edges.push(makeEdge(root, id, '等待报告证据', 'unknown'))
  }

  const systemId = 'system:cao'
  nodes.push({
    id: systemId, kind: 'system', title: 'CAO 运行底座', subtitle: `${system.sessions} Session · ${system.terminals} 终端 · ${system.runs} 运行`,
    status: system.connected ? `实时同步 · ${relativeTime(system.lastSync)}` : '后端连接中断', tone: system.connected ? 'idle' : 'error',
    body: '该节点只显示无模型的 CAO 服务端观测。服务端轮询状态、日志和事件不会调用 Codex/Claude；只有智能体真正推理或执行工具时才消耗模型 token。',
    meta: { Session数: String(system.sessions), 终端数: String(system.terminals), 工作流运行数: String(system.runs), 最近同步: formatTime(system.lastSync) },
    task, x: 770, y: 290, width: 205, height: 96,
  })
  edges.push(makeEdge(root, systemId, '无模型观测', system.connected ? 'idle' : 'error'))
  return { nodes, edges, width: 1280, height: 700 }
}

function GraphIcon({ kind, size = 15 }: { kind: NodeKind; size?: number }) {
  if (kind === 'architect' || kind === 'implementer') return <Bot size={size} />
  if (kind === 'handoff') return <MessageSquareText size={size} />
  if (kind === 'report') return <FileCheck2 size={size} />
  if (kind === 'review') return <ShieldCheck size={size} />
  if (kind === 'publish') return <GitCommitHorizontal size={size} />
  if (kind === 'memory') return <MemoryStick size={size} />
  if (kind === 'artifact') return <TestTube2 size={size} />
  if (kind === 'system') return <Server size={size} />
  if (kind === 'contract') return <CheckCircle2 size={size} />
  return <Activity size={size} />
}

function GraphCanvas({ snapshot, label, onSelect }: { snapshot: GraphSnapshot; label: string; onSelect: (node: DetailNode) => void }) {
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]))
  if (!snapshot.nodes.length) {
    return (
      <div className="flex h-[390px] items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-950/45 text-center">
        <div><Network size={30} className="mx-auto text-slate-700" /><p className="mt-3 text-sm text-slate-500">还没有可绘制的任务证据</p><p className="mt-1 text-xs text-slate-700">连接恢复或出现持久任务后会自动生成节点</p></div>
      </div>
    )
  }
  return (
    <div className="graph-scroll relative overflow-auto rounded-2xl border border-slate-700/80 bg-[#070b14]" aria-label={label}>
      <svg width={snapshot.width} height={snapshot.height} viewBox={`0 0 ${snapshot.width} ${snapshot.height}`} role="img" aria-label={label} className="block max-w-none bg-[radial-gradient(circle_at_50%_45%,rgba(15,118,110,.10),transparent_35%)]">
        <defs>
          <pattern id={`grid-${label}`} width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="#1e293b" strokeWidth="0.55" opacity="0.55" /></pattern>
          <marker id={`arrow-${label}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#64748b" /></marker>
        </defs>
        <rect width="100%" height="100%" fill={`url(#grid-${label})`} />
        {snapshot.edges.map(edge => {
          const source = byId.get(edge.source)
          const target = byId.get(edge.target)
          if (!source || !target) return null
          let sx: number
          let sy: number
          let tx: number
          let ty: number
          let labelX: number
          let labelY: number
          let path: string
          if (target.x >= source.x + source.width) {
            sx = source.x + source.width
            sy = source.y + source.height / 2
            tx = target.x
            ty = target.y + target.height / 2
            const mid = (sx + tx) / 2
            path = `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`
            labelX = mid
            labelY = (sy + ty) / 2 - 8
          } else if (target.y + target.height <= source.y) {
            sx = source.x + source.width / 2
            sy = source.y
            tx = target.x + target.width / 2
            ty = target.y + target.height
            const mid = (sy + ty) / 2
            path = `M ${sx} ${sy} C ${sx} ${mid}, ${tx} ${mid}, ${tx} ${ty}`
            labelX = (sx + tx) / 2
            labelY = mid - 6
          } else if (target.y >= source.y + source.height) {
            sx = source.x + source.width / 2
            sy = source.y + source.height
            tx = target.x + target.width / 2
            ty = target.y
            const mid = (sy + ty) / 2
            path = `M ${sx} ${sy} C ${sx} ${mid}, ${tx} ${mid}, ${tx} ${ty}`
            labelX = (sx + tx) / 2
            labelY = mid - 6
          } else {
            sx = source.x
            sy = source.y + source.height / 2
            tx = target.x + target.width
            ty = target.y + target.height / 2
            const mid = (sx + tx) / 2
            path = `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ty}, ${tx} ${ty}`
            labelX = mid
            labelY = (sy + ty) / 2 - 8
          }
          const stroke = edge.tone === 'active' ? '#38bdf8' : edge.tone === 'done' ? '#34d399' : edge.tone === 'error' ? '#fb7185' : edge.tone === 'warn' ? '#fbbf24' : '#64748b'
          return (
            <g key={edge.id}>
              <path d={path} fill="none" stroke={stroke} strokeWidth="2" opacity="0.85" markerEnd={`url(#arrow-${label})`} className={edge.tone === 'active' ? 'graph-edge-active' : ''} />
              <text x={labelX} y={labelY} textAnchor="middle" fill="#94a3b8" fontSize="10" className="select-none"><tspan className="graph-edge-label">{short(edge.label, 30)}</tspan></text>
            </g>
          )
        })}
        {snapshot.nodes.map(node => (
          <foreignObject key={node.id} x={node.x} y={node.y} width={node.width} height={node.height}>
            <button
              type="button"
              data-testid={`graph-node-${node.id}`}
              onClick={() => onSelect(node)}
              className={`h-full w-full rounded-2xl border px-3 py-2.5 text-left transition hover:-translate-y-0.5 hover:border-white/50 focus:outline-none ${TONE_CLASS[node.tone]}`}
            >
              <span className="flex items-center gap-2 text-[11px] font-semibold"><GraphIcon kind={node.kind} /><span className="truncate">{node.title}</span></span>
              <span className="mt-1.5 block truncate text-[10px] opacity-65">{node.subtitle}</span>
              <span className="mt-2 flex items-center gap-1.5 text-[10px]"><span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[node.tone]}`} /><span className="truncate">{node.status}</span></span>
              {node.timestamp ? <span className="mt-1 block truncate text-[9px] opacity-50">{formatTime(node.timestamp)}</span> : null}
            </button>
          </foreignObject>
        ))}
      </svg>
    </div>
  )
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

function NodeInspector({
  node,
  controllable,
  onClose,
  onOpenTerminal,
  onRefresh,
}: {
  node: DetailNode
  controllable: boolean
  onClose: () => void
  onOpenTerminal: (terminal: HydratedTerminal) => void
  onRefresh: () => void
}) {
  const showSnackbar = useStore(state => state.showSnackbar)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [memoryBody, setMemoryBody] = useState<string | null>(null)
  const [memoryError, setMemoryError] = useState<string | null>(null)

  useEffect(() => {
    setMessage('')
    setMemoryBody(null)
    setMemoryError(null)
    if (!node.memory) return
    let cancelled = false
    api.getMemory(node.memory.key, node.memory.scope, node.memory.scope_id || undefined)
      .then(detail => { if (!cancelled) setMemoryBody(detail.content) })
      .catch(error => { if (!cancelled) setMemoryError(error?.detail || error?.message || '记忆正文读取失败') })
    return () => { cancelled = true }
  }, [node.id])

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      showSnackbar({ type: 'success', message: success })
      setMessage('')
      onRefresh()
    } catch (error: any) {
      showSnackbar({ type: 'error', message: error?.detail || error?.message || '操作失败' })
    } finally {
      setBusy(false)
    }
  }

  const terminal = node.terminal
  const terminalOpenable = !!terminal && terminal.reachable !== false && normalizeState(terminal.status) !== 'error'
  const runTask = node.task?.run
  return (
    <div className="fixed inset-0 z-[60] flex justify-end bg-slate-950/55 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label={`节点详情 ${node.title}`}>
      <aside className="flex h-full w-full max-w-[470px] flex-col border-l border-slate-700 bg-[#0b101b] shadow-2xl">
        <div className="flex items-start justify-between border-b border-slate-800 px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-cyan-300"><GraphIcon kind={node.kind} /><span>节点详情</span></div>
            <h2 className="mt-2 break-words text-lg font-bold text-white">{node.title}</h2>
            <p className="mt-1 break-all text-xs text-slate-500">{node.subtitle}</p>
          </div>
          <button onClick={onClose} aria-label="关闭节点详情" className="rounded-lg p-2 text-slate-500 hover:bg-slate-800 hover:text-white"><X size={18} /></button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div className={`rounded-xl border px-3 py-2 text-xs ${TONE_CLASS[node.tone]}`}><span className={`mr-2 inline-block h-2 w-2 rounded-full ${DOT_CLASS[node.tone]}`} />{node.status}</div>
          {node.meta ? (
            <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-slate-800 bg-slate-950/55 p-4 text-xs">
              {Object.entries(node.meta).map(([key, value]) => <div className="contents" key={key}><dt className="text-slate-600">{key}</dt><dd className="break-all text-slate-300">{value}</dd></div>)}
            </dl>
          ) : null}
          <div className="rounded-xl border border-slate-800 bg-slate-950/55 p-4">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">完整证据 / 说明</div>
            {node.memory && memoryBody === null && !memoryError ? <div className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={13} className="animate-spin" />读取 memory 正文…</div> : null}
            {memoryError ? <p className="text-xs text-rose-300">{memoryError}</p> : null}
            <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-slate-300">{memoryBody ?? node.body}</pre>
          </div>

          {terminal ? (
            <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
              <div className="flex flex-wrap gap-2">
                <button disabled={!terminalOpenable} onClick={() => terminalOpenable && onOpenTerminal(terminal)} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"><SquareTerminal size={13} />打开真实终端</button>
                {terminalOpenable ? <a href={`unidlq-cao://terminal/${terminal.id}`} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-300 hover:border-slate-400"><ExternalLink size={13} />Windows Terminal</a> : null}
                <button disabled={!terminalOpenable || !controllable || busy} onClick={() => run(() => api.sendKey(terminal.id, 'C-c'), '已向该终端发送 Ctrl+C')} className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-950/25 px-3 py-2 text-xs text-rose-200 disabled:opacity-35"><CircleStop size={13} />打断当前命令</button>
              </div>
              {!terminalOpenable ? <p className="text-xs leading-5 text-rose-300">该 tmux pane 已退出或不可达，所以界面不会给出一个打不开的假按钮。历史证据仍可阅读。</p> : null}
              <textarea value={message} onChange={event => setMessage(event.target.value)} disabled={!terminalOpenable || !controllable} rows={4} placeholder="用英文输入对当前智能体的补充或修改；点击后直接送入真实终端。" className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-700 focus:border-cyan-500 focus:outline-none disabled:opacity-45" />
              <button disabled={!message.trim() || !terminalOpenable || !controllable || busy} onClick={() => run(() => api.sendInput(terminal.id, message.trim()), '补充指令已送入真实终端')} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs text-white hover:bg-sky-500 disabled:opacity-35"><Send size={13} />修改当前智能体任务</button>
            </div>
          ) : null}

          {runTask ? (
            <div className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-950/55 p-4">
              {!TERMINAL_STATES.has(normalizeState(runTask.state)) ? <button disabled={busy} onClick={() => run(() => api.cancelWorkflowRun(runTask.run_id), '工作流已暂停；持久 journal 保留')} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-950/25 px-3 py-2 text-xs text-amber-200"><PauseCircle size={13} />暂停工作流</button> : null}
              {['failed', 'cancelled'].includes(normalizeState(runTask.state)) ? <button disabled={busy} onClick={() => run(() => api.resumeWorkflowRun(runTask.run_id), '已从持久记录启动恢复')} className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-2 text-xs text-white"><Play size={13} />从记录恢复</button> : null}
            </div>
          ) : null}
        </div>
        <div className="border-t border-slate-800 p-4">
          <button onClick={() => downloadText(`${node.kind}-${node.id.replace(/[^a-z0-9_-]+/gi, '-')}.txt`, `${node.title}\n${node.subtitle}\n${node.status}\n\n${memoryBody ?? node.body}`)} className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500"><Download size={13} />下载这个节点的完整证据</button>
        </div>
      </aside>
    </div>
  )
}

export function GraphWorkspace({ embedded = false }: { embedded?: boolean }) {
  const [sessions, setSessions] = useState<Array<{ id: string; name: string; status: string }>>([])
  const [runs, setRuns] = useState<RunSummaryRow[]>([])
  const [evidenceByRun, setEvidenceByRun] = useState<Record<string, WorkflowEvidence>>({})
  const [terminals, setTerminals] = useState<HydratedTerminal[]>([])
  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [memories, setMemories] = useState<MemorySummary[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [liveTerminal, setLiveTerminal] = useState<HydratedTerminal | null>(null)
  const [connected, setConnected] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const refreshingRef = useRef(false)
  const selectedRef = useRef<string | null>(null)
  const evidenceRef = useRef<Record<string, WorkflowEvidence>>({})

  useEffect(() => { selectedRef.current = selectedTaskId }, [selectedTaskId])
  useEffect(() => { evidenceRef.current = evidenceByRun }, [evidenceByRun])
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])

  const refresh = useCallback(async (visible = false) => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    if (visible) setRefreshing(true)
    try {
      const [sessionRows, runRows] = await Promise.all([api.listSessions(), api.listWorkflowRuns()])
      const details = await Promise.all(sessionRows.map(session => api.getSession(session.name).catch(() => null)))
      const metas = [...new Map(details.flatMap(detail => detail?.terminals || []).map((meta: TerminalMeta) => [meta.id, meta])).values()]
      const hydrated = await Promise.all(metas.map(async meta => {
        try {
          return { ...mergeTerminal(meta, await api.getTerminal(meta.id)), reachable: true }
        } catch {
          return { ...mergeTerminal(meta), reachable: false }
        }
      }))
      const inboxGroups = await Promise.all(hydrated.map(terminal => api.getInboxMessages(terminal.id, 100, undefined, true).catch(() => [])))
      const firstHop = [...new Map(inboxGroups.flat().map(message => [String(message.id), message])).values()]
      const related = relatedInboxEndpointIds(firstHop, hydrated.map(terminal => terminal.id))
      const relatedGroups = await Promise.all(related.map(id => api.getInboxMessages(id, 100, undefined, true).catch(() => [])))
      const inboxRows = [...new Map([...firstHop, ...relatedGroups.flat()].map(message => [String(message.id), message])).values()]
      const selectedRun = selectedRef.current && runRows.some(run => run.run_id === selectedRef.current) ? selectedRef.current : null
      const liveIds = runRows.filter(run => !TERMINAL_STATES.has(normalizeState(run.state))).map(run => run.run_id)
      const hydrateIds = [...new Set([...liveIds, ...runRows.slice(0, 8).map(run => run.run_id), ...(selectedRun ? [selectedRun] : [])])]
      const evidencePairs = await Promise.all(hydrateIds.map(async runId => {
        try {
          const [inspection, timeline] = await Promise.all([api.inspectWorkflowRun(runId), api.getWorkflowRunEvents(runId)])
          const prior = evidenceRef.current[runId]
          return [runId, { inspection, timeline, diagnostics: prior?.diagnostics || null, result: prior?.result || null }] as const
        } catch {
          return [runId, evidenceRef.current[runId] || { inspection: null, timeline: EMPTY_TIMELINE, diagnostics: null, result: null }] as const
        }
      }))
      const memoryRows = await api.listMemories({ scope: 'project', limit: 100 }).catch(() => [] as MemorySummary[])
      if (mountedRef.current) {
        setSessions(sessionRows)
        setRuns(runRows)
        setTerminals(hydrated)
        setMessages(inboxRows)
        setMemories(memoryRows)
        setEvidenceByRun(current => ({ ...current, ...Object.fromEntries(evidencePairs) }))
        setConnected(true)
        setLoadError(null)
        setLastSync(new Date().toISOString())
      }
    } catch (error: any) {
      if (mountedRef.current) {
        setConnected(false)
        setLoadError(error?.detail || error?.message || '无法读取 CAO 当前状态')
      }
    } finally {
      refreshingRef.current = false
      if (mountedRef.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const loop = async () => {
      await refresh(false)
      if (!cancelled) timer = setTimeout(loop, 4000)
    }
    void loop()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [refresh])

  const tasks = useMemo(() => buildTaskProjections(runs, evidenceByRun, terminals, messages), [runs, evidenceByRun, terminals, messages])
  useEffect(() => {
    if (!tasks.length) return
    if (!selectedTaskId || !tasks.some(task => task.id === selectedTaskId)) {
      // Projections are newest-first.  An old unresolved inbox record must not
      // steal the landing view from the latest UniDLQ task.
      setSelectedTaskId(tasks[0].id)
    }
  }, [tasks, selectedTaskId])
  const selectedTask = tasks.find(task => task.id === selectedTaskId) || null

  useEffect(() => {
    const runId = selectedTask?.run?.run_id
    if (!runId) return
    const current = evidenceRef.current[runId]
    if (current?.diagnostics && current?.result) return
    let cancelled = false
    Promise.all([
      current?.inspection ? Promise.resolve(current.inspection) : api.inspectWorkflowRun(runId),
      current?.timeline ? Promise.resolve(current.timeline) : api.getWorkflowRunEvents(runId),
      api.getWorkflowRunDiagnostics(runId).catch(() => null),
      api.getWorkflowRunResult(runId).catch(() => null),
    ]).then(([inspection, timeline, diagnostics, result]) => {
      if (!cancelled) setEvidenceByRun(cache => ({ ...cache, [runId]: { inspection: inspection as RunInspection, timeline, diagnostics, result } }))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selectedTask?.id])

  const workflowGraph = useMemo(() => buildWorkflowGraph(selectedTask), [selectedTask])
  const evidenceGraph = useMemo(() => buildEvidenceGraph(selectedTask, memories, {
    sessions: sessions.length,
    terminals: terminals.length,
    runs: runs.length,
    connected,
    lastSync,
  }), [selectedTask, memories, sessions.length, terminals.length, runs.length, connected, lastSync])
  const allNodes = useMemo(() => [...workflowGraph.nodes, ...evidenceGraph.nodes], [workflowGraph, evidenceGraph])
  const selectedNode = allNodes.find(node => node.id === selectedNodeId) || null

  const controllableIds = useMemo(() => {
    const ids = new Set<string>()
    if (!selectedTask) return ids
    if (selectedTask.direct) {
      const current = new Set(selectedTask.direct.currentWorkerIds)
      selectedTask.workers.filter(worker => current.has(worker.id) && worker.reachable !== false && normalizeState(worker.status) !== 'error').forEach(worker => ids.add(worker.id))
    } else if (selectedTask.kind === 'live') {
      selectedTask.workers.filter(worker => worker.reachable !== false && normalizeState(worker.status) !== 'error').forEach(worker => ids.add(worker.id))
    }
    return ids
  }, [selectedTask])

  const activeRoundImplementerIds = new Set(
    selectedTask?.direct?.assignmentMessages
      .filter(assignment => {
        const returned = selectedTask.direct?.returnMessages.some(message => (
          message.sender_id === assignment.receiver_id
          && (message.reply_to_message_id == null || String(message.reply_to_message_id) === String(assignment.id))
        ))
        return !returned && Boolean(assignment.delivered_at || assignment.started_at)
      })
      .map(assignment => assignment.receiver_id) || [],
  )
  const activeArchitects = selectedTask?.workers.filter(worker => terminalRole(worker, worker.id).kind === 'architect' && normalizeState(worker.status) === 'processing') || []
  const activeImplementers = selectedTask?.workers.filter(worker => (
    terminalRole(worker, worker.id).kind === 'implementer'
    && normalizeState(worker.status) === 'processing'
    && (selectedTask.kind !== 'direct' || activeRoundImplementerIds.has(worker.id))
  )) || []
  const overlap = activeArchitects.length > 0 && activeImplementers.length > 0
  const activeTasks = tasks.filter(task => ACTIVE_STATES.has(normalizeState(task.state))).length
  const selectedRunningAgents = activeArchitects.length + activeImplementers.length

  return (
    <div className={embedded ? 'text-slate-200' : 'min-h-screen bg-[#070a11] text-slate-200'}>
      {!embedded ? <header className="sticky top-0 z-40 border-b border-slate-800/90 bg-[#090d16]/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1900px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-emerald-600 text-slate-950 shadow-[0_0_32px_rgba(45,212,191,.18)]"><Network size={21} /></div>
            <div><h1 className="font-bold tracking-tight text-white">UniDLQ 全景监督图</h1><p className="text-[11px] text-slate-500">只看两张图：任务如何流动，证据如何积累</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${connected ? 'border-emerald-500/35 bg-emerald-950/30 text-emerald-300' : 'border-rose-500/40 bg-rose-950/30 text-rose-300'}`}><span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-300' : 'bg-rose-300'}`} />{connected ? `实时 · ${relativeTime(lastSync)}` : '连接中断'}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${overlap ? 'border-amber-500/45 bg-amber-950/30 text-amber-200' : 'border-cyan-500/30 bg-cyan-950/25 text-cyan-200'}`}>{overlap ? <AlertTriangle size={12} /> : <Clock3 size={12} />}{overlap ? '观测到架构师与实现者同时 processing' : '串行事件驱动 · 无模型轮询'}</span>
            <button disabled={refreshing} onClick={() => refresh(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-300 hover:border-slate-500 disabled:opacity-50"><RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />立即刷新</button>
          </div>
        </div>
      </header> : (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-700/70 bg-[#090d16] px-4 py-3">
          <div><div className="flex items-center gap-2 text-sm font-semibold text-white"><Network size={16} className="text-cyan-300" />UniDLQ 全景监督图</div><p className="mt-1 text-[11px] text-slate-500">任务中心已替换为动态图；CAO 其余原生功能保留在上方标签。</p></div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${connected ? 'border-emerald-500/35 bg-emerald-950/30 text-emerald-300' : 'border-rose-500/40 bg-rose-950/30 text-rose-300'}`}><span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-300' : 'bg-rose-300'}`} />{connected ? `实时 · ${relativeTime(lastSync)}` : '连接中断'}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 ${overlap ? 'border-amber-500/45 bg-amber-950/30 text-amber-200' : 'border-cyan-500/30 bg-cyan-950/25 text-cyan-200'}`}>{overlap ? <AlertTriangle size={12} /> : <Clock3 size={12} />}{overlap ? '观测到架构师与实现者同时 processing' : '串行事件驱动 · 无模型轮询'}</span>
            <button disabled={refreshing} onClick={() => refresh(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-300 hover:border-slate-500 disabled:opacity-50"><RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />立即刷新</button>
          </div>
        </div>
      )}

      <main className={embedded ? 'space-y-5' : 'mx-auto max-w-[1900px] space-y-5 px-4 py-5 sm:px-6'}>
        {loadError ? <div role="alert" className="rounded-xl border border-rose-500/40 bg-rose-950/25 px-4 py-3 text-sm text-rose-200">{loadError}。画面保留最后一次成功快照，不会伪装成实时。</div> : null}
        <section className="rounded-3xl border border-slate-700/70 bg-slate-900/45 p-4 shadow-[0_24px_80px_rgba(0,0,0,.22)]" aria-labelledby="workflow-graph-title">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><div className="flex flex-wrap items-center gap-2"><Activity size={16} className="text-cyan-300" /><h2 id="workflow-graph-title" className="font-semibold text-white">工作流动态图</h2><span className="rounded-full bg-sky-950 px-2 py-0.5 text-[10px] text-sky-300">本任务 {selectedRunningAgents} 个智能体运行</span><span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">全局 {activeTasks} 个任务未闭环</span></div><p className="mt-1 text-xs text-slate-500">每条箭头就是一次真实交接；每个 Claude、Codex、回报、审核和提交都是可点击节点。</p></div>
            <label className="flex min-w-[300px] items-center gap-2 text-xs text-slate-500"><span className="shrink-0">查看任务</span><select value={selectedTaskId || ''} onChange={event => { setSelectedNodeId(null); setSelectedTaskId(event.target.value) }} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-cyan-500 focus:outline-none"><option value="" disabled>等待任务数据</option>{tasks.map(task => <option key={task.id} value={task.id}>{ACTIVE_STATES.has(normalizeState(task.state)) ? '● ' : ''}{short(task.title, 70)} · {statusLabel(task.state)}</option>)}</select></label>
          </div>
          <GraphCanvas snapshot={workflowGraph} label="工作流动态图" onSelect={node => setSelectedNodeId(node.id)} />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600"><span>蓝色脉冲：正在执行</span><span>绿色：有持久证据</span><span>黄色：等待或证据缺口</span><span>红色：失败 / 终端不可达</span><span>灰色：未观测，不做猜测</span></div>
        </section>

        <section className="rounded-3xl border border-slate-700/70 bg-slate-900/45 p-4 shadow-[0_24px_80px_rgba(0,0,0,.22)]" aria-labelledby="evidence-graph-title">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div><div className="flex items-center gap-2"><Brain size={16} className="text-violet-300" /><h2 id="evidence-graph-title" className="font-semibold text-white">记忆 / 证据动态图</h2><span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">{evidenceGraph.nodes.length} 个节点</span></div><p className="mt-1 text-xs text-slate-500">任务约束、memory、实现报告、测试、实验、哈希、提交和 CAO 运行底座都汇入同一张证据图。</p></div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 px-3 py-1.5 text-[10px] text-slate-400"><Sparkles size={11} />点击节点，在右侧读完整内容或下载备份</span>
          </div>
          <GraphCanvas snapshot={evidenceGraph} label="记忆与证据动态图" onSelect={node => setSelectedNodeId(node.id)} />
        </section>
      </main>

      {selectedNode ? <NodeInspector node={selectedNode} controllable={!!selectedNode.terminal && controllableIds.has(selectedNode.terminal.id)} onClose={() => setSelectedNodeId(null)} onOpenTerminal={terminal => { setSelectedNodeId(null); setLiveTerminal(terminal) }} onRefresh={() => { void refresh(true) }} /> : null}
      {liveTerminal ? <TerminalView terminalId={liveTerminal.id} provider={liveTerminal.provider} agentProfile={liveTerminal.agent_profile} onClose={() => setLiveTerminal(null)} /> : null}
    </div>
  )
}
