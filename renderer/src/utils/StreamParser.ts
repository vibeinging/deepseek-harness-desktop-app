/**
 * Streaming message parser.
 *
 * Handles both:
 * 1. Real-time parsing for streaming output
 * 2. Parsing of historical messages
 */

export class StreamParser {
  handlers: Record<string, any>

  constructor() {
    this.handlers = {
      content_stream: this.handleContentStream.bind(this),
      status_update: this.handleStatusUpdate.bind(this),
      complete: this.handleComplete.bind(this),
      error: this.handleError.bind(this),
      task_failed: this.handleError.bind(this),
      connection_established: this.handleConnectionEstablished.bind(this)
    }
  }

  // ============ Streaming event handling ============

  parseEvent(payload: any, streamingMessage: any, addContentItem: any) {
    const eventType = payload?.type || 'unknown'
    const handler = this.handlers[eventType]

    if (handler) {
      handler(payload, streamingMessage, addContentItem)
    } else {
      // Unknown type: if content_id exists, treat it as content_stream.
      if (payload && payload.content_id && payload.content !== undefined) {
        this.handleContentStream(payload, streamingMessage, addContentItem)
      }
    }
  }

  handleContentStream(event: any, streamingMessage: any, addContentItem: any) {
    const { content_id, content_type, content, session_id, title, metadata = {}, summary } = event

    // Validate session_id.
    if (session_id && streamingMessage.sessionId && session_id !== streamingMessage.sessionId) {
      return
    }

    if (!streamingMessage.content_items) {
      streamingMessage.content_items = []
    }

    let block = this.findContentBlock(streamingMessage, content_id)

    // Read display_type from content first.
    const displayType = (content && typeof content === 'object' && content.display_type)
      ? content.display_type
      : content_type

    const isObjectContent = content && typeof content === 'object'

    if (!block) {
      block = {
        id: content_id,
        type: content_type,
        content: isObjectContent ? null : '',
        title: title || this.getDefaultTitle(content_type, displayType),
        summary, // Promote summary to top-level.
        metadata: { ...metadata },
        is_streaming: true,
        is_complete: false,
        savable_to_panel: metadata.savable_to_panel || false,
        display_type: displayType
      }
      streamingMessage.content_items.push(block)
    } else {
      // Subsequent streaming events with the same content_id may add metadata/task_group/title,
      // so merge continuously into existing block to avoid losing grouping and display info.
      block.metadata = {
        ...(block.metadata || {}),
        ...(metadata || {})
      }

      if (summary !== undefined) {
        block.summary = summary
      }
      if (title) {
        block.title = title
      }
      if (displayType) {
        block.display_type = displayType
      }
      if (content_type) {
        block.type = content_type
      }
      if (metadata.savable_to_panel !== undefined) {
        block.savable_to_panel = Boolean(block.savable_to_panel || metadata.savable_to_panel)
      }
    }

    // If metadata contains task_plan, update the message top-level (latest value wins).
    if (metadata.task_plan && Array.isArray(metadata.task_plan)) {
      streamingMessage.task_plan = metadata.task_plan
    }

    // If metadata contains executor_info, update it to message top-level.
    if (metadata.executor_info && typeof metadata.executor_info === 'object') {
      streamingMessage.executor_info = metadata.executor_info
    }

    const replaceContent = metadata.replace_content === true

    // Append content incrementally.
    if (content !== undefined && content !== null) {
      if (isObjectContent) {
        block.content = content
        if (content.display_type) {
          block.display_type = content.display_type
        }
      } else if (typeof content === 'string') {
        if (replaceContent || typeof block.content !== 'string') {
          block.content = content
        } else if (typeof block.content === 'string') {
          block.content += content
        }
      }
    }

    if (addContentItem) {
      addContentItem({
        id: block.id,
        type: block.type,
        content: block.content,
        title: block.title,
        summary: block.summary, // Carry summary field.
        metadata: block.metadata || {},
        is_streaming: block.is_streaming,
        is_complete: block.is_complete,
        display_type: block.display_type,
        savable_to_panel: block.savable_to_panel
      })
    }

    streamingMessage.status = 'processing'
  }

  handleStatusUpdate(event: any, streamingMessage: any) {
    streamingMessage.status = event.status || 'processing'
    streamingMessage.statusMessage = event.message || '处理中...'
  }

  handleConnectionEstablished(event: any, streamingMessage: any) {
    streamingMessage.status = 'connected'
    streamingMessage.statusMessage = '连接已建立'
  }

  handleComplete(event: any, streamingMessage: any) {
    streamingMessage.status = 'completed'
    streamingMessage.statusMessage = event.message || '处理完成'
    streamingMessage.is_streaming = false
  }

  handleError(event: any, streamingMessage: any, addContentItem: any) {
    // task_failed errors are in the `error` field; error event details are in message/content.
    const errorMessage = event.error || event.message || event.content || '处理失败'

    if (addContentItem) {
      addContentItem({
        type: 'error',
        content: errorMessage,
        title: '错误'
      })
    }

    streamingMessage.status = 'error'
    streamingMessage.statusMessage = errorMessage
    streamingMessage.is_streaming = false
  }

  // ============ Historical message parsing ============

  /**
   * Parse a historical message into normalized shape.
   * @param {Object} msg - Message object returned by backend.
   * @returns {Object} - Normalized message object.
  */
  parseHistoryMessage(msg: any) {
    // Tolerate backend returning content_items as JSON string (desktop Node backend does this),
    // so try parsing it into array first to keep the existing content_items branch active.
    if (typeof msg.content_items === 'string') {
      try {
        const parsed = JSON.parse(msg.content_items)
        if (Array.isArray(parsed)) msg = { ...msg, content_items: parsed }
      } catch {
        /* Not valid JSON, keep as-is and fall back in later logic. */
      }
    }
    // If content_items exists, normalize directly.
    if (msg.content_items && Array.isArray(msg.content_items)) {
      // Extract task_plan from item metadata (keep the last one) to message top-level.
      let taskPlan = msg.task_plan || msg.message_metadata?.task_plan || null
      let executorInfo = msg.executor_info || msg.message_metadata?.executor_info || null
      for (const item of msg.content_items) {
        if (item.metadata?.task_plan && Array.isArray(item.metadata.task_plan)) {
          taskPlan = item.metadata.task_plan
        }
        if (item.metadata?.executor_info && typeof item.metadata.executor_info === 'object') {
          executorInfo = item.metadata.executor_info
        }
      }
      return {
        ...msg,
        is_streaming: false,
        task_plan: taskPlan,
        executor_info: executorInfo,
        content_items: msg.content_items.map((item: any) => this.normalizeContentItem(item))
      }
    }

    // If content exists, try to parse it.
    if (msg.content) {
      const contentItems = this.parseContentField(msg.content, msg.id)
      if (contentItems) {
        return {
          ...msg,
          is_streaming: false,
          content_items: contentItems
        }
      }
    }

    // No content available.
    return {
      ...msg,
      is_streaming: false,
      content_items: []
    }
  }

  /**
   * Parse content field.
   */
  parseContentField(content: any, msgId: any) {
    // If it is already an array.
    if (Array.isArray(content)) {
      return content.map((item: any) => this.normalizeContentItem(item))
    }

    // Try JSON parsing.
    if (typeof content === 'string') {
      try {
        const parsed = JSON.parse(content)

        // Parsed result is array.
        if (Array.isArray(parsed)) {
          return parsed.map((item: any) => this.normalizeContentItem(item))
        }

        // Parsed result contains content_items.
        if (parsed && Array.isArray(parsed.content_items)) {
          return parsed.content_items.map((item: any) => this.normalizeContentItem(item))
        }

        // Parsed result is a single object, wrap into one content item.
        if (parsed && typeof parsed === 'object') {
          return [this.normalizeContentItem({
            id: `${msgId}_content`,
            type: parsed.type || 'json',
            content: parsed,
            display_type: parsed.display_type
          })]
        }
      } catch (e) {
        // JSON parsing failed; treat as plain text.
        return [{
          id: `${msgId}_content`,
          type: 'text',
          content: content,
          title: null,
          metadata: {},
          is_streaming: false,
          is_complete: true,
          savable_to_panel: false,
          display_type: 'text'
        }]
      }
    }

    return null
  }

  /**
   * Normalize content item.
   */
  normalizeContentItem(item: any) {
    // Prioritize display_type from item, then content.display_type, then fallback to type.
    let displayType = item.display_type
    if (!displayType && item.content && typeof item.content === 'object') {
      displayType = item.content.display_type
    }
    if (!displayType) {
      displayType = item.type || 'text'
    }

    return {
      id: item.id || `item_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
      type: item.type || 'text',
      content: item.content,
      title: item.title || null,
      summary: item.summary, // Support summary field.
      metadata: item.metadata || {},
      is_streaming: false,
      is_complete: true,
      savable_to_panel: item.savable_to_panel || item.metadata?.savable_to_panel || false,
      display_type: displayType
    }
  }

  // ============ Utility methods ============

  findContentBlock(streamingMessage: any, contentId: any) {
    if (!streamingMessage.content_items) {
      return null
    }
    return streamingMessage.content_items.find((block: any) => block.id === contentId)
  }

  getDefaultTitle(contentType: any, displayType: any) {
    if (displayType) {
      const displayTitles: Record<string, string> = {
        table: '查询结果',
        bar: '柱状图',
        line: '折线图',
        pie: '饼图',
        text: '文本内容'
      }
      if (displayTitles[displayType]) {
        return displayTitles[displayType]
      }
    }

    const titles: Record<string, string> = {
      text: '文本',
      markdown: '内容',
      json: '数据',
      table: '查询结果',
      sql: 'SQL查询',
      error: '错误信息',
      html: '研究报告',
      user_input: '请选择'
    }
    return titles[contentType] || '内容'
  }

  reset() {
    // Stateless.
  }
}

export const defaultStreamParser = new StreamParser()

// Streaming event parser.
export function parseStreamEvent(payload: any, streamingMessage: any, addContentItem: any) {
  return defaultStreamParser.parseEvent(payload, streamingMessage, addContentItem)
}

// Historical message parser.
export function parseHistoryMessage(msg: any) {
  return defaultStreamParser.parseHistoryMessage(msg)
}

// Batch parse historical messages: filter out mirrored user disambiguation messages (avoid duplicate display),
// then normalize each message.
// Shared by chat page and share read-only page; keeps is_user_input_response filtering in one place.
export function parseHistoryMessages(rawMessages: any) {
  return (rawMessages || [])
    .filter((msg: any) => !(msg.role === 'user' && msg.message_metadata?.is_user_input_response))
    .map((msg: any) => defaultStreamParser.parseHistoryMessage(msg))
}
