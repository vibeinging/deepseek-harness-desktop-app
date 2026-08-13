import { useMemo } from 'react'
import { Text, Textarea, TextInput } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './SqlFragmentEditor.module.scss'

interface SqlFragmentEditorProps {
  values?: string[]
  description?: string
  fieldInfo?: Record<string, any>
  onUpdateValues?: (values: string[]) => void
  onUpdateDescription?: (description: string) => void
}

export default function SqlFragmentEditor({
  values = [],
  description = '',
  // fieldInfo is not yet used in this component; keep it to align with original component props contract
  fieldInfo = {},
  onUpdateValues,
  onUpdateDescription,
}: SqlFragmentEditorProps) {
  const { t } = useTranslation()

  // SQL value (take the first one)
  const sqlValue = useMemo(
    () => (values && values.length > 0 ? values[0] : ''),
    [values],
  )

  // Handle SQL change
  const handleSqlChange = (value: string) => {
    onUpdateValues?.(value ? [value] : [])
  }

  // Handle description change
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  return (
    <div className={styles.sqlFragmentEditor}>
      <div className={styles.sqlInputSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>
            {t('business.codeKnowledge.sqlExpression')}
          </span>
          <Text c="dimmed" size="sm">
            {t('business.codeKnowledge.sqlExpressionHint')}
          </Text>
        </div>
        <Textarea
          value={sqlValue}
          onChange={(e) => handleSqlChange(e.currentTarget.value)}
          rows={3}
          placeholder={t('business.codeKnowledge.sqlExpressionPlaceholder')}
        />
        <Text c="orange" size="sm" style={{ marginTop: 4, display: 'block' }}>
          {t('business.codeKnowledge.sqlWarning')}
        </Text>
      </div>

      {/* Description input */}
      <div className={styles.descriptionSection}>
        <span className={styles.sectionLabel}>
          {t('business.codeKnowledge.conditionDescOptional')}
        </span>
        <TextInput
          value={description}
          onChange={(e) => handleDescriptionChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.sqlConditionDescPlaceholder')}
        />
      </div>
    </div>
  )
}
