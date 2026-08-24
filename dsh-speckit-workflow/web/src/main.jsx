import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { antdConfig } from './theme/antd.js'
import App from './App.jsx'
import './styles/boards.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider theme={antdConfig}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
