import { Button } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import SemanticEmptyState from '../../SemanticEmptyState'

// defineEmits(['add-column-value', 'add-column-name']) → callback props
export interface EmptyStateProps {
  onAddColumnValue?: () => void
  onAddColumnName?: () => void
}

export default function EmptyState({ onAddColumnValue, onAddColumnName }: EmptyStateProps) {
  const { t } = useTranslation()

  return (
    <SemanticEmptyState
      icon={<ElSvgIcon name="Collection" size={26} color="#fff" />}
      satellites={[
        <ElSvgIcon key="a" name="List" size={20} />,
        <ElSvgIcon key="b" name="Grid" size={20} />
      ]}
      title={t('business.entity.emptyTitle')}
      description={t('business.entity.emptyDesc')}
      features={[
        { icon: <ElSvgIcon name="List" size={16} />, label: t('business.entity.columnValueNoun') },
        { icon: <ElSvgIcon name="Grid" size={16} />, label: t('business.entity.columnNameNoun') }
      ]}
      actions={
        <>
          <Button
            variant="filled"
            size="sm"
            leftSection={<ElSvgIcon name="Plus" size={16} />}
            onClick={() => onAddColumnValue?.()}
          >
            {t('business.entity.addColumnValue')}
          </Button>
          <Button
            variant="default"
            size="sm"
            leftSection={<ElSvgIcon name="Grid" size={16} />}
            onClick={() => onAddColumnName?.()}
          >
            {t('business.entity.addColumnName')}
          </Button>
        </>
      }
    />
  )
}
