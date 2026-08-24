import type { UnlistenFn } from '@tauri-apps/api/event'
import type { DshUpdateInfo } from './types'
import { invoke } from '@tauri-apps/api/core'
import i18next from 'i18next'
import { defineStore } from 'valtio-define'
import { harness } from '../harness'

/**
 * 版本更新模块：后台静默检查 + 手动更新安装。
 * 安装进度与启动等待复用 harness 模块的能力，本模块只负责"有没有新版本"的决策。
 */
export const updater = defineStore({
  state: () => ({
    /** 发现的新版本信息（null 表示暂无/已被忽略） */
    updateInfo: null as DshUpdateInfo | null,
    /** 是否正在安装更新 */
    updating: false,
  }),
  actions: {
    /** 后台静默检查是否有新版 Harness（网络失败/API 限流时静默跳过） */
    async checkForUpdate() {
      try {
        const info = await invoke<DshUpdateInfo | null>('check_dsh_update')
        if (info) {
          this.updateInfo = info
        }
      }
      catch (err) {
        console.warn('[Harness] update check skipped:', err)
      }
    },

    /** 手动更新：重新下载安装新版并重启服务 */
    async handleUpdate() {
      if (this.updating)
        return
      this.updating = true
      this.updateInfo = null
      let unlistenInstall: UnlistenFn | null = null
      try {
        unlistenInstall = await harness.listenInstallProgress()
        harness.prepareInstall(i18next.t('status.updating'))
        await invoke('install_dependencies')
        await harness.launchAndWait()
        this.updateInfo = null
      }
      catch (err) {
        console.error('[Harness] update failed:', err)
        harness.fail(String(err))
      }
      finally {
        unlistenInstall?.()
        this.updating = false
      }
    },

    /** 忽略本次更新提示 */
    dismissUpdate() {
      this.updateInfo = null
    },
  },
})
