import type { SetupStatus } from '../store/modules/harness'
import type { IconComponent } from './loadable'
import { ArrowDownToLine, CircleCheck, CircleExclamation, CircleInfo, Magnifier, Rocket } from '@gravity-ui/icons'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { harness } from '../store/modules/harness'
import Loadable from './loadable'

// 各阶段对应不同图标，保持与 logo 一致的黑白中性色调
const STATUS_ICONS: Record<SetupStatus, IconComponent> = {
  checking: Magnifier,
  installing: ArrowDownToLine,
  starting: Rocket,
  preinstall: CircleInfo,
  ready: CircleCheck,
  error: CircleExclamation,
}

/**
 * 安装/更新页：基于通用 Loadable 组件渲染，
 * 视觉与官方 web shell 的 boot 加载页（AppRoot）一致。
 * 状态与重试动作直接从 harness store 读取，不再接收 props。
 */
export default function Setup() {
  const { t } = useTranslation()
  const { status, installer, errorMsg } = useStore(harness)
  const error = status === 'error'
  const installing = status === 'installing'
  const heading = error ? t('status.error') : installer.title || t('status.installing')
  const description = error ? '' : installer.detail || t('status.installing')
  const StatusIcon = STATUS_ICONS[status]

  return (
    <Loadable
      icon={StatusIcon}
      title={heading}
      subtitle={error ? undefined : description}
      percentage={installing ? installer.percentage : undefined}
      logs={installing ? installer.logs : undefined}
      errorMsg={error ? errorMsg : undefined}
      onRetry={error ? harness.boot : undefined}
    />
  )
}
