// Syntax-highlighted code viewer (highlight.js), used for read tool output and file preview.
import { useMemo } from 'react'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import styles from './agent.module.scss'

const langFromPath = (p?: string): string | undefined => {
  const ext = (p || '').split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    py: 'python',
    js: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    jsx: 'javascript',
    sql: 'sql',
    sh: 'bash',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    css: 'css',
    html: 'xml',
    csv: 'plaintext'
  }
  return ext ? map[ext] : undefined
}

export default function CodeView({ code, path, max = 320 }: { code: string; path?: string; max?: number }) {
  const html = useMemo(() => {
    const lang = langFromPath(path)
    try {
      return lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value
    } catch {
      return null
    }
  }, [code, path])

  return (
    <pre className={`hljs ${styles.codeView}`} style={{ maxHeight: max }}>
      {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
    </pre>
  )
}
