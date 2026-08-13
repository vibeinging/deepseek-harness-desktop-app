import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  LoadingOverlay,
  Modal,
  NumberInput,
  Pagination,
  ScrollArea,
  Select,
  Switch,
  TextInput,
  Textarea,
} from '@mantine/core'
import { DatePickerInput } from '@mantine/dates'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import {
  IconPlus,
  IconRefresh,
  IconWand,
  IconX,
} from '@tabler/icons-react'
import {
  createMetricViewReq,
  deleteMetricViewReq,
  generateMetricViewEmbeddingsReq,
  getColumnDistinctValuesReq,
  getMetricViewDetailReq,
  getMetricViewsReq,
  previewMetricViewReq,
  updateMetricViewReq,
  updateMetricViewStatusReq,
} from '@/api/business-semantic'
import { getBusinessDataSourcesReq } from '@/api/business'
import { getCachedTablesReq, getTableColumnsReq } from '@/api/database'
import FilterableMultiSelect from './FilterableMultiSelect'
import MetricViewRecommendationDrawer from './MetricViewRecommendationDrawer'
import SemanticEmptyState from './SemanticEmptyState'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './MetricViewManager.module.scss'

export interface MetricViewManagerProps {
  projectId: string
  businessId: string
}

const DEFAULT_LIMIT = 100
const TEMPLATE_FIELD_PATTERN = /\{\{\s*([^}]+)\s*\}\}/g
const BARE_FIELD_REFERENCE_PATTERN = /(?<!\{\{)([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)(?!\}\})/g
const CANONICAL_SCHEMA_OMIT_NAMES = new Set(['default'])

function buildMt(locale: string) {
  const isZh = String(locale || '').startsWith('zh')
  return isZh
    ? {
        title: '业务视图',
        filterAllSources: '全部数据源',
        createView: '新建视图',
        smartRecommend: '智能推荐',
        refresh: '刷新',
        generateEmbeddings: '生成向量',
        emptyList: '暂无视图定义',
        emptyTitle: '业务视图',
        emptyDescription: '视图把常用的查询口径(表 / JOIN / 过滤 / 维度)预先定义好,让 AI 直接复用,避免每次重新拼 SQL。',
        emptyFunctionLabel: '功能:',
        emptyFunctionDesc: '将一组表关联与过滤条件固化成可复用的「视图」,AI 命中后按视图口径取数。',
        emptyScenarioLabel: '适用场景:',
        emptyScenarioDesc: '跨表关联、口径复杂或频繁复用的查询(如「在贷客户」「有效订单」)。',
        emptyFeature1: '可复用视图',
        emptyFeature2: '跨表口径固化',
        emptyFeature3: '语义召回',
        columns: { index: '序号', name: '名称', description: '说明', aliases: '别名', status: '状态', vector: '向量', actions: '操作' },
        statusEnabled: '启用',
        statusDisabled: '禁用',
        filterAllStatuses: '全部状态',
        statusOptions: { active: '启用', inactive: '停用', draft: '草稿' },
        statusActions: { activate: '启用', deactivate: '停用' },
        vectorGenerated: '已生成',
        vectorPending: '未生成',
        edit: '编辑',
        json: 'JSON',
        delete: '删除',
        add: '添加',
        remove: '删除',
        prev: '上一步',
        next: '下一步',
        validate: '验证',
        save: '保存',
        saveDraft: '暂存',
        cancel: '取消',
        close: '关闭',
        requiredText: '必填',
        optionalText: '可选',
        dialogEditTitle: '编辑视图定义',
        dialogCreateTitle: '新建视图定义',
        jsonDialogTitle: '视图定义 JSON',
        jsonEditPlaceholder: '在此直接编辑视图定义 JSON,点保存写回后端',
        jsonEditorHintCreate: '保存将以当前 JSON 创建新视图。',
        jsonEditorHintDraft: '保存为草稿:跳过严格 schema 校验,允许字段不全。',
        jsonEditorHintActive: '保存为正式视图:会做完整 schema 校验,字段缺失会被拒绝。',
        basicInfo: {
          dataSource: '数据源',
          selectDataSource: '请选择数据源',
          editSourceLockedHint: '编辑已有视图时，暂不支持直接切换数据源。',
          draftSourceSwitchHint: '草稿态允许切换数据源 — 切换后表/列/维度/过滤等会被清空,需要重新配置。',
          name: '名称',
          namePlaceholder: '如：销售趋势',
          description: '说明',
          descriptionPlaceholder: '视图用途说明',
          aliases: '别名',
          aliasPlaceholder: '输入别名后回车',
        },
        tableConfig: {
          selectSourceFirst: '请先在「基本信息」中选择数据源',
          mainTable: '主表',
          joinTable: 'JOIN 表 {index}',
          tableName: '表名',
          searchSelectTable: '搜索并选择表',
          stableRefHint: '系统会自动维护稳定引用，编辑时只需要关心表和列。',
          joinType: 'JOIN 类型',
          joinCondition: 'JOIN 条件',
          currentTableColumn: '当前表列',
          relatedTable: '关联表',
          relatedColumn: '关联列',
          addJoinTable: '+ 添加 JOIN 表',
        },
        fixedPredicates: {
          hint: '固定 WHERE 条件，每次查询都会带上（如 is_deleted = 0）',
          modeStructured: '图形条件',
          modeTemplate: '高级条件',
          templateHintPrefix: '高级条件中必须使用当前视图的表 key 引用字段，例如',
          templateHintSuffix: '不要使用旧别名 `m / o`。',
          availableTableKeys: '当前可用表 key：',
          selectTable: '选择表',
          selectColumn: '选择列',
          rangeStartPlaceholder: '起始值',
          rangeEndPlaceholder: '结束值',
          listPlaceholder: '下拉选择或输入搜索/新增候选值',
          multiValuesPlaceholder: '多个值用逗号分隔',
          searchPlaceholder: '输入关键词搜索并选择',
          valuePlaceholder: '值',
          candidateHint: '候选值来自示例值和枚举映射，仅供参考，可直接输入任意值。',
          bulkSelectHint: '支持全选当前筛选结果、取消当前筛选结果和清空已选。',
          empty: '暂无固定条件',
        },
        queryDimensions: {
          hint: '用户可动态筛选的维度（如地区、类型）',
          dimensionCard: '维度 {index}',
          dimensionName: '维度名称',
          dimensionNamePlaceholder: '如 org_name',
          table: '表',
          selectTable: '选择表',
          column: '列',
          selectColumn: '选择列',
          operator: '操作符',
          paramType: '参数类型',
          paramTypeDiscrete: '离散值',
          paramTypeRange: '范围',
          paramTypeEntity: '实体',
          paramTypeSubquery: '子查询',
          required: '是否必填',
          allowedValues: '可选值',
          allowedValuesPlaceholder: '输入并添加正式可选值',
          bulkSelectHint: '支持全选当前筛选结果、取消当前筛选结果和清空已选。',
          referenceValues: '参考值',
          importAllReferenceValues: '导入全部参考值',
          referenceHint: '示例值和枚举映射仅作参考，不会自动成为正式可选值。',
          manageReferenceValues: '维护参考值',
          dbColumnValues: '数据库列值',
          currentRefValues: '当前参考值',
          searchPlaceholder: '输入关键词搜索...',
          searchBtn: '搜索',
          importSelected: '导入',
          save: '保存',
          clearAll: '清空',
          selectAll: '全选当前页',
          noRefValues: '暂无参考值',
          loadFromDbEmpty: '未找到匹配的值',
          addDimension: '+ 添加维度',
        },
        timeDimension: {
          empty: '未配置时间维度',
          enable: '启用时间维度',
          table: '表',
          selectTable: '选择表',
          column: '列名',
          selectColumn: '选择时间列',
          operator: '操作符',
          required: '是否必填',
          grain: '粒度',
          grainDay: '天',
          grainMonth: '月',
          grainYear: '年',
          outputFormat: '输出格式',
          remove: '移除时间维度',
        },
        projections: {
          hintPrimary: '投影就是最终 SQL 的 SELECT 输出列，决定用户会看到哪些字段、指标和列名。',
          hintSecondary: '优先使用辅助式编辑生成常见投影；复杂表达式再用高级输入。下方紫色标签展示的是当前已配置的投影，不是示例。',
          selectTable: '选择表',
          selectColumn: '选择列',
          aliasPlaceholder: '业务别名',
          addHelperProjection: '添加辅助投影',
          advancedExpressionPlaceholder: '高级表达式（可选），例如：SUM(branch_metrics.amount) AS 销售额',
          addAdvancedExpression: '添加高级表达式',
          configured: '已配置投影',
          empty: '暂无投影列',
          groupByTitle: 'GROUP BY 列',
          selectGroupByField: '选择分组字段',
          emptyGroupBy: '暂无 GROUP BY',
        },
        sort: {
          hint: '使用结构化排序规则生成 ORDER BY 片段。',
          selectField: '选择排序字段',
          addRule: '添加排序规则',
          empty: '暂无排序列',
          defaultLimit: '默认 LIMIT',
        },
        preview: {
          title: '演示与校验',
          notGenerated: '尚未生成预览，请点击“验证”后查看 SQL 与基础校验结果。',
          definitionExpired: '当前预览已过期，以下结果基于上一次验证；保存时会先自动验证当前配置。',
          demoExpired: '当前参数演示已变更，以下结果基于上一次验证，请重新验证以刷新 SQL 预览。',
          summaryTitle: '结构摘要',
          summary: { table: '表', fixedPredicates: '固定条件', queryDimensions: '查询维度', timeDimension: '时间维度', projections: '投影列', sortRules: '排序规则', yes: '有', no: '无' },
          completenessTitle: '当前配置完整性',
          completenessSuccess: '当前配置已满足验证与保存的最小结构要求',
          completenessWarning: '当前配置还不完整，请先补齐以下项',
          validationTitle: '基础校验',
          validationNotGenerated: '尚未生成校验结果，请点击验证。',
          validationOutdated: '当前显示的是上一次验证结果，请重新验证后再作为最新结论。',
          validationSuccess: '当前配置可生成只读 SQL，基础校验通过',
          validationWarning: '当前配置可生成只读 SQL，但仍有提醒项',
          validationError: '当前配置尚未通过基础校验',
          templateSql: '模板 SQL',
          demoTitle: '参数演示',
          restoreDefaults: '恢复默认',
          rangeStartPlaceholder: '起始值',
          rangeEndPlaceholder: '结束值',
          searchPlaceholder: '输入关键词搜索并选择',
          multiValuePlaceholder: '多个值可用逗号分隔',
          singleValuePlaceholder: '输入演示值',
          allowedValuesHint: '候选值 {count} 项，可输入关键词缩小范围。',
          noDemoFields: '当前没有可演示的运行时参数。',
          demoSql: '参数代入后 SQL',
          timeStartPlaceholder: '开始日期',
          timeEndPlaceholder: '结束日期',
        },
        wizardSteps: {
          basicInfo: { title: '基本信息', desc: '数据源、名称、别名' },
          tables: { title: '表配置', desc: '查询表与 JOIN' },
          fixedPredicates: { title: '固定条件', desc: '固定 WHERE 条件' },
          dimensions: { title: '查询维度', desc: '动态筛选维度' },
          time: { title: '时间维度', desc: '时间范围配置' },
          projections: { title: '投影与分组', desc: 'SELECT / GROUP BY' },
          sort: { title: '排序', desc: 'ORDER BY / LIMIT' },
        },
        messages: {
          loadListFailed: '加载视图列表失败',
          jsonInvalid: 'JSON 格式不合法',
          draftSaved: '已保存为草稿,可在列表里继续编辑',
          draftRequireName: '暂存草稿至少需要填写名称',
          draftRequireSource: '暂存草稿至少需要选择数据源',
          statusChanged: '状态已更新为「{status}」',
          deleteConfirmTitle: '确认删除',
          deleteConfirmMsg: '确定删除视图「{name}」？',
          deleteSuccess: '删除成功',
          deleteFailed: '删除失败',
          embeddingSuccess: '生成成功',
          embeddingFailed: '生成向量失败',
          templatePlaceholder: '输入模板条件，例如：{{{tableKey}.data_date}} = (SELECT MAX(data_date) FROM {tableRef})',
          requestErrorFallback: '验证失败，请稍后重试',
          dimensionSummaryName: '名称：{value}',
          dimensionSummaryField: '字段：{value}',
          dimensionSummaryOperator: '操作符：{value}',
          dimensionSummaryParamType: '参数类型：{value}',
          previewTemplateEmpty: '尚未生成，请点击验证',
          previewTemplateMissing: '当前验证未生成模板 SQL。',
          previewDemoMissing: '当前验证未生成参数演示 SQL。',
          timeHintDay: '按天演示时，建议直接选择具体日期范围。',
          timeHintMonth: '按月演示时，建议选择该月起止日期。',
          timeHintYear: '按年演示时，建议选择该年起止日期。',
          timeHintDefault: '请为时间维度补一个演示范围。',
          loadDetailFailed: '加载详情失败',
          issueSelectDataSource: '请先在「基本信息」中选择数据源。',
          issueInputName: '请先在「基本信息」中填写视图名称。',
          issueSelectTable: '请先在「表配置」中至少配置一个查询表。',
          issueJoinCondition: '请先为 JOIN 表「{name}」配置关联条件。',
          issueProjection: '请先在「投影与分组」中至少配置一个投影列。',
          saveValidationDetailFallback: '请先修正右侧基础校验错误后再保存。',
          saveValidationStopped: '当前配置验证未通过，已停止保存：{detail}',
          saveValidationStoppedToast: '当前配置验证未通过，已停止保存。',
          validateSuccess: '验证通过：当前配置可生成只读 SQL。',
          validateWarning: '验证完成：当前配置可生成只读 SQL，但仍有提醒项。',
          validateErrorFallback: '当前配置尚未通过基础校验。',
          validateErrorToast: '验证未通过，请查看右侧基础校验。',
          updateSuccess: '更新成功',
          createSuccess: '创建成功',
          updateFailed: '更新失败',
          createFailed: '创建失败',
        },
      }
    : {
        title: 'Business Views',
        filterAllSources: 'All data sources',
        createView: 'Create View',
        smartRecommend: 'Smart Recommend',
        refresh: 'Refresh',
        generateEmbeddings: 'Generate Embeddings',
        emptyList: 'No view definitions',
        emptyTitle: 'Business Views',
        emptyDescription: 'A view predefines a reusable query shape (tables / joins / filters / dimensions) so the AI can reuse it instead of re-assembling SQL each time.',
        emptyFunctionLabel: 'Function: ',
        emptyFunctionDesc: 'Freeze a set of table joins and filters into a reusable "view"; once matched, the AI fetches data by the view definition.',
        emptyScenarioLabel: 'Scenario: ',
        emptyScenarioDesc: 'Cross-table, complex, or frequently reused queries (e.g. "active borrowers", "valid orders").',
        emptyFeature1: 'Reusable views',
        emptyFeature2: 'Frozen join logic',
        emptyFeature3: 'Semantic recall',
        columns: { index: 'No.', name: 'Name', description: 'Description', aliases: 'Aliases', status: 'Status', vector: 'Embedding', actions: 'Actions' },
        statusEnabled: 'Enabled',
        statusDisabled: 'Disabled',
        filterAllStatuses: 'All statuses',
        statusOptions: { active: 'Active', inactive: 'Inactive', draft: 'Draft' },
        statusActions: { activate: 'Activate', deactivate: 'Deactivate' },
        vectorGenerated: 'Generated',
        vectorPending: 'Not generated',
        edit: 'Edit',
        json: 'JSON',
        delete: 'Delete',
        add: 'Add',
        remove: 'Delete',
        prev: 'Previous',
        next: 'Next',
        validate: 'Validate',
        save: 'Save',
        saveDraft: 'Stash',
        cancel: 'Cancel',
        close: 'Close',
        requiredText: 'Required',
        optionalText: 'Optional',
        dialogEditTitle: 'Edit View Definition',
        dialogCreateTitle: 'Create View Definition',
        jsonDialogTitle: 'View Definition JSON',
        jsonEditPlaceholder: 'Edit the view definition JSON here; click Save to apply.',
        jsonEditorHintCreate: 'Save will create a new view from this JSON.',
        jsonEditorHintDraft: 'Saving as draft: strict schema validation is skipped; partial fields allowed.',
        jsonEditorHintActive: 'Saving as active view: full schema validation runs; missing fields will be rejected.',
        basicInfo: {
          dataSource: 'Data Source',
          selectDataSource: 'Please select a data source',
          editSourceLockedHint: 'Switching the data source is not supported when editing an existing view.',
          draftSourceSwitchHint: 'Drafts allow source switching — tables/columns/dimensions/filters will be cleared and need to be reconfigured.',
          name: 'Name',
          namePlaceholder: 'e.g. Sales Trend',
          description: 'Description',
          descriptionPlaceholder: 'Describe the purpose of this view',
          aliases: 'Aliases',
          aliasPlaceholder: 'Enter an alias and press Enter',
        },
        tableConfig: {
          selectSourceFirst: 'Please select a data source in "Basic Info" first',
          mainTable: 'Main Table',
          joinTable: 'JOIN Table {index}',
          tableName: 'Table Name',
          searchSelectTable: 'Search and select a table',
          stableRefHint: 'Stable references are maintained automatically. You only need to care about tables and columns while editing.',
          joinType: 'JOIN Type',
          joinCondition: 'JOIN Condition',
          currentTableColumn: 'Current table column',
          relatedTable: 'Related table',
          relatedColumn: 'Related column',
          addJoinTable: '+ Add JOIN Table',
        },
        fixedPredicates: {
          hint: 'Fixed WHERE predicates are applied on every query (for example, is_deleted = 0).',
          modeStructured: 'Structured',
          modeTemplate: 'Advanced',
          templateHintPrefix: 'Advanced conditions must reference fields by table key, for example',
          templateHintSuffix: 'Do not use legacy aliases like `m / o`.',
          availableTableKeys: 'Available table keys:',
          selectTable: 'Select table',
          selectColumn: 'Select column',
          rangeStartPlaceholder: 'Start value',
          rangeEndPlaceholder: 'End value',
          listPlaceholder: 'Select or search / create options',
          multiValuesPlaceholder: 'Separate multiple values with commas',
          searchPlaceholder: 'Search and select',
          valuePlaceholder: 'Value',
          candidateHint: 'Candidate values come from examples and enum mappings for reference only. You can still type any value directly.',
          bulkSelectHint: 'Supports select all filtered, deselect filtered, and clear selected values.',
          empty: 'No fixed predicates',
        },
        queryDimensions: {
          hint: 'Dimensions users can filter dynamically (for example, region or type).',
          dimensionCard: 'Dimension {index}',
          dimensionName: 'Dimension Name',
          dimensionNamePlaceholder: 'e.g. org_name',
          table: 'Table',
          selectTable: 'Select table',
          column: 'Column',
          selectColumn: 'Select column',
          operator: 'Operator',
          paramType: 'Parameter Type',
          paramTypeDiscrete: 'Discrete',
          paramTypeRange: 'Range',
          paramTypeEntity: 'Entity',
          paramTypeSubquery: 'Subquery',
          required: 'Required',
          allowedValues: 'Allowed Values',
          allowedValuesPlaceholder: 'Type and add official allowed values',
          bulkSelectHint: 'Supports select all filtered, deselect filtered, and clear selected values.',
          referenceValues: 'Reference Values',
          importAllReferenceValues: 'Import all reference values',
          referenceHint: 'Example values and enum mappings are only references and will not become official allowed values automatically.',
          manageReferenceValues: 'Manage Reference Values',
          dbColumnValues: 'DB Column Values',
          currentRefValues: 'Current Reference Values',
          searchPlaceholder: 'Search by keyword...',
          searchBtn: 'Search',
          importSelected: 'Import',
          save: 'Save',
          clearAll: 'Clear All',
          selectAll: 'Select all on page',
          noRefValues: 'No reference values',
          loadFromDbEmpty: 'No matching values found',
          addDimension: '+ Add Dimension',
        },
        timeDimension: {
          empty: 'No time dimension configured',
          enable: 'Enable Time Dimension',
          table: 'Table',
          selectTable: 'Select table',
          column: 'Column',
          selectColumn: 'Select time column',
          operator: 'Operator',
          required: 'Required',
          grain: 'Granularity',
          grainDay: 'Day',
          grainMonth: 'Month',
          grainYear: 'Year',
          outputFormat: 'Output Format',
          remove: 'Remove Time Dimension',
        },
        projections: {
          hintPrimary: 'Projections are the final SELECT output columns that decide which fields, metrics, and aliases users will see.',
          hintSecondary: 'Prefer helper projections for common cases, and only use advanced expressions for complex logic. The purple tags below show configured projections, not examples.',
          selectTable: 'Select table',
          selectColumn: 'Select column',
          aliasPlaceholder: 'Business alias',
          addHelperProjection: 'Add Helper Projection',
          advancedExpressionPlaceholder: 'Advanced expression (optional), e.g. SUM(branch_metrics.amount) AS Sales',
          addAdvancedExpression: 'Add Advanced Expression',
          configured: 'Configured Projections',
          empty: 'No projections',
          groupByTitle: 'GROUP BY Fields',
          selectGroupByField: 'Select group-by fields',
          emptyGroupBy: 'No GROUP BY',
        },
        sort: {
          hint: 'Build ORDER BY using structured sort rules.',
          selectField: 'Select sort field',
          addRule: 'Add Sort Rule',
          empty: 'No sort rules',
          defaultLimit: 'Default LIMIT',
        },
        preview: {
          title: 'Demo & Validation',
          notGenerated: 'No preview has been generated yet. Click "Validate" to view SQL and validation results.',
          definitionExpired: 'The preview is outdated. Results below are from the last validation, and saving will validate the current definition again.',
          demoExpired: 'The demo inputs changed. Results below are based on the last validation. Re-validate to refresh the SQL preview.',
          summaryTitle: 'Structure Summary',
          summary: { table: 'Tables', fixedPredicates: 'Fixed Predicates', queryDimensions: 'Query Dimensions', timeDimension: 'Time Dimension', projections: 'Projections', sortRules: 'Sort Rules', yes: 'Yes', no: 'No' },
          completenessTitle: 'Current Configuration Completeness',
          completenessSuccess: 'The current configuration already satisfies the minimum structure required for validation and saving.',
          completenessWarning: 'The current configuration is still incomplete. Please fill in the following items first.',
          validationTitle: 'Basic Validation',
          validationNotGenerated: 'No validation result has been generated yet. Click Validate.',
          validationOutdated: 'The currently displayed result is from the previous validation. Re-validate before taking it as the latest conclusion.',
          validationSuccess: 'The current configuration can generate read-only SQL and has passed basic validation.',
          validationWarning: 'The current configuration can generate read-only SQL, but there are still warning items.',
          validationError: 'The current configuration has not passed basic validation yet.',
          templateSql: 'Template SQL',
          demoTitle: 'Parameter Demo',
          restoreDefaults: 'Restore Defaults',
          rangeStartPlaceholder: 'Start value',
          rangeEndPlaceholder: 'End value',
          searchPlaceholder: 'Search and select',
          multiValuePlaceholder: 'Separate multiple values with commas',
          singleValuePlaceholder: 'Enter a demo value',
          allowedValuesHint: '{count} candidate values. Type keywords to narrow down the list.',
          noDemoFields: 'There are no runtime parameters available for demonstration.',
          demoSql: 'SQL with Demo Parameters',
          timeStartPlaceholder: 'Start date',
          timeEndPlaceholder: 'End date',
        },
        wizardSteps: {
          basicInfo: { title: 'Basic Info', desc: 'Data source, name, aliases' },
          tables: { title: 'Tables', desc: 'Query tables and JOINs' },
          fixedPredicates: { title: 'Fixed Predicates', desc: 'Fixed WHERE predicates' },
          dimensions: { title: 'Query Dimensions', desc: 'Dynamic filter dimensions' },
          time: { title: 'Time Dimension', desc: 'Time range configuration' },
          projections: { title: 'Projection & Grouping', desc: 'SELECT / GROUP BY' },
          sort: { title: 'Sorting', desc: 'ORDER BY / LIMIT' },
        },
        messages: {
          loadListFailed: 'Failed to load view list',
          jsonInvalid: 'Invalid JSON',
          draftSaved: 'Saved as draft. You can continue editing from the list.',
          draftRequireName: 'A name is required to save as draft',
          draftRequireSource: 'A data source is required to save as draft',
          statusChanged: 'Status updated to {status}',
          deleteConfirmTitle: 'Confirm Delete',
          deleteConfirmMsg: 'Delete view "{name}"?',
          deleteSuccess: 'Deleted successfully',
          deleteFailed: 'Delete failed',
          embeddingSuccess: 'Generated successfully',
          embeddingFailed: 'Failed to generate embeddings',
          templatePlaceholder: 'Enter a template predicate, e.g. {{{tableKey}.data_date}} = (SELECT MAX(data_date) FROM {tableRef})',
          requestErrorFallback: 'Validation failed, please try again later',
          dimensionSummaryName: 'Name: {value}',
          dimensionSummaryField: 'Field: {value}',
          dimensionSummaryOperator: 'Operator: {value}',
          dimensionSummaryParamType: 'Parameter type: {value}',
          previewTemplateEmpty: 'Not generated yet. Click Validate.',
          previewTemplateMissing: 'No template SQL was generated by the current validation.',
          previewDemoMissing: 'No demo SQL was generated by the current validation.',
          timeHintDay: 'For day-level demos, it is recommended to choose the exact date range directly.',
          timeHintMonth: 'For month-level demos, it is recommended to choose the start and end dates of that month.',
          timeHintYear: 'For year-level demos, it is recommended to choose the start and end dates of that year.',
          timeHintDefault: 'Please provide a demo range for the time dimension.',
          loadDetailFailed: 'Failed to load details',
          issueSelectDataSource: 'Please select a data source in "Basic Info" first.',
          issueInputName: 'Please fill in the view name in "Basic Info" first.',
          issueSelectTable: 'Please configure at least one query table in "Tables" first.',
          issueJoinCondition: 'Please configure join conditions for JOIN table "{name}" first.',
          issueProjection: 'Please configure at least one projection in "Projection & Grouping" first.',
          saveValidationDetailFallback: 'Please fix the validation errors shown on the right before saving.',
          saveValidationStopped: 'Validation failed and saving has been stopped: {detail}',
          saveValidationStoppedToast: 'Validation failed. Saving has been stopped.',
          validateSuccess: 'Validation passed: the current configuration can generate read-only SQL.',
          validateWarning: 'Validation completed: the current configuration can generate read-only SQL, but there are still warnings.',
          validateErrorFallback: 'The current configuration has not passed basic validation yet.',
          validateErrorToast: 'Validation failed. Please review the basic validation panel.',
          updateSuccess: 'Updated successfully',
          createSuccess: 'Created successfully',
          updateFailed: 'Update failed',
          createFailed: 'Create failed',
        },
      }
}

type Mt = ReturnType<typeof buildMt>

// ===== Pure function helpers (independent of form state) =====
function uniqueValues(values: any[]): any[] {
  return [...new Set((values || []).filter(Boolean))]
}

function buildFieldRef(tableKey: any, columnName: any): string {
  if (!tableKey || !columnName) return ''
  return `${tableKey}.${columnName}`
}

function parseFieldRef(fieldRef: any): { table_key: string; column_name: string } {
  if (!fieldRef || typeof fieldRef !== 'string') return { table_key: '', column_name: '' }
  const dotIndex = fieldRef.indexOf('.')
  if (dotIndex <= 0) return { table_key: '', column_name: '' }
  return { table_key: fieldRef.slice(0, dotIndex), column_name: fieldRef.slice(dotIndex + 1) }
}

function createPredicateBuilder() {
  return { mode: 'structured', table: '', column: '', op: '=', value: '', valueItems: [] as string[], valueList: '', rangeStart: '', rangeEnd: '', expression: '' }
}
function createProjectionBuilder() {
  return { table: '', column: '', aggregate: 'raw', alias: '', precision: 2 }
}
function createSortBuilder() {
  return { field: '', direction: 'ASC' }
}
function createBaseTableRow(): any {
  return { table_key: 'main', table_ref: '', _tableId: null, join_type: 'inner', join_conditions: [], _joinLeftCol: '', _joinOperator: '=', _joinRightTable: '', _joinRightCol: '', _lastTableRef: '' }
}
function createEmptyForm(): any {
  return {
    name: '', description: '', aliases: [], source_id: null,
    tables: [createBaseTableRow()], fixed_predicates: [], query_dimensions: [],
    time_dimension: null, projections: [], group_by: [], group_by_advanced: [],
    sort_spec: { order_by: [], limit_default: DEFAULT_LIMIT }, status: 'active',
  }
}
function createEmptyDemoInputs(): any {
  return { dimension_values: {}, time_range: { start: '', end: '' } }
}
function createEmptyDemoTouched(): any {
  return { dimension_keys: {}, time_range: { start: false, end: false } }
}

function fieldRefToPayload(fieldRef: any) {
  const { table_key: tableKey, column_name: columnName } = parseFieldRef(fieldRef)
  if (!tableKey || !columnName) return null
  return { table_key: tableKey, column_name: columnName }
}
function payloadFieldToFieldRef(field: any): string {
  if (!field || typeof field !== 'object') return ''
  return buildFieldRef(field.table_key, field.column_name)
}
function parseQualifiedColumn(fieldRef: any, tables: any[]): { _table: string; _col: string } {
  if (!fieldRef) return { _table: '', _col: '' }
  if (typeof fieldRef === 'object') {
    return parseQualifiedColumn(payloadFieldToFieldRef(fieldRef), tables)
  }
  const raw = String(fieldRef).trim()
  const dotIndex = raw.lastIndexOf('.')
  if (dotIndex <= 0) return { _table: '', _col: raw }
  const prefix = raw.slice(0, dotIndex)
  const columnName = raw.slice(dotIndex + 1)
  const matchedTable = (tables || []).find((table) => table.table_key === prefix || table.table_ref === prefix)
  return { _table: matchedTable?.table_key || '', _col: columnName }
}
function buildExpressionPrefixMap(tables: any[]): Record<string, string> {
  const refCounts: Record<string, number> = {}
  ;(tables || []).forEach((table) => {
    if (table.table_ref) refCounts[table.table_ref] = (refCounts[table.table_ref] || 0) + 1
  })
  const mapping: Record<string, string> = {}
  ;(tables || []).forEach((table) => {
    if (!table.table_key) return
    mapping[table.table_key] = table.table_key
    if (table.table_ref && refCounts[table.table_ref] === 1) {
      mapping[table.table_ref] = table.table_key
    }
  })
  return mapping
}
function resolveExpressionFieldToken(token: any, prefixMap: Record<string, string>) {
  const raw = String(token || '').trim()
  const dotIndex = raw.lastIndexOf('.')
  if (dotIndex <= 0) return null
  const prefix = raw.slice(0, dotIndex)
  const columnName = raw.slice(dotIndex + 1)
  const tableKey = prefixMap[prefix]
  if (!tableKey || !columnName) return null
  return { table_key: tableKey, column_name: columnName }
}
function getTableDisplayName(table: any): string {
  return table?.table_ref || table?.table_key || ''
}
function normalizeOperator(op: any) {
  if (!op || typeof op !== 'string') return op
  const lower = op.trim().toLowerCase()
  const allowed = new Set(['=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'between', 'is_null', 'is_not_null'])
  return allowed.has(lower) ? lower : op
}
function cloneDemoValue(value: any) {
  if (Array.isArray(value)) return [...value]
  if (value && typeof value === 'object') return { ...value }
  return value ?? ''
}
function buildTableRef(table: any): string {
  if (!table) return ''
  const schemaName = String(table.schema_name || '').trim()
  const tableName = String(table.table_name || '').trim()
  if (!tableName) return ''
  if (!schemaName || CANONICAL_SCHEMA_OMIT_NAMES.has(schemaName.toLowerCase())) return tableName
  return `${schemaName}.${tableName}`
}
function normalizeTableRef(tableRef: any): string {
  const raw = String(tableRef || '').trim().replace(/[`"]/g, '')
  return raw.replace(/^default\./i, '')
}
function getBareTableName(tableRef: any): string {
  const normalizedRef = normalizeTableRef(tableRef)
  if (!normalizedRef) return ''
  return normalizedRef.split('.').pop() as string
}
function buildCanonicalTableRef(table: any, fallbackRef = ''): string {
  const normalizedFallback = normalizeTableRef(fallbackRef)
  if (normalizedFallback && !normalizedFallback.includes('.')) {
    return table?.table_name || normalizedFallback
  }
  return buildTableRef(table) || fallbackRef
}

function getDataSourceDisplayName(dataSource: any): string {
  return dataSource?.display_name || dataSource?.name || ''
}
function getDataSourceConnectionId(dataSource: any): string {
  return dataSource?.database_connection_id || dataSource?.id || ''
}

export default function MetricViewManager({ projectId, businessId }: MetricViewManagerProps) {
  const { i18n } = useTranslation()
  const locale = i18n.language || 'zh'
  const mt: Mt = useMemo(() => buildMt(locale), [locale])

  // === List state ===
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [embeddingLoading, setEmbeddingLoading] = useState(false)
  const [listSourceFilter, setListSourceFilter] = useState('')
  const [listStatusFilter, setListStatusFilter] = useState('')

  // === Data sources & tables ===
  const [dataSources, setDataSources] = useState<any[]>([])
  const dataSourcesRef = useRef<any[]>([])
  dataSourcesRef.current = dataSources
  const [dsLoading, setDsLoading] = useState(false)
  const [availableTables, setAvailableTables] = useState<any[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  // tableColumnsCache / tableColumnsLoading: use ref (raw data) + bump to trigger rendering
  const tableColumnsCacheRef = useRef<Record<string, any[]>>({})
  const tableColumnsLoadingRef = useRef<Record<string, boolean>>({})
  const dataSourcesLoadedBusinessIdRef = useRef('')
  const availableTablesCacheRef = useRef<Record<string, any[]>>({})
  const availableTablesRef = useRef<any[]>([])
  availableTablesRef.current = availableTables

  // === Wizard state ===
  const [wizardVisible, setWizardVisible] = useState(false)
  const wizardVisibleRef = useRef(false)
  wizardVisibleRef.current = wizardVisible
  const [wizardStep, setWizardStep] = useState(0)
  const [isEditing, setIsEditing] = useState(false)
  const editingIdRef = useRef<any>(null)
  const [recommendationDrawerVisible, setRecommendationDrawerVisible] = useState(false)
  const editingCandidateIdRef = useRef<any>(null)
  const returnToDrawerAfterWizardRef = useRef(false)
  const [fromCandidateMode, setFromCandidateMode] = useState(false)
  const [externallyAppliedCandidateId, setExternallyAppliedCandidateId] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [wizardInitializing, setWizardInitializing] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewResult, setPreviewResult] = useState<any>(null)
  const previewResultRef = useRef<any>(null)
  previewResultRef.current = previewResult
  const [previewGenerated, setPreviewGenerated] = useState(false)
  const previewReusableForSaveRef = useRef(false)
  const lastPreviewDefinitionSignatureRef = useRef('')
  const lastPreviewRequestSignatureRef = useRef('')
  const [saveValidationMessage, setSaveValidationMessage] = useState('')
  const previewRequestTokenRef = useRef(0)
  const availableTableLookupTasksRef = useRef<Map<string, Promise<any>>>(new Map())
  const tableColumnsTasksRef = useRef<Map<string, Promise<any>>>(new Map())

  // === Mutable form object + version bump to trigger rendering (align with Vue deep reactivity) ===
  const formRef = useRef<any>(createEmptyForm())
  const form = formRef.current
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  const bump = useCallback(() => forceRender(), [])

  // === Builders / draft input states ===
  const [aliasInput, setAliasInput] = useState('')
  const predicateBuilderRef = useRef<any>(createPredicateBuilder())
  const predicateBuilder = predicateBuilderRef.current
  const [projectionInput, setProjectionInput] = useState('')
  const projectionBuilderRef = useRef<any>(createProjectionBuilder())
  const projectionBuilder = projectionBuilderRef.current
  const sortBuilderRef = useRef<any>(createSortBuilder())
  const sortBuilder = sortBuilderRef.current

  // === JSON editor ===
  const [jsonDialogVisible, setJsonDialogVisible] = useState(false)
  const [jsonContent, setJsonContent] = useState('')
  const [jsonError, setJsonError] = useState('')
  const [jsonSaving, setJsonSaving] = useState(false)

  // === Demo input ===
  const demoInputsRef = useRef<any>(createEmptyDemoInputs())
  const demoInputs = demoInputsRef.current
  const demoInputTouchedRef = useRef<any>(createEmptyDemoTouched())
  const demoInputTouched = demoInputTouchedRef.current
  const demoOptionQueryRef = useRef<Record<string, string>>({})

  // ===== Helper functions that depend on form/state =====
  function findDataSourceBySourceId(sourceId: any) {
    return dataSources.find((item) => String(item.source_id || '') === String(sourceId || '')) || null
  }
  function findDataSourceByName(sourceName: any) {
    return dataSources.find((item) => getDataSourceDisplayName(item) === sourceName) || null
  }
  function getSelectedConnectionId(dataSourceId: any = form.source_id) {
    const selectedSource = findDataSourceBySourceId(dataSourceId)
    return getDataSourceConnectionId(selectedSource)
  }
  const isDraftEditing = isEditing && form && form.status === 'draft'
  const selectedSourceName = getDataSourceDisplayName(findDataSourceBySourceId(form.source_id))

  function findTableByKey(tableKey: any, tables: any[] = form.tables) {
    return (tables || []).find((table) => table.table_key === tableKey) || null
  }
  function formatFieldRef(fieldRef: any, tables: any[] = form.tables): string {
    const { table_key: tableKey, column_name: columnName } = parseFieldRef(fieldRef)
    if (!tableKey || !columnName) return fieldRef || ''
    const table = findTableByKey(tableKey, tables)
    return table?.table_ref ? `${table.table_ref}.${columnName}` : fieldRef
  }
  function displayExpressionToTemplate(expression: any): string {
    const prefixMap = buildExpressionPrefixMap(form.tables)
    return String(expression || '')
      .replace(TEMPLATE_FIELD_PATTERN, (_match, token) => {
        const field = resolveExpressionFieldToken(token, prefixMap)
        return field ? `{{${field.table_key}.${field.column_name}}}` : `{{${String(token).trim()}}}`
      })
      .replace(BARE_FIELD_REFERENCE_PATTERN, (match) => {
        const field = resolveExpressionFieldToken(match, prefixMap)
        return field ? `{{${field.table_key}.${field.column_name}}}` : match
      })
      .trim()
  }
  function templateExpressionToDisplay(expression: any, tables: any[] = form.tables): string {
    return String(expression || '').replace(TEMPLATE_FIELD_PATTERN, (_match, token) => {
      const field = resolveExpressionFieldToken(token, buildExpressionPrefixMap(tables))
      if (!field) return String(token).trim()
      return `${field.table_key}.${field.column_name}`
    })
  }
  function collectExpressionTableKeys(expression: any): Set<string> {
    const tableKeys = new Set<string>()
    const text = String(expression || '')
    text.replace(TEMPLATE_FIELD_PATTERN, (m, token) => {
      const raw = String(token || '').trim()
      const dotIndex = raw.lastIndexOf('.')
      if (dotIndex > 0) tableKeys.add(raw.slice(0, dotIndex))
      return m
    })
    text.replace(BARE_FIELD_REFERENCE_PATTERN, (match) => {
      const raw = String(match || '').trim()
      const dotIndex = raw.lastIndexOf('.')
      if (dotIndex > 0) tableKeys.add(raw.slice(0, dotIndex))
      return match
    })
    return tableKeys
  }
  function expressionUsesTableKey(expression: any, tableKey: any) {
    return collectExpressionTableKeys(expression).has(tableKey)
  }
  function predicateUsesTableKey(predicate: any, tableKey: any) {
    if (!predicate) return false
    if (predicate.kind === 'template') {
      return expressionUsesTableKey(predicate.expression ?? predicate.expression_template ?? '', tableKey)
    }
    return parseFieldRef(predicate.field).table_key === tableKey
  }
  function projectionUsesTableKey(projection: any, tableKey: any) {
    if (!projection) return false
    if (projection.kind === 'expression') {
      return expressionUsesTableKey(projection.expression ?? projection.expression_template ?? '', tableKey)
    }
    return parseFieldRef(projection.field).table_key === tableKey
  }
  function advancedGroupByUsesTableKey(item: any, tableKey: any) {
    return expressionUsesTableKey(item?.expression ?? item?.expression_template ?? '', tableKey)
  }
  function sortRuleUsesTableKey(rule: any, tableKey: any, removedProjectionKeys: Set<any> = new Set()) {
    if (!rule) return false
    if (rule.kind === 'field') return parseFieldRef(rule.field).table_key === tableKey
    if (rule.kind === 'projection') return removedProjectionKeys.has(rule.projection_key)
    return expressionUsesTableKey(rule.expression ?? rule.expression_template ?? '', tableKey)
  }

  // ===== List actions =====
  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const res = await getMetricViewsReq(projectId, currentPage, pageSize, false,
        listSourceFilter || null, listStatusFilter || null,
      )
      setList(res.data.items || [])
      setTotal(res.data.total || 0)
    } catch {
      notifications.show({ color: 'red', message: mt.messages.loadListFailed })
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, businessId, currentPage, pageSize, listSourceFilter, listStatusFilter, mt])

  function statusTagType(status: any): string {
    if (status === 'active') return 'success'
    if (status === 'draft') return 'warning'
    return 'info'
  }
  // EP tag type → Mantine Badge color
  const badgeColor = (type: string) =>
    type === 'success' ? 'green' : type === 'warning' ? 'orange' : type === 'danger' ? 'red' : 'gray'
  function statusLabel(status: any): string {
    if (status === 'active') return mt.statusOptions.active
    if (status === 'draft') return mt.statusOptions.draft
    if (status === 'inactive') return mt.statusOptions.inactive
    return status || '-'
  }
  async function changeStatus(row: any, target: any) {
    try {
      await updateMetricViewStatusReq(projectId, row.id, target)
      notifications.show({ color: 'green', message: mt.messages.statusChanged.replace('{status}', statusLabel(target)) })
      await loadList()
    } catch (e: any) {
      const detail = e?.response?.data?.message || e?.message || String(e)
      notifications.show({ color: 'red', message: detail })
    }
  }
  function handleListStatusChange(val: string) {
    setListStatusFilter(val)
    setCurrentPage(1)
  }
  function handlePageChange(page: number) {
    setCurrentPage(page)
  }
  function handlePageSizeChange(size: number) {
    setPageSize(size)
    setCurrentPage(1)
  }
  function handleListSourceChange(val: string) {
    setListSourceFilter(val)
    setCurrentPage(1)
  }
  async function applyDefaultSourceForNewView() {
    const defaultSource = listSourceFilter
      ? findDataSourceBySourceId(listSourceFilter)
      : (dataSources.length === 1 ? dataSources[0] : null)
    if (!defaultSource?.source_id) return
    form.source_id = defaultSource.source_id
    await loadTablesForSource(getDataSourceConnectionId(defaultSource))
  }
  function metricViewRowIndex(index: number) {
    return (currentPage - 1) * pageSize + index + 1
  }
  function handleDelete(row: any) {
    modals.openConfirmModal({
      title: mt.messages.deleteConfirmTitle,
      children: mt.messages.deleteConfirmMsg.replace('{name}', row.name),
      labels: { confirm: mt.delete, cancel: mt.cancel },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteMetricViewReq(projectId, row.id)
          notifications.show({ color: 'green', message: mt.messages.deleteSuccess })
          await loadList()
        } catch {
          notifications.show({ color: 'red', message: mt.messages.deleteFailed })
        }
      },
    })
  }
  async function generateAllEmbeddings() {
    setEmbeddingLoading(true)
    try {
      const res = await generateMetricViewEmbeddingsReq(projectId)
      notifications.show({ color: 'green', message: res.data?.message || mt.messages.embeddingSuccess })
      await loadList()
    } catch {
      notifications.show({ color: 'red', message: mt.messages.embeddingFailed })
    } finally {
      setEmbeddingLoading(false)
    }
  }

  // ===== Data sources & table loading =====
  const loadDataSources = useCallback(async () => {
    if (dataSourcesLoadedBusinessIdRef.current === businessId && dataSourcesRef.current.length) {
      return dataSourcesRef.current
    }
    setDsLoading(true)
    try {
      const res = await getBusinessDataSourcesReq(projectId)
      const next = res.data?.database_connections || []
      dataSourcesRef.current = next
      setDataSources(next)
      dataSourcesLoadedBusinessIdRef.current = businessId
    } catch {
      dataSourcesRef.current = []
      setDataSources([])
    } finally {
      setDsLoading(false)
    }
    return dataSourcesRef.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, businessId])

  async function loadTablesForSource(sourceId: any) {
    if (!sourceId) {
      availableTablesRef.current = []
      setAvailableTables([])
      return []
    }
    if (Array.isArray(availableTablesCacheRef.current[sourceId])) {
      const cached = availableTablesCacheRef.current[sourceId]
      availableTablesRef.current = cached
      setAvailableTables(cached)
      return cached
    }
    setTablesLoading(true)
    try {
      const res = await getCachedTablesReq(projectId, sourceId, { limit: 1000 })
      const items = res.data?.items || []
      availableTablesRef.current = items
      setAvailableTables(items)
      availableTablesCacheRef.current = { ...availableTablesCacheRef.current, [sourceId]: items }
    } catch {
      availableTablesRef.current = []
      setAvailableTables([])
    } finally {
      setTablesLoading(false)
    }
    return availableTablesRef.current
  }

  function handleDataSourceChange(sourceName: any) {
    const selectedSource = findDataSourceByName(sourceName)
    form.source_id = selectedSource?.source_id || null
    form.tables = [createBaseTableRow()]
    form.fixed_predicates = []
    form.query_dimensions = []
    form.time_dimension = null
    form.projections = []
    form.group_by = []
    form.group_by_advanced = []
    form.sort_spec = { order_by: [], limit_default: DEFAULT_LIMIT }
    tableColumnsCacheRef.current = {}
    predicateBuilderRef.current = createPredicateBuilder()
    projectionBuilderRef.current = createProjectionBuilder()
    sortBuilderRef.current = createSortBuilder()
    demoInputsRef.current = createEmptyDemoInputs()
    demoInputTouchedRef.current = createEmptyDemoTouched()
    demoOptionQueryRef.current = {}
    bump()
    loadTablesForSource(getDataSourceConnectionId(selectedSource))
  }

  function findConfiguredTable(tableToken: any) {
    return form.tables.find((table: any) => table.table_key === tableToken || table.table_ref === tableToken) || null
  }
  function resolveTableRef(tableToken: any): string {
    if (!tableToken) return ''
    const matchedTable = findConfiguredTable(tableToken)
    return matchedTable?.table_ref || tableToken
  }
  function findAvailableTableByRef(tableRef: any) {
    const normalizedRef = normalizeTableRef(tableRef)
    if (!normalizedRef) return null
    const bareTableName = getBareTableName(normalizedRef)
    const requestHasSchema = normalizedRef.includes('.')
    return availableTablesRef.current.find((table) => {
      const fullRef = normalizeTableRef(buildTableRef(table))
      if (fullRef === normalizedRef) return true
      if (requestHasSchema) return false
      return getBareTableName(fullRef) === bareTableName
    }) || null
  }
  async function resolveStableTable(table: any) {
    if (!table?.table_ref || !form.source_id) return null
    const matchedTable = await ensureAvailableTable(table.table_ref)
    if (!matchedTable) {
      table._tableId = null
      return null
    }
    const canonicalRef = buildCanonicalTableRef(matchedTable, table.table_ref)
    table._tableId = matchedTable.id ?? null
    table.table_ref = canonicalRef
    table._lastTableRef = canonicalRef
    return matchedTable
  }
  function mergeAvailableTables(tables: any[] = []) {
    if (!Array.isArray(tables) || !tables.length) return
    const existingIds = new Set(availableTablesRef.current.map((table) => String(table.id)))
    const nextTables = [...availableTablesRef.current]
    tables.forEach((table) => {
      const tableId = String(table.id)
      if (!existingIds.has(tableId)) {
        existingIds.add(tableId)
        nextTables.push(table)
      }
    })
    availableTablesRef.current = nextTables
    setAvailableTables(nextTables)
  }
  async function ensureAvailableTable(tableRef: any) {
    const normalizedRef = normalizeTableRef(tableRef)
    let matchedTable = findAvailableTableByRef(normalizedRef)
    const connectionId = getSelectedConnectionId()
    if (matchedTable || !connectionId) return matchedTable
    const bareName = normalizedRef.split('.').pop()
    const searchKeywords = uniqueValues([normalizedRef, bareName])
    const lookupKey = `${connectionId}:${normalizedRef}`
    if (availableTableLookupTasksRef.current.has(lookupKey)) {
      return availableTableLookupTasksRef.current.get(lookupKey)
    }
    const lookupTask = (async () => {
      for (const search of searchKeywords) {
        if (!search) continue
        try {
          const res = await getCachedTablesReq(projectId, connectionId, { limit: 100, search })
          const items = res.data?.items || []
          mergeAvailableTables(items)
          matchedTable = findAvailableTableByRef(normalizedRef)
          if (matchedTable) return matchedTable
        } catch {
          // Ignore transient table lookup failures to keep the dropdown usable
        }
      }
      return null
    })()
    availableTableLookupTasksRef.current.set(lookupKey, lookupTask)
    try {
      return await lookupTask
    } finally {
      availableTableLookupTasksRef.current.delete(lookupKey)
    }
  }
  function setTableColumnsLoading(tableRef: any, isLoading: boolean) {
    if (!tableRef) return
    tableColumnsLoadingRef.current = { ...tableColumnsLoadingRef.current, [tableRef]: isLoading }
    bump()
  }
  function isTableColumnsLoading(tableToken: any): boolean {
    const tableRef = resolveTableRef(tableToken)
    return Boolean(tableRef && tableColumnsLoadingRef.current[tableRef])
  }
  async function loadColumnsForTable(tableToken: any) {
    const configuredTable = findConfiguredTable(tableToken)
    let tableRef = configuredTable?.table_ref || resolveTableRef(tableToken)
    const connectionId = getSelectedConnectionId()
    if (!tableRef || !connectionId) return
    let tableId = configuredTable?._tableId ?? null
    if (!tableId) {
      const matchedTable = configuredTable
        ? await resolveStableTable(configuredTable)
        : await ensureAvailableTable(tableRef)
      if (!matchedTable) return
      tableId = matchedTable.id
      tableRef = buildCanonicalTableRef(matchedTable, tableRef)
    }
    const cachedColumns = tableColumnsCacheRef.current[tableRef]
    if (Array.isArray(cachedColumns) && cachedColumns.length > 0) return cachedColumns
    const lookupKey = `${connectionId}:${tableId || tableRef}`
    if (tableColumnsTasksRef.current.has(lookupKey)) {
      await tableColumnsTasksRef.current.get(lookupKey)
      return tableColumnsCacheRef.current[tableRef] || []
    }
    const task = (async () => {
      setTableColumnsLoading(tableRef, true)
      try {
        const res = await getTableColumnsReq(projectId, connectionId, tableId)
        tableColumnsCacheRef.current[tableRef] = res.data?.items || res.data || []
      } catch {
        tableColumnsCacheRef.current[tableRef] = []
      } finally {
        setTableColumnsLoading(tableRef, false)
      }
    })()
    tableColumnsTasksRef.current.set(lookupKey, task)
    try {
      await task
    } finally {
      tableColumnsTasksRef.current.delete(lookupKey)
    }
    bump()
    return tableColumnsCacheRef.current[tableRef] || []
  }
  function getColumnsForTable(tableToken: any): any[] {
    const tableRef = resolveTableRef(tableToken)
    return tableRef ? (tableColumnsCacheRef.current[tableRef] || []) : []
  }
  function getColumnMetadata(tableToken: any, columnName: any) {
    if (!tableToken || !columnName) return null
    return getColumnsForTable(tableToken).find((column) => column.column_name === columnName) || null
  }
  function extractEnumMappingValues(enumMappings: any): string[] {
    const mappings = Array.isArray(enumMappings?.mappings)
      ? enumMappings.mappings
      : (Array.isArray(enumMappings) ? enumMappings : [])
    return mappings
      .map((mapping: any) => {
        if (mapping === null || mapping === undefined) return ''
        if (typeof mapping === 'string' || typeof mapping === 'number') return String(mapping).trim()
        if (typeof mapping !== 'object') return ''
        return String(mapping.code ?? mapping.value ?? mapping.key ?? mapping.id ?? mapping.raw_value ?? '').trim()
      })
      .filter(Boolean)
  }
  function extractColumnOptionValues(tableToken: any, columnName: any): string[] {
    const column = getColumnMetadata(tableToken, columnName)
    if (!column) return []
    const exampleValues = Array.isArray(column.example_values)
      ? column.example_values.map((value: any) => String(value ?? '').trim()).filter(Boolean)
      : []
    const enumValues = extractEnumMappingValues(column.enum_mappings)
    return uniqueValues([...exampleValues, ...enumValues]) as string[]
  }
  function refreshDimensionAllowedOptions(dim: any) {
    if (!dim) return
    dim._allowedOptions = uniqueValues(dim.allowed_values || [])
  }
  function getDimensionReferenceOptions(dim: any): string[] {
    if (!dim || dim.param_type !== 'discrete') return []
    return extractColumnOptionValues(dim._table, dim._col)
  }
  function appendDimensionReferenceValue(dim: any, value: any) {
    if (!dim || !value) return
    const nextValues = uniqueValues([...(dim.allowed_values || []), value])
    updateDimensionAllowedValues(dim, nextValues)
  }
  function appendAllDimensionReferenceValues(dim: any) {
    if (!dim) return
    const referenceOptions = getDimensionReferenceOptions(dim)
    if (!referenceOptions.length) return
    updateDimensionAllowedValues(dim, uniqueValues([...(dim.allowed_values || []), ...referenceOptions]))
  }

  // ---- Reference values maintenance dialog ----
  const dimensionDbDialogRef = useRef<any>({
    visible: false, dim: null, search: '', values: [], selected: [], selectAll: false,
    totalCount: 0, page: 1, pageSize: 20, loading: false, currentValues: [],
  })
  const dimensionDbDialog = dimensionDbDialogRef.current

  function resetDimensionDbDialog(dim: any, allowedValues: any) {
    dimensionDbDialog.dim = dim
    dimensionDbDialog.search = ''
    dimensionDbDialog.values = []
    dimensionDbDialog.selected = []
    dimensionDbDialog.selectAll = false
    dimensionDbDialog.totalCount = 0
    dimensionDbDialog.page = 1
    dimensionDbDialog.loading = false
    dimensionDbDialog.currentValues = [...(allowedValues || [])]
  }
  async function openDimensionDbDialog(dim: any) {
    if (!dim._table || !dim._col) return
    const table = configuredTables.find((t: any) => t.table_key === dim._table)
    if (!table?.table_ref) return
    resetDimensionDbDialog(dim, dim.allowed_values)
    dimensionDbDialog.visible = true
    bump()
    await fetchDimensionDbPage(1)
  }
  async function fetchDimensionDbPage(page: number) {
    const dim = dimensionDbDialog.dim
    if (!dim) return
    const table = configuredTables.find((t: any) => t.table_key === dim._table)
    if (!table?.table_ref) return
    dimensionDbDialog.loading = true
    dimensionDbDialog.page = page
    bump()
    try {
      const res = await getColumnDistinctValuesReq(projectId, {
        source_id: form.source_id,
        table_ref: table.table_ref,
        column_name: dim._col,
        keyword: dimensionDbDialog.search || null,
        page_size: dimensionDbDialog.pageSize,
        page,
      })
      const data = res?.data
      if (data) {
        dimensionDbDialog.values = data.values || []
        dimensionDbDialog.totalCount = data.total_count || 0
        dimensionDbDialog.selected = []
        dimensionDbDialog.selectAll = false
      }
    } catch (e: any) {
      notifications.show({ color: 'red', message: e?.message || 'Failed to load values' })
    } finally {
      dimensionDbDialog.loading = false
      bump()
    }
  }
  function toggleSelectAllPage(checked: boolean) {
    dimensionDbDialog.selected = checked ? [...dimensionDbDialog.values] : []
    dimensionDbDialog.selectAll = checked
    bump()
  }
  function importSelectedToRight() {
    if (!dimensionDbDialog.selected.length) return
    dimensionDbDialog.currentValues = uniqueValues([...dimensionDbDialog.currentValues, ...dimensionDbDialog.selected])
    dimensionDbDialog.selected = []
    bump()
  }
  function removeDimensionDbDialogValue(val: any) {
    dimensionDbDialog.currentValues = dimensionDbDialog.currentValues.filter((v: any) => v !== val)
    bump()
  }
  function confirmDimensionDbDialog() {
    const dim = dimensionDbDialog.dim
    if (!dim) return
    updateDimensionAllowedValues(dim, dimensionDbDialog.currentValues)
    dimensionDbDialog.visible = false
    bump()
  }

  function getPreviousTables(currentIndex: number) {
    return form.tables.slice(0, currentIndex).filter((t: any) => t.table_ref)
  }
  function getNextJoinTableKey(): string {
    const existingKeys = new Set(form.tables.map((table: any) => table.table_key))
    let index = form.tables.length
    let candidate = `join_${index}`
    while (existingKeys.has(candidate)) {
      index += 1
      candidate = `join_${index}`
    }
    return candidate
  }
  function removeFieldReferencesForTable(tableKey: any) {
    form.fixed_predicates = form.fixed_predicates.filter((predicate: any) => !predicateUsesTableKey(predicate, tableKey))
    form.query_dimensions = form.query_dimensions.filter((dim: any) => parseFieldRef(dim.column).table_key !== tableKey)
    if (parseFieldRef(form.time_dimension?.column || '').table_key === tableKey) {
      form.time_dimension = null
    }
    const removedProjectionKeys = new Set(
      form.projections
        .filter((projection: any) => projectionUsesTableKey(projection, tableKey))
        .map((projection: any) => projection.projection_key)
        .filter(Boolean),
    )
    form.projections = form.projections.filter((projection: any) => !projectionUsesTableKey(projection, tableKey))
    form.group_by = form.group_by.filter((fieldRef: any) => parseFieldRef(fieldRef).table_key !== tableKey)
    form.group_by_advanced = form.group_by_advanced.filter((item: any) => !advancedGroupByUsesTableKey(item, tableKey))
    form.sort_spec.order_by = form.sort_spec.order_by.filter((rule: any) => !sortRuleUsesTableKey(rule, tableKey, removedProjectionKeys))
  }
  async function handleTableRefChange(table: any) {
    const previousRef = table._lastTableRef || ''
    const nextRef = table.table_ref || ''
    if (!nextRef) {
      table._tableId = null
      table.join_conditions = []
      table._joinLeftCol = ''
      table._joinRightCol = ''
      table._joinRightTable = ''
      table._lastTableRef = ''
      removeFieldReferencesForTable(table.table_key)
      bump()
      return
    }
    const [previousTable, nextTable] = await Promise.all([
      previousRef ? ensureAvailableTable(previousRef) : Promise.resolve(null),
      ensureAvailableTable(nextRef),
    ])
    const canonicalNextRef = buildCanonicalTableRef(nextTable, nextRef)
    const isSameLogicalTable = previousTable && nextTable
      ? String(previousTable.id) === String(nextTable.id)
      : normalizeTableRef(previousRef) === normalizeTableRef(canonicalNextRef)
    if (previousRef && !isSameLogicalTable) {
      removeFieldReferencesForTable(table.table_key)
      table.join_conditions = []
      table._joinLeftCol = ''
      table._joinRightCol = ''
    }
    table._tableId = nextTable?.id ?? null
    table.table_ref = canonicalNextRef
    table._lastTableRef = canonicalNextRef
    bump()
    await loadColumnsForTable(table.table_key)
  }
  function buildJoinCondition(table: any) {
    if (!table._joinLeftCol || !table._joinRightTable || !table._joinRightCol) {
      table.join_conditions = []
      bump()
      return
    }
    table.join_conditions = [{
      kind: 'field_compare',
      left: fieldRefToPayload(buildFieldRef(table.table_key, table._joinLeftCol)),
      operator: table._joinOperator || '=',
      right: fieldRefToPayload(buildFieldRef(table._joinRightTable, table._joinRightCol)),
    }]
    bump()
  }
  function joinConditionDisplayText(table: any): string {
    if (!table?.join_conditions?.length) return ''
    return table.join_conditions.map((condition: any) => {
      if (condition.kind === 'template') {
        return templateExpressionToDisplay(condition.expression ?? condition.expression_template ?? '')
      }
      const left = payloadFieldToFieldRef(condition.left)
      const right = payloadFieldToFieldRef(condition.right)
      return `${formatFieldRef(left)} ${condition.operator || '='} ${formatFieldRef(right)}`
    }).join(' AND ')
  }

  // ===== Computed (directly derived, recalculated on each render, aligned with Vue computed) =====
  const configuredTables = form.tables.filter((t: any) => t.table_ref)
  const predicateTemplateTableGuide = configuredTables.map((table: any) => ({ table_key: table.table_key, table_ref: getTableDisplayName(table) }))
  const predicateTemplatePlaceholder = (() => {
    const mainTable = configuredTables[0]
    const mainKey = mainTable?.table_key || 'main'
    const mainRef = mainTable?.table_ref || 'branch_metrics'
    return mt.messages.templatePlaceholder.replace('{tableKey}', mainKey).replace('{tableRef}', mainRef)
  })()
  const configuredColumnOptions = (() => {
    const options: any[] = []
    configuredTables.forEach((table: any) => {
      getColumnsForTable(table.table_key).forEach((col: any) => {
        const value = buildFieldRef(table.table_key, col.column_name)
        options.push({ value, label: formatFieldRef(value), table_key: table.table_key, column_name: col.column_name })
      })
    })
    return options
  })()
  const predicateUsesNoValue = ['IS NULL', 'IS NOT NULL'].includes(predicateBuilder.op)
  const predicateUsesListValue = predicateBuilder.op === 'IN'
  const predicateUsesRangeValue = predicateBuilder.op === 'BETWEEN'
  const predicateAllowedOptions = (() => {
    const field = buildFieldRef(predicateBuilder.table, predicateBuilder.column)
    if (!field) return []
    const dimensionOptions = form.query_dimensions.filter((dim: any) => dim.column === field).flatMap((dim: any) => dim.allowed_values || [])
    const predicateOptions = form.fixed_predicates.filter((predicate: any) => predicate.kind === 'set' && predicate.field === field).flatMap((predicate: any) => predicate.values || [])
    const columnOptions = extractColumnOptionValues(predicateBuilder.table, predicateBuilder.column)
    return uniqueValues([...columnOptions, ...dimensionOptions, ...predicateOptions]) as string[]
  })()

  function buildPredicateFromBuilder(builder: any): any {
    if (builder.mode === 'template') {
      const expression = String(builder.expression || '').trim()
      if (!expression) return null
      return { kind: 'template', expression }
    }
    const field = buildFieldRef(builder.table, builder.column)
    if (!field) return null
    if (builder.op === 'IS NULL') return { kind: 'null_check', field, operator: 'is_null' }
    if (builder.op === 'IS NOT NULL') return { kind: 'null_check', field, operator: 'is_not_null' }
    if (builder.op === 'IN') {
      const values = uniqueValues([
        ...(builder.valueItems || []),
        ...String(builder.valueList || '').split(',').map((item: string) => item.trim()),
      ])
      if (!values.length) return null
      return { kind: 'set', field, operator: 'in', values }
    }
    if (builder.op === 'BETWEEN') {
      if (!builder.rangeStart || !builder.rangeEnd) return null
      return { kind: 'range', field, operator: 'between', start: builder.rangeStart, end: builder.rangeEnd }
    }
    if (!builder.value.trim()) return null
    return { kind: 'comparison', field, operator: builder.op.toLowerCase() === 'like' ? 'like' : builder.op, value: builder.value.trim() }
  }
  function predicateDisplayText(predicate: any): string {
    if (!predicate) return ''
    if (predicate.kind === 'template') {
      return templateExpressionToDisplay(predicate.expression ?? predicate.expression_template ?? '')
    }
    const fieldText = formatFieldRef(predicate.field)
    if (predicate.kind === 'null_check') return `${fieldText} ${predicate.operator === 'is_not_null' ? 'IS NOT NULL' : 'IS NULL'}`
    if (predicate.kind === 'set') return `${fieldText} IN (${(predicate.values || []).join(', ')})`
    if (predicate.kind === 'range') return `${fieldText} BETWEEN ${predicate.start} AND ${predicate.end}`
    return `${fieldText} ${String(predicate.operator || '=').toUpperCase()} ${predicate.value ?? ''}`.trim()
  }
  const predicatePreviewText = predicateDisplayText(buildPredicateFromBuilder(predicateBuilder))

  function setPredicateMode(mode: string) {
    predicateBuilder.mode = mode
    bump()
  }
  function addPredicateFromBuilder() {
    const predicate = buildPredicateFromBuilder(predicateBuilder)
    if (!predicate) return
    form.fixed_predicates.push(predicate)
    const nextBuilder = createPredicateBuilder()
    if (predicateBuilder.mode === 'structured') {
      nextBuilder.table = predicateBuilder.table
    } else {
      nextBuilder.mode = 'template'
    }
    predicateBuilderRef.current = nextBuilder
    bump()
  }
  function serializePredicate(predicate: any): any {
    if (!predicate) return null
    if (predicate.kind === 'template') {
      return { kind: 'template', expression_template: displayExpressionToTemplate(predicate.expression ?? predicate.expression_template ?? '') }
    }
    const field = fieldRefToPayload(predicate.field)
    if (!field) return null
    const payload: any = { kind: predicate.kind, field, operator: normalizeOperator(predicate.operator) }
    if (predicate.kind === 'comparison') payload.value = predicate.value
    if (predicate.kind === 'set') payload.values = uniqueValues(predicate.values || [])
    if (predicate.kind === 'range') {
      payload.start = predicate.start
      payload.end = predicate.end
    }
    return payload
  }
  function hydratePredicate(predicate: any): any {
    if (!predicate) return null
    if (typeof predicate === 'string') return { kind: 'template', expression: predicate }
    if (predicate.kind === 'template') return { kind: 'template', expression: templateExpressionToDisplay(predicate.expression_template || '') }
    return { ...predicate, operator: normalizeOperator(predicate.operator), field: payloadFieldToFieldRef(predicate.field) }
  }

  function resetPreviewState() {
    previewRequestTokenRef.current += 1
    setPreviewLoading(false)
    setPreviewResult(null)
    setPreviewGenerated(false)
    previewReusableForSaveRef.current = false
    lastPreviewDefinitionSignatureRef.current = ''
    lastPreviewRequestSignatureRef.current = ''
  }
  function getRequestErrorMessage(error: any, fallback = mt.messages.requestErrorFallback) {
    return error?.response?.data?.message || error?.response?.data?.msg || error?.message || fallback
  }
  function buildPreviewErrorResult(message: string) {
    return {
      summary: previewSummary,
      validation: { status: 'error', errors: [message], warnings: [] },
      template_sql: '', demo_sql: '', demo_inputs: { dimension_values: {}, time_range: {} },
    }
  }
  function handlePreviewInteractionVisibility() {
    return undefined
  }

  function hydrateTableRows(tables: any[] = []): any[] {
    if (!tables.length) return [createBaseTableRow()]
    return tables.map((table, index) => {
      const tableKey = table.table_key || (index === 0 ? 'main' : `join_${index}`)
      let joinState: any = { _joinLeftCol: '', _joinOperator: '=', _joinRightTable: '', _joinRightCol: '' }
      for (const condition of (table.join_conditions || [])) {
        if (condition.kind !== 'field_compare' || !condition.left || !condition.right) continue
        if (condition.left.table_key === tableKey) {
          joinState = { _joinLeftCol: condition.left.column_name, _joinOperator: condition.operator || '=', _joinRightTable: condition.right.table_key, _joinRightCol: condition.right.column_name }
          break
        }
        if (condition.right.table_key === tableKey) {
          joinState = { _joinLeftCol: condition.right.column_name, _joinOperator: condition.operator || '=', _joinRightTable: condition.left.table_key, _joinRightCol: condition.left.column_name }
          break
        }
      }
      return {
        table_key: tableKey, table_ref: table.table_ref || '', _tableId: null,
        join_type: table.join_type || 'inner', join_conditions: table.join_conditions || [],
        _lastTableRef: table.table_ref || '', ...joinState,
      }
    })
  }
  function hydrateDimension(dim: any, tables: any[]): any {
    const fieldRef = payloadFieldToFieldRef(dim.field) || dim.column || ''
    const allowedOptions = uniqueValues(dim.allowed_values || [])
    const fieldState = parseQualifiedColumn(fieldRef, tables)
    const currentName = dim.name || fieldState._col || ''
    return {
      name: currentName, column: fieldRef, op: dim.op || '=', param_type: dim.param_type || 'discrete',
      required: dim.required !== false, allowed_values: [...allowedOptions], _allowedOptions: [...allowedOptions],
      _allowedInput: '', _suggestedName: currentName, ...fieldState,
    }
  }
  function hydrateTimeDimension(timeDimension: any, tables: any[]): any {
    if (!timeDimension) return null
    const fieldRef = payloadFieldToFieldRef(timeDimension.field) || timeDimension.column || ''
    return {
      column: fieldRef, op: timeDimension.op || 'between', extract_type: timeDimension.extract_type || 'day',
      required: timeDimension.required !== false, output_format: timeDimension.output_format || 'YYYY-MM-DD',
      ...parseQualifiedColumn(fieldRef, tables),
    }
  }
  function updateTimeDimensionColumn() {
    if (!form.time_dimension?._table || !form.time_dimension?._col) return
    form.time_dimension.column = buildFieldRef(form.time_dimension._table, form.time_dimension._col)
    bump()
  }
  function nextProjectionKey(): string {
    const existingKeys = new Set(form.projections.map((item: any) => item.projection_key).filter(Boolean))
    let index = form.projections.length + 1
    let candidate = `projection_${index}`
    while (existingKeys.has(candidate)) {
      index += 1
      candidate = `projection_${index}`
    }
    return candidate
  }
  function buildProjectionFromBuilder(builder: any): any {
    const field = buildFieldRef(builder.table, builder.column)
    if (!field) return null
    const alias = builder.alias.trim() || builder.column
    if (builder.aggregate === 'raw') {
      return { projection_key: nextProjectionKey(), kind: 'field', field, alias }
    }
    return {
      projection_key: nextProjectionKey(), kind: 'aggregate', field, function: builder.aggregate, alias,
      precision: builder.aggregate === 'round' ? builder.precision : null,
    }
  }
  function projectionDisplayText(projection: any): string {
    if (!projection) return ''
    if (projection.kind === 'expression') return projection.expression || templateExpressionToDisplay(projection.expression_template || '')
    const fieldText = formatFieldRef(projection.field)
    if (projection.kind === 'field') return `${fieldText} AS ${projection.alias || parseFieldRef(projection.field).column_name}`.trim()
    if (projection.function === 'round') return `ROUND(${fieldText}, ${projection.precision ?? 2}) AS ${projection.alias || ''}`.trim()
    return `${String(projection.function || 'raw').toUpperCase()}(${fieldText}) AS ${projection.alias || ''}`.trim()
  }
  const projectionPreviewText = projectionDisplayText(buildProjectionFromBuilder(projectionBuilder))
  function addProjectionFromBuilder() {
    const projection = buildProjectionFromBuilder(projectionBuilder)
    if (!projection) return
    form.projections.push(projection)
    projectionBuilderRef.current = { ...createProjectionBuilder(), table: projectionBuilder.table }
    bump()
  }
  function serializeProjection(projection: any): any {
    if (!projection) return null
    if (projection.kind === 'expression') {
      const expressionTemplate = displayExpressionToTemplate(projection.expression || projection.expression_template || '')
      if (!expressionTemplate) return null
      return { projection_key: projection.projection_key || nextProjectionKey(), kind: 'expression', expression_template: expressionTemplate, alias: projection.alias || null }
    }
    const field = fieldRefToPayload(projection.field)
    if (!field) return null
    const payload: any = { projection_key: projection.projection_key || nextProjectionKey(), kind: projection.kind, field, alias: projection.alias || null }
    if (projection.kind === 'aggregate') {
      payload.function = projection.function || 'sum'
      if (projection.function === 'round' && projection.precision !== null && projection.precision !== undefined) {
        payload.precision = projection.precision
      }
    }
    return payload
  }
  function hydrateProjection(projection: any, index: number): any {
    if (!projection) return null
    if (typeof projection === 'string') return { projection_key: `projection_${index}`, kind: 'expression', expression: projection }
    if (projection.kind === 'expression') {
      return { projection_key: projection.projection_key || `projection_${index}`, kind: 'expression', alias: projection.alias || '', expression: templateExpressionToDisplay(projection.expression_template || '') }
    }
    return {
      projection_key: projection.projection_key || `projection_${index}`, kind: projection.kind || 'field',
      field: payloadFieldToFieldRef(projection.field), function: projection.function || (projection.kind === 'aggregate' ? 'sum' : 'raw'),
      alias: projection.alias || '', precision: projection.precision ?? 2,
    }
  }
  function dimensionPreviewText(dim: any): string {
    const parts: string[] = []
    if (dim.name) parts.push(mt.messages.dimensionSummaryName.replace('{value}', dim.name))
    if (dim.column) parts.push(mt.messages.dimensionSummaryField.replace('{value}', formatFieldRef(dim.column)))
    if (dim.op) parts.push(mt.messages.dimensionSummaryOperator.replace('{value}', dim.op))
    if (dim.param_type) parts.push(mt.messages.dimensionSummaryParamType.replace('{value}', dim.param_type))
    if (dim.required !== undefined) parts.push(dim.required ? mt.requiredText : mt.optionalText)
    return parts.join(' · ')
  }
  function hydrateGroupBy(groupByItems: any[] = []): { basic: any[]; advanced: any[] } {
    const basic: any[] = []
    const advanced: any[] = []
    groupByItems.forEach((item) => {
      if (typeof item === 'string') {
        const state = parseQualifiedColumn(item, form.tables)
        if (state._table && state._col) {
          basic.push(buildFieldRef(state._table, state._col))
        } else {
          advanced.push({ kind: 'expression', expression: item })
        }
        return
      }
      if (item?.kind === 'field' && item.field) {
        const fieldRef = payloadFieldToFieldRef(item.field)
        if (fieldRef) basic.push(fieldRef)
        return
      }
      if (item?.kind === 'expression') {
        advanced.push({ kind: 'expression', expression: templateExpressionToDisplay(item.expression_template || '') })
      }
    })
    return { basic: uniqueValues(basic), advanced }
  }
  function groupByDisplayText(item: any): string {
    if (!item) return ''
    if (typeof item === 'string') return formatFieldRef(item)
    if (item.kind === 'expression') return item.expression || templateExpressionToDisplay(item.expression_template || '')
    return formatFieldRef(payloadFieldToFieldRef(item.field))
  }
  const sortTargetOptions = (() => {
    const projectionOptions = form.projections.map((projection: any) => ({
      value: `projection:${projection.projection_key}`,
      label: `${mt.projections.configured} · ${projectionDisplayText(projection)}`,
    }))
    const fieldOptions = configuredColumnOptions.map((option: any) => ({
      value: `field:${option.value}`,
      label: `${mt.queryDimensions.column} · ${option.label}`,
    }))
    return [...projectionOptions, ...fieldOptions]
  })()
  const sortPreviewText = (() => {
    if (!sortBuilder.field) return ''
    const [kind, rawValue] = sortBuilder.field.split(':')
    if (kind === 'field') return `${formatFieldRef(rawValue)} ${sortBuilder.direction}`
    if (kind === 'projection') {
      const projection = form.projections.find((item: any) => item.projection_key === rawValue)
      return `${projection ? projectionDisplayText(projection) : rawValue} ${sortBuilder.direction}`
    }
    return `${sortBuilder.field} ${sortBuilder.direction}`
  })()
  function addOrderByRule() {
    if (!sortBuilder.field) return
    const [kind, rawValue] = sortBuilder.field.split(':')
    if (kind === 'field') {
      form.sort_spec.order_by.push({ kind: 'field', field: rawValue, direction: sortBuilder.direction })
    } else if (kind === 'projection') {
      form.sort_spec.order_by.push({ kind: 'projection', projection_key: rawValue, direction: sortBuilder.direction })
    }
    sortBuilderRef.current = createSortBuilder()
    bump()
  }
  function sortRuleDisplayText(rule: any): string {
    if (!rule) return ''
    if (rule.kind === 'field') return `${formatFieldRef(rule.field)} ${rule.direction}`
    if (rule.kind === 'projection') {
      const projection = form.projections.find((item: any) => item.projection_key === rule.projection_key)
      return `${projection ? projectionDisplayText(projection) : rule.projection_key} ${rule.direction}`
    }
    return `${rule.expression || templateExpressionToDisplay(rule.expression_template || '')} ${rule.direction}`
  }

  function buildMetricViewPayload(): any {
    const f = form
    const groupByItems = [
      ...f.group_by
        .map((fieldRef: any) => {
          const field = fieldRefToPayload(fieldRef)
          return field ? { kind: 'field', field } : null
        })
        .filter(Boolean),
      ...f.group_by_advanced
        .map((item: any) => {
          const expressionTemplate = displayExpressionToTemplate(item.expression || item.expression_template || '')
          return expressionTemplate ? { kind: 'expression', expression_template: expressionTemplate } : null
        })
        .filter(Boolean),
    ]
    return {
      name: f.name,
      description: f.description || null,
      aliases: f.aliases.length ? f.aliases : null,
      source_id: f.source_id || null,
      tables: f.tables.filter((t: any) => t.table_ref).map((table: any, index: number) => ({
        table_key: table.table_key,
        table_ref: table.table_ref,
        join_type: index === 0 ? null : (table.join_type || 'inner'),
        join_conditions: index === 0 ? [] : (table.join_conditions || []),
      })),
      fixed_predicates: f.fixed_predicates.length ? f.fixed_predicates.map(serializePredicate).filter(Boolean) : null,
      query_dimensions: f.query_dimensions.length
        ? f.query_dimensions
          .map((dim: any) => {
            const field = fieldRefToPayload(dim.column)
            if (!field || !dim.name?.trim()) return null
            return { name: dim.name.trim(), field, op: normalizeOperator(dim.op), param_type: dim.param_type, required: dim.required !== false, allowed_values: uniqueValues(dim.allowed_values || []) }
          })
          .filter(Boolean)
        : null,
      time_dimension: (() => {
        const field = fieldRefToPayload(f.time_dimension?.column || '')
        if (!f.time_dimension || !field) return null
        return { field, op: normalizeOperator(f.time_dimension.op), extract_type: f.time_dimension.extract_type, required: f.time_dimension.required !== false, output_format: f.time_dimension.output_format || 'YYYY-MM-DD' }
      })(),
      projections: f.projections.map(serializeProjection).filter(Boolean),
      group_by: groupByItems.length ? groupByItems : null,
      sort_spec: {
        order_by: f.sort_spec.order_by.map((rule: any) => {
          if (rule.kind === 'field') return { kind: 'field', field: fieldRefToPayload(rule.field), direction: rule.direction }
          if (rule.kind === 'projection') return { kind: 'projection', projection_key: rule.projection_key, direction: rule.direction }
          const expressionTemplate = displayExpressionToTemplate(rule.expression || rule.expression_template || '')
          return expressionTemplate ? { kind: 'expression', expression_template: expressionTemplate, direction: rule.direction } : null
        }).filter(Boolean),
        limit_default: f.sort_spec.limit_default,
      },
      ...(f.status ? { status: f.status } : {}),
    }
  }

  // ===== Demo specs / completeness (computed) =====
  const demoDimensionSpecs = form.query_dimensions
    .filter((dim: any) => dim.name?.trim())
    .map((dim: any) => ({
      ...dim,
      key: dim.name.trim(),
      label: dim.name.trim(),
      column_label: formatFieldRef(dim.column),
      isRange: dim.param_type === 'range' || String(dim.op || '').toLowerCase() === 'between',
      isMulti: String(dim.op || '').toLowerCase() === 'in',
      allowed_values: Array.isArray(dim.allowed_values) ? dim.allowed_values : [],
    }))
  const hasDemoFields = demoDimensionSpecs.length > 0 || Boolean(form.time_dimension)

  function buildPreviewDemoInputsPayload(): any {
    const payload: any = {}
    const touchedDimensions: any = {}
    demoDimensionSpecs.forEach((field: any) => {
      if (demoInputTouched.dimension_keys[field.key]) {
        touchedDimensions[field.key] = cloneDemoValue(demoInputs.dimension_values[field.key])
      }
    })
    if (Object.keys(touchedDimensions).length) payload.dimension_values = touchedDimensions
    if (form.time_dimension && (demoInputTouched.time_range.start || demoInputTouched.time_range.end)) {
      payload.time_range = { start: demoInputs.time_range.start || '', end: demoInputs.time_range.end || '' }
    }
    return Object.keys(payload).length ? payload : null
  }

  const metricViewPayload = buildMetricViewPayload()
  const previewPayload = (() => {
    const payload = { ...metricViewPayload }
    const demoPayload = buildPreviewDemoInputsPayload()
    if (demoPayload) payload.demo_inputs = demoPayload
    return payload
  })()
  const currentDefinitionSignature = JSON.stringify(metricViewPayload)
  const currentPreviewRequestSignature = JSON.stringify(previewPayload)

  const previewSummary = (() => {
    const payload = metricViewPayload
    const tableCount = Array.isArray(payload.tables) ? payload.tables.length : 0
    return {
      table_count: tableCount,
      join_count: Math.max(tableCount - 1, 0),
      fixed_predicate_count: Array.isArray(payload.fixed_predicates) ? payload.fixed_predicates.length : 0,
      query_dimension_count: Array.isArray(payload.query_dimensions) ? payload.query_dimensions.length : 0,
      has_time_dimension: Boolean(payload.time_dimension),
      group_by_count: Array.isArray(payload.group_by) ? payload.group_by.length : 0,
      projection_count: Array.isArray(payload.projections) ? payload.projections.length : 0,
      sort_count: Array.isArray(payload.sort_spec?.order_by) ? payload.sort_spec.order_by.length : 0,
    }
  })()
  const previewValidation = previewResult?.validation || { status: '', errors: [], warnings: [] }
  const definitionPreviewStale = previewGenerated && currentDefinitionSignature !== lastPreviewDefinitionSignatureRef.current
  const previewStale = previewGenerated && currentPreviewRequestSignature !== lastPreviewRequestSignatureRef.current
  const demoPreviewStale = previewStale && !definitionPreviewStale
  const previewNeedsValidationBeforeSave = !previewReusableForSaveRef.current || definitionPreviewStale
  const previewTemplateSqlText = previewResult?.template_sql ? previewResult.template_sql : (!previewGenerated ? mt.messages.previewTemplateEmpty : mt.messages.previewTemplateMissing)
  const previewDemoSqlText = previewResult?.demo_sql ? previewResult.demo_sql : (!previewGenerated ? mt.messages.previewTemplateEmpty : mt.messages.previewDemoMissing)

  function hasConfiguredBasicInfo() { return Boolean(form.source_id && form.name?.trim()) }
  function hasConfiguredTables() { return form.tables.some((table: any) => table.table_ref) }
  function hasConfiguredPredicates() { return form.fixed_predicates.length > 0 }
  function hasConfiguredDimensions() { return form.query_dimensions.some((dim: any) => dim.name?.trim() && dim.column?.trim() && dim.op && dim.param_type) }
  function hasConfiguredTimeDimension() { return Boolean(form.time_dimension?.column?.trim() && form.time_dimension?.extract_type) }
  function hasConfiguredProjectionStep() { return form.projections.length > 0 || form.group_by.length > 0 || form.group_by_advanced.length > 0 }
  function hasConfiguredSortStep() { return form.sort_spec.order_by.length > 0 || form.sort_spec.limit_default !== DEFAULT_LIMIT }
  const stepDoneStates = [
    hasConfiguredBasicInfo(), hasConfiguredTables(), hasConfiguredPredicates(),
    hasConfiguredDimensions(), hasConfiguredTimeDimension(), hasConfiguredProjectionStep(), hasConfiguredSortStep(),
  ]
  function isStepDone(index: number) { return Boolean(stepDoneStates[index]) }

  function getLocalValidationIssues() {
    const issues: { step: number; message: string }[] = []
    if (!form.source_id) issues.push({ step: 0, message: mt.messages.issueSelectDataSource })
    if (!form.name?.trim()) issues.push({ step: 0, message: mt.messages.issueInputName })
    if (!form.tables.some((t: any) => t.table_ref)) issues.push({ step: 1, message: mt.messages.issueSelectTable })
    const invalidJoinTable = form.tables.find((table: any, index: number) => index > 0 && table.table_ref && !table.join_conditions.length)
    if (invalidJoinTable) issues.push({ step: 1, message: mt.messages.issueJoinCondition.replace('{name}', getTableDisplayName(invalidJoinTable)) })
    if (!form.projections.length) issues.push({ step: 5, message: mt.messages.issueProjection })
    return issues
  }
  function getSaveValidationIssue() { return getLocalValidationIssues()[0] || null }
  const localValidation = (() => {
    const issues = getLocalValidationIssues().map((item) => item.message)
    return { status: issues.length ? 'warning' : 'success', issues }
  })()
  const timeRangeHint = (() => {
    if (!form.time_dimension) return ''
    const grainMap: any = { day: mt.messages.timeHintDay, month: mt.messages.timeHintMonth, year: mt.messages.timeHintYear }
    return grainMap[form.time_dimension.extract_type] || mt.messages.timeHintDefault
  })()

  const jsonEditorHint = (() => {
    if (!isEditing) return mt.jsonEditorHintCreate
    return form?.status === 'draft' ? mt.jsonEditorHintDraft : mt.jsonEditorHintActive
  })()

  // ===== Smart recommendations =====
  function openRecommendationDrawer() { setRecommendationDrawerVisible(true) }
  async function handleEditCandidate(candidate: any) {
    editingCandidateIdRef.current = candidate?.candidate_id || null
    returnToDrawerAfterWizardRef.current = true
    setFromCandidateMode(true)
    setRecommendationDrawerVisible(false)
    await openWizard(candidate, { fromCandidate: true })
  }
  async function handleRecommendationApplied(results: any) {
    if (!Array.isArray(results)) return
    const okCount = results.filter((r) => r && r.success).length
    if (okCount > 0) await loadList()
  }

  // ===== Wizard operations =====
  async function openWizard(row: any = null, options: any = {}) {
    const fromCandidate = !!options.fromCandidate
    setWizardInitializing(true)
    setWizardStep(0)
    setAliasInput('')
    predicateBuilderRef.current = createPredicateBuilder()
    setProjectionInput('')
    projectionBuilderRef.current = createProjectionBuilder()
    sortBuilderRef.current = createSortBuilder()
    availableTablesRef.current = []
    setAvailableTables([])
    tableColumnsCacheRef.current = {}
    tableColumnsLoadingRef.current = {}
    resetPreviewState()
    demoInputsRef.current = createEmptyDemoInputs()
    demoInputTouchedRef.current = createEmptyDemoTouched()
    demoOptionQueryRef.current = {}
    setWizardVisible(true)
    try {
      if (row) {
        setIsEditing(!fromCandidate)
        editingIdRef.current = fromCandidate ? null : row.id
        let d
        if (fromCandidate) {
          await loadDataSources()
          d = row
        } else {
          const [, res] = await Promise.all([
            loadDataSources(),
            getMetricViewDetailReq(projectId, row.id),
          ])
          d = res.data
        }
        const hydratedTables = hydrateTableRows(d.tables || [])
        const groupByState = hydrateGroupBy(d.group_by || [])
        formRef.current = {
          name: d.name || '',
          description: d.description || '',
          aliases: d.aliases || [],
          source_id: d.source_id,
          tables: hydratedTables,
          fixed_predicates: (d.fixed_predicates || []).map(hydratePredicate).filter(Boolean),
          query_dimensions: (d.query_dimensions || []).map((dim: any) => hydrateDimension(dim, hydratedTables)),
          time_dimension: hydrateTimeDimension(d.time_dimension, hydratedTables),
          projections: (d.projections || []).map((projection: any, index: number) => hydrateProjection(projection, index + 1)).filter(Boolean),
          group_by: groupByState.basic,
          group_by_advanced: groupByState.advanced,
          sort_spec: {
            order_by: (d.sort_spec?.order_by || []).map((item: any) => {
              if (typeof item === 'string') {
                const parts = String(item).trim().split(/\s+/)
                const direction = parts.length > 1 ? (parts.pop() as string).toUpperCase() : 'ASC'
                const target = parts.join(' ')
                const parsed = parseQualifiedColumn(target, hydratedTables)
                if (parsed._table && parsed._col) {
                  return { kind: 'field', field: buildFieldRef(parsed._table, parsed._col), direction: ['ASC', 'DESC'].includes(direction) ? direction : 'ASC' }
                }
                return { kind: 'expression', expression: target, direction: ['ASC', 'DESC'].includes(direction) ? direction : 'ASC' }
              }
              if (item?.kind === 'field') return { kind: 'field', field: payloadFieldToFieldRef(item.field), direction: item.direction || 'ASC' }
              if (item?.kind === 'projection') return { kind: 'projection', projection_key: item.projection_key, direction: item.direction || 'ASC' }
              return { kind: 'expression', expression: templateExpressionToDisplay(item?.expression_template || ''), direction: item?.direction || 'ASC' }
            }).filter(Boolean),
            limit_default: d.sort_spec?.limit_default || DEFAULT_LIMIT,
          },
          status: d.status || 'active',
        }
        if (d.source_id) {
          await loadTablesForSource(getSelectedConnectionId(d.source_id))
          if (formRef.current.status !== 'draft') {
            await Promise.all(
              formRef.current.tables
                .filter((table: any) => table.table_ref)
                .map(async (table: any) => {
                  await resolveStableTable(table)
                  await loadColumnsForTable(table.table_key)
                }),
            )
            formRef.current.query_dimensions.forEach((dim: any) => { refreshDimensionAllowedOptions(dim) })
          }
        }
      } else {
        setIsEditing(false)
        editingIdRef.current = null
        await loadDataSources()
        formRef.current = createEmptyForm()
        await applyDefaultSourceForNewView()
      }
    } catch {
      notifications.show({ color: 'red', message: mt.messages.loadDetailFailed })
      setWizardVisible(false)
      return
    } finally {
      setWizardInitializing(false)
      bump()
    }
  }

  async function handleSaveDraft() {
    setSaveValidationMessage('')
    if (!form?.name?.trim()) {
      setSaveValidationMessage(mt.messages.draftRequireName)
      setWizardStep(0)
      return
    }
    if (!form?.source_id) {
      setSaveValidationMessage(mt.messages.draftRequireSource)
      setWizardStep(0)
      return
    }
    setSavingDraft(true)
    try {
      const payload = { ...buildMetricViewPayload(), status: 'draft' }
      if (isEditing && editingIdRef.current) {
        await updateMetricViewReq(projectId, editingIdRef.current, payload)
      } else {
        await createMetricViewReq(projectId, payload)
      }
      notifications.show({ color: 'green', message: mt.messages.draftSaved })
      if (fromCandidateMode && editingCandidateIdRef.current) {
        setExternallyAppliedCandidateId(editingCandidateIdRef.current)
      }
      setWizardVisible(false)
      await loadList()
    } catch (e: any) {
      setSaveValidationMessage(e?.response?.data?.message || e?.message || String(e))
    } finally {
      setSavingDraft(false)
    }
  }

  async function handleSave() {
    setSaveValidationMessage('')
    const issue = getSaveValidationIssue()
    if (issue) {
      setWizardStep(issue.step)
      setSaveValidationMessage(issue.message)
      return
    }
    setSaving(true)
    try {
      if (previewNeedsValidationBeforeSave) {
        await loadPreview()
      }
      const currentValidation = previewResultRef.current?.validation || { status: '', errors: [], warnings: [] }
      if (currentValidation.status === 'error') {
        const detail = currentValidation.errors[0] || mt.messages.saveValidationDetailFallback
        setSaveValidationMessage(mt.messages.saveValidationStopped.replace('{detail}', detail))
        notifications.show({ color: 'orange', message: mt.messages.saveValidationStoppedToast })
        return
      }
      await saveMetricView()
    } finally {
      setSaving(false)
    }
  }

  async function handleValidate() {
    setSaveValidationMessage('')
    const issue = getSaveValidationIssue()
    if (issue) {
      setWizardStep(issue.step)
      setSaveValidationMessage(issue.message)
      return
    }
    await loadPreview()
    const currentValidation = previewResultRef.current?.validation || { status: '', errors: [], warnings: [] }
    if (currentValidation.status === 'success') {
      notifications.show({ color: 'green', message: mt.messages.validateSuccess })
      return
    }
    if (currentValidation.status === 'warning') {
      notifications.show({ color: 'orange', message: mt.messages.validateWarning })
      return
    }
    setSaveValidationMessage(currentValidation.errors[0] || mt.messages.validateErrorFallback)
    notifications.show({ color: 'orange', message: mt.messages.validateErrorToast })
  }

  async function saveMetricView() {
    try {
      const payload = buildMetricViewPayload()
      if (isEditing) {
        await updateMetricViewReq(projectId, editingIdRef.current, payload)
        notifications.show({ color: 'green', message: mt.messages.updateSuccess })
      } else {
        await createMetricViewReq(projectId, payload)
        notifications.show({ color: 'green', message: mt.messages.createSuccess })
      }
      setSaveValidationMessage('')
      setWizardVisible(false)
      await loadList()
    } catch (error) {
      setSaveValidationMessage(getRequestErrorMessage(error, isEditing ? mt.messages.updateFailed : mt.messages.createFailed))
    }
  }

  function openJsonEditor() {
    setJsonError('')
    setJsonContent(JSON.stringify(buildMetricViewPayload(), null, 2))
    setJsonDialogVisible(true)
  }
  async function saveJsonAndClose() {
    setJsonError('')
    let payload: any
    try {
      payload = JSON.parse(jsonContent)
    } catch (e: any) {
      setJsonError(mt.messages.jsonInvalid + ': ' + (e?.message || String(e)))
      return
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      setJsonError(mt.messages.jsonInvalid)
      return
    }
    payload.status = form?.status || (isEditing ? 'draft' : 'active')
    setJsonSaving(true)
    try {
      if (isEditing && editingIdRef.current) {
        await updateMetricViewReq(projectId, editingIdRef.current, payload)
        notifications.show({ color: 'green', message: mt.messages.updateSuccess })
      } else {
        await createMetricViewReq(projectId, payload)
        notifications.show({ color: 'green', message: mt.messages.createSuccess })
      }
      setJsonDialogVisible(false)
      setWizardVisible(false)
      await loadList()
    } catch (e: any) {
      setJsonError(e?.response?.data?.message || e?.message || String(e))
    } finally {
      setJsonSaving(false)
    }
  }

  // ===== List add/remove helpers =====
  function addAlias() {
    if (aliasInput.trim()) {
      form.aliases.push(aliasInput.trim())
      setAliasInput('')
      bump()
    }
  }
  function removeAlias(i: number) { form.aliases.splice(i, 1); bump() }
  function addTable() {
    form.tables.push({
      table_key: getNextJoinTableKey(), table_ref: '', join_type: 'inner', join_conditions: [],
      _joinLeftCol: '', _joinOperator: '=', _joinRightTable: '', _joinRightCol: '', _lastTableRef: '',
    })
    bump()
  }
  function removeTable(i: number) {
    const removed = form.tables[i]
    if (!removed) return
    removeFieldReferencesForTable(removed.table_key)
    form.tables.splice(i, 1)
    form.tables.forEach((table: any) => {
      if (table._joinRightTable === removed.table_key) {
        table._joinRightTable = ''
        table._joinRightCol = ''
        buildJoinCondition(table)
      }
    })
    bump()
  }
  function removePredicate(i: number) { form.fixed_predicates.splice(i, 1); bump() }
  function addDimension() {
    form.query_dimensions.push({ name: '', column: '', op: '=', param_type: 'discrete', required: true, allowed_values: [], _allowedOptions: [], _table: '', _col: '', _suggestedName: '' })
    bump()
  }
  function removeDimension(i: number) { form.query_dimensions.splice(i, 1); bump() }
  function updateDimensionAllowedValues(dim: any, values: any) {
    const nextValues = uniqueValues(values || [])
    const optionPool = uniqueValues([...(dim._allowedOptions || []), ...nextValues])
    dim.allowed_values = nextValues
    dim._allowedOptions = optionPool
    bump()
  }
  function resetPredicateBuilderValues() {
    predicateBuilder.value = ''
    predicateBuilder.valueItems = []
    predicateBuilder.valueList = ''
    predicateBuilder.rangeStart = ''
    predicateBuilder.rangeEnd = ''
  }
  function handlePredicateOperatorChange(nextOperator: any) {
    predicateBuilder.op = nextOperator
    resetPredicateBuilderValues()
    bump()
  }
  function handlePredicateTableChange(nextTableKey: any) {
    predicateBuilder.table = nextTableKey
    predicateBuilder.column = ''
    resetPredicateBuilderValues()
    bump()
    if (nextTableKey) loadColumnsForTable(nextTableKey)
  }
  function handlePredicateColumnChange(nextColumnName: any) {
    predicateBuilder.column = nextColumnName
    resetPredicateBuilderValues()
    bump()
  }
  function resetDimensionDemoState(dim: any) {
    const key = dim?.name?.trim()
    if (!key) return
    const { [key]: _rv, ...restValues } = demoInputs.dimension_values || {}
    demoInputs.dimension_values = restValues
    const { [key]: _rt, ...restTouched } = demoInputTouched.dimension_keys || {}
    demoInputTouched.dimension_keys = restTouched
  }
  function handleDimensionOperatorChange(dim: any, nextOp: any) {
    if (!dim) return
    dim.op = nextOp
    dim.allowed_values = []
    if (nextOp === 'between') {
      dim.param_type = 'range'
    } else if (dim.param_type === 'range' || nextOp === 'in' || nextOp === '=') {
      dim.param_type = 'discrete'
    }
    refreshDimensionAllowedOptions(dim)
    resetDimensionDemoState(dim)
    bump()
  }
  function updateDimColumn(dim: any) {
    const previousColumn = dim.column || ''
    if (dim._table && dim._col) {
      const nextColumn = buildFieldRef(dim._table, dim._col)
      if (previousColumn && previousColumn !== nextColumn) dim.allowed_values = []
      dim.column = nextColumn
      if (!dim.name || dim.name === dim._suggestedName) dim.name = dim._col
      dim._suggestedName = dim._col
    } else if (previousColumn) {
      dim.column = ''
      dim.allowed_values = []
    }
    refreshDimensionAllowedOptions(dim)
    bump()
  }
  function enableTimeDimension() {
    form.time_dimension = { column: '', op: 'between', extract_type: 'day', required: true, output_format: 'YYYY-MM-DD', _table: '', _col: '' }
    bump()
  }
  function disableTimeDimension() { form.time_dimension = null; bump() }
  function addProjection() {
    const expression = projectionInput.trim()
    if (!expression) return
    form.projections.push({ projection_key: nextProjectionKey(), kind: 'expression', expression })
    setProjectionInput('')
    bump()
  }
  function removeProjection(i: number) {
    const [removed] = form.projections.splice(i, 1)
    if (!removed?.projection_key) { bump(); return }
    form.sort_spec.order_by = form.sort_spec.order_by.filter((rule: any) => !(rule.kind === 'projection' && rule.projection_key === removed.projection_key))
    bump()
  }
  function removeAdvancedGroupBy(i: number) { form.group_by_advanced.splice(i, 1); bump() }
  function removeOrderBy(i: number) { form.sort_spec.order_by.splice(i, 1); bump() }

  // ===== Demo input handling =====
  function getDemoDimensionValue(key: string, fallback: any = '') {
    const value = demoInputs.dimension_values[key]
    return value === undefined ? fallback : value
  }
  function normalizeDemoSearchText(value: any) { return String(value ?? '').trim().toLowerCase() }
  function fuzzyMatchDemoOption(option: any, keyword: any): boolean {
    const text = normalizeDemoSearchText(option)
    const query = normalizeDemoSearchText(keyword)
    if (!query) return true
    if (text.includes(query)) return true
    let pointer = 0
    for (const char of text) {
      if (char === query[pointer]) {
        pointer += 1
        if (pointer === query.length) return true
      }
    }
    return false
  }
  function updateDemoOptionQuery(key: string, query: string) {
    demoOptionQueryRef.current = { ...demoOptionQueryRef.current, [key]: query || '' }
    bump()
  }
  function handleDemoOptionDropdown(key: string, visible: boolean) {
    if (visible) return
    updateDemoOptionQuery(key, '')
  }
  function getFilteredDemoOptions(field: any): string[] {
    const query = demoOptionQueryRef.current[field.key] || ''
    const options = Array.isArray(field.allowed_values) ? field.allowed_values : []
    const filtered = query ? options.filter((option: any) => fuzzyMatchDemoOption(option, query)) : options
    return filtered.slice(0, 200)
  }
  function getDemoDimensionRangeValue(key: string, boundary: string) {
    const value = demoInputs.dimension_values[key]
    if (!value || Array.isArray(value) || typeof value !== 'object') return ''
    return value[boundary] || ''
  }
  function getDemoTimeRangeValue(boundary: string) {
    return demoInputs.time_range?.[boundary] || ''
  }
  function markDemoDimensionTouched(key: string) {
    demoInputTouched.dimension_keys = { ...demoInputTouched.dimension_keys, [key]: true }
  }
  function updateDemoDimensionValue(key: string, value: any) {
    markDemoDimensionTouched(key)
    demoInputs.dimension_values = { ...demoInputs.dimension_values, [key]: cloneDemoValue(value) }
    bump()
  }
  function updateDemoDimensionRangeValue(key: string, boundary: string, value: any) {
    markDemoDimensionTouched(key)
    const currentValue = demoInputs.dimension_values[key]
    const nextValue = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue) ? { ...currentValue } : { start: '', end: '' }
    nextValue[boundary] = value || ''
    demoInputs.dimension_values = { ...demoInputs.dimension_values, [key]: nextValue }
    bump()
  }
  function updateDemoTimeRangeValue(boundary: string, value: any) {
    demoInputTouched.time_range = { ...demoInputTouched.time_range, [boundary]: true }
    demoInputs.time_range = { ...demoInputs.time_range, [boundary]: value || '' }
    bump()
  }
  function syncDemoInputsFromPreview(result: any) {
    const serverInputs = result?.demo_inputs || {}
    const nextDimensionValues: any = {}
    demoDimensionSpecs.forEach((field: any) => {
      if (demoInputTouched.dimension_keys[field.key]) {
        nextDimensionValues[field.key] = cloneDemoValue(demoInputs.dimension_values[field.key])
        return
      }
      if (Object.prototype.hasOwnProperty.call(serverInputs.dimension_values || {}, field.key)) {
        nextDimensionValues[field.key] = cloneDemoValue(serverInputs.dimension_values[field.key])
        return
      }
      nextDimensionValues[field.key] = field.isMulti ? [] : (field.isRange ? { start: '', end: '' } : '')
    })
    const nextTimeRange: any = { start: '', end: '' }
    if (form.time_dimension) {
      nextTimeRange.start = demoInputTouched.time_range.start ? (demoInputs.time_range.start || '') : (serverInputs.time_range?.start || '')
      nextTimeRange.end = demoInputTouched.time_range.end ? (demoInputs.time_range.end || '') : (serverInputs.time_range?.end || '')
    }
    demoInputsRef.current = { dimension_values: nextDimensionValues, time_range: nextTimeRange }
    bump()
  }
  function resetDemoInputs() {
    demoInputsRef.current = createEmptyDemoInputs()
    demoInputTouchedRef.current = createEmptyDemoTouched()
    if (previewResultRef.current) syncDemoInputsFromPreview(previewResultRef.current)
    bump()
  }

  async function loadPreview() {
    if (!wizardVisibleRef.current) return
    const definitionSignature = currentDefinitionSignature
    const requestSignature = currentPreviewRequestSignature
    const token = ++previewRequestTokenRef.current
    setPreviewLoading(true)
    try {
      const res = await previewMetricViewReq(projectId, previewPayload)
      if (token !== previewRequestTokenRef.current) return
      const result = res.data || null
      previewResultRef.current = result
      setPreviewResult(result)
      setPreviewGenerated(true)
      previewReusableForSaveRef.current = true
      lastPreviewDefinitionSignatureRef.current = definitionSignature
      lastPreviewRequestSignatureRef.current = requestSignature
      syncDemoInputsFromPreview(result)
    } catch (e: any) {
      if (token !== previewRequestTokenRef.current) return
      const result = buildPreviewErrorResult(getRequestErrorMessage(e, mt.messages.requestErrorFallback))
      previewResultRef.current = result
      setPreviewResult(result)
      setPreviewGenerated(true)
      previewReusableForSaveRef.current = Boolean(e?.response)
      lastPreviewDefinitionSignatureRef.current = definitionSignature
      lastPreviewRequestSignatureRef.current = requestSignature
      syncDemoInputsFromPreview(result)
    } finally {
      if (token === previewRequestTokenRef.current) setPreviewLoading(false)
    }
  }

  // ===== Lifecycle =====
  const isFirstMountRef = useRef(true)
  useEffect(() => {
    // onMounted + watch(businessId): trigger on initial mount and when businessId changes
    if (!isFirstMountRef.current) {
      setCurrentPage(1)
      setListSourceFilter('')
      availableTablesCacheRef.current = {}
      dataSourcesLoadedBusinessIdRef.current = ''
      availableTableLookupTasksRef.current.clear()
      tableColumnsTasksRef.current.clear()
    }
    isFirstMountRef.current = false
    ;(async () => {
      await loadDataSources()
      await loadList()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId])

  // currentPage / pageSize / filter changes: reload list when filters change (aligned with handlePageChange directly calling loadList)
  useEffect(() => {
    if (isFirstMountRef.current) return
    loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, pageSize, listSourceFilter, listStatusFilter])

  // watch(wizardVisible): clear preview after close, and reopen Drawer when needed
  const prevWizardVisibleRef = useRef(false)
  useEffect(() => {
    const wasVisible = prevWizardVisibleRef.current
    prevWizardVisibleRef.current = wizardVisible
    if (wasVisible && !wizardVisible) {
      resetPreviewState()
      setSaveValidationMessage('')
      if (returnToDrawerAfterWizardRef.current) {
        returnToDrawerAfterWizardRef.current = false
        setTimeout(() => {
          setRecommendationDrawerVisible(true)
          setTimeout(() => {
            setExternallyAppliedCandidateId(null)
            editingCandidateIdRef.current = null
          }, 100)
        }, 50)
      }
      setFromCandidateMode(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardVisible])

  // ===== Render helpers =====
  const wizardSteps = [
    mt.wizardSteps.basicInfo, mt.wizardSteps.tables, mt.wizardSteps.fixedPredicates,
    mt.wizardSteps.dimensions, mt.wizardSteps.time, mt.wizardSteps.projections, mt.wizardSteps.sort,
  ]
  const sourceFilterData = dataSources.map((ds: any) => ({ value: String(ds.source_id), label: getDataSourceDisplayName(ds) }))
  const statusFilterData = [
    { value: 'active', label: mt.statusOptions.active },
    { value: 'inactive', label: mt.statusOptions.inactive },
    { value: 'draft', label: mt.statusOptions.draft },
  ]
  const dataSourceSelectData = dataSources.map((ds: any) => ({
    value: getDataSourceDisplayName(ds),
    label: `${getDataSourceDisplayName(ds)}${ds.db_type ? `  ${ds.db_type}` : ''}`,
  }))
  const availableTableSelectData = availableTables.map((tb: any) => {
    const v = tb.schema_name ? `${tb.schema_name}.${tb.table_name}` : tb.table_name
    return { value: v, label: v }
  })
  const columnSelectData = (tableToken: any) =>
    getColumnsForTable(tableToken).map((col: any) => ({
      value: col.column_name,
      label: col.data_type ? `${col.column_name}  (${col.data_type})` : col.column_name,
    }))
  const previousTableSelectData = (i: number) =>
    getPreviousTables(i).map((pt: any) => ({ value: pt.table_key, label: getTableDisplayName(pt) }))
  const configuredTableSelectData = configuredTables.map((tt: any) => ({ value: tt.table_key, label: getTableDisplayName(tt) }))
  const projectionAggregateOptions = [
    { label: locale.startsWith('zh') ? '原始字段' : 'Raw Field', value: 'raw' },
    { label: 'SUM', value: 'sum' }, { label: 'AVG', value: 'avg' }, { label: 'COUNT', value: 'count' },
    { label: 'COUNT DISTINCT', value: 'count_distinct' }, { label: 'MAX', value: 'max' }, { label: 'MIN', value: 'min' }, { label: 'ROUND', value: 'round' },
  ]

  // True empty state (no views and no active filters): hide top actions and keep only the unified empty state with built-in create CTA.
  // Keep actions when filters are active even if result is 0; otherwise users cannot clear filters.
  const showEmptyState = !loading && list.length === 0 && !listSourceFilter && !listStatusFilter

  return (
    <div className={styles.tabContainer} style={{ gap: 16 }}>
      {/* Top actions bar (hidden when empty, empty state includes create CTA) */}
      {!showEmptyState && (
      <div className={styles.operationsCard}>
        <div className={styles.operationsHeader}>
          <h3>{mt.title}</h3>
          <div className={styles.headerActions}>
            <Select
              value={listSourceFilter || null}
              clearable
              placeholder={mt.filterAllSources}
              className={styles.sourceFilter}
              data={sourceFilterData}
              onChange={(val) => handleListSourceChange(val || '')}
            />
            <Select
              value={listStatusFilter || null}
              clearable
              placeholder={mt.filterAllStatuses}
              className={styles.sourceFilter}
              data={statusFilterData}
              onChange={(val) => handleListStatusChange(val || '')}
            />
            <Button leftSection={<IconPlus size={16} />} onClick={() => openWizard()}>{mt.createView}</Button>
            <Button color="green" leftSection={<IconWand size={16} />} onClick={openRecommendationDrawer}>{mt.smartRecommend}</Button>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={loading} onClick={loadList}>{mt.refresh}</Button>
            <Button variant="default" loading={embeddingLoading} onClick={generateAllEmbeddings}>{mt.generateEmbeddings}</Button>
          </div>
        </div>
      </div>
      )}

      {/* List: use unified semantic empty state (flat, no card) when empty; use table for data/loading */}
      {showEmptyState ? (
        <SemanticEmptyState
          icon={<ElSvgIcon name="Grid" size={26} color="#fff" />}
          satellites={[
            <ElSvgIcon key="a" name="Share" size={20} />,
            <ElSvgIcon key="b" name="Document" size={20} />
          ]}
          title={mt.emptyTitle}
          description={mt.emptyDescription}
          features={[
            { icon: <ElSvgIcon name="Share" size={16} />, label: mt.emptyFeature1 },
            { icon: <ElSvgIcon name="Connection" size={16} />, label: mt.emptyFeature2 },
            { icon: <ElSvgIcon name="Search" size={16} />, label: mt.emptyFeature3 }
          ]}
          actions={
            <Button leftSection={<IconPlus size={16} />} onClick={() => openWizard()}>
              {mt.createView}
            </Button>
          }
        />
      ) : (
      <div className={styles.contentCard}>
        <LoadingOverlay visible={loading} />
        <div className={styles.scrollableContent}>
          <table className={styles.metricViewTable}>
            <thead>
              <tr>
                <th style={{ width: 72, textAlign: 'center' }}>{mt.columns.index}</th>
                <th style={{ minWidth: 190 }}>{mt.columns.name}</th>
                <th style={{ minWidth: 220 }}>{mt.columns.description}</th>
                <th style={{ minWidth: 360 }}>{mt.columns.aliases}</th>
                <th style={{ width: 72, textAlign: 'center' }}>{mt.columns.status}</th>
                <th style={{ width: 68, textAlign: 'center' }}>{mt.columns.vector}</th>
                <th style={{ width: 196, textAlign: 'center' }}>{mt.columns.actions}</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 ? (
                <tr><td colSpan={7} className={styles.tableEmpty}>{mt.emptyList}</td></tr>
              ) : (
                list.map((row, index) => (
                  <tr key={row.id ?? index}>
                    <td style={{ textAlign: 'center' }}>{metricViewRowIndex(index)}</td>
                    <td className={styles.cellEllipsis} title={row.name}>{row.name}</td>
                    <td className={styles.cellEllipsis} title={row.description}>{row.description}</td>
                    <td>
                      {row.aliases && row.aliases.length ? (
                        <div className={styles.aliasCell}>
                          {row.aliases.slice(0, 4).map((a: string) => (
                            <Badge key={a} size="sm" variant="light" className={styles.aliasTag}>{a}</Badge>
                          ))}
                          {row.aliases.length > 4 && <span className={styles.aliasMore}>+{row.aliases.length - 4}</span>}
                        </div>
                      ) : (
                        <span className={styles.aliasEmpty}>-</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Badge size="sm" color={badgeColor(statusTagType(row.status))} className={styles.tableBadge}>{statusLabel(row.status)}</Badge>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <Badge size="sm" color={row.embedding_model ? 'green' : 'orange'} className={styles.tableBadge}>
                        {row.embedding_model ? mt.vectorGenerated : mt.vectorPending}
                      </Badge>
                    </td>
                    <td>
                      <div className={styles.rowActions}>
                        <button type="button" className={`${styles.rowActionBtn} ${styles.isEdit}`} onClick={() => openWizard(row)}>{mt.edit}</button>
                        {(row.status === 'draft' || row.status === 'inactive') && (
                          <button type="button" className={`${styles.rowActionBtn} ${styles.isSuccess}`} onClick={() => changeStatus(row, 'active')}>{mt.statusActions.activate}</button>
                        )}
                        {row.status === 'active' && (
                          <button type="button" className={`${styles.rowActionBtn} ${styles.isWarning}`} onClick={() => changeStatus(row, 'inactive')}>{mt.statusActions.deactivate}</button>
                        )}
                        <button type="button" className={`${styles.rowActionBtn} ${styles.isDanger}`} onClick={() => handleDelete(row)}>{mt.delete}</button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {total > 0 && (
          <div className={styles.paginationWrapper}>
            <Pagination
              total={Math.max(1, Math.ceil(total / pageSize))}
              value={currentPage}
              onChange={handlePageChange}
            />
          </div>
        )}
      </div>
      )}

      {/* Wizard modal */}
      <Modal
        opened={wizardVisible}
        onClose={() => setWizardVisible(false)}
        title={isEditing ? mt.dialogEditTitle : mt.dialogCreateTitle}
        size="94vw"
        closeOnClickOutside={false}
        styles={{ content: { maxWidth: 1320 }, body: { padding: 0 } }}
      >
        <div className={styles.wizardLayout}>
          {/* Left-side navigation */}
          <div className={styles.wizardNav}>
            {wizardSteps.map((s, i) => (
              <div
                key={i}
                className={[styles.wizardNavItem, wizardStep === i ? styles.active : '', isStepDone(i) && wizardStep !== i ? styles.done : ''].filter(Boolean).join(' ')}
                onClick={() => setWizardStep(i)}
              >
                <div className={styles.navIndicator}>
                  {isStepDone(i) && wizardStep !== i ? <span className={styles.navCheck}>&#10003;</span> : <span>{i + 1}</span>}
                </div>
                <div className={styles.navText}>
                  <div className={styles.navTitle}>{s.title}</div>
                  <div className={styles.navDesc}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Right-side content */}
          <div className={styles.wizardContent} style={{ position: 'relative' }}>
            <LoadingOverlay visible={wizardInitializing} />
            <div className={styles.wizardMainGrid}>
              <div className={styles.wizardEditor}>
                {/* Step 0: Basic info */}
                <div style={{ display: wizardStep === 0 ? undefined : 'none' }}>
                  <div className={styles.formItem}>
                    <div className={`${styles.formItemLabel} ${styles.requiredMark}`} style={{ width: 80 }}>{mt.basicInfo.dataSource}</div>
                    <div className={styles.formItemControl}>
                      <Select
                        value={selectedSourceName || null}
                        placeholder={mt.basicInfo.selectDataSource}
                        searchable
                        data={dataSourceSelectData}
                        disabled={!!(isEditing && !isDraftEditing)}
                        onChange={(val) => handleDataSourceChange(val || '')}
                      />
                    </div>
                  </div>
                  {isEditing && !isDraftEditing && (
                    <div className={styles.wizardHint} style={{ margin: '-8px 0 12px 80px' }}>{mt.basicInfo.editSourceLockedHint}</div>
                  )}
                  {isDraftEditing && (
                    <div className={styles.wizardHint} style={{ margin: '-8px 0 12px 80px', color: '#e6a23c' }}>{mt.basicInfo.draftSourceSwitchHint}</div>
                  )}
                  <div className={styles.formItem}>
                    <div className={`${styles.formItemLabel} ${styles.requiredMark}`} style={{ width: 80 }}>{mt.basicInfo.name}</div>
                    <div className={styles.formItemControl}>
                      <TextInput value={form.name} placeholder={mt.basicInfo.namePlaceholder} onChange={(e) => { form.name = e.currentTarget.value; bump() }} />
                    </div>
                  </div>
                  <div className={styles.formItem}>
                    <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.basicInfo.description}</div>
                    <div className={styles.formItemControl}>
                      <Textarea value={form.description} rows={3} placeholder={mt.basicInfo.descriptionPlaceholder} onChange={(e) => { form.description = e.currentTarget.value; bump() }} />
                    </div>
                  </div>
                  <div className={styles.formItem}>
                    <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.basicInfo.aliases}</div>
                    <div className={styles.formItemControl}>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <TextInput style={{ flex: 1 }} value={aliasInput} placeholder={mt.basicInfo.aliasPlaceholder} onChange={(e) => setAliasInput(e.currentTarget.value)} onKeyUp={(e) => { if (e.key === 'Enter') addAlias() }} />
                        <Button variant="default" onClick={addAlias}>{mt.add}</Button>
                      </div>
                      {form.aliases.map((a: string, i: number) => (
                        <Badge key={i} variant="light" rightSection={<IconX size={12} style={{ cursor: 'pointer' }} onClick={() => removeAlias(i)} />} style={{ marginRight: 6 }}>{a}</Badge>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Step 1: Table setup */}
                <div style={{ display: wizardStep === 1 ? undefined : 'none' }}>
                  {!form.source_id ? (
                    <div className={styles.wizardHint} style={{ textAlign: 'center', padding: '40px 0' }}>{mt.tableConfig.selectSourceFirst}</div>
                  ) : (
                    <>
                      {form.tables.map((tval: any, i: number) => (
                        <div key={i} className={styles.wizardCard}>
                          <div className={styles.wizardCardHeader}>
                            <span>{i === 0 ? mt.tableConfig.mainTable : mt.tableConfig.joinTable.replace('{index}', String(i))}</span>
                            {i > 0 && (
                              <span className={styles.removeTableBtn} onClick={() => removeTable(i)}><IconX size={14} /></span>
                            )}
                          </div>
                          <div className={styles.formItem}>
                            <div className={`${styles.formItemLabel} ${styles.requiredMark}`} style={{ width: 90 }}>{mt.tableConfig.tableName}</div>
                            <div className={styles.formItemControl}>
                              <Select
                                value={tval.table_ref || null}
                                searchable
                                placeholder={mt.tableConfig.searchSelectTable}
                                data={availableTableSelectData}
                                onChange={(val) => { tval.table_ref = val || ''; bump(); handleTableRefChange(tval) }}
                              />
                            </div>
                          </div>
                          <div className={styles.wizardHint} style={{ margin: '-4px 0 12px 90px' }}>{mt.tableConfig.stableRefHint}</div>
                          {i > 0 && (
                            <>
                              <div className={styles.formItem}>
                                <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.tableConfig.joinType}</div>
                                <div className={styles.formItemControl}>
                                  <Select value={tval.join_type} data={[{ value: 'inner', label: 'INNER' }, { value: 'left', label: 'LEFT' }, { value: 'right', label: 'RIGHT' }, { value: 'full', label: 'FULL' }]} onChange={(val) => { tval.join_type = val || 'inner'; bump() }} />
                                </div>
                              </div>
                              <div className={styles.formItem}>
                                <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.tableConfig.joinCondition}</div>
                                <div className={styles.formItemControl}>
                                  <div className={styles.joinConditionBuilder}>
                                    <Select
                                      style={{ width: 160 }}
                                      value={tval._joinLeftCol || null}
                                      searchable
                                      placeholder={mt.tableConfig.currentTableColumn}
                                      data={columnSelectData(tval.table_key)}
                                      onDropdownOpen={() => loadColumnsForTable(tval.table_key)}
                                      onChange={(val) => { tval._joinLeftCol = val || ''; bump(); buildJoinCondition(tval) }}
                                    />
                                    <span className={styles.joinEq}>=</span>
                                    <Select
                                      style={{ width: 160 }}
                                      value={tval._joinRightTable || null}
                                      searchable
                                      placeholder={mt.tableConfig.relatedTable}
                                      data={previousTableSelectData(i)}
                                      onChange={(val) => { tval._joinRightTable = val || ''; tval._joinRightCol = ''; if (val) loadColumnsForTable(val); bump(); buildJoinCondition(tval) }}
                                    />
                                    <span className={styles.joinDot}>.</span>
                                    <Select
                                      style={{ width: 160 }}
                                      value={tval._joinRightCol || null}
                                      disabled={!tval._joinRightTable}
                                      searchable
                                      placeholder={mt.tableConfig.relatedColumn}
                                      data={columnSelectData(tval._joinRightTable)}
                                      onDropdownOpen={() => { if (tval._joinRightTable) loadColumnsForTable(tval._joinRightTable) }}
                                      onChange={(val) => { tval._joinRightCol = val || ''; bump(); buildJoinCondition(tval) }}
                                    />
                                  </div>
                                  {joinConditionDisplayText(tval) && (
                                    <div className={styles.builderPreview}>{joinConditionDisplayText(tval)}</div>
                                  )}
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      <Button fullWidth onClick={addTable}>{mt.tableConfig.addJoinTable}</Button>
                    </>
                  )}
                </div>

                {/* Step 2: Fixed filters */}
                <div style={{ display: wizardStep === 2 ? undefined : 'none' }}>
                  <p className={styles.wizardHint}>{mt.fixedPredicates.hint}</p>
                  <div className={styles.predicateModeSwitch}>
                    <Button.Group>
                      <Button size="xs" variant={predicateBuilder.mode === 'structured' ? 'filled' : 'default'} onClick={() => setPredicateMode('structured')}>{mt.fixedPredicates.modeStructured}</Button>
                      <Button size="xs" variant={predicateBuilder.mode === 'template' ? 'filled' : 'default'} onClick={() => setPredicateMode('template')}>{mt.fixedPredicates.modeTemplate}</Button>
                    </Button.Group>
                  </div>
                  <div className={[styles.predicateBuilder, predicateBuilder.mode === 'template' ? styles.isTemplateMode : ''].filter(Boolean).join(' ')}>
                    {predicateBuilder.mode === 'template' ? (
                      <>
                        <Textarea
                          className={styles.predicateTemplateInput}
                          value={predicateBuilder.expression}
                          rows={3}
                          placeholder={predicateTemplatePlaceholder}
                          onChange={(e) => { predicateBuilder.expression = e.currentTarget.value; bump() }}
                          onKeyUp={(e) => { if (e.key === 'Enter' && e.ctrlKey) addPredicateFromBuilder() }}
                        />
                        <div className={styles.demoFormMeta}>
                          {mt.fixedPredicates.templateHintPrefix} <code>{'{{main.data_date}}'}</code>。 {mt.fixedPredicates.templateHintSuffix}
                        </div>
                        {predicateTemplateTableGuide.length > 0 && (
                          <div className={styles.predicateTemplateGuide}>
                            <span className={styles.predicateTemplateGuideLabel}>{mt.fixedPredicates.availableTableKeys}</span>
                            {predicateTemplateTableGuide.map((item: any) => (
                              <Badge key={item.table_key} size="sm" variant="outline" className={styles.predicateTemplateGuideTag}>{item.table_key} = {item.table_ref}</Badge>
                            ))}
                          </div>
                        )}
                        <Button onClick={addPredicateFromBuilder}>{mt.add}</Button>
                      </>
                    ) : (
                      <>
                        <Select
                          style={{ width: 160 }}
                          value={predicateBuilder.table || null}
                          searchable
                          placeholder={mt.fixedPredicates.selectTable}
                          data={configuredTableSelectData}
                          onChange={(val) => handlePredicateTableChange(val || '')}
                        />
                        <span className={styles.predicateDot}>.</span>
                        <Select
                          style={{ width: 160 }}
                          value={predicateBuilder.column || null}
                          disabled={!predicateBuilder.table}
                          searchable
                          placeholder={mt.fixedPredicates.selectColumn}
                          data={columnSelectData(predicateBuilder.table)}
                          onDropdownOpen={() => { if (predicateBuilder.table) loadColumnsForTable(predicateBuilder.table) }}
                          onChange={(val) => handlePredicateColumnChange(val || '')}
                        />
                        <Select
                          style={{ width: 100, flexShrink: 0 }}
                          value={predicateBuilder.op}
                          data={['=', '!=', '>', '>=', '<', '<=', 'IN', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL'].map((op) => ({ value: op, label: op }))}
                          onChange={(val) => handlePredicateOperatorChange(val || '=')}
                        />
                        {predicateUsesRangeValue ? (
                          <>
                            <TextInput style={{ width: 140 }} value={predicateBuilder.rangeStart} placeholder={mt.fixedPredicates.rangeStartPlaceholder} onChange={(e) => { predicateBuilder.rangeStart = e.currentTarget.value; bump() }} />
                            <TextInput style={{ width: 140 }} value={predicateBuilder.rangeEnd} placeholder={mt.fixedPredicates.rangeEndPlaceholder} onChange={(e) => { predicateBuilder.rangeEnd = e.currentTarget.value; bump() }} />
                          </>
                        ) : predicateUsesListValue && predicateAllowedOptions.length ? (
                          <FilterableMultiSelect
                            modelValue={predicateBuilder.valueItems}
                            options={predicateAllowedOptions}
                            selectStyle="min-width:180px;flex:1 1 180px"
                            placeholder={mt.fixedPredicates.listPlaceholder}
                            onVisibleChange={handlePreviewInteractionVisibility}
                            onChange={(values) => { predicateBuilder.valueItems = values; bump() }}
                          />
                        ) : predicateUsesListValue ? (
                          <TextInput style={{ width: 140 }} value={predicateBuilder.valueList} placeholder={mt.fixedPredicates.multiValuesPlaceholder} onChange={(e) => { predicateBuilder.valueList = e.currentTarget.value; bump() }} onKeyUp={(e) => { if (e.key === 'Enter') addPredicateFromBuilder() }} />
                        ) : !predicateUsesNoValue && !predicateUsesRangeValue && predicateAllowedOptions.length ? (
                          <Select
                            style={{ minWidth: 180, flex: '1 1 180px' }}
                            value={predicateBuilder.value || null}
                            searchable
                            clearable
                            placeholder={mt.fixedPredicates.searchPlaceholder}
                            data={predicateAllowedOptions.slice(0, 200).map((option: string) => ({ value: option, label: option }))}
                            onChange={(val) => { predicateBuilder.value = val || ''; bump() }}
                          />
                        ) : !predicateUsesNoValue ? (
                          <TextInput style={{ width: 140 }} value={predicateBuilder.value} placeholder={mt.fixedPredicates.valuePlaceholder} onChange={(e) => { predicateBuilder.value = e.currentTarget.value; bump() }} onKeyUp={(e) => { if (e.key === 'Enter') addPredicateFromBuilder() }} />
                        ) : null}
                        {!predicateUsesNoValue && !predicateUsesRangeValue && predicateAllowedOptions.length > 0 && (
                          <div className={styles.demoFormMeta}>{mt.fixedPredicates.candidateHint}</div>
                        )}
                        <Button onClick={addPredicateFromBuilder}>{mt.add}</Button>
                      </>
                    )}
                  </div>
                  {predicateUsesListValue && predicateAllowedOptions.length > 8 && (
                    <div className={styles.demoFormMeta}>{mt.fixedPredicates.bulkSelectHint}</div>
                  )}
                  {predicatePreviewText && <div className={styles.builderPreview}>{predicatePreviewText}</div>}
                  <div style={{ marginTop: 12 }}>
                    {form.fixed_predicates.map((p: any, i: number) => (
                      <Badge key={i} variant="light" style={{ marginBottom: 6, marginRight: 6 }} rightSection={<IconX size={12} style={{ cursor: 'pointer' }} onClick={() => removePredicate(i)} />}>{predicateDisplayText(p)}</Badge>
                    ))}
                  </div>
                  {!form.fixed_predicates.length && <div className={styles.emptyState}>{mt.fixedPredicates.empty}</div>}
                </div>

                {/* Step 3: Query dimensions */}
                <div style={{ display: wizardStep === 3 ? undefined : 'none' }}>
                  <p className={styles.wizardHint}>{mt.queryDimensions.hint}</p>
                  {form.query_dimensions.map((dim: any, i: number) => (
                    <div key={i} className={styles.wizardCard}>
                      <div className={styles.wizardCardHeader}>
                        <span>{mt.queryDimensions.dimensionCard.replace('{index}', String(i + 1))}</span>
                        <span className={styles.removeTableBtn} onClick={() => removeDimension(i)}><IconX size={14} /></span>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.queryDimensions.dimensionName}</div>
                        <div className={styles.formItemControl}>
                          <TextInput value={dim.name} placeholder={mt.queryDimensions.dimensionNamePlaceholder} onChange={(e) => { dim.name = e.currentTarget.value; bump() }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.queryDimensions.table}</div>
                        <div className={styles.formItemControl}>
                          <Select value={dim._table || null} searchable placeholder={mt.queryDimensions.selectTable} data={configuredTableSelectData} onChange={(val) => { dim._table = val || ''; dim._col = ''; if (val) loadColumnsForTable(val); updateDimColumn(dim) }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.queryDimensions.column}</div>
                        <div className={styles.formItemControl}>
                          <Select value={dim._col || null} searchable disabled={!dim._table} placeholder={mt.queryDimensions.selectColumn} data={columnSelectData(dim._table)} onDropdownOpen={() => { if (dim._table) loadColumnsForTable(dim._table) }} onChange={(val) => { dim._col = val || ''; updateDimColumn(dim) }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.queryDimensions.operator}</div>
                        <div className={styles.formItemControl}>
                          <Select value={dim.op} data={['=', '>', '>=', '<', '<=', 'in', 'between'].map((op) => ({ value: op, label: op }))} onChange={(val) => handleDimensionOperatorChange(dim, val)} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.queryDimensions.paramType}</div>
                        <div className={styles.formItemControl}>
                          <Select value={dim.param_type} data={[{ value: 'discrete', label: mt.queryDimensions.paramTypeDiscrete }, { value: 'range', label: mt.queryDimensions.paramTypeRange }, { value: 'entity', label: mt.queryDimensions.paramTypeEntity }, { value: 'subquery', label: mt.queryDimensions.paramTypeSubquery }]} onChange={(val) => { dim.param_type = val || 'discrete'; bump() }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.queryDimensions.required}</div>
                        <div className={styles.formItemControl}>
                          <Switch checked={dim.required} onLabel={mt.requiredText} offLabel={mt.optionalText} onChange={(e) => { dim.required = e.currentTarget.checked; bump() }} />
                        </div>
                      </div>
                      {dim.param_type === 'discrete' && (
                        <div className={styles.formItem}>
                          <div className={styles.formItemLabel} style={{ width: 80 }}>{mt.queryDimensions.allowedValues}</div>
                          <div className={styles.formItemControl}>
                            <FilterableMultiSelect modelValue={dim.allowed_values} options={dim._allowedOptions || []} placeholder={mt.queryDimensions.allowedValuesPlaceholder} onVisibleChange={handlePreviewInteractionVisibility} onChange={(values) => updateDimensionAllowedValues(dim, values)} />
                            {(dim._allowedOptions || []).length > 8 && <div className={styles.demoFormMeta}>{mt.queryDimensions.bulkSelectHint}</div>}
                            {getDimensionReferenceOptions(dim).length > 0 && (
                              <div className={styles.dimensionReferenceValues}>
                                <span className={styles.dimensionReferenceLabel}>{mt.queryDimensions.referenceValues}</span>
                                {getDimensionReferenceOptions(dim).slice(0, 12).map((option: string) => (
                                  <Badge key={`${dim.column || dim.name}-reference-${option}`} size="sm" variant="outline" className={styles.dimensionReferenceTag} onClick={() => appendDimensionReferenceValue(dim, option)}>{option}</Badge>
                                ))}
                              </div>
                            )}
                            {(getDimensionReferenceOptions(dim).length > 0 || (dim._table && dim._col)) && (
                              <div className={styles.dimensionActionRow}>
                                {getDimensionReferenceOptions(dim).length > 0 && <Button variant="subtle" size="xs" onClick={() => appendAllDimensionReferenceValues(dim)}>{mt.queryDimensions.importAllReferenceValues}</Button>}
                                {dim._table && dim._col && <Button variant="subtle" size="xs" onClick={() => openDimensionDbDialog(dim)}>{mt.queryDimensions.manageReferenceValues}</Button>}
                              </div>
                            )}
                            <div className={styles.demoFormMeta}>{mt.queryDimensions.referenceHint}</div>
                          </div>
                        </div>
                      )}
                      {dimensionPreviewText(dim) && <div className={styles.builderPreview}>{dimensionPreviewText(dim)}</div>}
                    </div>
                  ))}
                  <Button fullWidth onClick={addDimension}>{mt.queryDimensions.addDimension}</Button>
                </div>

                {/* Step 4: Time dimension */}
                <div style={{ display: wizardStep === 4 ? undefined : 'none' }}>
                  {!form.time_dimension ? (
                    <div className={styles.emptyState}>
                      <div style={{ marginBottom: 12 }}>{mt.timeDimension.empty}</div>
                      <Button onClick={enableTimeDimension}>{mt.timeDimension.enable}</Button>
                    </div>
                  ) : (
                    <>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.timeDimension.table}</div>
                        <div className={styles.formItemControl}>
                          <Select value={form.time_dimension._table || null} searchable placeholder={mt.timeDimension.selectTable} data={configuredTableSelectData} onChange={(val) => { form.time_dimension._table = val || ''; form.time_dimension._col = ''; if (val) loadColumnsForTable(val); updateTimeDimensionColumn() }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.timeDimension.column}</div>
                        <div className={styles.formItemControl}>
                          <Select value={form.time_dimension._col || null} searchable disabled={!form.time_dimension._table} placeholder={mt.timeDimension.selectColumn} data={columnSelectData(form.time_dimension._table)} onDropdownOpen={() => { if (form.time_dimension._table) loadColumnsForTable(form.time_dimension._table) }} onChange={(val) => { form.time_dimension._col = val || ''; updateTimeDimensionColumn() }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.timeDimension.operator}</div>
                        <div className={styles.formItemControl}>
                          <Select value={form.time_dimension.op} data={['between', '=', '>', '>=', '<', '<='].map((op) => ({ value: op, label: op }))} onChange={(val) => { form.time_dimension.op = val || 'between'; bump() }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.timeDimension.required}</div>
                        <div className={styles.formItemControl}>
                          <Switch checked={form.time_dimension.required} onLabel={mt.requiredText} offLabel={mt.optionalText} onChange={(e) => { form.time_dimension.required = e.currentTarget.checked; bump() }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.timeDimension.grain}</div>
                        <div className={styles.formItemControl}>
                          <Select value={form.time_dimension.extract_type} data={[{ value: 'day', label: mt.timeDimension.grainDay }, { value: 'month', label: mt.timeDimension.grainMonth }, { value: 'year', label: mt.timeDimension.grainYear }]} onChange={(val) => { form.time_dimension.extract_type = val || 'day'; bump() }} />
                        </div>
                      </div>
                      <div className={styles.formItem}>
                        <div className={styles.formItemLabel} style={{ width: 90 }}>{mt.timeDimension.outputFormat}</div>
                        <div className={styles.formItemControl}>
                          <TextInput value={form.time_dimension.output_format} placeholder="YYYY-MM-DD" onChange={(e) => { form.time_dimension.output_format = e.currentTarget.value; bump() }} />
                        </div>
                      </div>
                      <Button variant="subtle" color="red" onClick={disableTimeDimension}>{mt.timeDimension.remove}</Button>
                    </>
                  )}
                </div>

                {/* Step 5: Projections and grouping */}
                <div style={{ display: wizardStep === 5 ? undefined : 'none' }}>
                  <div className={styles.sectionIntro}>
                    <p className={styles.wizardHint}>{mt.projections.hintPrimary}</p>
                    <p className={styles.wizardHint}>{mt.projections.hintSecondary}</p>
                  </div>
                  <div className={styles.projectionBuilder}>
                    <Select style={{ minWidth: 140, flex: '1 1 140px' }} value={projectionBuilder.table || null} searchable placeholder={mt.projections.selectTable} data={configuredTableSelectData} onChange={(val) => { projectionBuilder.table = val || ''; projectionBuilder.column = ''; if (val) loadColumnsForTable(val); bump() }} />
                    <span className={styles.predicateDot}>.</span>
                    <Select style={{ minWidth: 140, flex: '1 1 140px' }} value={projectionBuilder.column || null} searchable disabled={!projectionBuilder.table} placeholder={mt.projections.selectColumn} data={columnSelectData(projectionBuilder.table)} onDropdownOpen={() => { if (projectionBuilder.table) loadColumnsForTable(projectionBuilder.table) }} onChange={(val) => { projectionBuilder.column = val || ''; bump() }} />
                    <Select style={{ width: 120, flexShrink: 0 }} value={projectionBuilder.aggregate} data={projectionAggregateOptions} onChange={(val) => { projectionBuilder.aggregate = val || 'raw'; bump() }} />
                    {projectionBuilder.aggregate === 'round' && (
                      <NumberInput style={{ width: 96, flexShrink: 0 }} value={projectionBuilder.precision} min={0} max={8} onChange={(val) => { projectionBuilder.precision = Number(val) || 0; bump() }} />
                    )}
                    <TextInput style={{ minWidth: 140, flex: '1 1 140px' }} value={projectionBuilder.alias} placeholder={mt.projections.aliasPlaceholder} onChange={(e) => { projectionBuilder.alias = e.currentTarget.value; bump() }} />
                    <Button onClick={addProjectionFromBuilder}>{mt.projections.addHelperProjection}</Button>
                  </div>
                  {projectionPreviewText && <div className={styles.builderPreview}>{projectionPreviewText}</div>}
                  <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
                    <TextInput style={{ flex: 1 }} value={projectionInput} placeholder={mt.projections.advancedExpressionPlaceholder} onChange={(e) => setProjectionInput(e.currentTarget.value)} onKeyUp={(e) => { if (e.key === 'Enter') addProjection() }} />
                    <Button variant="default" onClick={addProjection}>{mt.projections.addAdvancedExpression}</Button>
                  </div>
                  <div className={styles.configuredSectionTitle}>{mt.projections.configured}</div>
                  {form.projections.map((p: any, i: number) => (
                    <Badge key={i} variant="light" color="grape" style={{ marginBottom: 6, marginRight: 6 }} rightSection={<IconX size={12} style={{ cursor: 'pointer' }} onClick={() => removeProjection(i)} />}>{projectionDisplayText(p)}</Badge>
                  ))}
                  {!form.projections.length && <div className={styles.emptyState}>{mt.projections.empty}</div>}
                  <div style={{ borderTop: '1px solid #ebeef5', margin: '16px 0' }} />
                  <p className={styles.wizardHint}>{mt.projections.groupByTitle}</p>
                  <FilterableMultiSelect
                    modelValue={form.group_by}
                    options={configuredColumnOptions.map((o: any) => o.value)}
                    placeholder={mt.projections.selectGroupByField}
                    onChange={(values) => { form.group_by = values; bump() }}
                  />
                  {form.group_by_advanced.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      {form.group_by_advanced.map((item: any, idx: number) => (
                        <Badge key={`group-advanced-${idx}`} variant="light" style={{ marginBottom: 6, marginRight: 6 }} rightSection={<IconX size={12} style={{ cursor: 'pointer' }} onClick={() => removeAdvancedGroupBy(idx)} />}>{groupByDisplayText(item)}</Badge>
                      ))}
                    </div>
                  )}
                  {!form.group_by.length && !form.group_by_advanced.length && <div className={styles.emptyState}>{mt.projections.emptyGroupBy}</div>}
                </div>

                {/* Step 6: Sorting */}
                <div style={{ display: wizardStep === 6 ? undefined : 'none' }}>
                  <p className={styles.wizardHint}>{mt.sort.hint}</p>
                  <div className={styles.projectionBuilder}>
                    <Select style={{ minWidth: 140, flex: '1 1 140px' }} value={sortBuilder.field || null} searchable placeholder={mt.sort.selectField} data={sortTargetOptions} onChange={(val) => { sortBuilder.field = val || ''; bump() }} />
                    <Select style={{ width: 120, flexShrink: 0 }} value={sortBuilder.direction} data={[{ value: 'ASC', label: 'ASC' }, { value: 'DESC', label: 'DESC' }]} onChange={(val) => { sortBuilder.direction = val || 'ASC'; bump() }} />
                    <Button onClick={addOrderByRule}>{mt.sort.addRule}</Button>
                  </div>
                  {sortPreviewText && <div className={styles.builderPreview}>{sortPreviewText}</div>}
                  <div className={styles.sortRuleList}>
                    {form.sort_spec.order_by.map((rule: any, i: number) => (
                      <div key={`sort-${i}`} className={styles.sortRuleItem}>
                        <span className={styles.sortRuleText}>{sortRuleDisplayText(rule)}</span>
                        <Button variant="subtle" color="red" size="xs" onClick={() => removeOrderBy(i)}>{mt.remove}</Button>
                      </div>
                    ))}
                  </div>
                  {!form.sort_spec.order_by.length && <div className={styles.emptyState}>{mt.sort.empty}</div>}
                  <div style={{ borderTop: '1px solid #ebeef5', margin: '16px 0' }} />
                  <div className={styles.formItem}>
                    <div className={styles.formItemLabel} style={{ width: 100 }}>{mt.sort.defaultLimit}</div>
                    <div className={styles.formItemControl}>
                      <NumberInput value={form.sort_spec.limit_default} min={1} max={10000} onChange={(val) => { form.sort_spec.limit_default = Number(val) || 1; bump() }} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Right-side preview */}
              <div className={styles.wizardPreview}>
                <ScrollArea className={styles.previewScrollbar}>
                  <div className={styles.previewPanel} style={{ position: 'relative' }}>
                    <LoadingOverlay visible={previewLoading} />
                    <div className={styles.previewTitle}>{mt.preview.title}</div>

                    {!previewGenerated ? (
                      <div className={styles.previewBlock}><Alert color="blue" title={mt.preview.notGenerated} /></div>
                    ) : definitionPreviewStale ? (
                      <div className={styles.previewBlock}><Alert color="yellow" title={mt.preview.definitionExpired} /></div>
                    ) : demoPreviewStale ? (
                      <div className={styles.previewBlock}><Alert color="yellow" title={mt.preview.demoExpired} /></div>
                    ) : null}

                    <div className={styles.previewBlock}>
                      <div className={styles.previewBlockTitle}>{mt.preview.summaryTitle}</div>
                      <div className={styles.previewSummaryGrid}>
                        <div className={styles.summaryItem}><span>{mt.preview.summary.table}</span><strong>{previewSummary.table_count}</strong></div>
                        <div className={styles.summaryItem}><span>JOIN</span><strong>{previewSummary.join_count}</strong></div>
                        <div className={styles.summaryItem}><span>{mt.preview.summary.fixedPredicates}</span><strong>{previewSummary.fixed_predicate_count}</strong></div>
                        <div className={styles.summaryItem}><span>{mt.preview.summary.queryDimensions}</span><strong>{previewSummary.query_dimension_count}</strong></div>
                        <div className={styles.summaryItem}><span>{mt.preview.summary.timeDimension}</span><strong>{previewSummary.has_time_dimension ? mt.preview.summary.yes : mt.preview.summary.no}</strong></div>
                        <div className={styles.summaryItem}><span>{mt.preview.summary.projections}</span><strong>{previewSummary.projection_count}</strong></div>
                        <div className={styles.summaryItem}><span>GROUP BY</span><strong>{previewSummary.group_by_count}</strong></div>
                        <div className={styles.summaryItem}><span>{mt.preview.summary.sortRules}</span><strong>{previewSummary.sort_count}</strong></div>
                      </div>
                    </div>

                    <div className={styles.previewBlock}>
                      <div className={styles.previewBlockTitle}>{mt.preview.completenessTitle}</div>
                      {localValidation.status === 'success' ? (
                        <Alert color="green" title={mt.preview.completenessSuccess} />
                      ) : (
                        <Alert color="yellow" title={mt.preview.completenessWarning} />
                      )}
                      {localValidation.issues.length > 0 && (
                        <ul className={`${styles.previewMessages} ${styles.warning}`}>
                          {localValidation.issues.map((msg: string, idx: number) => <li key={`local-${idx}`}>{msg}</li>)}
                        </ul>
                      )}
                    </div>

                    <div className={styles.previewBlock}>
                      <div className={styles.previewBlockTitle}>{mt.preview.validationTitle}</div>
                      {!previewGenerated ? (
                        <Alert color="blue" title={mt.preview.validationNotGenerated} />
                      ) : (definitionPreviewStale || demoPreviewStale) ? (
                        <Alert color="yellow" title={mt.preview.validationOutdated} />
                      ) : previewValidation.status === 'success' ? (
                        <Alert color="green" title={mt.preview.validationSuccess} />
                      ) : previewValidation.status === 'warning' ? (
                        <Alert color="yellow" title={mt.preview.validationWarning} />
                      ) : previewValidation.status === 'error' ? (
                        <Alert color="red" title={mt.preview.validationError} />
                      ) : null}
                      {previewGenerated && previewValidation.errors.length > 0 && (
                        <ul className={`${styles.previewMessages} ${styles.error}`}>
                          {previewValidation.errors.map((msg: string, idx: number) => <li key={`e-${idx}`}>{msg}</li>)}
                        </ul>
                      )}
                      {previewGenerated && previewValidation.warnings.length > 0 && (
                        <ul className={`${styles.previewMessages} ${styles.warning}`}>
                          {previewValidation.warnings.map((msg: string, idx: number) => <li key={`w-${idx}`}>{msg}</li>)}
                        </ul>
                      )}
                    </div>

                    <div className={styles.previewBlock}>
                      <div className={styles.previewBlockTitle}>{mt.preview.templateSql}</div>
                      <pre className={styles.previewSql}>{previewTemplateSqlText}</pre>
                    </div>

                    <div className={styles.previewBlock}>
                      <div className={styles.previewBlockHeader}>
                        <div className={styles.previewBlockTitle} style={{ marginBottom: 0 }}>{mt.preview.demoTitle}</div>
                        <Button variant="subtle" size="xs" disabled={!hasDemoFields} onClick={resetDemoInputs}>{mt.preview.restoreDefaults}</Button>
                      </div>
                      {hasDemoFields ? (
                        <div className={styles.demoForm}>
                          {demoDimensionSpecs.map((field: any) => (
                            <div key={field.key} className={styles.demoFormItem}>
                              <div className={styles.demoFormHead}>
                                <div className={styles.demoFormLabel}>
                                  <span>{field.label}</span>
                                  <Badge size="sm" variant="outline">{field.param_type}</Badge>
                                  <Badge size="sm" variant="outline" color={field.required ? 'red' : 'gray'}>{field.required ? mt.requiredText : mt.optionalText}</Badge>
                                </div>
                                <div className={styles.demoFormMeta}>{field.column_label} · {field.op}</div>
                              </div>
                              {field.isRange ? (
                                <div className={styles.demoRangeInputs}>
                                  <TextInput value={getDemoDimensionRangeValue(field.key, 'start')} placeholder={mt.preview.rangeStartPlaceholder} onChange={(e) => updateDemoDimensionRangeValue(field.key, 'start', e.currentTarget.value)} />
                                  <TextInput value={getDemoDimensionRangeValue(field.key, 'end')} placeholder={mt.preview.rangeEndPlaceholder} onChange={(e) => updateDemoDimensionRangeValue(field.key, 'end', e.currentTarget.value)} />
                                </div>
                              ) : field.isMulti && field.allowed_values.length ? (
                                <FilterableMultiSelect modelValue={getDemoDimensionValue(field.key, [])} options={field.allowed_values} placeholder={mt.preview.searchPlaceholder} onVisibleChange={handlePreviewInteractionVisibility} onChange={(value) => updateDemoDimensionValue(field.key, value)} />
                              ) : field.allowed_values.length ? (
                                <Select
                                  value={getDemoDimensionValue(field.key, '') || null}
                                  searchable
                                  clearable
                                  placeholder={mt.preview.searchPlaceholder}
                                  data={getFilteredDemoOptions(field).map((option: string) => ({ value: option, label: option }))}
                                  onSearchChange={(query) => updateDemoOptionQuery(field.key, query)}
                                  onDropdownClose={() => handleDemoOptionDropdown(field.key, false)}
                                  onChange={(value) => updateDemoDimensionValue(field.key, value || '')}
                                />
                              ) : (
                                <TextInput value={getDemoDimensionValue(field.key, '')} placeholder={field.isMulti ? mt.preview.multiValuePlaceholder : mt.preview.singleValuePlaceholder} onChange={(e) => updateDemoDimensionValue(field.key, e.currentTarget.value)} />
                              )}
                              {field.allowed_values.length > 8 && <div className={styles.demoFormMeta}>{mt.preview.allowedValuesHint.replace('{count}', String(field.allowed_values.length))}</div>}
                            </div>
                          ))}
                          {form.time_dimension && (
                            <div className={styles.demoFormItem}>
                              <div className={styles.demoFormHead}>
                                <div className={styles.demoFormLabel}>
                                  <span>time_range</span>
                                  <Badge size="sm" variant="outline">{form.time_dimension.extract_type}</Badge>
                                  <Badge size="sm" variant="outline" color={form.time_dimension.required ? 'red' : 'gray'}>{form.time_dimension.required ? mt.requiredText : mt.optionalText}</Badge>
                                </div>
                                <div className={styles.demoFormMeta}>{formatFieldRef(form.time_dimension.column)} · {form.time_dimension.op}</div>
                              </div>
                              <div className={styles.demoRangeInputs}>
                                <DatePickerInput value={getDemoTimeRangeValue('start') ? dayjs(getDemoTimeRangeValue('start')).toDate() : null} valueFormat="YYYY-MM-DD" placeholder={mt.preview.timeStartPlaceholder} onChange={(value: any) => updateDemoTimeRangeValue('start', value ? dayjs(value).format('YYYY-MM-DD') : '')} />
                                <DatePickerInput value={getDemoTimeRangeValue('end') ? dayjs(getDemoTimeRangeValue('end')).toDate() : null} valueFormat="YYYY-MM-DD" placeholder={mt.preview.timeEndPlaceholder} onChange={(value: any) => updateDemoTimeRangeValue('end', value ? dayjs(value).format('YYYY-MM-DD') : '')} />
                              </div>
                              <div className={styles.demoFormMeta}>{timeRangeHint}</div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className={styles.wizardHint}>{mt.preview.noDemoFields}</div>
                      )}
                      <div className={styles.previewBlockTitle} style={{ marginTop: 12 }}>{mt.preview.demoSql}</div>
                      <pre className={styles.previewSql}>{previewDemoSqlText}</pre>
                    </div>
                  </div>
                </ScrollArea>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={styles.wizardFooter} style={{ marginTop: 12 }}>
          {saveValidationMessage && <div className={styles.wizardFooterMessage}>{saveValidationMessage}</div>}
          <div className={styles.wizardFooterActions}>
            {!fromCandidateMode && <Button variant="default" loading={previewLoading} disabled={saving} onClick={handleValidate}>{mt.validate}</Button>}
            <Button variant="default" disabled={saving} onClick={openJsonEditor}>{mt.json}</Button>
            <Button className={styles.btnStash} color="lime" loading={savingDraft} disabled={saving} onClick={handleSaveDraft}>{mt.saveDraft}</Button>
            {!fromCandidateMode && <Button loading={saving} disabled={previewLoading || savingDraft} onClick={handleSave}>{mt.save}</Button>}
            <Button variant="default" onClick={() => setWizardVisible(false)}>{mt.cancel}</Button>
          </div>
        </div>
      </Modal>

      {/* JSON editor modal */}
      <Modal opened={jsonDialogVisible} onClose={() => setJsonDialogVisible(false)} title={mt.jsonDialogTitle} size={820}>
        <div className={styles.jsonEditorHint}>{jsonEditorHint}</div>
        <Textarea value={jsonContent} rows={22} styles={{ input: { fontFamily: 'monospace' } }} placeholder={mt.jsonEditPlaceholder} onChange={(e) => setJsonContent(e.currentTarget.value)} />
        {jsonError && <div className={styles.jsonEditorError}>{jsonError}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="default" onClick={() => setJsonDialogVisible(false)}>{mt.cancel}</Button>
          <Button loading={jsonSaving} onClick={saveJsonAndClose}>{mt.save}</Button>
        </div>
      </Modal>

      {/* Reference values maintenance modal */}
      <Modal opened={dimensionDbDialog.visible} onClose={() => { dimensionDbDialog.visible = false; bump() }} title={mt.queryDimensions.manageReferenceValues} size={860}>
        <div className={styles.dimensionDbDialogBody}>
          <div className={styles.dimensionDbDialogLeft}>
            <div className={styles.dimensionDbDialogLeftHeader}>
              <span style={{ fontWeight: 600 }}>{mt.queryDimensions.dbColumnValues}（{dimensionDbDialog.dim?._col || ''}）</span>
              <Button size="xs" disabled={!dimensionDbDialog.selected.length} leftSection={<IconPlus size={14} />} onClick={importSelectedToRight}>{mt.queryDimensions.importSelected}</Button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <TextInput style={{ flex: 1 }} value={dimensionDbDialog.search} placeholder={mt.queryDimensions.searchPlaceholder} size="xs" onChange={(e) => { dimensionDbDialog.search = e.currentTarget.value; bump() }} onKeyUp={(e) => { if (e.key === 'Enter' && !dimensionDbDialog.loading) fetchDimensionDbPage(1) }} />
              <Button size="xs" variant="default" loading={dimensionDbDialog.loading} onClick={() => fetchDimensionDbPage(1)}>{mt.queryDimensions.searchBtn}</Button>
            </div>
            <div className={styles.dimensionDbDialogList}>
              <Checkbox
                size="xs"
                style={{ marginBottom: 6, borderBottom: '1px solid #eee', paddingBottom: 6 }}
                label={mt.queryDimensions.selectAll}
                checked={dimensionDbDialog.values.length > 0 && dimensionDbDialog.selected.length === dimensionDbDialog.values.length}
                indeterminate={dimensionDbDialog.selected.length > 0 && dimensionDbDialog.selected.length < dimensionDbDialog.values.length}
                disabled={!dimensionDbDialog.values.length}
                onChange={(e) => toggleSelectAllPage(e.currentTarget.checked)}
              />
              <Checkbox.Group value={dimensionDbDialog.selected} onChange={(vals) => { dimensionDbDialog.selected = vals; bump() }}>
                <div className={styles.dimensionDbDialogCheckboxCol}>
                  {dimensionDbDialog.values.map((item: any) => (
                    <Checkbox key={item} value={item} label={item} size="xs" />
                  ))}
                </div>
              </Checkbox.Group>
              {!dimensionDbDialog.loading && !dimensionDbDialog.values.length && <div className={styles.emptyState}>{mt.queryDimensions.loadFromDbEmpty}</div>}
            </div>
            {dimensionDbDialog.totalCount > dimensionDbDialog.pageSize && (
              <Pagination
                size="sm"
                style={{ marginTop: 8 }}
                total={Math.max(1, Math.ceil(dimensionDbDialog.totalCount / dimensionDbDialog.pageSize))}
                value={dimensionDbDialog.page}
                onChange={(page) => fetchDimensionDbPage(page)}
              />
            )}
          </div>
          <div className={styles.dimensionDbDialogRight}>
            <div className={styles.dimensionDbDialogRightHeader}>
              <span style={{ fontWeight: 600 }}>{mt.queryDimensions.currentRefValues} ({dimensionDbDialog.currentValues.length})</span>
              {dimensionDbDialog.currentValues.length > 0 && <Button variant="subtle" color="red" size="xs" onClick={() => { dimensionDbDialog.currentValues = []; bump() }}>{mt.queryDimensions.clearAll}</Button>}
            </div>
            <div className={styles.dimensionDbDialogList}>
              {dimensionDbDialog.currentValues.map((val: any) => (
                <Badge key={val} size="sm" variant="light" style={{ margin: '3px 6px 3px 0' }} rightSection={<IconX size={12} style={{ cursor: 'pointer' }} onClick={() => removeDimensionDbDialogValue(val)} />}>{val}</Badge>
              ))}
              {!dimensionDbDialog.currentValues.length && <div className={styles.emptyState}>{mt.queryDimensions.noRefValues}</div>}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <Button variant="default" onClick={() => { dimensionDbDialog.visible = false; bump() }}>{mt.close}</Button>
          <Button onClick={confirmDimensionDbDialog}>{mt.queryDimensions.save}</Button>
        </div>
      </Modal>

      {/* Smart recommendation drawer */}
      <MetricViewRecommendationDrawer
        modelValue={recommendationDrawerVisible}
        projectId={projectId}
        businessId={businessId}
        dataSources={dataSources}
        externallyAppliedCandidateId={externallyAppliedCandidateId}
        onUpdateModelValue={(v) => setRecommendationDrawerVisible(v)}
        onEditCandidate={handleEditCandidate}
        onApplied={handleRecommendationApplied}
      />
    </div>
  )
}
