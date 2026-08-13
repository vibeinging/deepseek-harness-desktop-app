import { useEffect, useMemo, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { getAppInstructionsReq, updateAppInstructionsReq } from '@/api/app-settings'
import styles from './AppInstructions.module.scss'

const DEFAULT_MAX_LENGTH = 8_000

export default function AppInstructions() {
  const [instructions, setInstructions] = useState('')
  const [savedInstructions, setSavedInstructions] = useState('')
  const [maxLength, setMaxLength] = useState(DEFAULT_MAX_LENGTH)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    getAppInstructionsReq()
      .then((response: any) => {
        if (!alive) return
        const value = String(response?.data?.instructions || '')
        setInstructions(value)
        setSavedInstructions(value)
        setMaxLength(Number(response?.data?.max_length || DEFAULT_MAX_LENGTH))
      })
      .catch((error: any) => {
        if (!alive) return
        notifications.show({
          color: 'red',
          message: error?.message || '全局指令读取失败'
        })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [])

  const hasChanges = useMemo(
    () => instructions !== savedInstructions,
    [instructions, savedInstructions]
  )

  const save = async () => {
    if (!hasChanges || saving) return
    setSaving(true)
    try {
      const response: any = await updateAppInstructionsReq(instructions)
      const value = String(response?.data?.instructions ?? instructions.trim())
      setInstructions(value)
      setSavedInstructions(value)
      setMaxLength(Number(response?.data?.max_length || maxLength))
      notifications.show({ color: 'green', message: '全局指令已保存' })
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: error?.message || '全局指令保存失败'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.page} data-app-instructions>
      <h1>全局指令</h1>
      <p className={styles.lead}>
        设置 dsh-work 在所有普通聊天和项目中的通用回答偏好。保存后从下一轮消息开始生效。
      </p>

      <section className={styles.card}>
        <div className={styles.headingRow}>
          <div>
            <h2>给 dsh-work 的指令</h2>
            <p>例如常用语言、回答风格、代码习惯或希望一直遵守的工作方式。</p>
          </div>
          <span>{instructions.length.toLocaleString()} / {maxLength.toLocaleString()}</span>
        </div>
        <textarea
          data-testid="app-instructions-input"
          value={instructions}
          onChange={(event) => setInstructions(event.currentTarget.value)}
          maxLength={maxLength}
          disabled={loading || saving}
          placeholder={'例如：\n- 默认使用简体中文\n- 先给结论，再说明必要细节\n- 修改代码后运行相关测试'}
          aria-label="App 全局指令"
        />
        <div className={styles.actions}>
          <button data-testid="app-instructions-save" type="button" className={styles.primary} disabled={!hasChanges || loading || saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={!hasChanges || saving}
            onClick={() => setInstructions(savedInstructions)}
          >
            撤销更改
          </button>
        </div>
      </section>

      <div className={styles.scope}>
        <strong>作用范围</strong>
        <span>全局指令对所有聊天生效；项目指令只在对应项目中追加生效。两者都不能改变安全限制、工具权限和审批结果。</span>
      </div>
    </div>
  )
}
