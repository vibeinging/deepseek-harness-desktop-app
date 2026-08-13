import { Tabs } from '@mantine/core'
import { useTranslation } from 'react-i18next'

import MetricManager from './MetricManager'
import MetricViewManager from './MetricViewManager'

export interface SemanticDefinitionManagerProps {
  projectId: string
  businessId: string
}

export default function SemanticDefinitionManager({ projectId, businessId }: SemanticDefinitionManagerProps) {
  const { t } = useTranslation()

  return (
    <Tabs defaultValue="metrics" keepMounted>
      <Tabs.List mb="md">
        <Tabs.Tab value="metrics">{t('project.settings.definitionKinds.metrics')}</Tabs.Tab>
        <Tabs.Tab value="views">{t('project.settings.definitionKinds.views')}</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="metrics">
        <MetricManager projectId={projectId} businessId={businessId} />
      </Tabs.Panel>
      <Tabs.Panel value="views">
        <MetricViewManager projectId={projectId} businessId={businessId} />
      </Tabs.Panel>
    </Tabs>
  )
}
