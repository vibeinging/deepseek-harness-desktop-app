import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Group, Modal, Textarea } from '@mantine/core'
import { useResponsive } from '@/hooks/use-responsive'
import styles from './EditRuleDialog.module.scss'

interface RuleConfig {
  table_name?: string
  column_name?: string
  rule?: string
  [key: string]: any
}

interface EditRuleDialogProps {
  visible: boolean
  config?: RuleConfig | null
  saving?: boolean
  /** v-model:visible → callback */
  onUpdateVisible?: (val: boolean) => void
  /** v-model:rule → callback */
  onUpdateRule?: (val: string) => void
  /** @save */
  onSave?: (rule: string) => void
}

export default function EditRuleDialog(props: EditRuleDialogProps) {
  const { visible, config, saving = false, onUpdateVisible, onUpdateRule, onSave } = props
  const { t } = useTranslation()

  const { isMobile } = useResponsive()
  // Computed dialog width: 92% on mobile, otherwise 500px
  const dialogWidth = useMemo(() => (isMobile ? '92%' : '500px'), [isMobile])

  // ruleValue: in source this is computed(get: config?.rule, set: emit update:rule)
  // In React use controlled local state synced with config, and emit update:rule
  const [ruleValue, setRuleValue] = useState<string>(config?.rule || '')

  useEffect(() => {
    setRuleValue(config?.rule || '')
  }, [config?.rule])

  const handleRuleChange = (val: string) => {
    setRuleValue(val)
    onUpdateRule?.(val)
  }

  const handleCancel = () => {
    onUpdateVisible?.(false)
  }

  const handleSave = () => {
    onSave?.(ruleValue)
  }

  return (
    <Modal
      opened={visible}
      onClose={handleCancel}
      title={t('business.entity.editRuleTitle')}
      size={dialogWidth}
      closeOnClickOutside={false}
      className={styles.editRuleEntityDialog}
    >
      <div className={styles.editRuleDialogContent}>
        <div className={styles.ruleInfo}>
          {/* el-descriptions equivalent: custom bordered description table */}
          <table className={styles.descriptions}>
            <tbody>
              <tr>
                <th className={styles.descLabel}>{t('business.entity.tableName')}</th>
                <td className={styles.descContent}>{config?.table_name}</td>
              </tr>
              <tr>
                <th className={styles.descLabel}>{t('business.entity.fieldName')}</th>
                <td className={styles.descContent}>{config?.column_name}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className={styles.ruleInputSection}>
          <label className={styles.ruleLabel}>{t('business.entity.ruleDescription')}</label>
          <Textarea
            value={ruleValue}
            onChange={(e) => handleRuleChange(e.currentTarget.value)}
            autosize
            minRows={4}
            maxRows={4}
            placeholder={t('business.entity.rulePlaceholder')}
            maxLength={500}
          />
          {/* show-word-limit → manual word count */}
          <div className={styles.wordLimit}>{ruleValue.length}/500</div>
        </div>
      </div>

      <Group className={styles.dialogFooter} justify="flex-end" mt="lg">
        <Button variant="default" onClick={handleCancel}>
          {t('business.entity.cancel')}
        </Button>
        <Button color="primary" onClick={handleSave} loading={saving}>
          {t('business.entity.save')}
        </Button>
      </Group>
    </Modal>
  )
}
