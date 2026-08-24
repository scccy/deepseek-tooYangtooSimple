import type { RefObject } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  LayoutSideContent,
  LayoutSideContentLeft,
  Minus,
  Square,
  Xmark,
} from '@gravity-ui/icons'
import { Button, Description, Dropdown, Label } from '@heroui/react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTranslation } from 'react-i18next'
import { If } from 'react-if-lite'
import { useStore } from 'valtio-define'
import { useDshPlugins } from '../hooks/use-dsh-plugins'
import { useIframeTauri } from '../hooks/use-iframe-tauri'
import { desktopUpdate } from '../store/modules/desktop-update'
import { DebugSidebar } from './debug-sidebar'

/**
 * 壳层窗口顶部导航栏（44px，常驻）：
 *
 *   [侧边栏(展开/收起)] [后退] [前进] [  空白拖拽区  ] [最小化][最大化][后台化(X)]
 *
 * - 侧边栏/后退/前进：经 postMessage 操控 iframe 内的 dsh 应用
 *   （`dsh://sidebar:toggle` / `dsh://page:prev` / `dsh://page:next`，
 *   由 dsh-tauri 插件或桌面端注入的导航桥脚本 NAV_SHIM_JS 执行）；
 *   折叠图标与按钮禁用态由 iframe 回报的
 *   `dsh://sidebar:collapsed` / `dsh://page:firsted` / `dsh://page:lasted` 同步。
 *   左侧控件只在「dsh-tauri 插件已启用（已安装）」且存在 iframe 时渲染：
 *   原生桥缺席时控件没有可靠接收方，避免出现点了没反应的死按钮。
 * - 空白拖拽区：Tauri 原生 `data-tauri-drag-region`（顶层文档直接生效），
 *   双击切换最大化。
 * - 窗口按钮：直接调用 Tauri 窗口 API；后台化 = 隐藏到托盘（服务保持运行）。
 *
 * 未传入 iframeRef（安装/错误/预装引导页，无 iframe 可操控）时
 * 只渲染窗口控制，不渲染左侧导航控制。
 */

/**
 * dsh-tauri 插件 id：安装后 iframe 内提供 `window.__dsh_tauri_bridge__`
 *  原生导航桥（`useDshPlugins` 实时同步其安装状态，插件增删即时生效）
 */
const TAURI_PLUGIN_ID = 'dsh-tauri'

interface NavbarProps {
  /** 就绪态 iframe；传入时启用左侧导航控制 */
  iframeRef?: RefObject<HTMLIFrameElement | null>
}

export default function Navbar({ iframeRef }: NavbarProps) {
  const { t } = useTranslation()
  const { plugins } = useDshPlugins()
  const { sidebarCollapsed, canGoBack, canGoForward, sendNav } = useIframeTauri(iframeRef)
  const { updateInfo } = useStore(desktopUpdate)
  // 仅当 dsh-tauri 插件启用（已安装）时显示左侧导航控件
  const tauriEnabled = plugins.some(plugin => plugin.id === TAURI_PLUGIN_ID)
  function handleWindowAction(action: 'minimize' | 'maximize' | 'background') {
    const appWindow = getCurrentWindow()
    switch (action) {
      case 'minimize':
        void appWindow.minimize()
        break
      case 'maximize':
        void appWindow.toggleMaximize()
        break
      case 'background':
        // 后台化：隐藏窗口到托盘（与关闭按钮行为一致，服务保持运行）
        void appWindow.hide()
        break
    }
  }

  function handleHelpAction(key: string) {
    if (key === 'check-update')
      void desktopUpdate.openUpdateDialog()
    else if (key === 'about')
      void desktopUpdate.openAbout()
  }

  return (
    <div className="relative flex h-11 w-full flex-none select-none items-center gap-0.5 border-b border-line px-1.5 bg-[#f9fafb] dark:bg-[#1b1b1c]">
      <If cond={iframeRef != null && tauriEnabled}>
        <Button
          className="rounded-lg size-7"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t(sidebarCollapsed ? 'nav.sidebar_expand' : 'nav.sidebar_collapse')}
          onPress={() => { sendNav('sidebar:toggle') }}
        >
          <If
            cond={sidebarCollapsed}
            then={<LayoutSideContentLeft />}
            else={<LayoutSideContent />}
          />
        </Button>

        <Button
          className="rounded-lg size-7"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t('nav.back')}
          isDisabled={!canGoBack}
          onPress={() => { sendNav('page:prev') }}
        >
          <ArrowLeft />
        </Button>

        <Button
          className="rounded-lg size-7"
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t('nav.forward')}
          isDisabled={!canGoForward}
          onPress={() => { sendNav('page:next') }}
        >
          <ArrowRight />
        </Button>
        <div className="ml-1">
          <DebugSidebar>
            <Button
              className="rounded-lg h-6 text-xs px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('app.expand_sidebar')}
            >
              {t('app.debug')}
            </Button>
          </DebugSidebar>
          <Dropdown>
            <Button
              className="rounded-lg h-6 text-xs px-1.5"
              size="sm"
              variant="ghost"
              aria-label={t('app.expand_sidebar')}
            >
              {t('app.help')}
            </Button>
            <Dropdown.Popover className="rounded-md w-5!">
              <Dropdown.Menu>
                <Dropdown.Item
                  className="rounded-md"
                  id="check-update"
                  textValue={t('menu.check_update')}
                  onAction={() => handleHelpAction('check-update')}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <Label>{t('menu.check_update')}</Label>
                    <If cond={updateInfo != null}>
                      <Description>{t('menu.new_version')}</Description>
                    </If>
                  </span>
                </Dropdown.Item>
                <Dropdown.Item
                  className="rounded-md"
                  id="about"
                  textValue={t('menu.about')}
                  onAction={() => handleHelpAction('about')}
                >
                  <Label>{t('menu.about')}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>

        </div>
      </If>

      {/* 拖拽区：Tauri 原生拖拽（仅此元素带 data-tauri-drag-region，按钮不受影响） */}
      <div
        className="min-w-0 flex-1 self-stretch"
        data-tauri-drag-region
        onDoubleClick={() => { void getCurrentWindow().toggleMaximize() }}
      />

      <Button
        className="rounded-lg size-7"
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t('nav.minimize')}
        onPress={() => { handleWindowAction('minimize') }}
      >
        <Minus />
      </Button>

      <Button
        className="rounded-lg size-7"
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t('nav.maximize')}
        onPress={() => { handleWindowAction('maximize') }}
      >
        <Square style={{ width: 14, height: 14 }} />
      </Button>

      <Button
        className="rounded-lg size-7 transition-colors enabled:hover:bg-danger/16 enabled:hover:text-danger"
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t('nav.background')}
        onPress={() => { handleWindowAction('background') }}
      >
        <Xmark />
      </Button>
    </div>
  )
}
