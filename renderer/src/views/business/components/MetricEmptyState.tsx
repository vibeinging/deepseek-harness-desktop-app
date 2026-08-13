import { useTranslation } from 'react-i18next'
import { Button } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import SemanticEmptyState from './SemanticEmptyState'

interface MetricEmptyStateProps {
  onAddMetric?: () => void
  onBulkImport?: () => void
}

export default function MetricEmptyState({ onAddMetric, onBulkImport }: MetricEmptyStateProps) {
  const { t } = useTranslation()

  return (
    <SemanticEmptyState
      icon={<ElSvgIcon name="DataLine" size={26} color="#fff" />}
      satellites={[
        <ElSvgIcon key="a" name="Coin" size={20} />,
        <ElSvgIcon key="b" name="Document" size={20} />
      ]}
      title={t('business.metricEmpty.title')}
      description={t('business.metricEmpty.description')}
      features={[
        { icon: <ElSvgIcon name="Document" size={16} />, label: t('business.metricEmpty.feature1', 'SQL 口径模板') },
        { icon: <ElSvgIcon name="MagicStick" size={16} />, label: t('business.metricEmpty.feature2', '自然语言描述') },
        { icon: <ElSvgIcon name="Connection" size={16} />, label: t('business.metricEmpty.feature3', '统一计算口径') }
      ]}
      actions={
        <>
          <Button
            variant="filled"
            size="sm"
            leftSection={<ElSvgIcon name="Plus" size={16} />}
            onClick={() => onAddMetric?.()}
          >
            {t('business.metricEmpty.createMetric')}
          </Button>
          <Button
            variant="default"
            size="sm"
            leftSection={<ElSvgIcon name="Upload" size={16} />}
            onClick={() => onBulkImport?.()}
          >
            {t('business.metricEmpty.bulkImport')}
          </Button>
        </>
      }
    />
  )
}
