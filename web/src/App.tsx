import { useEffect } from 'react'
import { useStore } from './store'
import { ErrorBoundary } from './components/ErrorBoundary'
import { GraphWorkspace } from './components/GraphWorkspace'
import { CheckCircle, XCircle, Info } from 'lucide-react'

function Snackbar() {
  const { snackbar, hideSnackbar } = useStore()

  useEffect(() => {
    if (snackbar) {
      const timer = setTimeout(hideSnackbar, 3000)
      return () => clearTimeout(timer)
    }
  }, [snackbar, hideSnackbar])

  if (!snackbar) return null

  const colors = {
    success: 'bg-emerald-600 border-emerald-500',
    error: 'bg-red-600 border-red-500',
    info: 'bg-blue-600 border-blue-500',
  }
  const icons = {
    success: <CheckCircle size={18} />,
    error: <XCircle size={18} />,
    info: <Info size={18} />,
  }

  return (
    <div role="alert" className={`fixed bottom-4 right-4 z-50 px-4 py-3 rounded-lg border shadow-lg flex items-center gap-2 text-white ${colors[snackbar.type]}`}>
      {icons[snackbar.type]}
      <span className="text-sm">{snackbar.message}</span>
    </div>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-[#070a11] text-gray-200">
      <ErrorBoundary><GraphWorkspace /></ErrorBoundary>
      <Snackbar />
    </div>
  )
}
