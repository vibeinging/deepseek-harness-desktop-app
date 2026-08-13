import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, NumberInput, TextInput, Textarea, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { updateDataSourceReq, deleteDataSourceReq } from '@/api/structured_data_source'
import { getDatabaseDetailReq, updateDatabaseReq } from '@/api/database'
import { useProjectStore, projectGetters } from '@/store/project'
import { useResponsive } from '@/hooks/use-responsive'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './DataSourceSettings.module.scss'

interface DataSourceSettingsProps {
  dataSource: any
  databaseConnectionId?: string | null
  onUpdated?: (v: any) => void
  onDeleted?: () => void
}

interface SettingsForm {
  name: string
  description: string
  embedding_model_name: string
  retrieval_mode: string
  table_limit: number
}

export default function DataSourceSettings({
  dataSource,
  databaseConnectionId = null,
  onUpdated,
  onDeleted
}: DataSourceSettingsProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const currentProjectId = useProjectStore((s) => projectGetters.currentProjectId(s))
  const { isMobile } = useResponsive()
  const [saving, setSaving] = useState(false)

  const [form, setForm] = useState<SettingsForm>({
    name: '',
    description: '',
    embedding_model_name: '',
    retrieval_mode: 'table',
    table_limit: 5
  })

  // Database connection detail (used to save retrieval mode)
  const dbDetailRef = useRef<any>(null)

  // Vue-style watch equivalent for dataSource with immediate: true
  useEffect(() => {
    if (dataSource) {
      setForm((prev) => ({
        ...prev,
        name: dataSource.name || '',
        description: dataSource.description || '',
        embedding_model_name: dataSource.embedding_model_name || dataSource.embedding_model?.name || ''
      }))
    }
  }, [dataSource])

  // Vue-style watch equivalent for databaseConnectionId with immediate: true
  useEffect(() => {
        // Load retrieval-mode config from database connection
    const loadDbConfig = async () => {
      if (!databaseConnectionId) return
      try {
        const res: any = await getDatabaseDetailReq(currentProjectId, databaseConnectionId)
        if (res.success && res.data) {
          dbDetailRef.current = res.data
          if (res.data.extra_config && typeof res.data.extra_config === 'string') {
            try {
              const parsed = JSON.parse(res.data.extra_config)
              if (parsed && typeof parsed === 'object') {
                setForm((prev) => ({
                  ...prev,
                  retrieval_mode: parsed.retrieval_mode || 'table',
                  table_limit: parsed.table_limit || 5
                }))
              }
            } catch (e) {
              console.warn('解析extra_config失败:', e)
            }
          }
        }
      } catch (error) {
        console.error('Failed to load db config:', error)
      }
    }
    if (databaseConnectionId) loadDbConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseConnectionId])

  const handleSave = async () => {
    if (!form.name || !form.name.trim()) {
      notifications.show({ color: 'yellow', message: t('structuredData.nameRequired') })
      return
    }

    setSaving(true)
    try {
      // 1. Save basic datasource information
      const res: any = await updateDataSourceReq(
        currentProjectId,
        dataSource.id,
        form.name,
        form.description
      )
      if (!res.success) {
        notifications.show({ color: 'red', message: res.message || t('structuredData.saveFailed') })
        return
      }

      // 2. Save retrieval mode to database connection
      let retrievalModeFailed = false
      if (databaseConnectionId && dbDetailRef.current) {
        try {
          let existingExtra: any = {}
          if (dbDetailRef.current.extra_config && typeof dbDetailRef.current.extra_config === 'string') {
            try {
              existingExtra = JSON.parse(dbDetailRef.current.extra_config)
            } catch {
              /* ignore */
            }
          }
          const extraConfig = {
            ...existingExtra,
            retrieval_mode: form.retrieval_mode || 'table',
            table_limit: form.table_limit || 5
          }
          await updateDatabaseReq(currentProjectId, {
            id: databaseConnectionId,
            extra_config: JSON.stringify(extraConfig)
          })
        } catch (e) {
          console.error('保存召回模式失败:', e)
          retrievalModeFailed = true
        }
      }

      if (retrievalModeFailed) {
        notifications.show({ color: 'yellow', message: t('structuredData.retrievalModeSaveWarning') })
      } else {
        notifications.show({ color: 'green', message: t('structuredData.saveSuccess') })
      }
      onUpdated?.({ ...dataSource, name: form.name, description: form.description })
    } catch (error) {
      notifications.show({ color: 'red', message: t('structuredData.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = () => {
    modals.openConfirmModal({
      title: t('structuredData.deleteConfirmTitle'),
      children: <Text size="sm">{t('structuredData.deleteConfirmMsg')}</Text>,
      labels: { confirm: t('structuredData.confirm'), cancel: t('structuredData.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          const res: any = await deleteDataSourceReq(currentProjectId, dataSource.id, true)
          if (res.success) {
            notifications.show({ color: 'green', message: t('structuredData.deleteSuccess') })
            onDeleted?.()
            navigate('/structured_data_source')
          } else {
            notifications.show({ color: 'red', message: res.message || t('structuredData.deleteFailed') })
          }
        } catch (error) {
          notifications.show({ color: 'red', message: t('structuredData.deleteFailed') })
        }
      }
    })
  }

  // Simulate el-form label width and label position: mobile labels on top, desktop labels fixed-width right aligned
  const labelWidth = isMobile ? undefined : 120
  const fieldStyle: React.CSSProperties = isMobile
    ? { display: 'block' }
    : { display: 'flex', alignItems: 'flex-start', gap: 12 }
  const labelStyle: React.CSSProperties = isMobile
    ? { display: 'block', marginBottom: 6, fontSize: 14, color: 'var(--el-text-color-regular, #606266)' }
    : {
        width: labelWidth,
        flex: '0 0 auto',
        textAlign: 'right',
        paddingTop: 8,
        paddingRight: 12,
        fontSize: 14,
        color: 'var(--el-text-color-regular, #606266)'
      }
  const controlStyle: React.CSSProperties = { flex: 1, minWidth: 0 }

  return (
    <div className={styles.dataSourceSettings}>
      <div className={`${styles.contentCard} ${styles.settingsCard}`}>
        <div className={styles.settingsForm}>
          {/* Name */}
          <div className={styles.formItem} style={fieldStyle}>
            <label style={labelStyle}>{t('structuredData.name')}</label>
            <div style={controlStyle}>
              <TextInput
                size="md"
                value={form.name}
                placeholder={t('structuredData.namePlaceholder')}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.currentTarget.value }))}
              />
            </div>
          </div>

          {/* Description */}
          <div className={styles.formItem} style={fieldStyle}>
            <label style={labelStyle}>{t('structuredData.description')}</label>
            <div style={controlStyle}>
              <Textarea
                size="md"
                rows={3}
                value={form.description}
                placeholder={t('structuredData.descriptionPlaceholder')}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.currentTarget.value }))}
              />
            </div>
          </div>

          {/* Embedding model */}
          <div className={styles.formItem} style={fieldStyle}>
            <label style={labelStyle}>{t('structuredData.embeddingModel')}</label>
            <div style={controlStyle}>
              <TextInput size="md" value={form.embedding_model_name} disabled />
            </div>
          </div>

          {/* Retrieval mode */}
          {databaseConnectionId && (
            <div className={styles.formItem} style={fieldStyle}>
              <label style={labelStyle}>{t('database.connForm.retrievalMode')}</label>
              <div style={controlStyle}>
                <div className={styles.retrievalModeContainer}>
                  <div className={styles.retrievalModeGroup}>
                    {[
                      {
                        value: 'table',
                        title: t('database.connForm.tableRetrieval'),
                        desc: t('database.connForm.tableRetrievalDesc')
                      },
                      {
                        value: 'column',
                        title: t('database.connForm.columnRetrieval'),
                        desc: t('database.connForm.columnRetrievalDesc')
                      }
                    ].map((opt) => (
                      <div
                        key={opt.value}
                        className={`${styles.retrievalRadio} ${
                          form.retrieval_mode === opt.value ? styles.checked : ''
                        }`}
                        onClick={() => setForm((prev) => ({ ...prev, retrieval_mode: opt.value }))}
                      >
                        <div className={styles.radioContent}>
                          <div className={styles.radioTitle}>{opt.title}</div>
                          <div className={styles.radioDesc}>{opt.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Table retrieval count */}
          {databaseConnectionId && form.retrieval_mode === 'table' && (
            <div className={styles.formItem} style={fieldStyle}>
              <label style={labelStyle}>{t('database.connForm.tableLimit')}</label>
              <div style={controlStyle}>
                <NumberInput
                  size="md"
                  min={1}
                  max={50}
                  step={1}
                  value={form.table_limit}
                  onChange={(val) =>
                    setForm((prev) => ({ ...prev, table_limit: typeof val === 'number' ? val : 5 }))
                  }
                />
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className={styles.formItem} style={fieldStyle}>
            {!isMobile && <label style={labelStyle} />}
            <div style={controlStyle}>
              <div className={styles.settingsActions}>
                <Button
                  color="blue"
                  loading={saving}
                  leftSection={<ElSvgIcon name="Check" size={16} />}
                  onClick={handleSave}
                >
                  {t('structuredData.save')}
                </Button>
                <Button
                  color="red"
                  variant="light"
                  leftSection={<ElSvgIcon name="Delete" size={16} />}
                  onClick={handleDelete}
                >
                  {t('structuredData.delete')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
