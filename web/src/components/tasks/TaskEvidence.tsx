import { Archive, BrainCircuit, CheckCircle2, Download, FileJson, FileText, GitCommitHorizontal, ShieldCheck, Users } from 'lucide-react'
import type { InboxMessage, MemorySummary } from '../../api'
import type { TaskProjection } from './taskModel'
import { parseDiagnosticInputs } from './taskModel'
import { buildTaskReport, downloadText, safeReportFilename, taskReportMarkdown } from './taskReport'
import { EvidenceChart } from './EvidenceChart'

const UNOBSERVED = '未观测'

function countOutputRefs(task: TaskProjection): number {
  const refs = new Set<string>()
  task.evidence?.timeline.events.forEach(event => {
    if (event.output_ref) refs.add(event.output_ref)
  })
  task.evidence?.diagnostics?.references.artifacts.forEach(item => refs.add(item))
  return refs.size
}

function Node({ icon, title, value, tone }: { icon: React.ReactNode; title: string; value: string; tone: string }) {
  return (
    <div className={`relative rounded-xl border p-3 ${tone}`}>
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
        {icon} {title}
      </div>
      <p className="mt-2 line-clamp-3 text-[11px] leading-4 text-slate-400" title={value}>{value}</p>
    </div>
  )
}

export function TaskMemoryMap({ task, projectMemories }: { task: TaskProjection; projectMemories: MemorySummary[] }) {
  const inputs = parseDiagnosticInputs(task.evidence?.diagnostics || null)
  const events = task.evidence?.timeline.events || []
  const artifacts = task.evidence?.diagnostics?.references.artifacts || []
  const goal = task.direct?.contract.goal || (typeof inputs?.goal === 'string' ? inputs.goal : UNOBSERVED)
  const scope = task.direct?.contract.scope || (typeof inputs?.scope === 'string' ? inputs.scope : UNOBSERVED)
  const processCount = task.direct?.messages.length || events.length

  return (
    <section aria-label="任务记忆与证据图" className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-white">任务记忆与证据图</h3>
        <p className="mt-1 text-xs text-slate-500">这不是模型隐藏思维；它展示可以复核和备份的任务定义、执行记录、产物与审核关系。</p>
      </div>
      <div className="relative grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px_1fr] md:grid-rows-2">
        <div className="md:col-start-1 md:row-start-1">
          <Node icon={<FileText size={13} className="text-sky-300" />} title="任务目标" value={goal} tone="border-sky-500/35 bg-sky-950/20" />
        </div>
        <div className="md:col-start-1 md:row-start-2">
          <Node icon={<GitCommitHorizontal size={13} className="text-cyan-300" />} title="修改范围" value={scope} tone="border-cyan-500/35 bg-cyan-950/20" />
        </div>
        <div className="flex min-h-32 flex-col items-center justify-center rounded-2xl border border-emerald-500/50 bg-emerald-950/30 p-4 text-center md:col-start-2 md:row-span-2 md:row-start-1">
          <BrainCircuit size={27} className="text-emerald-300" />
          <p className="mt-2 text-sm font-semibold text-white">{task.title}</p>
          <p className="mt-1 break-all font-mono text-[10px] text-emerald-200/60">{task.id}</p>
          <span className="mt-3 rounded-full border border-emerald-500/40 px-2 py-1 text-[10px] text-emerald-200">证据中心</span>
        </div>
        <div className="md:col-start-3 md:row-start-1">
          <Node icon={<Users size={13} className="text-violet-300" />} title="智能体与过程" value={`${task.workers.length} 个终端 · ${processCount} 条持久记录`} tone="border-violet-500/35 bg-violet-950/20" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:col-start-3 md:row-start-2">
          <Node icon={<Archive size={13} className="text-amber-300" />} title="产物" value={`${artifacts.length || countOutputRefs(task)} 项`} tone="border-amber-500/35 bg-amber-950/20" />
          <Node icon={<ShieldCheck size={13} className="text-rose-300" />} title="审核" value={task.reviewVerdict || UNOBSERVED} tone="border-rose-500/35 bg-rose-950/20" />
        </div>
        <div className="pointer-events-none absolute left-1/3 right-1/3 top-1/2 hidden border-t border-dashed border-slate-700 md:block" />
      </div>
      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/35 px-3 py-2 text-[11px] text-slate-500">
        数据来源：工作流 journal、持久 inbox、terminal metadata 与项目 memory；接口没有提供的字段一律标成“未观测”。
      </div>
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-semibold text-slate-300">项目长期记忆</h4>
          <span className="text-[10px] text-slate-600">{projectMemories.length} 个可复核节点</span>
        </div>
        {projectMemories.length ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {projectMemories.map(memory => (
              <div key={`${memory.scope}:${memory.scope_id || ''}:${memory.key}`} className="rounded-xl border border-indigo-500/30 bg-indigo-950/20 p-3">
                <p className="text-xs font-semibold text-indigo-200">{memory.key}</p>
                <p className="mt-1 text-[10px] text-slate-500">{memory.memory_type} · {memory.scope}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-700 px-3 py-5 text-center text-xs text-slate-600">项目 memory API 未返回节点</div>
        )}
      </div>
    </section>
  )
}

function ContractBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/45 p-3">
      <p className="text-[10px] font-semibold tracking-widest text-emerald-300">{label}</p>
      <p className={`mt-2 whitespace-pre-wrap text-xs leading-5 ${value === UNOBSERVED ? 'text-slate-600' : 'text-slate-300'}`}>{value}</p>
    </div>
  )
}

function displayOutput(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) || UNOBSERVED } catch { return UNOBSERVED }
}

export function TaskReportView({ task, inbox, projectMemories }: { task: TaskProjection; inbox: InboxMessage[]; projectMemories: MemorySummary[] }) {
  const report = buildTaskReport(task, inbox, projectMemories)
  const stem = safeReportFilename(task.id)

  return (
    <section aria-label="详细任务报告" className="space-y-4">
      <div className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <FileText size={16} className="text-emerald-300" />
              <h3 className="text-sm font-semibold text-white">详细任务报告</h3>
              {task.reviewVerdict === 'ACCEPT' ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-950 px-2 py-1 text-[10px] text-emerald-300"><CheckCircle2 size={11} /> 已验收</span>
              ) : (
                <span className="rounded-full bg-amber-950/60 px-2 py-1 text-[10px] text-amber-300">未观察到 ACCEPT</span>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">报告由持久证据确定性生成，可作为后续复核和论文写作的索引，不调用前端 LLM。</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => downloadText(`${stem}.md`, taskReportMarkdown(report), 'text/markdown;charset=utf-8')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-emerald-500/50"
            >
              <Download size={12} /> Markdown
            </button>
            <button
              type="button"
              onClick={() => downloadText(`${stem}.json`, JSON.stringify(report, null, 2), 'application/json;charset=utf-8')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-emerald-500/50"
            >
              <FileJson size={12} /> JSON
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <ContractBlock label="GOAL" value={report.contract.goal} />
          <ContractBlock label="EFFORT" value={report.contract.effort} />
          <ContractBlock label="SCOPE" value={report.contract.scope} />
          <ContractBlock label="STOP WHEN" value={report.contract.stop_when} />
          <div className="md:col-span-2"><ContractBlock label="RETURN" value={report.contract.return} /></div>
        </div>
      </div>

      <EvidenceChart events={task.evidence?.timeline.events || []} task={task} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">步骤与验证</h4>
          <div className="mt-3 space-y-2">
            {report.execution.steps.length ? report.execution.steps.map(step => (
                <details key={step.id} className="rounded-lg border border-slate-800 bg-slate-950/35 px-3 py-2 text-xs">
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-center justify-between gap-3"><span className="font-medium text-slate-200">{step.id}</span><span className="text-slate-400">{step.state}</span></div>
                    <p className="mt-1 text-[10px] text-slate-600">尝试 {step.attempts} · 终端 {step.terminal_id} · 点击查看原始报告</p>
                  </summary>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[10px] leading-5 text-slate-400">{displayOutput(step.output)}</pre>
                </details>
            )) : <p className="text-xs text-slate-600">未观测</p>}
          </div>
        </div>
        <div className="rounded-2xl border border-slate-700/70 bg-slate-900/50 p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">未解决风险</h4>
          <ul className="mt-3 space-y-2 text-xs text-slate-400">
            {report.unresolved_risks.map(risk => <li key={risk} className="flex gap-2"><span className="text-amber-400">•</span><span>{risk}</span></li>)}
          </ul>
        </div>
      </div>
    </section>
  )
}
