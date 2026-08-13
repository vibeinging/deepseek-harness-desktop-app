import { useEffect, useMemo, useState } from 'react'
import { Button, Modal } from '@mantine/core'
import { IconArrowRight, IconCheck, IconFolder, IconMessage } from '@tabler/icons-react'
import styles from './ConversationMoveModal.module.scss'

export interface ConversationMoveRequest {
  fromProjectId: string
  conversationId: string
  title: string
  status?: string
}

export interface ConversationMoveProject {
  id: string
  name: string
}

export default function ConversationMoveModal({
  request,
  projects,
  opened,
  onClose,
  onMove
}: {
  request: ConversationMoveRequest | null
  projects: ConversationMoveProject[]
  opened: boolean
  onClose: () => void
  onMove: (request: ConversationMoveRequest, targetProjectId: string) => Promise<void>
}) {
  const targets = useMemo(
    () => projects.filter((project) => project.id !== request?.fromProjectId),
    [projects, request?.fromProjectId]
  )
  const [targetId, setTargetId] = useState('')
  const [moving, setMoving] = useState(false)

  useEffect(() => {
    if (!opened) return
    setTargetId((current) => targets.some((project) => project.id === current) ? current : targets[0]?.id || '')
  }, [opened, request?.conversationId, targets])

  const submit = async () => {
    if (!request || !targetId || moving) return
    setMoving(true)
    try {
      await onMove(request, targetId)
      onClose()
    } catch {
      // The caller reports the server error and keeps the dialog open for retry.
    } finally {
      setMoving(false)
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={() => !moving && onClose()}
      title="移到项目"
      centered
      size={520}
      classNames={{ content: styles.modal, header: styles.header, title: styles.title, body: styles.body }}
      closeButtonProps={{ 'aria-label': '关闭移动对话窗口', disabled: moving }}
    >
      <div className={styles.conversation} data-conversation-move>
        <IconMessage size={17} stroke={1.7} />
        <span>{request?.title || '新对话'}</span>
        <IconArrowRight size={16} stroke={1.6} />
      </div>

      <div className={styles.label}>选择目标项目</div>
      <div className={styles.projectList} role="radiogroup" aria-label="目标项目">
        {targets.map((project) => {
          const selected = project.id === targetId
          return (
            <button
              key={project.id}
              type="button"
              className={`${styles.project} ${selected ? styles.projectSelected : ''}`}
              role="radio"
              data-target-project-id={project.id}
              aria-checked={selected}
              onClick={() => setTargetId(project.id)}
            >
              <IconFolder size={18} stroke={1.6} />
              <span>{project.name}</span>
              {selected && <IconCheck size={17} stroke={2} />}
            </button>
          )
        })}
        {targets.length === 0 && <div className={styles.empty}>还没有可移入的项目。</div>}
      </div>

      <p className={styles.hint}>移动后会保留历史记录，并从下一轮开始使用目标项目的文件和项目指令。</p>

      <div className={styles.actions}>
        <Button variant="subtle" color="gray" onClick={onClose} disabled={moving}>取消</Button>
        <Button data-testid="conversation-move-submit" onClick={submit} loading={moving} disabled={!targetId}>移到项目</Button>
      </div>
    </Modal>
  )
}
