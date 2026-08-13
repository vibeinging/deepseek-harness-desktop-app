import { Button } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import SemanticEmptyState from './SemanticEmptyState'

export interface ExampleEmptyStateProps {
  onAddFirst?: () => void
  onBulkImport?: () => void
}

export default function ExampleEmptyState({ onAddFirst, onBulkImport }: ExampleEmptyStateProps) {
  const { t } = useTranslation()

  return (
    <SemanticEmptyState
      icon={<ElSvgIcon name="MagicStick" size={26} color="#fff" />}
      satellites={[
        <ElSvgIcon key="a" name="Document" size={20} />,
        <ElSvgIcon key="b" name="Search" size={20} />
      ]}
      title={t('business.exampleEmpty.title')}
      description={t('business.exampleEmpty.description')}
      features={[
        { icon: <ElSvgIcon name="Document" size={16} />, label: t('business.exampleEmpty.feature1', '问答配对样例') },
        { icon: <ElSvgIcon name="MagicStick" size={16} />, label: t('business.exampleEmpty.feature2', '引导 AI 学习') },
        { icon: <ElSvgIcon name="Connection" size={16} />, label: t('business.exampleEmpty.feature3', '提升回答一致性') }
      ]}
      actions={
        <>
          <Button
            variant="filled"
            size="sm"
            leftSection={<ElSvgIcon name="Plus" size={16} />}
            onClick={() => onAddFirst?.()}
          >
            {t('business.exampleEmpty.createExample')}
          </Button>
          <Button
            variant="default"
            size="sm"
            leftSection={<ElSvgIcon name="Upload" size={16} />}
            onClick={() => onBulkImport?.()}
          >
            {t('business.exampleEmpty.bulkImport')}
          </Button>
        </>
      }
    />
  )
}
