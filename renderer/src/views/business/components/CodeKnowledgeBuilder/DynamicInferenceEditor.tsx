import { useMemo } from 'react'
import { TextInput, Textarea, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './DynamicInferenceEditor.module.scss'

interface DynamicInferenceEditorProps {
  values?: any[]
  operator?: string | null
  description?: string
  fieldInfo?: Record<string, any>
  onUpdateValues?: (values: any[]) => void
  onUpdateDescription?: (description: string) => void
}

/**
 * Dynamic inference rule editor
 * Corresponds to Vue: DynamicInferenceEditor.vue
 */
export default function DynamicInferenceEditor({
  values = [],
  description = '',
  onUpdateValues,
  onUpdateDescription
}: DynamicInferenceEditorProps) {
  const { t } = useTranslation()

  // Rule name (values[0])
  const ruleName = useMemo(
    () => (values && values.length > 0 ? values[0] : ''),
    [values]
  )

  // Handle rule name change
  const handleRuleNameChange = (value: string) => {
    onUpdateValues?.(value ? [value] : [])
  }

  // Handle description change
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  return (
    <div className={styles.dynamicInferenceEditor}>
      {/* Rule name input */}
      <div className={styles.fieldSection}>
        <div className={styles.sectionLabel}>{t('business.codeKnowledge.ruleName')}</div>
        <TextInput
          value={ruleName}
          onChange={(e) => handleRuleNameChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.ruleNamePlaceholder')}
        />
      </div>

      {/* Hint information */}
      <div>
        <Text c="dimmed" size="sm" component="span" className={styles.hintSection}>
          <span className={styles.hintIcon}>
            <ElSvgIcon name="InfoFilled" size={14} />
          </span>
          {t('business.codeKnowledge.dynamicInferenceHint')}
        </Text>
      </div>

      {/* Condition description */}
      <div className={styles.descriptionSection}>
        <div className={styles.sectionLabel}>
          {t('business.codeKnowledge.conditionDescOptional')}
        </div>
        <Textarea
          value={description}
          onChange={(e) => handleDescriptionChange(e.currentTarget.value)}
          placeholder={t('business.codeKnowledge.dynamicInferenceDescPlaceholder')}
          rows={2}
        />
      </div>
    </div>
  )
}
