import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('.', import.meta.url))

// 构建给 dsh 插件加载的单文件 IIFE bundle：
//   bundle-dist/board.js —— React + antd + App 组件树 + 内联 scoped CSS，
//   暴露 window.__SPKB_BOARD__.mount(container, deps)。
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    lib: {
      entry: resolve(root, 'src/board-bundle.jsx'),
      formats: ['iife'],
      name: 'SpkbBoard',
      fileName: () => 'board.js'
    },
    cssCodeSplit: false,
    minify: 'esbuild',
    outDir: 'bundle-dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        compact: true
      }
    }
  }
})