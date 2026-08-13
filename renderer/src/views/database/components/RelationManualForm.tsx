import { useState } from 'react'
import { Grid, Input, Select, TextInput } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import styles from './RelationManualForm.module.scss'

// Match original defineProps: relationForm is a two-way-bound object held by the parent
interface RelationFormModel {
  source_table_id?: any
  source_column?: any
  target_table_id?: any
  target_column?: any
  relationship_type?: any
  description?: any
  [key: string]: any
}

interface TableItem {
  id: any
  table_name: string
  [key: string]: any
}

interface ColumnItem {
  column_name: string
  data_type: string
  [key: string]: any
}

interface RelationManualFormProps {
  relationForm: RelationFormModel
  tables?: TableItem[]
  sourceColumns?: ColumnItem[]
  targetColumns?: ColumnItem[]
  // defineEmits(['source-table-change', 'target-table-change'])
  onSourceTableChange?: (value: any) => void
  onTargetTableChange?: (value: any) => void
}

export default function RelationManualForm({
  relationForm,
  tables = [],
  sourceColumns = [],
  targetColumns = [],
  onSourceTableChange,
  onTargetTableChange
}: RelationManualFormProps) {
  const { t } = useTranslation()

  // relationForm is owned by the parent (original v-model directly mutates parent object); update in place to trigger local re-render
  const [, forceUpdate] = useState(0)
  const setField = (key: string, value: any) => {
    relationForm[key] = value
    forceUpdate((n) => n + 1)
  }

  // Mantine Select value needs strings, so normalize numeric IDs from the original value
  const toStr = (v: any) => (v === undefined || v === null ? null : String(v))

  // Table dropdown options: value uses id, label uses table_name
  const tableOptions = tables.map((tb) => ({ value: String(tb.id), label: tb.table_name }))

  // Column dropdown options: label = `${column_name} (${data_type})`, value = column_name
  const sourceColumnOptions = sourceColumns.map((c) => ({
    value: c.column_name,
    label: `${c.column_name} (${c.data_type})`
  }))
  const targetColumnOptions = targetColumns.map((c) => ({
    value: c.column_name,
    label: `${c.column_name} (${c.data_type})`
  }))

  // Recover original id type (number/string) from id string
  const findTableId = (value: string | null) => {
    if (value === null) return null
    const match = tables.find((tb) => String(tb.id) === value)
    return match ? match.id : value
  }

  return (
    <div className={styles.relationManualForm}>
      <Grid gutter={16}>
        <Grid.Col span={6}>
          {/* el-form-item label-position=top + required */}
          <Input.Wrapper
            label={t('database.relation.sourceTable')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.source_table_id)}
              placeholder={t('database.relation.selectSourceTable') as string}
              searchable
              data={tableOptions}
              onChange={(val) => {
                const realId = findTableId(val)
                setField('source_table_id', realId)
                onSourceTableChange?.(realId)
              }}
            />
          </Input.Wrapper>
        </Grid.Col>
        <Grid.Col span={6}>
          <Input.Wrapper
            label={t('database.relation.sourceColumn')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.source_column)}
              placeholder={t('database.relation.selectColumn') as string}
              searchable
              data={sourceColumnOptions}
              onChange={(val) => setField('source_column', val)}
            />
          </Input.Wrapper>
        </Grid.Col>
      </Grid>
      <Grid gutter={16}>
        <Grid.Col span={6}>
          <Input.Wrapper
            label={t('database.relation.targetTable')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.target_table_id)}
              placeholder={t('database.relation.selectTargetTable') as string}
              searchable
              data={tableOptions}
              onChange={(val) => {
                const realId = findTableId(val)
                setField('target_table_id', realId)
                onTargetTableChange?.(realId)
              }}
            />
          </Input.Wrapper>
        </Grid.Col>
        <Grid.Col span={6}>
          <Input.Wrapper
            label={t('database.relation.targetColumn')}
            required
            className={styles.formItem}
          >
            <Select
              value={toStr(relationForm.target_column)}
              placeholder={t('database.relation.selectColumn') as string}
              searchable
              data={targetColumnOptions}
              onChange={(val) => setField('target_column', val)}
            />
          </Input.Wrapper>
        </Grid.Col>
      </Grid>
      <Input.Wrapper label={t('database.relation.type')} className={styles.formItem}>
        <Select
          value={toStr(relationForm.relationship_type)}
          data={[
            { value: 'many_to_one', label: t('database.relation.manyToOne') },
            { value: 'one_to_one', label: t('database.relation.oneToOne') },
            { value: 'many_to_many', label: t('database.relation.manyToMany') }
          ]}
          onChange={(val) => setField('relationship_type', val)}
        />
      </Input.Wrapper>
      <Input.Wrapper label={t('database.relation.description')} className={styles.formItem}>
        <TextInput
          value={relationForm.description ?? ''}
          placeholder={t('database.relation.descriptionPlaceholder') as string}
          onChange={(e) => setField('description', e.currentTarget.value)}
        />
      </Input.Wrapper>
    </div>
  )
}
