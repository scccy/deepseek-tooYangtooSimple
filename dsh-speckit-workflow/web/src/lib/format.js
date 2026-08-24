export const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const formatTime = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—')

export const newActionId = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
