import { theme as antdTheme } from 'antd'

/**
 * Ant Design dark theme mapped to the confirmed v0.7/v0.8 design tokens
 * (lib/client.js CSS variables, preserved verbatim).
 */
const TOKENS = {
  colorPrimary: '#49c7b5',
  colorInfo: '#49c7b5',
  colorSuccess: '#6bd18b',
  colorWarning: '#e8b45d',
  colorError: '#ef7d7d',
  colorBgBase: '#0e1115',
  colorBgContainer: '#151a20',
  colorBgElevated: '#1b222a',
  colorBgLayout: '#0e1115',
  colorBorder: '#2b353f',
  colorBorderSecondary: '#202930',
  colorText: '#edf1f4',
  colorTextSecondary: '#96a3ad',
  colorTextTertiary: '#66737d',
  colorTextQuaternary: '#4a5661',
  borderRadius: 8,
  borderRadiusLG: 10,
  boxShadow: '0 18px 44px rgba(0,0,0,0.28)',
  fontFamily:
    '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
  fontSize: 13
}

export const antdConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: TOKENS,
  components: {
    Drawer: {
      paddingLG: 0
    },
    Modal: {
      paddingContentHorizontalLG: 0,
      paddingContentVerticalLG: 0,
      headerBg: '#151a20',
      contentBg: '#151a20'
    },
    Switch: {
      switchHeight: 18,
      switchMinWidth: 31,
      colorPrimary: '#318879',
      colorPrimaryHover: '#3f9d91'
    },
    Select: {
      colorBgContainer: '#151a20',
      colorBorder: '#2b353f',
      colorText: '#edf1f4'
    }
  }
}
