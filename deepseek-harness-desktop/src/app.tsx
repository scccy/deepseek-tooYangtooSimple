import { useEffect } from 'react'
import { useStore } from 'valtio-define'
import DesktopAboutDialog from './components/desktop-about-dialog'
import DesktopUpdateDialog from './components/desktop-update-dialog'
import DesktopUpdater from './components/desktop-updater'
import DownloadToast from './components/download-toast'
import HarnessUpdater from './components/harness-updater'
import HarnessWebview from './components/harness-webview'
import { useDshTheme } from './hooks/use-dsh-theme'
import { store } from './store'
import './i18n'
/**
 * 应用根组件：只负责首次启动与整体布局。
 * 业务状态与操作方法全部收敛到 valtio-define store，
 * 各子组件自行订阅 store，不再通过 props 透传回调与状态。
 */
export default function App() {
  useDshTheme()
  const { status } = useStore(store.harness)
  // 首次挂载自动启动 harness（store 内部对 StrictMode 重复挂载去重）
  useEffect(() => {
    store.harness.startup()
  }, [])

  return (
    <div className="flex h-screen w-screen">
      <HarnessWebview />
      {status === 'ready' && <HarnessUpdater />}
      {status === 'ready' && <DownloadToast />}
      <DesktopUpdater />
      <DesktopUpdateDialog />
      <DesktopAboutDialog />
    </div>
  )
}
