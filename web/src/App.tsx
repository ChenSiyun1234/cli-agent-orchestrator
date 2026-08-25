import { useEffect, useState, Suspense } from 'react'
import { api } from './api'
import { useStore } from './store'
import { ErrorBoundary } from './components/ErrorBoundary'
import { GraphWorkspace } from './components/GraphWorkspace'
import { AgentPanel } from './components/AgentPanel'
import { FlowsPanel } from './components/FlowsPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { WorkflowsPanel } from './components/WorkflowsPanel'
import { Bot, Home, Clock, Settings, Brain, Workflow, CheckCircle, XCircle, Info, Wifi, WifiOff } from 'lucide-react'

type TabKey = 'home' | 'agents' | 'flows' | 'settings' | 'memory' | 'workflows'

// Preserve the native CAO surfaces; only the task-centre presentation is
// replaced by the UniDLQ workflow and evidence graphs.
const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'home', label: '任务中心', icon: <Home size={16} /> },
  { key: 'agents', label: '智能体与终端', icon: <Bot size={16} /> },
  { key: 'flows', label: '定时任务', icon: <Clock size={16} /> },
  { key: 'settings', label: '系统设置', icon: <Settings size={16} /> },
  { key: 'memory', label: 'CAO 记忆库', icon: <Brain size={16} /> },
  { key: 'workflows', label: '工作流原始记录', icon: <Workflow size={16} /> },
]

function Snackbar() {
  const { snackbar, hideSnackbar } = useStore()

  useEffect(() => {
    if (snackbar) {
      const timer = setTimeout(hideSnackbar, 4000)
      return () => clearTimeout(timer)
    }
  }, [snackbar, hideSnackbar])

  if (!snackbar) return null
  const icons = {
    success: <CheckCircle size={16} className="text-emerald-400" />,
    error: <XCircle size={16} className="text-red-400" />,
    info: <Info size={16} className="text-blue-400" />,
  }
  return (
    <div className="fixed bottom-6 right-6 z-50 flex max-w-md items-center gap-3 rounded-lg border border-gray-700 bg-gray-800 px-4 py-3 shadow-xl animate-slide-in">
      {icons[snackbar.type]}
      <span className="text-sm text-gray-200">{snackbar.message}</span>
      <button onClick={hideSnackbar} className="ml-2 text-gray-500 hover:text-white">×</button>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<TabKey>('home')
  const [memoryEnabled, setMemoryEnabled] = useState(false)
  const { sessions, connected, fetchSessions } = useStore()
  const visibleTabs = TABS.filter(item => item.key !== 'memory' || memoryEnabled)

  useEffect(() => {
    fetchSessions()
    api.getMemoryStatus()
      .then(status => setMemoryEnabled(status.enabled))
      .catch(() => {})
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.altKey && event.key >= '1' && event.key <= String(visibleTabs.length)) {
        event.preventDefault()
        setTab(visibleTabs[parseInt(event.key) - 1].key)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [memoryEnabled])

  return (
    <div className="min-h-screen bg-[#0f0f14] text-gray-200">
      <header className="sticky top-0 z-40 border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1800px] items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700"><Bot size={18} className="text-white" /></div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-white">CLI Agent Orchestrator</h1>
              <p className="text-xs text-gray-500">UniDLQ 项目控制台 · 原生功能与动态图监督</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <span className="text-xs text-gray-500">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
            <div className="flex items-center gap-1.5" title={connected ? 'Connected' : 'Disconnected'}>
              {connected ? <Wifi size={14} className="text-emerald-400" /> : <WifiOff size={14} className="text-red-400" />}
              <span className={`text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>{connected ? '实时' : '离线'}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="border-b border-gray-800">
        <div className="mx-auto max-w-[1800px] px-4 sm:px-6">
          <nav className="flex gap-1 overflow-x-auto py-2" role="tablist">
            {visibleTabs.map((item, index) => (
              <button
                key={item.key}
                role="tab"
                aria-selected={tab === item.key}
                onClick={() => setTab(item.key)}
                className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 ${
                  tab === item.key
                    ? 'bg-gradient-to-r from-emerald-600 to-emerald-500 text-white shadow-lg shadow-emerald-500/20'
                    : 'text-gray-400 hover:bg-gray-800/50 hover:text-white'
                }`}
                title={`Alt+${index + 1}`}
              >
                {item.icon}
                {item.label}
                {item.key === 'agents' && sessions.length > 0 ? <span className={`rounded-full px-1.5 py-0.5 text-xs ${tab === item.key ? 'bg-white/20' : 'bg-gray-700'}`}>{sessions.length}</span> : null}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-[1800px] px-4 py-6 sm:px-6">
        <ErrorBoundary>
          <Suspense fallback={<div className="py-12 text-center text-sm text-gray-500">Loading...</div>}>
            {tab === 'home' && <GraphWorkspace embedded />}
            {tab === 'agents' && <AgentPanel />}
            {tab === 'flows' && <FlowsPanel />}
            {tab === 'settings' && <SettingsPanel />}
            {tab === 'memory' && <MemoryPanel />}
            {tab === 'workflows' && <WorkflowsPanel />}
          </Suspense>
        </ErrorBoundary>
      </main>

      <Snackbar />
    </div>
  )
}
