import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button, Stack, TextInput, Textarea } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import {
  updateDataSourceReq,
  deleteDataSourceReq,
  generateDatasourceDescriptionReq
} from '@/api/unstructured_data_source'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import styles from './DataSourceSettings.module.scss'

export interface DataSourceSettingsProps {
  dataSource: any
  onUpdated?: (dataSource: any) => void
  onDeleted?: () => void
}

interface FormState {
  name: string
  description: string
  embedding_model_name: string
}

export default function DataSourceSettings({ dataSource, onUpdated, onDeleted }: DataSourceSettingsProps) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)
  const { isMobile } = useResponsive()

  const [saving, setSaving] = useState(false)
  const [generatingDesc, setGeneratingDesc] = useState(false)

  const [form, setForm] = useState<FormState>({
    name: '',
    description: '',
    embedding_model_name: ''
  })

  // Watch dataSource changes and sync form values (equivalent to watch immediate)
  useEffect(() => {
    if (dataSource) {
      setForm({
        name: dataSource.name || '',
        description: dataSource.description || '',
        embedding_model_name: dataSource.embedding_model_name || dataSource.embedding_model?.name || ''
      })
    }
  }, [dataSource])

  // Generate data source description with AI
  const handleGenerateDescription = async () => {
    setGeneratingDesc(true)
    try {
      const normalizedLanguage = String(i18n.language || 'zh')
        .toLowerCase()
        .startsWith('en')
        ? 'en'
        : 'zh'
      const res: any = await generateDatasourceDescriptionReq(currentProjectId, dataSource.id, normalizedLanguage)
      if (res?.data?.description) {
        setForm((prev) => ({ ...prev, description: res.data.description }))
        onUpdated?.({ ...dataSource, description: res.data.description })
        notifications.show({ color: 'green', message: t('unstructuredData.datasourceDescriptionGenerated') })
      } else {
        notifications.show({ color: 'yellow', message: t('unstructuredData.noDocDescriptions') })
      }
    } catch (e: any) {
      notifications.show({ color: 'red', message: t('unstructuredData.generateFailed', { error: e?.message || e }) })
    } finally {
      setGeneratingDesc(false)
    }
  }

  // Save data source settings
  const handleSave = async () => {
    if (!form.name || !form.name.trim()) {
      notifications.show({ color: 'yellow', message: t('unstructuredData.message.nameRequired') })
      return
    }

    setSaving(true)
    try {
      const res: any = await updateDataSourceReq(currentProjectId, dataSource.id, form.name, form.description)
      if (res.success) {
        notifications.show({ color: 'green', message: t('unstructuredData.message.saveSuccess') })
        onUpdated?.({ ...dataSource, name: form.name, description: form.description })
      } else {
        notifications.show({ color: 'red', message: res.message || t('unstructuredData.message.saveFailed') })
      }
    } catch (error) {
      notifications.show({ color: 'red', message: t('unstructuredData.message.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  // Delete data source
  const handleDelete = () => {
    modals.openConfirmModal({
      title: t('unstructuredData.message.deleteTitle'),
      children: t('unstructuredData.message.deleteConfirm'),
      labels: { confirm: t('common.confirm'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await deleteDataSourceReq(currentProjectId, dataSource.id, true)
          if (res.success) {
            notifications.show({ color: 'green', message: t('unstructuredData.message.deleteSuccess') })
            onDeleted?.()
            // Navigate back to list
            navigate('/unstructured_data_source')
          } else {
            notifications.show({ color: 'red', message: res.message || t('unstructuredData.message.deleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('unstructuredData.message.deleteFailed') })
        }
      }
    })
  }

  return (
    <div className={styles['data-source-settings']}>
      <div className={`${styles['content-card']} ${styles['settings-card']}`}>
        <Stack
          gap={0}
          className={styles['settings-form']}
        >
          {/* Name */}
          <div className={styles['form-item']}>
            <TextInput
              size="md"
              label={t('unstructuredData.settings.name')}
              labelProps={isMobile ? undefined : { style: { width: 120 } }}
              placeholder={t('unstructuredData.form.namePlaceholder')}
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.currentTarget.value }))}
            />
          </div>

          {/* Description */}
          <div className={styles['form-item']}>
            <Textarea
              size="md"
              label={t('unstructuredData.settings.description')}
              minRows={3}
              autosize
              placeholder={t('unstructuredData.form.descriptionPlaceholder')}
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.currentTarget.value }))}
            />
            <Button
              variant="subtle"
              size="compact-sm"
              loading={generatingDesc}
              style={{ marginTop: 4 }}
              leftSection={<ElSvgIcon name="MagicStick" size={14} />}
              onClick={handleGenerateDescription}
            >
              {generatingDesc
                ? t('unstructuredData.aiGenerating')
                : t('unstructuredData.aiGenerateDescription')}
            </Button>
          </div>

          {/* Embedding model (disabled) */}
          <div className={styles['form-item']}>
            <TextInput
              size="md"
              label={t('unstructuredData.settings.embeddingModel')}
              disabled
              value={form.embedding_model_name}
              readOnly
            />
          </div>

          {/* Action buttons */}
          <div className={styles['settings-actions']}>
            <Button
              variant="light"
              className={styles['save-btn']}
              loading={saving}
              leftSection={<ElSvgIcon name="Check" size={16} />}
              onClick={handleSave}
            >
              {t('unstructuredData.settings.save')}
            </Button>
            <Button
              variant="light"
              color="red"
              className={styles['delete-btn']}
              leftSection={<ElSvgIcon name="Delete" size={16} />}
              onClick={handleDelete}
            >
              {t('unstructuredData.settings.delete')}
            </Button>
          </div>
        </Stack>
      </div>
    </div>
  )
}
