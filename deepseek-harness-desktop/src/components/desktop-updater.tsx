import { useWatch } from '@hairy/react-lib'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { toast } from '@/utils'
import { desktopUpdate } from '../store/modules/desktop-update'

/** 桌面端自更新轮询间隔：每 10 秒检查一次（Rust 侧带缓存，不重复打网络） */
const POLL_INTERVAL = 10_000

/**
 * 桌面端「发现新版本」提示：后台每 10 秒轮询，发现新版本时在右下角弹 toast。
 * 用户关闭后记住该版本，本次会话不再弹出；新版本出现仍会再次提示。
 */
export default function DesktopUpdater() {
  const { t } = useTranslation()
  const { updateInfo, dismissedTag, downloading, updateDialogOpen } = useStore(desktopUpdate)

  // 每 10 秒静默检查一次新版本
  useEffect(() => {
    void desktopUpdate.check()
    const timer = setInterval(() => {
      void desktopUpdate.check()
    }, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [])

  useWatch([updateInfo, dismissedTag, downloading, updateDialogOpen], () => {
    if (!updateInfo || downloading || updateDialogOpen)
      return
    // 用户已关闭过该版本提示 → 不再弹出
    if (updateInfo.tag === dismissedTag)
      return
    toast(t('update.available', { tag: updateInfo.tag }), {
      actionProps: {
        children: t('update.now'),
        onPress: () => {
          toast.clear()
          void desktopUpdate.downloadAndOpen()
        },
        variant: 'tertiary',
      },
      placement: 'bottom end',
      description: t('update.desktop_new'),
      variant: 'default',
      onClose: () => desktopUpdate.dismissToast(),
    })
  }, { immediate: true })

  return null
}
