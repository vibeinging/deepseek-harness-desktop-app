import {
  GENERATIVE_UI_LIMITS,
  type GenerativeUiButtonNodeV1,
  type GenerativeUiDocumentV1,
  type GenerativeUiFormNodeV1,
  type GenerativeUiFormValues
} from './types'

export type GenerativeUiActionMessageResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors: Record<string, string> }

function visibleText(value: unknown) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function checkedMessageLength(message: string): GenerativeUiActionMessageResult {
  if (message.length > GENERATIVE_UI_LIMITS.actionMessage) {
    return {
      ok: false,
      error: `提交内容不能超过 ${GENERATIVE_UI_LIMITS.actionMessage} 个字符，请缩短输入`,
      fieldErrors: {}
    }
  }
  return { ok: true, message }
}

function surfaceTitle(document: GenerativeUiDocumentV1) {
  return visibleText(document.title) || 'Agent 生成界面'
}

export function buildGenerativeUiButtonMessage(
  document: GenerativeUiDocumentV1,
  button: GenerativeUiButtonNodeV1
): GenerativeUiActionMessageResult {
  const message = [
    '[生成式界面操作]',
    `界面：${surfaceTitle(document)}`,
    `操作：${visibleText(button.label)}（${button.action_id}）`
  ].join('\n')
  return checkedMessageLength(message)
}

export function buildGenerativeUiFormMessage(
  document: GenerativeUiDocumentV1,
  form: GenerativeUiFormNodeV1,
  values: GenerativeUiFormValues
): GenerativeUiActionMessageResult {
  const fieldErrors: Record<string, string> = {}
  const lines = form.children.map((field) => {
    const rawValue = values[field.name]
    if (field.type === 'checkbox') {
      if (typeof rawValue !== 'boolean') fieldErrors[field.name] = '复选框的值无效'
      return `- ${visibleText(field.label)}：${rawValue === true ? '是' : '否'}`
    }

    const value = typeof rawValue === 'string' ? rawValue : ''
    if (value.length > GENERATIVE_UI_LIMITS.input) {
      fieldErrors[field.name] = `最多输入 ${GENERATIVE_UI_LIMITS.input} 个字符`
    } else if (field.required && !value.trim()) {
      fieldErrors[field.name] = '此项为必填项'
    }

    if (field.type === 'select') {
      const option = field.options.find((item) => item.value === value)
      if (value && !option) fieldErrors[field.name] = '请选择列表中的有效选项'
      const displayed = option?.label || (value ? '' : '未选择')
      return `- ${visibleText(field.label)}：${visibleText(displayed)}`
    }

    return `- ${visibleText(field.label)}：${visibleText(value) || '未填写'}`
  })

  if (Object.keys(fieldErrors).length) {
    return { ok: false, error: '请检查表单中的输入', fieldErrors }
  }

  const message = [
    '[生成式界面提交]',
    `界面：${surfaceTitle(document)}`,
    `操作：${visibleText(form.submit_label)}（${form.action_id}）`,
    '输入：',
    ...lines
  ].join('\n')
  return checkedMessageLength(message)
}
