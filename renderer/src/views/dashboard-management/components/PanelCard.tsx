import { useMemo, useState, useEffect } from 'react'
import { ActionIcon, Box, LoadingOverlay, Menu, Pagination, Table, Tooltip } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { marked } from 'marked'
import ReactECharts from 'echarts-for-react'
import ElSvgIcon from '@/components/ElSvgIcon'
import { isChartDisplayType, buildChartOption } from '@/utils/chartRegistry'
import styles from './PanelCard.module.scss'

// Markdown config (module-level, initialized once)
marked.setOptions({ breaks: true, gfm: true, smartLists: true, smartypants: true } as any)

const renderMarkdown = (content: string) => {
  if (!content) return ''
  try {
    return marked(content) as string
  } catch (error) {
    console.error('Markdown 渲染失败:', error)
    return content.replace(/\n/g, '<br>')
  }
}

export interface PanelCardProps {
  panel?: any
  isEditing?: boolean
  loading?: boolean
  // Content area height (used to calculate table height)
  contentHeight?: number
  // Whether to show the header
  showHeader?: boolean
  // defineEmits(['action'])
  onAction?: (payload: { action: string; id: any }) => void
}

const pageSize = 10

export default function PanelCard({
  panel = null,
  isEditing = false,
  loading = false,
  contentHeight = 250,
  showHeader = true,
  onAction,
}: PanelCardProps) {
  const { t } = useTranslation()

  const enableRefreshPanel = !!panel?.execute

  // Delay chart rendering to ensure layout size is ready
  const [chartReady, setChartReady] = useState(false)

  useEffect(() => {
    // Delay chart rendering so the DOM has dimensions
    const timer = setTimeout(() => {
      setChartReady(true)
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // Pagination
  const [currentPage, setCurrentPage] = useState(1)

  // Extract table data
  const tableData = useMemo<any[]>(() => {
    if (!panel?.content || panel?.content_type !== 'json') {
      return []
    }

    try {
      let parsed = panel.content
      if (typeof parsed === 'string') {
        parsed = JSON.parse(parsed)
      }

      // Extract from data field
      if (parsed.data && Array.isArray(parsed.data)) {
        return parsed.data
      }
      // Array format
      if (Array.isArray(parsed)) {
        return parsed
      }
    } catch (e) {
      console.error('解析JSON内容失败:', e)
    }

    return []
  }, [panel])

  // Extract table fields
  const tableFields = useMemo<any[]>(() => {
    // Prefer fields from display_config
    if (panel?.display_config?.fields) {
      return panel.display_config.fields
    }

    // Extract fields from content
    if (panel?.content && panel?.content_type === 'json') {
      try {
        let parsed = panel.content
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed)
        }

        // Extract from fields field
        if (parsed.fields && Array.isArray(parsed.fields)) {
          return parsed.fields
        }

        // Derive from first row of data
        const data = parsed.data || (Array.isArray(parsed) ? parsed : null)
        if (data && data.length > 0) {
          return Object.keys(data[0]).map((key) => ({
            expression: key,
            alias: key,
          }))
        }
      } catch (e) {
        console.error('解析JSON内容失败:', e)
      }
    }

    return []
  }, [panel])

  const paginatedData = useMemo<any[]>(() => {
    const data = tableData
    if (!data || data.length === 0) return []
    const start = (currentPage - 1) * pageSize
    return data.slice(start, start + pageSize)
  }, [tableData, currentPage])

  // Extract panel content
  const panelContent = useMemo<string>(() => {
    if (!panel?.content) return ''

    // Format JSON content as text when display type is text
    if (panel.content_type === 'json' && panel.display_type === 'text') {
      try {
        let parsed = panel.content
        // content may already be object or string
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed)
        }
        return JSON.stringify(parsed, null, 2)
      } catch (e) {
        return panel.content
      }
    }

    return panel.content
  }, [panel])

  // Determine markdown content type
  const isMarkdownContent = panel?.content_type === 'markdown'

  // Chart configuration is delegated to chartRegistry
  const chartOptionData = useMemo<any>(() => {
    const displayType = panel?.display_type
    if (!isChartDisplayType(displayType)) return null

    const displayConfig = panel?.display_config || {}
    const xAxisField = displayConfig.x_axis_field
    const yAxisFields = displayConfig.y_axis_fields || []

    if (panel?.content && panel?.content_type === 'json') {
      try {
        let parsed = panel.content
        if (typeof parsed === 'string') parsed = JSON.parse(parsed)

        if (parsed.data && Array.isArray(parsed.data) && parsed.data.length > 0) {
          let effectiveX = xAxisField || parsed.x_axis_field
          let effectiveY = yAxisFields.length > 0 ? yAxisFields : parsed.y_axis_fields || []
          const groupField = displayConfig.group_field || parsed.group_field || null
          if (!effectiveY.length) {
            const row = parsed.data[0]
            effectiveY = Object.keys(row).filter((k) => k !== effectiveX && typeof row[k] === 'number')
          }

          let chartInput: any = {
            data: parsed.data,
            x_axis_field: effectiveX,
            y_axis_fields: effectiveY,
            group_field: groupField,
          }

          // No valid x-axis available, auto-pivot data
          const needsPivot = !effectiveX || !parsed.data[0]?.[effectiveX]
          if (needsPivot && effectiveY.length > 0) {
            const pivoted: any[] = []
            for (const row of parsed.data) {
              for (const yf of effectiveY) {
                if (row[yf] != null) pivoted.push({ _category: yf, _value: row[yf] })
              }
            }
            if (pivoted.length > 0) {
              chartInput = {
                data: pivoted,
                x_axis_field: '_category',
                y_axis_fields: ['_value'],
                group_field: null,
              }
            }
          }

          if (chartInput.x_axis_field && chartInput.y_axis_fields.length > 0) {
            return buildChartOption(displayType, chartInput, panel?.id)
          }
        }
      } catch (e) {
        console.error('解析图表配置失败:', e)
      }
    }

    return null
  }, [panel])

  // Handle action commands
  const handleAction = (command: string) => {
    onAction?.({ action: command, id: panel?.id })
  }

  const renderContent = () => {
    // Table type
    if (panel?.display_type === 'table') {
      return (
        <div className={styles.tableContent}>
          <div className={styles.tableScroll} style={{ maxHeight: contentHeight }}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  {tableFields.map((field: any) => (
                    <Table.Th
                      key={field.expression}
                      style={{ minWidth: field.width || 100 }}
                    >
                      {field.alias}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {paginatedData.map((row: any, ri: number) => (
                  <Table.Tr key={ri}>
                    {tableFields.map((field: any) => (
                      <Table.Td key={field.expression}>
                        <Tooltip
                          label={String(row[field.expression] ?? '')}
                          multiline
                          withinPortal
                          openDelay={300}
                        >
                          <span
                            style={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {String(row[field.expression] ?? '')}
                          </span>
                        </Tooltip>
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          {tableData && tableData.length > pageSize && (
            <div className={styles.tablePagination}>
              <Pagination
                value={currentPage}
                onChange={setCurrentPage}
                total={Math.ceil(tableData.length / pageSize)}
                size="sm"
              />
            </div>
          )}
        </div>
      )
    }

    // Chart type
    if (isChartDisplayType(panel?.display_type)) {
      return (
        <div className={styles.chartContent}>
          {chartReady && chartOptionData && (
            <ReactECharts
              option={chartOptionData}
              notMerge
              lazyUpdate
              style={{ width: '100%', height: '100%' }}
              opts={{ renderer: 'canvas' }}
            />
          )}
        </div>
      )
    }

    // Text type
    if (panel?.display_type === 'text') {
      return (
        <div className={styles.textContent}>
          {/* Markdown rendering */}
          {isMarkdownContent ? (
            <div
              className={styles.markdownContent}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(panelContent) }}
            />
          ) : (
            // Plain text
            <div className={styles.plainTextContent}>{panelContent}</div>
          )}
        </div>
      )
    }

    // HTML type
    if (panel?.display_type === 'html') {
      return (
        <div
          className={styles.htmlContent}
          dangerouslySetInnerHTML={{ __html: panelContent }}
        />
      )
    }

    // No data
    return (
      <div className={styles.noData}>
        <ElSvgIcon name="Warning" size={32} color="#c0c4cc" />
        <p>{t('dashboardMgmt.noData')}</p>
      </div>
    )
  }

  return (
    <div className={styles.panelCard}>
      {/* Panel header */}
      {showHeader && (
        <div className={styles.panelHeader}>
          <div className={styles.panelTitle}>
            {isEditing && (
              <span className={styles.dragHandle}>
                <ElSvgIcon name="Rank" size={16} />
              </span>
            )}
            <span className={styles.titleText}>
              {panel?.title || t('dashboardMgmt.unnamedPanel')}
            </span>
          </div>
          <div className={styles.panelActions}>
            <Menu trigger="click" position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" size="sm">
                  <ElSvgIcon name="MoreFilled" size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  disabled={!enableRefreshPanel}
                  leftSection={<ElSvgIcon name="Refresh" size={14} />}
                  onClick={() => handleAction('refresh')}
                >
                  {t('dashboardMgmt.refresh')}
                </Menu.Item>
                <Menu.Item
                  leftSection={<ElSvgIcon name="Edit" size={14} />}
                  onClick={() => handleAction('edit')}
                >
                  {t('common.edit')}
                </Menu.Item>
                <Menu.Item
                  leftSection={<ElSvgIcon name="Download" size={14} />}
                  onClick={() => handleAction('export')}
                >
                  {t('dashboardMgmt.exportData')}
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  leftSection={<ElSvgIcon name="Delete" size={14} />}
                  onClick={() => handleAction('delete')}
                >
                  {t('common.delete')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        </div>
      )}

      {/* Panel content */}
      <Box className={styles.panelContent} pos="relative">
        <LoadingOverlay visible={loading} zIndex={5} />
        {renderContent()}
      </Box>
    </div>
  )
}
