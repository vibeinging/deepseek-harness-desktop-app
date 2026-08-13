import { Alert } from '@mantine/core'

import Models from '@/views/models'

interface ModelConfigProps {
  projectId?: string
}

/** Projects use the same DSH Profile catalog; model providers are not project-owned. */
export default function ModelConfig(_props: ModelConfigProps) {
  return (
    <div>
      <Alert color="blue" mb="md" title="模型由 DSH Profile 统一管理">
        项目不再保存单独的主模型和密钥。对话可以从 DSH 模型目录中选择模型与推理强度。
      </Alert>
      <Models showHeader={false} />
    </div>
  )
}
