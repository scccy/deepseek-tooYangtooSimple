import React from 'react'

// 轻量 Markdown 渲染（无外部依赖）：覆盖标题、段落、行内 code、
// 加粗/斜体、链接、无序/有序列表、引用、分隔线、围栏代码块。
// 产物查看场景足够用；未支持的特性按普通文本回退，不会渲染失败。

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderInlineLine(text, baseKey) {
  const nodes = []
  let buf = ''
  let i = 0
  const pushBuf = () => {
    if (buf) { nodes.push(buf); buf = '' }
  }
  while (i < text.length) {
    const rest = text.slice(i)
    let m
    if (rest.startsWith('`')) {
      const end = rest.indexOf('`', 1)
      if (end > 0) {
        pushBuf()
        nodes.push(<code key={`${baseKey}-c${i}`}>{rest.slice(1, end)}</code>)
        i += end + 1
        continue
      }
    }
    if ((m = rest.match(/^\[([^\]]+)\]\(([^)\s]+)\)/))) {
      pushBuf()
      const url = m[2]
      const safe = /^(https?:|mailto:)/i.test(url) ? url : '#'
      nodes.push(<a key={`${baseKey}-a${i}`} href={safe} target="_blank" rel="noreferrer">{renderInlineLine(m[1], `${baseKey}-a${i}`)}</a>)
      i += m[0].length
      continue
    }
    if ((m = rest.match(/^\*\*([^*]+)\*\*/)) || (m = rest.match(/^__([^_]+)__/))) {
      pushBuf()
      nodes.push(<strong key={`${baseKey}-b${i}`}>{renderInlineLine(m[1], `${baseKey}-b${i}`)}</strong>)
      i += m[0].length
      continue
    }
    if ((m = rest.match(/^\*([^*\s][^*]*)\*/))) {
      pushBuf()
      nodes.push(<em key={`${baseKey}-e${i}`}>{renderInlineLine(m[1], `${baseKey}-e${i}`)}</em>)
      i += m[0].length
      continue
    }
    buf += rest[0]
    i += 1
  }
  pushBuf()
  return nodes.length === 1 && typeof nodes[0] === 'string' ? nodes[0] : nodes
}

function renderBlocks(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // 围栏代码块
    const fence = line.match(/^```(.*)$/)
    if (fence) {
      const collected = []
      i += 1
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { collected.push(lines[i]); i += 1 }
      i += 1 // closing fence
      const lang = (fence[1] || '').trim()
      blocks.push(<pre key={`b${i}`}><code className={lang ? `lang-${escapeRegExp(lang)}` : ''}>{collected.join('\n')}</code></pre>)
      continue
    }
    // 标题
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      const H = `h${level}`
      blocks.push(React.createElement(H, { key: `b${i}` }, renderInlineLine(heading[2], `h${i}`)))
      i += 1
      continue
    }
    // 分隔线
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={`b${i}`} />)
      i += 1
      continue
    }
    // 引用
    if (/^>\s?/.test(line)) {
      const collected = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { collected.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      blocks.push(<blockquote key={`b${i}`}>{collected.map((l, idx) => <p key={idx}>{renderInlineLine(l, `q${i}-${idx}`)}</p>)}</blockquote>)
      continue
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const collected = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { collected.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i += 1 }
      blocks.push(<ul key={`b${i}`}>{collected.map((l, idx) => <li key={idx}>{renderInlineLine(l, `u${i}-${idx}`)}</li>)}</ul>)
      continue
    }
    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const collected = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { collected.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i += 1 }
      blocks.push(<ol key={`b${i}`}>{collected.map((l, idx) => <li key={idx}>{renderInlineLine(l, `o${i}-${idx}`)}</li>)}</ol>)
      continue
    }
    // 空行
    if (!line.trim()) { i += 1; continue }
    // 段落：收集连续普通行
    const collected = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|```$|\s*(---|\*\*\*|___)\s*$|>\s?|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i])) {
      collected.push(lines[i]); i += 1
    }
    blocks.push(<p key={`b${i}`}>{collected.map((l, idx) => <React.Fragment key={idx}>{idx > 0 ? <br /> : null}{renderInlineLine(l, `p${i}-${idx}`)}</React.Fragment>)}</p>)
  }
  return blocks
}

export default function Markdown({ source = '' }) {
  return <div className="markdown-body">{renderBlocks(source)}</div>
}