import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Group, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'

import { updateProjectReq } from '@/api/project'
import styles from './ProjectInstructions.module.scss'

const MAX_INSTRUCTIONS_LENGTH = 8_000

interface ProjectInstructionsProps {
  project?: any
  onUpdated?: (data: any) => void
}

export default function ProjectInstructions({ project = null, onUpdated }: ProjectInstructionsProps) {
  const { t } = useTranslation()
  const [instructions, setInstructions] = useState('')
  const [saving, setSaving] = useState(false)
  const canEdit = project?.is_owner !== false

  useEffect(() => {
    setInstructions(project?.instructions || '')
  }, [project?.id, project?.instructions])

  const savedInstructions = project?.instructions || ''
  const hasChanges = useMemo(
    () => instructions !== savedInstructions,
    [instructions, savedInstructions]
  )

  const handleSave = async () => {
    if (!project?.id || !canEdit || saving) return
    setSaving(true)
    try {
      const response: any = await updateProjectReq(project.id, { instructions })
      notifications.show({ color: 'green', message: t('project.instructions.updateSuccess') })
      onUpdated?.(response.data)
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message: error?.msg || error?.message || t('project.instructions.updateFailed')
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={styles.page} data-project-instructions>
      <header className={styles.header}>
        <h2>{t('project.instructions.title')}</h2>
        <p>{t('project.instructions.description')}</p>
      </header>

      <div className={styles.editor}>
        <Textarea
          data-testid="project-instructions-input"
          value={instructions}
          onChange={(event) => setInstructions(event.currentTarget.value)}
          label={t('project.instructions.fieldLabel')}
          description={t('project.instructions.fieldDescription')}
          placeholder={t('project.instructions.placeholder')}
          maxLength={MAX_INSTRUCTIONS_LENGTH}
          minRows={10}
          maxRows={18}
          autosize
          readOnly={!canEdit}
          classNames={{
            label: styles.fieldLabel,
            description: styles.fieldDescription,
            input: styles.textarea
          }}
        />
        <div className={styles.editorMeta}>
          <span>{canEdit ? t('project.instructions.localOnly') : t('project.instructions.ownerOnly')}</span>
          <span>{instructions.length.toLocaleString()} / {MAX_INSTRUCTIONS_LENGTH.toLocaleString()}</span>
        </div>
      </div>

      {canEdit && (
        <Group className={styles.actions}>
          <Button data-testid="project-instructions-save" onClick={handleSave} loading={saving} disabled={!hasChanges}>
            {t('project.instructions.save')}
          </Button>
          {hasChanges && (
            <Button variant="default" onClick={() => setInstructions(savedInstructions)} disabled={saving}>
              {t('project.instructions.reset')}
            </Button>
          )}
        </Group>
      )}

      <div className={styles.scope}>
        <strong>{t('project.instructions.scopeTitle')}</strong>
        <span>{t('project.instructions.scopeDescription')}</span>
      </div>
    </section>
  )
}
