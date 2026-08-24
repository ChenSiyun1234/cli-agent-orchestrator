import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from '../App'
import { DashboardHome } from '../components/DashboardHome'
import { api } from '../api'
import { buildTaskProjections, inboxEvidenceForTask } from '../components/tasks/taskModel'
import { buildTaskReport } from '../components/tasks/taskReport'

const fixture = vi.hoisted(() => ({
  sessions: [] as any[],
  terminals: [] as any[],
  runs: [] as any[],
  inspections: {} as Record<string, any>,
  timelines: {} as Record<string, any>,
  diagnostics: {} as Record<string, any>,
  results: {} as Record<string, any>,
  inbox: [] as any[],
  memories: [] as any[],
}))

vi.mock('../api', () => ({
  api: {
    getMemoryStatus: vi.fn(() => Promise.resolve({ enabled: true })),
    listMemories: vi.fn(() => Promise.resolve(fixture.memories)),
    listProfiles: vi.fn(() => Promise.resolve([])),
    listSessions: vi.fn(() => Promise.resolve(fixture.sessions)),
    listWorkflowRuns: vi.fn(() => Promise.resolve(fixture.runs)),
    getSession: vi.fn(() => Promise.resolve({ terminals: fixture.terminals })),
    getTerminal: vi.fn((id: string) => Promise.resolve({
      ...fixture.terminals.find(terminal => terminal.id === id),
      name: id,
      session_name: fixture.terminals.find(terminal => terminal.id === id)?.tmux_session,
    })),
    getTerminalStatus: vi.fn(() => Promise.resolve(null)),
    inspectWorkflowRun: vi.fn((id: string) => Promise.resolve(fixture.inspections[id])),
    getWorkflowRunEvents: vi.fn((id: string) => Promise.resolve(fixture.timelines[id] || { events: [], gaps: [], next_after_seq: null })),
    getWorkflowRunDiagnostics: vi.fn((id: string) => Promise.resolve(fixture.diagnostics[id])),
    getWorkflowRunResult: vi.fn((id: string) => Promise.resolve(fixture.results[id])),
    getInboxMessages: vi.fn((terminalId: string) => Promise.resolve(
      fixture.inbox.filter(message => message.receiver_id === terminalId),
    )),
    sendKey: vi.fn(() => Promise.resolve({ success: true })),
    sendInput: vi.fn(() => Promise.resolve({ success: true })),
    sendInboxMessage: vi.fn(() => Promise.resolve({ success: true })),
    cancelWorkflowRun: vi.fn(() => Promise.resolve({ success: true })),
    resumeWorkflowRun: vi.fn(() => Promise.resolve({ state: 'running' })),
    submitWorkflowRun: vi.fn(() => Promise.resolve({ run_id: 'new-version', state: 'running', links: {} })),
  },
}))

const store = {
  sessions: fixture.sessions,
  connected: true,
  fetchSessions: vi.fn(),
  snackbar: null,
  hideSnackbar: vi.fn(),
  showSnackbar: vi.fn(),
  terminalStatuses: {},
  setTerminalStatus: vi.fn(),
  clearTerminalStatuses: vi.fn(),
  deleteSession: vi.fn(),
}

vi.mock('../store', () => ({
  useStore: (selector?: (state: typeof store) => unknown) => selector ? selector(store) : store,
}))

const NAV_LABELS = ['任务中心', '智能体与终端', '定时任务', '系统设置', 'CAO 记忆库', '工作流原始记录']

function directWorkerFixture() {
  fixture.sessions = [{ id: 's1', name: 'cao-unidlq-architect', status: 'active' }]
  fixture.terminals = [
    {
      id: 'aaaaaaaa', tmux_session: 'cao-unidlq-architect', tmux_window: 'architect', provider: 'codex',
      agent_profile: 'unidlq_codex_architect', caller_id: null, status: 'idle', created_at: '2026-08-23T10:00:00Z', last_active: '2026-08-23T10:03:00Z',
    },
    {
      id: 'bbbbbbbb', tmux_session: 'cao-unidlq-architect', tmux_window: 'worker-1', provider: 'claude_code',
      agent_profile: 'unidlq_claude_implementer', caller_id: 'aaaaaaaa', status: 'processing', created_at: '2026-08-23T10:01:00Z', last_active: '2026-08-23T10:04:00Z',
    },
    {
      id: 'cccccccc', tmux_session: 'cao-unidlq-architect', tmux_window: 'worker-2', provider: 'claude_code',
      agent_profile: 'unidlq_claude_implementer', caller_id: 'aaaaaaaa', status: 'idle', created_at: '2026-08-23T10:02:00Z', last_active: '2026-08-23T10:03:30Z',
    },
  ]
}

function durableRunFixture(verdict: 'ACCEPT' | null = null) {
  const id = 'run-task-001'
  fixture.sessions = []
  fixture.terminals = []
  fixture.runs = [{ run_id: id, workflow_name: 'unidlq_implement', state: 'completed', tier: 'script', started_at: '2026-08-23T10:00:00Z', finished_at: '2026-08-23T10:10:00Z', current_step_id: null }]
  fixture.inspections[id] = {
    run_id: id, workflow_name: 'unidlq_implement', state: 'completed', current_step_id: null,
    started_at: '2026-08-23T10:00:00Z', finished_at: '2026-08-23T10:10:00Z', tier: 'script',
    steps: [
      { id: 'architect-plan', state: 'completed', attempts: 1, terminal_id: null, output_json: null },
      { id: 'implement', state: 'completed', attempts: 1, terminal_id: null, output_json: null },
      { id: 'architect-review', state: 'completed', attempts: 1, terminal_id: null, output_json: verdict ? JSON.stringify({ verdict }) : null },
    ],
  }
  fixture.timelines[id] = {
    events: [
      { run_id: id, seq: 1, event_type: 'step.started', event_schema_version: 1, ts: '2026-08-23T10:01:00Z', step_id: 'architect-plan', elapsed_ms: 1200 },
      { run_id: id, seq: 2, event_type: 'step.completed', event_schema_version: 1, ts: '2026-08-23T10:09:00Z', step_id: 'architect-review', elapsed_ms: 2400, validation_result: verdict },
    ],
    gaps: [], next_after_seq: null,
  }
  fixture.diagnostics[id] = {
    spec_id: 'unidlq_implement', spec_content_hash: 'hash',
    inputs: JSON.stringify({ goal: '实现任务中心', effort: 'high', scope: 'web/src', stop_when: '测试失败', return: 'npm test' }),
    events: fixture.timelines[id].events, gaps: [], step_outcomes: [],
    environment: { providers: [], agent_profiles: [], engines: [] },
    references: { terminals: [], artifacts: ['report.json'] }, excerpts: [], capture_enabled: true,
  }
  fixture.results[id] = { run_id: id, workflow_name: 'unidlq_implement', state: 'completed', steps: [], started_at: '2026-08-23T10:00:00Z', finished_at: '2026-08-23T10:10:00Z' }
}

function persistedDirectTaskFixture(verdict: 'ACCEPT' | null = 'ACCEPT') {
  directWorkerFixture()
  fixture.terminals[0].metadata = {
    display_name: 'S0 架构与验收',
    launch_model: 'gpt-5.6-sol',
    launch_reasoning_effort: 'high',
  }
  fixture.terminals[1].metadata = {
    display_name: 'S0 数据实现者',
    launch_model: 'claude-fable-5',
    launch_reasoning_effort: 'high',
  }
  fixture.terminals = fixture.terminals.slice(0, 2)
  fixture.inbox = [
    {
      id: 101,
      sender_id: 'aaaaaaaa',
      receiver_id: 'bbbbbbbb',
      message: [
        'GOAL: 修复直接任务生命周期',
        'EFFORT: high',
        'SCOPE: web/src/components/tasks',
        'STOP WHEN: focused tests fail',
        'RETURN: npm test -- src/test/unidlq-ui.test.tsx',
      ].join('\n'),
      status: 'delivered',
      created_at: '2026-08-23T10:01:00Z',
      delivered_at: '2026-08-23T10:01:05Z',
      started_at: '2026-08-23T10:01:05Z',
      reviewed_at: verdict ? '2026-08-23T10:08:00Z' : null,
      task_id: 'direct-101',
      reply_to_message_id: null,
      review_verdict: verdict,
    },
    {
      id: 102,
      sender_id: 'bbbbbbbb',
      receiver_id: 'aaaaaaaa',
      message: 'Implemented the lifecycle projection. Focused tests: 14 passed.',
      status: 'delivered',
      created_at: '2026-08-23T10:07:00Z',
      delivered_at: '2026-08-23T10:07:01Z',
      started_at: '2026-08-23T10:07:01Z',
      reviewed_at: null,
      task_id: 'direct-101',
      reply_to_message_id: 101,
      review_verdict: null,
    },
    ...(verdict ? [{
      id: 103,
      sender_id: 'aaaaaaaa',
      receiver_id: 'bbbbbbbb',
      message: 'Reviewed real diff and focused test evidence.',
      status: 'delivered',
      created_at: '2026-08-23T10:08:00Z',
      delivered_at: '2026-08-23T10:08:01Z',
      started_at: '2026-08-23T10:08:01Z',
      reviewed_at: '2026-08-23T10:08:00Z',
      task_id: 'direct-101',
      reply_to_message_id: 101,
      review_verdict: verdict,
    }] : []),
  ]
  fixture.memories = [
    { key: 'unidlq-research-authority', memory_type: 'project', scope: 'project', scope_id: 'unidlq', updated_at: '2026-08-23T09:00:00Z' },
    { key: 'unidlq-project-stage', memory_type: 'project', scope: 'project', scope_id: 'unidlq', updated_at: '2026-08-23T09:01:00Z' },
    { key: 'unidlq-collaboration-protocol', memory_type: 'project', scope: 'project', scope_id: 'unidlq', updated_at: '2026-08-23T09:02:00Z' },
  ]
}

describe('App shell — Chinese task-first navigation', () => {
  beforeEach(() => {
    fixture.sessions = []
    fixture.terminals = []
    fixture.runs = []
    fixture.inspections = {}
    fixture.timelines = {}
    fixture.diagnostics = {}
    fixture.results = {}
    fixture.inbox = []
    fixture.memories = []
    store.sessions = fixture.sessions
    vi.clearAllMocks()
  })

  it('keeps the CAO brand and presents the operator-facing project console', async () => {
    render(<App />)
    expect(screen.getByText('CLI Agent Orchestrator')).toBeInTheDocument()
    expect(screen.getByText('UniDLQ 项目控制台 · 任务、智能体、证据与报告集中监督')).toBeInTheDocument()
    await screen.findByText('CAO 记忆库')
  })

  it('preserves all six original surfaces in their original order with Chinese task-first labels', async () => {
    render(<App />)
    await screen.findByText('CAO 记忆库')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(NAV_LABELS)
    tabs.forEach((tab, index) => expect(tab).toHaveAttribute('title', `Alt+${index + 1}`))
  })

  it('keeps Memory fail-closed and leaves the other native tabs usable', async () => {
    vi.mocked(api.getMemoryStatus).mockRejectedValueOnce(new Error('backend down'))
    render(<App />)
    const workflows = await screen.findByText('工作流原始记录')
    expect(screen.queryByText('CAO 记忆库')).not.toBeInTheDocument()
    expect(workflows.closest('button')).toHaveAttribute('title', 'Alt+5')
  })

  it('keeps the session-count badge and horizontally scrollable tab bar', async () => {
    fixture.sessions = [{ id: 's1', name: 'cao-unidlq-architect', status: 'idle' }]
    store.sessions = fixture.sessions
    render(<App />)
    const agentsTab = (await screen.findByText('智能体与终端')).closest('button') as HTMLElement
    expect(within(agentsTab).getByText('1')).toBeInTheDocument()
    expect(screen.getByRole('tablist').className).toContain('overflow-x-auto')
  })
})

describe('Task center — graphical supervision and native controls', () => {
  beforeEach(() => {
    fixture.sessions = []
    fixture.terminals = []
    fixture.runs = []
    fixture.inspections = {}
    fixture.timelines = {}
    fixture.diagnostics = {}
    fixture.results = {}
    fixture.inbox = []
    fixture.memories = []
    store.sessions = fixture.sessions
    vi.clearAllMocks()
  })

  it('explains the four-stage operator flow and keeps legacy CAO tools collapsed below', async () => {
    render(<DashboardHome onNavigate={() => {}} />)
    expect(await screen.findByText('项目任务中心')).toBeInTheDocument()
    expect(screen.getByText('1. 你在主对话下达目标')).toBeInTheDocument()
    expect(screen.getByText('2. 架构师规划并派发')).toBeInTheDocument()
    expect(screen.getByText('3. 实现者各自一条泳道')).toBeInTheDocument()
    expect(screen.getByText('4. 审核并生成报告')).toBeInTheDocument()
    const summary = screen.getByText(/原版会话监控工具/)
    expect(summary.tagName).toBe('SUMMARY')
    expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('shows every parallel Claude as a separate live lane and opens the real terminal path', async () => {
    directWorkerFixture()
    store.sessions = fixture.sessions
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findByText('未结构化实时工作')
    expect(await screen.findAllByText(/Claude 实现者/)).toHaveLength(2)
    expect(screen.getByText(/Codex 架构师 \/ 审核者/)).toBeInTheDocument()
    expect(screen.getAllByText('打开原生终端')).toHaveLength(3)
    const nativeLinks = screen.getAllByText('用 Windows Terminal 打开')
    expect(nativeLinks[0].closest('a')).toHaveAttribute('href', 'unidlq-cao://terminal/aaaaaaaa')
  })

  it('routes interrupt and immediate/queued amendments to existing native CAO endpoints', async () => {
    directWorkerFixture()
    store.sessions = fixture.sessions
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findByText('未结构化实时工作')
    const interrupts = await screen.findAllByText('打断当前命令')
    fireEvent.click(interrupts[1])
    await waitFor(() => expect(api.sendKey).toHaveBeenCalledWith('bbbbbbbb', 'C-c'))

    const boxes = screen.getAllByPlaceholderText(/用英文写内部补充指令/)
    fireEvent.change(boxes[1], { target: { value: 'Run the focused test only.' } })
    fireEvent.click(screen.getAllByText('立即补充指令')[1])
    await waitFor(() => expect(api.sendInput).toHaveBeenCalledWith('bbbbbbbb', 'Run the focused test only.'))

    fireEvent.change(boxes[1], { target: { value: 'Queue this amendment.' } })
    fireEvent.click(screen.getAllByText('排队修改后续任务')[1])
    await waitFor(() => expect(api.sendInboxMessage).toHaveBeenCalledWith('bbbbbbbb', 'aaaaaaaa', 'Queue this amendment.'))
  })

  it('keeps completion separate from acceptance until a structured review verdict exists', async () => {
    durableRunFixture(null)
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findByText('unidlq_implement')
    expect(screen.getAllByText('独立审核：未观测').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('详细报告'))
    expect(await screen.findByText(/没有观察到结构化 ACCEPT\/REJECT/)).toBeInTheDocument()
  })

  it('accepts verdicts only from a review step and never invents inbox provenance', async () => {
    durableRunFixture(null)
    fixture.inspections['run-task-001'].steps[1].output_json = JSON.stringify({ verdict: 'ACCEPT' })
    fixture.timelines['run-task-001'].events.push({
      run_id: 'run-task-001', seq: 3, event_type: 'step.completed', event_schema_version: 1,
      ts: '2026-08-23T10:09:30Z', step_id: 'implement', validation_result: 'ACCEPT',
    })
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findByText('unidlq_implement')
    expect(screen.getAllByText('独立审核：未观测').length).toBeGreaterThan(0)

    directWorkerFixture()
    fixture.terminals[2].caller_id = null
    store.sessions = fixture.sessions
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findAllByText('未结构化实时工作')
    const queueButtons = screen.getAllByText('排队修改后续任务')
    expect(queueButtons[2].closest('button')).toBeDisabled()
    expect(screen.getAllByText('排队功能不可用：上游终端未观测').length).toBeGreaterThan(0)
  })

  it('binds inbox evidence by receiver, recorded caller, worker lifetime, and task time window', () => {
    durableRunFixture('ACCEPT')
    const worker = {
      id: 'dddddddd', tmux_session: 'workflow-session', tmux_window: 'worker', provider: 'claude_code',
      agent_profile: 'unidlq_claude_implementer', caller_id: 'aaaaaaaa', status: 'completed',
      created_at: '2026-08-23T10:02:00Z', last_active: '2026-08-23T10:08:00Z',
    }
    fixture.terminals = [worker]
    fixture.inspections['run-task-001'].steps[1].terminal_id = worker.id
    const task = buildTaskProjections(fixture.runs, {
      'run-task-001': {
        inspection: fixture.inspections['run-task-001'], timeline: fixture.timelines['run-task-001'],
        diagnostics: fixture.diagnostics['run-task-001'], result: fixture.results['run-task-001'],
      },
    }, fixture.terminals)[0]
    const messages = [
      { id: 'valid', sender_id: 'aaaaaaaa', receiver_id: worker.id, message: 'valid', status: 'delivered' as const, created_at: '2026-08-23T10:05:00Z' },
      { id: 'old', sender_id: 'aaaaaaaa', receiver_id: worker.id, message: 'old', status: 'delivered' as const, created_at: '2026-08-23T09:59:00Z' },
      { id: 'future', sender_id: 'aaaaaaaa', receiver_id: worker.id, message: 'future', status: 'pending' as const, created_at: '2026-08-23T10:11:00Z' },
      { id: 'wrong-sender', sender_id: 'eeeeeeee', receiver_id: worker.id, message: 'wrong', status: 'pending' as const, created_at: '2026-08-23T10:05:00Z' },
    ]
    expect(inboxEvidenceForTask(task, messages).map(message => message.id)).toEqual(['valid'])
    expect(buildTaskReport(task, messages).execution.queued_messages.map(message => message.id)).toEqual(['valid'])
  })

  it('renders an explicit assignment observation without inferring it from terminal creation', async () => {
    directWorkerFixture()
    store.sessions = fixture.sessions
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findByText('未结构化实时工作')
    expect(screen.getAllByText('明确派发事件')).toHaveLength(3)
    expect(screen.getAllByText('终端创建')).toHaveLength(3)
  })

  it('projects a persisted five-field direct task into real lifecycle, memory, and report evidence', async () => {
    persistedDirectTaskFixture('ACCEPT')
    store.sessions = fixture.sessions
    render(<DashboardHome onNavigate={() => {}} />)

    expect(await screen.findByText('修复直接任务生命周期')).toBeInTheDocument()
    expect(screen.queryByText('未结构化实时工作')).not.toBeInTheDocument()
    expect(screen.getByText('持久直接任务')).toBeInTheDocument()
    expect(screen.getByText('明确结论：ACCEPT')).toBeInTheDocument()
    expect(screen.getByText('实现者原始回报已纳入可下载报告')).toBeInTheDocument()
    expect(screen.getByText(/S0 数据实现者 · Claude 实现者/)).toBeInTheDocument()
    expect(screen.getByText('模型：claude-fable-5（已观测）')).toBeInTheDocument()
    expect(screen.getAllByText('推理：high（已观测）')).toHaveLength(2)
    expect(screen.getByText('会话：本任务新建（时间证据）')).toBeInTheDocument()
    expect(screen.getByText('会话：复用会话（时间证据）')).toBeInTheDocument()

    fireEvent.click(screen.getByText('记忆 / 证据图'))
    expect(await screen.findByText('unidlq-research-authority')).toBeInTheDocument()
    expect(screen.getByText('unidlq-project-stage')).toBeInTheDocument()
    expect(screen.getByText('unidlq-collaboration-protocol')).toBeInTheDocument()

    fireEvent.click(screen.getByText('详细报告'))
    expect(await screen.findByText('步骤耗时证据图')).toBeInTheDocument()
    fireEvent.click(screen.getByText('implementer-report-102'))
    expect(await screen.findByText(/Implemented the lifecycle projection/)).toBeInTheDocument()

    const task = buildTaskProjections([], {}, fixture.terminals, fixture.inbox)[0]
    const report = buildTaskReport(task, fixture.inbox, fixture.memories)
    expect(report.execution.chronology.map(row => row.event)).toEqual([
      'task.dispatched', 'message.delivered', 'task.started', 'task.returned', 'task.reviewed',
    ])
    expect(report.execution.queued_messages).toHaveLength(3)
    expect(report.project_memory).toHaveLength(3)
    expect(report.execution.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        terminal_id: 'bbbbbbbb',
        display_name: 'S0 数据实现者',
        launch_model: 'claude-fable-5',
        launch_model_source: 'observed',
        launch_reasoning_effort: 'high',
        launch_reasoning_effort_source: 'observed',
        session_use: 'new',
      }),
    ]))
    expect(report.verification.step_durations_ms).toEqual([
      { step: '派发 → 送达', duration_ms: 5000 },
      { step: '开始 → 返回', duration_ms: 355000 },
      { step: '返回 → 审核', duration_ms: 60000 },
    ])
    expect(report.provenance.inbox_binding).toContain('persisted task_id')
  })

  it('labels old direct-task linkage as historical inference and never calls quiet work frozen', () => {
    directWorkerFixture()
    fixture.terminals = fixture.terminals.slice(0, 2)
    fixture.terminals[1].status = 'idle'
    fixture.inbox = [{
      id: 91,
      sender_id: 'aaaaaaaa',
      receiver_id: 'bbbbbbbb',
      message: 'GOAL: legacy task\nEFFORT: medium — routine fix\nSCOPE: web/src\nSTOP WHEN: tests fail\nRETURN: test output',
      status: 'delivered',
      created_at: '2026-08-22T10:00:00Z',
      delivered_at: null,
      started_at: null,
      reviewed_at: null,
      task_id: null,
      reply_to_message_id: null,
      review_verdict: null,
    }]

    const task = buildTaskProjections([], {}, fixture.terminals, fixture.inbox)[0]
    expect(task.kind).toBe('direct')
    expect(task.state).toBe('quiet_running')
    expect(task.subtitle).toContain('历史推定关联')
    expect(JSON.stringify(task)).not.toContain('frozen')
    expect(buildTaskReport(task, fixture.inbox).unresolved_risks).toContain(
      '该直接任务来自旧版 inbox；回报关联按双向终端和相邻任务时间窗历史推定。',
    )
    expect(buildTaskReport(task, fixture.inbox).execution.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        terminal_id: 'bbbbbbbb',
        launch_model: 'claude-fable-5',
        launch_model_source: 'planned',
        launch_reasoning_effort: 'medium',
        launch_reasoning_effort_source: 'planned',
      }),
    ]))
  })

  it('does not present a superseded unpaired historical task as still running', () => {
    directWorkerFixture()
    fixture.terminals = fixture.terminals.slice(0, 2)
    fixture.terminals[1].status = 'idle'
    fixture.inbox = [
      {
        id: 91,
        sender_id: 'aaaaaaaa',
        receiver_id: 'bbbbbbbb',
        message: 'GOAL: old unpaired task\nEFFORT: medium\nSCOPE: web/src\nSTOP WHEN: tests fail\nRETURN: test output',
        status: 'delivered',
        created_at: '2026-08-22T10:00:00Z',
        delivered_at: null,
        started_at: null,
        reviewed_at: null,
        task_id: null,
        reply_to_message_id: null,
        review_verdict: null,
      },
      {
        id: 92,
        sender_id: 'aaaaaaaa',
        receiver_id: 'bbbbbbbb',
        message: 'GOAL: newer task\nEFFORT: low\nSCOPE: web/src\nSTOP WHEN: done\nRETURN: status',
        status: 'delivered',
        created_at: '2026-08-22T11:00:00Z',
        delivered_at: null,
        started_at: null,
        reviewed_at: null,
        task_id: null,
        reply_to_message_id: null,
        review_verdict: null,
      },
    ]

    const tasks = buildTaskProjections([], {}, fixture.terminals, fixture.inbox)
    const oldTask = tasks.find(task => task.title === 'old unpaired task')
    const newerTask = tasks.find(task => task.title === 'newer task')
    expect(oldTask?.state).toBe('historical_unresolved')
    expect(newerTask?.state).toBe('quiet_running')
  })

  it('renders the task memory graph and evidence-backed report with both download formats', async () => {
    durableRunFixture('ACCEPT')
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findByText('unidlq_implement')
    fireEvent.click(screen.getByText('记忆 / 证据图'))
    expect(await screen.findByText('任务记忆与证据图')).toBeInTheDocument()
    expect(screen.getByText('实现任务中心')).toBeInTheDocument()

    fireEvent.click(screen.getByText('详细报告'))
    expect(await screen.findByText('详细任务报告')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Markdown/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /JSON/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '步骤耗时证据图' })).toBeInTheDocument()
  })

  it('shows honest cancel semantics instead of claiming a frozen Claude context', async () => {
    durableRunFixture(null)
    fixture.runs[0].state = 'running'
    fixture.runs[0].finished_at = null
    fixture.inspections['run-task-001'].state = 'running'
    fixture.inspections['run-task-001'].finished_at = null
    render(<DashboardHome onNavigate={() => {}} />)
    const pause = await screen.findByText('暂停工作流')
    fireEvent.click(pause)
    expect(screen.getByText(/Claude 上下文不会被冻结/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(api.cancelWorkflowRun).toHaveBeenCalledWith('run-task-001'))
  })

  it('keeps completed workflow terminal references read-only to avoid reused-terminal controls', async () => {
    durableRunFixture('ACCEPT')
    fixture.sessions = [{ id: 's1', name: 'workflow-session', status: 'active' }]
    fixture.terminals = [{
      id: 'dddddddd', tmux_session: 'workflow-session', tmux_window: 'reused', provider: 'claude_code',
      agent_profile: 'unidlq_claude_implementer', caller_id: 'aaaaaaaa', status: 'processing',
      created_at: '2026-08-23T09:00:00Z', last_active: '2026-08-23T11:00:00Z',
    }]
    fixture.inspections['run-task-001'].steps[1].terminal_id = 'dddddddd'
    store.sessions = fixture.sessions
    render(<DashboardHome onNavigate={() => {}} />)
    await screen.findByText('unidlq_implement')
    expect(screen.getByText('打开原生终端').closest('button')).toBeDisabled()
    expect(screen.getByText('Windows Terminal 已禁用')).toBeInTheDocument()
    expect(screen.getByText(/历史或非当前终端默认只读/)).toBeInTheDocument()
  })
})
