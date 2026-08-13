import { useMemo } from 'react'
import { marked } from 'marked'
import styles from './QuestionOptions.module.scss'

// Markdown config (module-level, initialized once; aligned with global options in useMarkdown.js).
marked.setOptions({
  breaks: true,
  gfm: true,
  smartLists: true,
  smartypants: true,
} as any)

// Markdown render helper (aligned with renderMarkdown in composables/useMarkdown.js).
const renderMarkdown = (content: string) => {
  if (!content) return ''
  try {
    return marked(content) as string
  } catch (error) {
    console.error('Markdown 渲染失败:', error)
    return content.replace(/\n/g, '<br>')
  }
}

// Parse content block object (aligned with parseBlockContentObject in composables/useContentBlock.js).
const parseBlockContentObject = (content: any): any => {
  if (content && typeof content === 'object') {
    return content
  }

  if (typeof content === 'string') {
    try {
      return JSON.parse(content || '{}')
    } catch {
      return {}
    }
  }

  return {}
}

export interface QuestionOptionsProps {
  content: string | Record<string, any>
  dismissed?: boolean
}

// Render only the prompt text.
// Options are rendered above the input (chip bar), so users can select from them or type freely.
export default function QuestionOptions({ content, dismissed = false }: QuestionOptionsProps) {
  const renderedPrompt = useMemo(() => {
    const prompt = parseBlockContentObject(content)?.prompt || ''
    return renderMarkdown(prompt)
  }, [content])

  if (dismissed || !renderedPrompt) return null

  return (
    <div
      className={`${styles.questionPrompt} markdown-content`}
      dangerouslySetInnerHTML={{ __html: renderedPrompt }}
    />
  )
}
