// models 域路由表(LLM 模型 CRUD / 测试连接 / 项目模型 / 项目网络搜索模型,抽自 index.js)。
// 一域一文件,避免多 agent 扇出冲突。
import * as models from '../app/models/index.js';
import * as dshModels from '../app/models/dsh_models.js';
import * as dshModelStream from '../app/models/dsh_model_stream.js';
import * as webSearchModels from '../app/models/web_search_models.js';

export const modelsRoutes = [
  // DSH owns chat provider configuration, credentials and the model catalog.
  { m: 'GET', p: '/api/dsh/models', fn: dshModels.getDshModelSettings, auth: true },
  { m: 'GET', p: '/api/dsh/models/events', fn: dshModelStream.watchDshModelSettingsEvents, auth: true, stream: true },
  { m: 'POST', p: '/api/dsh/models/settings/mutate', fn: dshModels.mutateDshModelSettings, auth: true },
  { m: 'POST', p: '/api/dsh/models/credentials', fn: dshModels.setDshModelCredential, auth: true },
  { m: 'DELETE', p: '/api/dsh/models/credentials/:ref', fn: dshModels.unsetDshModelCredential, auth: true },
  { m: 'POST', p: '/api/dsh/models/discover', fn: dshModels.discoverDshModels, auth: true },

  // ── 系统级模型 CRUD（/api/llm_model/*，全字面路径）──
  { m: 'GET', p: '/api/llm_model/llm_models', fn: models.listModels, auth: true },
  { m: 'GET', p: '/api/llm_model/detail', fn: models.getModelDetail, auth: true },
  { m: 'POST', p: '/api/llm_model/create', fn: models.createModel, auth: true },
  { m: 'POST', p: '/api/llm_model/update', fn: models.updateModel, auth: true },
  { m: 'POST', p: '/api/llm_model/delete', fn: models.deleteModel, auth: true },
  { m: 'POST', p: '/api/llm_model/test-config', fn: models.testModelConfig, auth: true },

  // ── 项目模型 / 项目网络搜索模型 ──
  { m: 'GET', p: '/api/projects/:pid/models', fn: models.listProjectModels, auth: true },
  { m: 'GET', p: '/api/projects/:pid/agent-settings', fn: models.getProjectAgentSettings, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/agent-settings', fn: models.updateProjectAgentSettings, auth: true },
  { m: 'GET', p: '/api/projects/:pid/models/:modelId', fn: models.getProjectModelDetail, auth: true },
  { m: 'POST', p: '/api/projects/:pid/models', fn: models.createProjectModel, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/models', fn: models.updateProjectModel, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/models/:modelId', fn: models.deleteProjectModel, auth: true },
  { m: 'GET', p: '/api/projects/:pid/web-search-models', fn: webSearchModels.listProjectWebSearchModels, auth: true },
  { m: 'POST', p: '/api/projects/:pid/web-search-models', fn: webSearchModels.createProjectWebSearchModel, auth: true },
  { m: 'POST', p: '/api/projects/:pid/web-search-models/test-connection', fn: webSearchModels.testProjectWebSearchModel, auth: true },
  { m: 'POST', p: '/api/projects/:pid/web-search-models/qa-test', fn: webSearchModels.qaTestProjectWebSearchModel, auth: true },
  { m: 'POST', p: '/api/projects/:pid/web-search-models/infer-response-mappings', fn: webSearchModels.inferProjectWebSearchResponseMappings, auth: true },
  { m: 'GET', p: '/api/projects/:pid/web-search-models/:modelId', fn: webSearchModels.getProjectWebSearchModel, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/web-search-models/:modelId', fn: webSearchModels.updateProjectWebSearchModel, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/web-search-models/:modelId', fn: webSearchModels.deleteProjectWebSearchModel, auth: true },
];
