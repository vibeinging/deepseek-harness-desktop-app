import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, Badge } from '@mantine/core'
import { OPERATOR_CONFIG } from '@/config/operators.config'
import styles from './TypeSelector.module.scss'

interface TypeSelectorProps {
  /** Corresponds to v-model:type */
  type?: string
  /** Corresponds to v-model:operator */
  operator?: string | null
  /** emit('update:type') */
  onUpdateType?: (val: string) => void
  /** emit('update:operator') */
  onUpdateOperator?: (val: string | null) => void
  /** emit('change') */
  onChange?: (val: string) => void
}

export default function TypeSelector({
  type = 'field_condition',
  operator = null,
  onUpdateType,
  onUpdateOperator,
  onChange
}: TypeSelectorProps) {
  const { t } = useTranslation()

  // Available operator list
  const availableOperators = useMemo(() => {
    return OPERATOR_CONFIG.availableOperators || []
  }, [])

  // Whether to show operator selector
  const showOperatorSelector = type !== 'sql_fragment'

  // Whether operator control is disabled
  const operatorDisabled = type === 'sql_fragment' || type === 'entity_mapping'

  // Fixed text for operator
  const operatorFixedText = useMemo(() => {
    if (type === 'sql_fragment') return t('business.codeKnowledge.noOperatorNeeded')
    if (type === 'entity_mapping') return t('business.codeKnowledge.fixedEquals')
    return ''
  }, [type, t])

  // Handle type change
  const handleTypeChange = (newType: string | null) => {
    if (newType === null) return
    onUpdateType?.(newType)

    // Set default operator by type
    let defaultOperator: string | null = null
    switch (newType) {
      case 'field_condition':
        defaultOperator = null
        break
      case 'sql_fragment':
        defaultOperator = ''
        break
      case 'entity_mapping':
        defaultOperator = '='
        break
      case 'dynamic_inference':
        defaultOperator = null
        break
    }

    onUpdateOperator?.(defaultOperator)
    onChange?.(newType)
  }

  // Handle operator change
  const handleOperatorChange = (newOperator: string | null) => {
    onUpdateOperator?.(newOperator)
  }

  const typeOptions = [
    { value: 'field_condition', label: t('business.codeKnowledge.staticCondition') },
    { value: 'sql_fragment', label: t('business.codeKnowledge.sqlFragment') },
    { value: 'entity_mapping', label: t('business.codeKnowledge.entityMapping') },
    { value: 'dynamic_inference', label: t('business.codeKnowledge.dynamicInference') }
  ]

  return (
    <div className={styles.typeSelector}>
      <div className={styles.selectorRow}>
        <span className={styles.selectorLabel}>{t('business.codeKnowledge.type')}</span>
        <Select
          value={type}
          placeholder={t('business.codeKnowledge.selectType') as string}
          onChange={handleTypeChange}
          size="sm"
          className={styles.typeSelectInput}
          data={typeOptions}
          comboboxProps={{ withinPortal: true }}
          allowDeselect={false}
        />
      </div>

      {showOperatorSelector && (
        <div className={`${styles.selectorRow} ${styles.operatorRow}`}>
          <span className={styles.selectorLabel}>{t('business.codeKnowledge.operator')}</span>
          <Select
            value={operator ?? null}
            placeholder={t('business.codeKnowledge.selectOperator') as string}
            disabled={operatorDisabled}
            clearable
            onChange={handleOperatorChange}
            size="sm"
            className={styles.typeSelectInput}
            comboboxProps={{ withinPortal: true }}
            data={availableOperators.map((op: any) => ({ value: op.value, label: op.label }))}
          />
          {operatorDisabled && (
            <Badge color="gray" variant="light" size="sm" className={styles.operatorTag} style={{ marginLeft: 8 }}>
              {operatorFixedText}
            </Badge>
          )}
        </div>
      )}
    </div>
  )
}
