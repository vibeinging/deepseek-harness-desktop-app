import { useMemo } from 'react'
import { Button, Checkbox, Text, Textarea, TextInput } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './FieldConditionEditor.module.scss'

interface EnumMapping {
  code: string
  label: string
  [key: string]: any
}

interface FieldConditionEditorProps {
  values?: string[]
  description?: string
  fieldInfo?: Record<string, any>
  enumMappings?: EnumMapping[]
  // defineEmits(['update:values', 'update:description']) → callback props
  onUpdateValues?: (values: string[]) => void
  onUpdateDescription?: (description: string) => void
}

export default function FieldConditionEditor(props: FieldConditionEditorProps) {
  const {
    values = [],
    description = '',
    enumMappings = [],
    onUpdateValues,
    onUpdateDescription,
  } = props
  const { t } = useTranslation()

  // Whether enum mappings exist
  const hasEnumMappings = useMemo(() => {
    return !!(enumMappings && enumMappings.length > 0)
  }, [enumMappings])

  // values array
  const valuesArray = values || []

  // Manual input text
  const manualInputText = useMemo(() => {
    return valuesArray.join('\n')
  }, [valuesArray])

  // Check if enum value is selected
  const isValueSelected = (code: string) => {
    return valuesArray.includes(code)
  }

  // Handle enum checkbox change
  const handleValueCheckChange = (mapping: EnumMapping, checked: boolean) => {
    const newValues = [...valuesArray]
    const code = mapping.code

    if (checked) {
      // Add
      if (!newValues.includes(code)) {
        newValues.push(code)
      }
    } else {
      // Remove
      const index = newValues.indexOf(code)
      if (index > -1) {
        newValues.splice(index, 1)
      }
    }

    onUpdateValues?.(newValues)
  }

  // Handle manual input change
  const handleManualInputChange = (value: string) => {
    // Split by lines and filter empty lines
    const lines = value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    onUpdateValues?.(lines)
  }

  // Select all enum values
  const handleSelectAll = () => {
    const allCodes = enumMappings.map((m) => m.code)
    onUpdateValues?.(allCodes)
  }

  // Clear all enum values
  const handleClearAll = () => {
    onUpdateValues?.([])
  }

  // Handle description change
  const handleDescriptionChange = (value: string) => {
    onUpdateDescription?.(value)
  }

  return (
    <div className={styles.fieldConditionEditor}>
      {/* If enum values exist, show enum selector */}
      {hasEnumMappings && (
        <div className={styles.enumSection}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>
              {t('business.codeKnowledge.enumValueSelect')}
            </span>
            <Button size="xs" variant="default" onClick={handleSelectAll}>
              {t('business.codeKnowledge.selectAll')}
            </Button>
            <Button size="xs" variant="default" onClick={handleClearAll}>
              {t('business.codeKnowledge.clear')}
            </Button>
          </div>
          <div className={styles.enumValuesList}>
            {enumMappings.map((mapping) => (
              <div key={mapping.code} className={styles.enumValueItem}>
                <Checkbox
                  checked={isValueSelected(mapping.code)}
                  onChange={(event) =>
                    handleValueCheckChange(mapping, event.currentTarget.checked)
                  }
                  label={
                    <div className={styles.valueInfo}>
                      <span className={styles.codeText}>{mapping.code}</span>
                      <span className={styles.labelText}>{mapping.label}</span>
                    </div>
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual input area */}
      <div className={styles.manualInputSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionLabel}>
            {hasEnumMappings
              ? t('business.codeKnowledge.orManualInput')
              : t('business.codeKnowledge.inputValues')}
          </span>
          <Text c="dimmed" size="sm">
            {t('business.codeKnowledge.valuesEntered', { count: valuesArray.length })}
          </Text>
        </div>
        <Textarea
          value={manualInputText}
          onChange={(event) => handleManualInputChange(event.currentTarget.value)}
          rows={4}
          placeholder={t('business.codeKnowledge.inputValuesPlaceholder')}
        />
      </div>

      {/* Description input */}
      <div className={styles.descriptionSection}>
        <span className={styles.sectionLabel}>
          {t('business.codeKnowledge.conditionDescOptional')}
        </span>
        <TextInput
          value={description}
          onChange={(event) => handleDescriptionChange(event.currentTarget.value)}
          placeholder={t('business.codeKnowledge.conditionDescPlaceholder')}
        />
      </div>
    </div>
  )
}
