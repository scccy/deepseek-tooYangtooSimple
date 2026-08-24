import { useWatch } from '@hairy/react-lib'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { toast } from '@/utils'
import { updater } from '../store/modules/updater'
/** 右下角"发现新版本"提示条：状态与操作直接来自 updater store */
export default function HarnessUpdater() {
  const { t } = useTranslation()
  const { updateInfo, updating } = useStore(updater)

  useWatch([updateInfo, updating], () => {
    if (!updateInfo || updating)
      return null
    toast(t('update.available', { tag: updateInfo.tag }), {
      actionProps: {
        children: t('update.now'),
        onPress: () => {
          toast.clear()
          void updater.handleUpdate()
        },
        variant: 'tertiary',
      },
      placement: 'bottom end',
      description: updateInfo.commit.slice(0, 7),
      variant: 'default',
    })
  }, { immediate: true })

  return null
}
