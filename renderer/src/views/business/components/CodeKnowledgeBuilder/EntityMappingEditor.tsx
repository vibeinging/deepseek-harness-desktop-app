import { useEffect, useMemo, useState } from 'react'
import { Select, Text, Textarea } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import axiosReq from '@/utils/axios-req'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './EntityMappingEditor.module.scss'

interface EntityConfig {
  column_name: string
  table_name: string
  metadata_fields?: string[]
  entity_type?: string
  [key: string]: any
}

export interface EntityMappingEditorProps {
  values?: string[]
  description?: string
  fieldInfo?: Record<string, any>
  allFields?: any[]
  businessId?: string
  projectId?: string
  onUpdateValues?: (values: string[]) => void
  onUpdateDescription?: (description: string) => void
}

export default function EntityMappingEditor({
  values = [],
  description = '',
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fieldInfo = {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  allFields = [],
  businessId = '',
  projectId = '',
  onUpdateValues,
  onUpdateDescription,
}: EntityMappingEditorProps) {
  const { t } = useTranslation()

  // Entity noun configuration list
  const [entityConfigs, setEntityConfigs] = useState<EntityConfig[]>([])

  // Selected configuration
  const [selectedConfigId, setSelectedConfigId] = useState('')

  // Configurations with attached fields
  const configsWithMetadata = useMemo(
    () => entityConfigs.filter((config) => config.metadata_fields && config.metadata_fields.length > 0),
    [entityConfigs],
  )

  // Selected configuration
  const selectedConfig = useMemo(
    () => entityConfigs.find((c) => c.column_name === selectedConfigId),
    [entityConfigs, selectedConfigId],
  )

  // Bound field name
  const boundFieldName = values && values.length > 0 ? values[0] : ''

  // setter: equivalent to original computed's setter
  const setBoundFieldName = (val: string) => {
    onUpdateValues?.(val ? [val] : [])
  }

  // Handle entity noun selection change
  const handleConfigChange = (configId: string | null) => {
    setSelectedConfigId(configId || '')
    setBoundFieldName('')
  }

  // Handle attached field selection change
  const handleFieldChange = (fieldName: string | null) => {
    setBoundFieldName(fieldName || '')
  }

  // Handle description change
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  // Load entity configurations
  const loadEntityConfigs = async () => {
    if (!businessId || !projectId) {
      return
    }

    try {
      const response = await axiosReq({
        url: `/api/projects/${projectId}/businesses/${businessId}/entity_configs`,
        method: 'get',
        params: { page: 1, page_size: 100 },
      })

      if (response.data?.items) {
        setEntityConfigs(
          response.data.items.filter((config: EntityConfig) => config.entity_type === 'column_value'),
        )
      }
    } catch (error) {
      // Silently handle errors
    }
  }

  // Watch businessId and projectId changes
  useEffect(() => {
    loadEntityConfigs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, projectId])

  // Watch entityConfigs changes and initialize selection state
  useEffect(() => {
    const currentField = boundFieldName
    if (!currentField) {
      setSelectedConfigId('')
      return
    }

    for (const config of entityConfigs) {
      if (config.metadata_fields?.includes(currentField)) {
        setSelectedConfigId(config.column_name)
        return
      }
    }
    setSelectedConfigId('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityConfigs])

  return (
    <div className={styles.entityMappingEditor}>
      {/* Entity noun selection */}
      <div className={styles.fieldSection}>
        <div className={styles.sectionLabel}>{t('business.codeKnowledge.selectEntityNoun')}</div>
        <Select
          value={selectedConfigId || null}
          onChange={handleConfigChange}
          placeholder={t('business.codeKnowledge.selectEntityNounPlaceholder')}
          clearable
          searchable
          data={configsWithMetadata.map((config) => ({
            value: config.column_name,
            label: `${config.column_name} (${config.table_name})`,
          }))}
        />
      </div>

      {/* Attached field selection */}
      {selectedConfig && (
        <div className={styles.fieldSection}>
          <div className={styles.sectionLabel}>{t('business.codeKnowledge.selectMetadataField')}</div>
          <Select
            value={boundFieldName || null}
            onChange={handleFieldChange}
            placeholder={t('business.codeKnowledge.selectMetadataFieldPlaceholder')}
            clearable
            searchable
            data={(selectedConfig.metadata_fields || []).map((field) => ({
              value: field,
              label: field,
            }))}
          />
        </div>
      )}

      {/* Info message */}
      <div className={styles.hintSection}>
        <Text c="dimmed" size="sm" className={styles.hintText}>
          <ElSvgIcon name="InfoFilled" size={14} />
          {t('business.codeKnowledge.entityMappingHint')}
        </Text>
      </div>

      {/* Condition description */}
      <div className={styles.descriptionSection}>
        <div className={styles.sectionLabel}>{t('business.codeKnowledge.conditionDescOptional')}</div>
        <Textarea
          value={description}
          onChange={(e) => handleDescriptionChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.entityMappingDescPlaceholder')}
          rows={2}
        />
      </div>
    </div>
  )
}
