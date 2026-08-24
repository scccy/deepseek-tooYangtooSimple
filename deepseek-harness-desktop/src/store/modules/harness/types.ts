/** 安装/启动流程阶段状态 */
export type SetupStatus = 'checking' | 'installing' | 'starting' | 'preinstall' | 'ready' | 'error'

/** 侧边栏忙碌标记：标识当前正在执行的服务操作 */
export type SidebarBusyAction = 'restart' | 'shutdown' | 'start' | 'openBrowser' | null

/** 预装插件列表项（与 Rust service::plugin::PreinstallPlugin 对齐） */
export interface PreinstallPlugin {
  id: string
  name: string
  description: string
  repo_url: string
  recommended: boolean
  /** “修复”类项（Windows 极简模式修复）：黄色 chip，默认勾选 */
  fix: boolean
  /** 无 chip 但默认勾选（首次引导直接勾上，不标「推荐」） */
  defaultChecked: boolean
  installed: boolean
}

/** Rust 侧 preinstall-log 事件载荷（dsh plugin 进程输出行） */
export interface PreinstallLogPayload {
  line: string
}

/** 安装器展示状态 */
export interface InstallerState {
  title: string
  detail: string
  percentage: number
  logs: string[]
}

/** Rust 侧 install-progress 事件载荷 */
export interface InstallProgress {
  title: string
  detail: string
  log: string
  type: string
  percentage: number
  progress: number
}
