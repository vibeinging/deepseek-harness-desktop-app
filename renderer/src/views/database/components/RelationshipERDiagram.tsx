// Migrated from views/database/components/RelationshipERDiagram.vue
// Vue Flow ER diagram → @xyflow/react, dagre layout; nodes are tables and edges are foreign-key relationships
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  MarkerType,
  useReactFlow,
  type NodeTypes,
} from '@xyflow/react'
import dagre from 'dagre'
import {
  Modal,
  Drawer,
  Button,
  TextInput,
  Textarea,
  Select,
  Checkbox,
  Tooltip,
  Accordion,
  LoadingOverlay,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import {
  IconPlus,
  IconWand,
  IconTable,
  IconEdit,
  IconTrash,
  IconChevronLeft,
  IconChevronRight,
  IconChevronDown,
  IconChevronUp,
  IconRefresh,
  IconPencil,
  IconSearch,
  IconSettings,
} from '@tabler/icons-react'
import {
  getRelationshipsReq,
  createRelationshipReq,
  updateRelationshipReq,
  deleteRelationshipReq,
  discoverRelationshipsReq,
  batchCreateRelationshipsReq,
  aiSuggestRelationshipsReq,
  getTableColumnsReq,
  getCachedTablesReq,
} from '@/api/database'
import { useProjectStore } from '@/store/project'
import RelationManualForm from './RelationManualForm'
import styles from './RelationshipERDiagram.module.scss'

// Current project ID (non-reactive read, equivalent to Pinia projectStore.currentProjectId)
const getCurrentProjectId = () => useProjectStore.getState().currentProject?.id || null

const COLLAPSED_LIMIT = 8

export interface RelationshipERDiagramProps {
  databaseId: string
  selectedTableId?: string
  // defineEmits(['table-click'])
  onTableClick?: (payload: any) => void
}

export interface RelationshipERDiagramHandle {
  loadRelationships: () => Promise<void>
}

// Format relationship type
const formatRelType = (type: string) => {
  const map: Record<string, string> = {
    many_to_one: 'N:1',
    one_to_one: '1:1',
    many_to_many: 'N:N',
    one_to_many: '1:N',
  }
  return map[type] || type
}

const scoreClass = (score: number) => {
  if (score >= 0.8) return styles.scoreHigh
  if (score >= 0.6) return styles.scoreMedium
  return styles.scoreLow
}

// ─────────────────────────────────────────────
// Custom table node (corresponding to VueFlow #node-table slot)
// Xyflow node components only accept data, so callbacks/state are all put in data
// ─────────────────────────────────────────────
function TableNode({ id, data }: { id: string; data: any }) {
  const {
    label,
    columns = [],
    totalColumns = 0,
    highlighted,
    searchMatch,
    selectedTableId,
    searchQuery,
    expanded,
    onToggleExpand,
  } = data

  const visibleColumns = expanded ? columns : columns.slice(0, COLLAPSED_LIMIT)

  const nodeCls = [
    styles.tableNode,
    highlighted ? styles.highlighted : '',
    selectedTableId === id ? styles.selected : '',
    searchQuery && !searchMatch ? styles.dimmed : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={nodeCls}>
      <div className={styles.tableNodeHeader}>
        <IconTable size={14} />
        <span className={styles.tableNodeTitle}>{label}</span>
        <span className={styles.tableNodeCount}>{totalColumns}</span>
      </div>
      <div className={styles.tableNodeColumns}>
        {visibleColumns.map((col: any) => {
          const colCls = [
            styles.columnRow,
            col.is_primary_key ? styles.pkColumn : '',
            col.is_foreign_key || col.is_relation_source || col.is_relation_target
              ? styles.fkColumn
              : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div key={col.column_name} className={colCls}>
              <Handle
                type="source"
                position={Position.Right}
                id={`${col.column_name}-source`}
                className={`${styles.columnHandle} ${styles.columnHandleRight}`}
              />
              <Handle
                type="target"
                position={Position.Left}
                id={`${col.column_name}-target`}
                className={`${styles.columnHandle} ${styles.columnHandleLeft}`}
              />
              <span className={styles.columnIcon}>
                {col.is_primary_key
                  ? '🔑'
                  : col.is_foreign_key || col.is_relation_source
                    ? '🔗'
                    : '·'}
              </span>
              <span className={styles.columnName}>{col.column_name}</span>
              <span className={styles.columnType}>{col.data_type}</span>
            </div>
          )
        })}
        {totalColumns > COLLAPSED_LIMIT && !expanded && (
          <div
            className={`${styles.columnRow} ${styles.toggleBtn}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand?.(id)
            }}
          >
            <span className={styles.columnIcon}>
              <IconChevronDown size={12} />
            </span>
            <span className={styles.columnName}>{data.expandLabel}</span>
          </div>
        )}
        {expanded && totalColumns > COLLAPSED_LIMIT && (
          <div
            className={`${styles.columnRow} ${styles.toggleBtn}`}
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand?.(id)
            }}
          >
            <span className={styles.columnIcon}>
              <IconChevronUp size={12} />
            </span>
            <span className={styles.columnName}>{data.collapseLabel}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// Internal implementation: depends on useReactFlow (fitView), must be inside ReactFlowProvider
const InnerERDiagram = forwardRef<RelationshipERDiagramHandle, RelationshipERDiagramProps>(
  function InnerERDiagram(props, ref) {
    const { databaseId, selectedTableId = '', onTableClick } = props
    const { t } = useTranslation()
    const { fitView } = useReactFlow()

    const canvasRef = useRef<HTMLDivElement>(null)

    const [tables, setTables] = useState<any[]>([])
    const [graphLoading, setGraphLoading] = useState(false)
    const [relationships, setRelationships] = useState<any[]>([])
    const [nodes, setNodes] = useState<any[]>([])
    const [edges, setEdges] = useState<any[]>([])
    const [listCollapsed, setListCollapsed] = useState(false)
    const [discovering, setDiscovering] = useState(false)
    const [discoverCandidates, setDiscoverCandidates] = useState<any[]>([])
    const [discoverStats, setDiscoverStats] = useState<any>(null)
    const [discoverSkipped, setDiscoverSkipped] = useState<any[]>([])
    const [saving, setSaving] = useState(false)
    const [dialogVisible, setDialogVisible] = useState(false)
    const [editingRelationship, setEditingRelationship] = useState<any>(null)

    // Connection confirmation
    const [pendingConnection, setPendingConnection] = useState<any>(null)
    const [connectDialogVisible, setConnectDialogVisible] = useState(false)

    // Management drawer
    const [manageDrawerVisible, setManageDrawerVisible] = useState(false)
    const [manageSearchQuery, setManageSearchQuery] = useState('')

    // Search state
    const [searchQuery, setSearchQuery] = useState('')

    // Add relationship dialog mode
    const [addMode, setAddMode] = useState('ai')
    const [aiHint, setAiHint] = useState('')
    const [aiLoading, setAiLoading] = useState(false)
    const [aiSuggestions, setAiSuggestions] = useState<any[]>([])
    const [aiSuggestDone, setAiSuggestDone] = useState(false)

    // Expand/collapse columns
    const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({})

    const [relationForm, setRelationForm] = useState<any>({
      source_table_id: '',
      target_table_id: '',
      source_column: '',
      target_column: '',
      relationship_type: 'many_to_one',
      description: '',
    })

    // Column cache (persisted with ref to avoid duplicate requests; state also used to trigger rendering)
    const columnsCacheRef = useRef<Record<string, any[]>>({})
    const [columnsCacheVersion, setColumnsCacheVersion] = useState(0)

    // Hold latest nodes/edges/relationships in refs for layout callbacks
    const nodesRef = useRef<any[]>([])
    const edgesRef = useRef<any[]>([])
    nodesRef.current = nodes
    edgesRef.current = edges

    // ── Derived values ──
    const filteredRelationships = useMemo(() => {
      const q = manageSearchQuery.trim().toLowerCase()
      if (!q) return relationships
      return relationships.filter(
        (rel) =>
          rel.source_table_name?.toLowerCase().includes(q) ||
          rel.target_table_name?.toLowerCase().includes(q) ||
          rel.source_column?.toLowerCase().includes(q) ||
          rel.target_column?.toLowerCase().includes(q),
      )
    }, [manageSearchQuery, relationships])

    const selectedSuggestionCount = useMemo(
      () => aiSuggestions.filter((s) => s._selected).length,
      [aiSuggestions],
    )

    const discoverSelectedCount = useMemo(
      () => discoverCandidates.filter((c) => c._selected).length,
      [discoverCandidates],
    )
    const discoverSelectAll = useMemo(
      () => discoverCandidates.length > 0 && discoverCandidates.every((c) => c._selected),
      [discoverCandidates],
    )
    const discoverSelectIndeterminate = useMemo(() => {
      const selected = discoverSelectedCount
      return selected > 0 && selected < discoverCandidates.length
    }, [discoverSelectedCount, discoverCandidates])

    const dialogTabItems = useMemo(
      () => [
        {
          key: 'ai',
          label: t('database.relation.aiAssist'),
          desc: t('database.relation.aiAssistDesc'),
          icon: IconWand,
        },
        {
          key: 'manual',
          label: t('database.relation.manualAdd'),
          desc: t('database.relation.manualAddDesc'),
          icon: IconPencil,
        },
        {
          key: 'discover',
          label: t('database.relation.autoDiscover'),
          desc: t('database.relation.autoDiscoverDesc'),
          icon: IconSearch,
        },
      ],
      [t],
    )

    // Lazy load columns for selected tables (depends on column-cache version)
    const sourceColumns = useMemo(
      () => columnsCacheRef.current[relationForm.source_table_id] || [],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [relationForm.source_table_id, columnsCacheVersion],
    )
    const targetColumns = useMemo(
      () => columnsCacheRef.current[relationForm.target_table_id] || [],
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [relationForm.target_table_id, columnsCacheVersion],
    )

    // ── Search input ──
    const handleSearchInput = (val: string) => {
      const q = val.trim().toLowerCase()
      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          data: {
            ...n.data,
            searchMatch: !q || n.data.label?.toLowerCase().includes(q),
          },
        })),
      )
    }

    // ── Node click ──
    const handleNodeClick = (_e: any, node: any) => {
      const table = tables.find((tb) => tb.id === node.id)
      if (table) {
        onTableClick?.({ ...table, columns: node.data.columns || [] })
      }
    }

    // ── Column loading ──
    const loadColumnsForTable = useCallback(
      async (tableId: string) => {
        if (!tableId || columnsCacheRef.current[tableId]) return
        try {
          const res: any = await getTableColumnsReq(getCurrentProjectId(), databaseId, tableId)
          if (res?.success) {
            columnsCacheRef.current[tableId] = res.data?.items || []
            setColumnsCacheVersion((v) => v + 1)
          }
        } catch (e) {
          console.error('加载列信息失败:', e)
        }
      },
      [databaseId],
    )

    const handleSourceTableChange = async (tableId: string) => {
      setRelationForm((prev: any) => ({ ...prev, source_table_id: tableId, source_column: '' }))
      await loadColumnsForTable(tableId)
    }

    const handleTargetTableChange = async (tableId: string) => {
      setRelationForm((prev: any) => ({ ...prev, target_table_id: tableId, target_column: '' }))
      await loadColumnsForTable(tableId)
    }

    // Load columns for all visible tables (max 10 concurrent)
    const loadAllColumns = useCallback(
      async (tableIds: string[]) => {
        const toLoad = tableIds.filter((id) => !columnsCacheRef.current[id])
        if (toLoad.length === 0) return
        const batchSize = 10
        for (let i = 0; i < toLoad.length; i += batchSize) {
          const batch = toLoad.slice(i, i + batchSize)
          await Promise.all(batch.map((id) => loadColumnsForTable(id)))
        }
      },
      [loadColumnsForTable],
    )

    // ── Read actual DOM size of nodes ──
    const getNodeDOMSizes = useCallback(() => {
      const sizes: Record<string, { width: number; height: number }> = {}
      const container = canvasRef.current
      if (!container) return sizes
      const nodeEls = container.querySelectorAll<HTMLElement>('.react-flow__node')
      nodeEls.forEach((el) => {
        const id = el.dataset?.id || el.getAttribute('data-id')
        if (id) {
          sizes[id] = { width: el.offsetWidth || 230, height: el.offsetHeight || 200 }
        }
      })
      return sizes
    }, [])

    // ── Dagre auto layout ──
    const autoLayout = useCallback(() => {
      const curNodes = nodesRef.current
      const curEdges = edgesRef.current
      if (curNodes.length === 0) return

      const domSizes = getNodeDOMSizes()
      const nodeWidth = Math.max(230, ...Object.values(domSizes).map((s) => s.width))

      // Split connected nodes and isolated nodes
      const connectedIds = new Set<string>()
      for (const edge of curEdges) {
        connectedIds.add(edge.source)
        connectedIds.add(edge.target)
      }

      const connectedNodes = curNodes.filter((n) => connectedIds.has(n.id))
      const isolatedNodes = curNodes.filter((n) => !connectedIds.has(n.id))

      const positions: Record<string, { x: number; y: number }> = {}
      let maxY = 0

      // Layout connected nodes with dagre
      if (connectedNodes.length > 0) {
        const g = new dagre.graphlib.Graph()
        g.setDefaultEdgeLabel(() => ({}))
        g.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: 200, marginx: 60, marginy: 60 })

        for (const node of connectedNodes) {
          const s = domSizes[node.id] || { width: 230, height: 200 }
          g.setNode(node.id, { width: s.width + 40, height: s.height + 40 })
        }

        for (const edge of curEdges) {
          g.setEdge(edge.source, edge.target)
        }

        dagre.layout(g)

        for (const node of connectedNodes) {
          const pos = g.node(node.id)
          const s = domSizes[node.id] || { width: 230, height: 200 }
          positions[node.id] = { x: pos.x - s.width / 2, y: pos.y - pos.height / 2 }
          const bottom = positions[node.id].y + pos.height
          if (bottom > maxY) maxY = bottom
        }
      }

      // Layout isolated nodes with an adaptive grid
      if (isolatedNodes.length > 0) {
        const startY = maxY > 0 ? maxY + 80 : 40
        const colGap = 50
        const rowGap = 40
        const cellWidth = nodeWidth + colGap

        const canvasWidth = canvasRef.current?.offsetWidth || 1200
        const cols = Math.max(Math.floor(canvasWidth / cellWidth), 2)

        const rows: any[][] = []
        for (let i = 0; i < isolatedNodes.length; i += cols) {
          rows.push(isolatedNodes.slice(i, i + cols))
        }

        let currentY = startY
        rows.forEach((row) => {
          let rowMaxH = 0
          row.forEach((node, colIdx) => {
            const s = domSizes[node.id] || { width: 230, height: 200 }
            if (s.height > rowMaxH) rowMaxH = s.height
            positions[node.id] = { x: 40 + colIdx * cellWidth, y: currentY }
          })
          currentY += rowMaxH + rowGap
        })
      }

      // Commit layout updates (write back position)
      setNodes((prev) =>
        prev.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
      )

      // Fit view after layout completes
      requestAnimationFrame(() => {
        fitView({ padding: 0.12, duration: 300 })
      })
    }, [getNodeDOMSizes, fitView])

    const handleAutoLayout = () => {
      autoLayout()
    }

    // ── Column expand/collapse ──
    const toggleExpand = useCallback(
      (nodeId: string) => {
        setExpandedNodes((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }))
        // Wait for DOM update then relayout
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            autoLayout()
          })
        })
      },
      [autoLayout],
    )

    // ── Build graph ──
    const buildGraph = useCallback(
      async (rels: any[], tableList: any[]) => {
        // Build relationship index (used to mark columns)
        const sourceColSet = new Set<string>()
        const targetColSet = new Set<string>()
        for (const rel of rels) {
          sourceColSet.add(`${rel.source_table_id}:${rel.source_column}`)
          targetColSet.add(`${rel.target_table_id}:${rel.target_column}`)
        }

        // Show all tables (ReactFlow clips by viewport)
        const tablesToShow = tableList

        // Load all columns for tables that will be shown
        await loadAllColumns(tablesToShow.map((tb) => tb.id))

        // Create nodes
        const newNodes = tablesToShow.map((tb) => {
          const allColumns = columnsCacheRef.current[tb.id] || []
          const totalColumns = allColumns.length
          const displayColumns = allColumns.map((c) => ({
            ...c,
            is_relation_source: sourceColSet.has(`${tb.id}:${c.column_name}`),
            is_relation_target: targetColSet.has(`${tb.id}:${c.column_name}`),
          }))

          return {
            id: tb.id,
            type: 'table',
            position: { x: 0, y: 0 },
            data: {
              label: tb.table_name,
              columns: displayColumns,
              totalColumns,
              highlighted: false,
              searchMatch: true,
            },
          }
        })

        // Create edges connected to specific column handles
        const newEdges = rels.map((rel) => ({
          id: rel.id,
          source: rel.source_table_id,
          target: rel.target_table_id,
          sourceHandle: `${rel.source_column}-source`,
          targetHandle: `${rel.target_column}-target`,
          label: `${rel.source_column} → ${rel.target_column}`,
          type: 'default',
          animated: false,
          style: { stroke: '#6366f1', strokeWidth: 2 },
          labelStyle: { fontSize: '11px', fill: '#606266' },
          labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1' },
          data: rel,
        }))

        nodesRef.current = newNodes
        edgesRef.current = newEdges
        setNodes(newNodes)
        setEdges(newEdges)

        // Render nodes first to generate DOM, then read actual height for layout
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            autoLayout()
          })
        })
      },
      [loadAllColumns, autoLayout],
    )

    // ── Load table list ──
    const loadTables = useCallback(async () => {
      if (!databaseId) return [] as any[]
      try {
        const res: any = await getCachedTablesReq(getCurrentProjectId(), databaseId, { limit: 1000 })
        if (res?.success) {
          const items = res.data?.items || []
          setTables(items)
          return items
        }
      } catch (e) {
        console.error('加载表列表失败:', e)
      }
      return [] as any[]
    }, [databaseId])

    // ── Load relationships ──
    const loadRelationships = useCallback(async () => {
      if (!databaseId) return
      try {
        const res: any = await getRelationshipsReq(getCurrentProjectId(), databaseId)
        if (res?.success) {
          const items = res.data?.items || []
          setRelationships(items)
          // buildGraph needs latest tables: pass tbs directly here instead of relying on async state
          await buildGraph(items, tablesRef.current)
        }
      } catch (e) {
        console.error('加载关系失败:', e)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [databaseId, buildGraph])

    // Tables ref so loadRelationships always reads latest values
    const tablesRef = useRef<any[]>([])
    tablesRef.current = tables

    // ── Watch databaseId changes (immediate) ──
    useEffect(() => {
      if (!databaseId) return
      let cancelled = false
      ;(async () => {
        setGraphLoading(true)
        try {
          const tbs = await loadTables()
          if (cancelled) return
          tablesRef.current = tbs
          // Pass tbs directly to buildGraph to avoid relying on async state
          if (!databaseId) return
          const res: any = await getRelationshipsReq(getCurrentProjectId(), databaseId)
          if (cancelled) return
          if (res?.success) {
            const items = res.data?.items || []
            setRelationships(items)
            await buildGraph(items, tbs)
          }
        } finally {
          if (!cancelled) setGraphLoading(false)
        }
      })()
      return () => {
        cancelled = true
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [databaseId])

    // ── Auto discovery ──
    const handleAutoDiscover = async () => {
      setDiscovering(true)
      setDiscoverCandidates([])
      setDiscoverStats(null)
      setDiscoverSkipped([])
      try {
        const res: any = await discoverRelationshipsReq(getCurrentProjectId(), databaseId)
        if (res?.success) {
          const data = res.data || {}
          const candidates = data.candidates || []
          setDiscoverStats(data.stats || null)
          const skipped = [...(data.skipped_existing || []), ...(data.skipped_low_score || [])]
          setDiscoverSkipped(skipped)
          // Candidates with score >= 0.6 are selected by default
          setDiscoverCandidates(
            candidates.map((c: any) => ({ ...c, _selected: (c.score || 0) >= 0.6 })),
          )
          if (candidates.length === 0 && skipped.length === 0) {
            notifications.show({ message: t('database.relation.noCandidates') })
          }
        } else {
          notifications.show({
            color: 'red',
            message: res?.msg || t('database.relation.discoverFailed'),
          })
        }
      } catch (e) {
        console.error('自动发现失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.discoverFailed') })
      } finally {
        setDiscovering(false)
      }
    }

    // Save selected auto-discovery candidates
    const handleSaveDiscoverCandidates = async () => {
      const selected = discoverCandidates.filter((c) => c._selected)
      if (selected.length === 0) return

      setSaving(true)
      try {
        const res: any = await batchCreateRelationshipsReq(
          getCurrentProjectId(),
          databaseId,
          selected.map(({ _selected, ...rest }) => rest),
        )
        if (res?.success) {
          notifications.show({
            color: 'green',
            message: t('database.relation.addedRelations', {
              count: res.data?.created || selected.length,
            }),
          })
          setDialogVisible(false)
          setDiscoverCandidates([])
          await loadRelationships()
        } else {
          notifications.show({
            color: 'red',
            message: res?.msg || t('database.relation.saveRelationFailed'),
          })
        }
      } catch (e) {
        console.error('保存失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
      } finally {
        setSaving(false)
      }
    }

    const handleDiscoverSelectAll = (val: boolean) => {
      setDiscoverCandidates((prev) => prev.map((c) => ({ ...c, _selected: val })))
    }

    // ── AI assisted suggestions ──
    const handleAISuggest = async () => {
      if (!aiHint.trim()) return
      setAiLoading(true)
      setAiSuggestDone(false)
      setAiSuggestions([])
      try {
        const res: any = await aiSuggestRelationshipsReq(
          getCurrentProjectId(),
          databaseId,
          aiHint.trim(),
        )
        if (res?.success) {
          setAiSuggestions((res.data?.suggestions || []).map((s: any) => ({ ...s, _selected: true })))
          setAiSuggestDone(true)
        } else {
          notifications.show({
            color: 'red',
            message: res?.msg || t('database.relation.aiAnalysisFailed'),
          })
        }
      } catch (e) {
        console.error('AI建议失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.aiAnalysisFailed') })
      } finally {
        setAiLoading(false)
      }
    }

    // Save selected AI suggestions
    const handleSaveSelectedSuggestions = async () => {
      const selected = aiSuggestions.filter((s) => s._selected)
      if (selected.length === 0) return

      setSaving(true)
      try {
        let count = 0
        for (const sug of selected) {
          await createRelationshipReq(getCurrentProjectId(), databaseId, {
            source_table_id: sug.source_table_id,
            target_table_id: sug.target_table_id,
            source_column: sug.source_column,
            target_column: sug.target_column,
            relationship_type: sug.relationship_type,
          })
          count++
        }
        notifications.show({
          color: 'green',
          message: t('database.relation.addedRelations', { count }),
        })
        setDialogVisible(false)
        await loadRelationships()
      } catch (e) {
        console.error('保存失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
      } finally {
        setSaving(false)
      }
    }

    // Add all
    const handleSaveAllSuggestions = () => {
      const all = aiSuggestions.map((s) => ({ ...s, _selected: true }))
      setAiSuggestions(all)
      // Save using all immediately to avoid waiting for state updates
      ;(async () => {
        if (all.length === 0) return
        setSaving(true)
        try {
          let count = 0
          for (const sug of all) {
            await createRelationshipReq(getCurrentProjectId(), databaseId, {
              source_table_id: sug.source_table_id,
              target_table_id: sug.target_table_id,
              source_column: sug.source_column,
              target_column: sug.target_column,
              relationship_type: sug.relationship_type,
            })
            count++
          }
          notifications.show({
            color: 'green',
            message: t('database.relation.addedRelations', { count }),
          })
          setDialogVisible(false)
          await loadRelationships()
        } catch (e) {
          console.error('保存失败:', e)
          notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
        } finally {
          setSaving(false)
        }
      })()
    }

    // ── Add relationship ──
    const handleAddRelationship = () => {
      setEditingRelationship(null)
      setAddMode('ai')
      setAiHint('')
      setAiSuggestions([])
      setAiSuggestDone(false)
      setDiscoverCandidates([])
      setDiscoverStats(null)
      setDiscoverSkipped([])
      setRelationForm({
        source_table_id: '',
        target_table_id: '',
        source_column: '',
        target_column: '',
        relationship_type: 'many_to_one',
        description: '',
      })
      setDialogVisible(true)
    }

    // ── Edit relationship ──
    const handleEditRelationship = async (rel: any) => {
      setEditingRelationship(rel)
      setRelationForm({
        source_table_id: rel.source_table_id,
        target_table_id: rel.target_table_id,
        source_column: rel.source_column,
        target_column: rel.target_column,
        relationship_type: rel.relationship_type,
        description: rel.description || '',
      })
      // Load columns
      await Promise.all([
        loadColumnsForTable(rel.source_table_id),
        loadColumnsForTable(rel.target_table_id),
      ])
      setDialogVisible(true)
    }

    // ── Save relationship ──
    const handleSaveRelationship = async () => {
      const form = relationForm
      if (
        !form.source_table_id ||
        !form.target_table_id ||
        !form.source_column ||
        !form.target_column
      ) {
        notifications.show({ color: 'yellow', message: t('database.relation.fillComplete') })
        return
      }

      setSaving(true)
      try {
        if (editingRelationship) {
          await updateRelationshipReq(
            getCurrentProjectId(),
            databaseId,
            editingRelationship.id,
            form,
          )
          notifications.show({ color: 'green', message: t('database.relation.updateSuccess') })
        } else {
          await createRelationshipReq(getCurrentProjectId(), databaseId, form)
          notifications.show({ color: 'green', message: t('database.relation.createSuccess') })
        }
        setDialogVisible(false)
        await loadRelationships()
      } catch (e) {
        console.error('保存关系失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.saveRelationFailed') })
      } finally {
        setSaving(false)
      }
    }

    // ── Delete relationship ──
    const handleDeleteRelationship = (rel: any) => {
      modals.openConfirmModal({
        title: t('database.relation.deleteRelation'),
        children: t('database.relation.deleteConfirm', {
          source: `${rel.source_table_name}.${rel.source_column}`,
          target: `${rel.target_table_name}.${rel.target_column}`,
        }),
        labels: { confirm: t('database.action.delete'), cancel: t('database.action.cancel') },
        confirmProps: { color: 'red' },
        onConfirm: async () => {
          try {
            await deleteRelationshipReq(getCurrentProjectId(), databaseId, rel.id)
            notifications.show({ color: 'green', message: t('database.relation.deleteSuccess') })
            await loadRelationships()
          } catch (e) {
            console.error('删除关系失败:', e)
            notifications.show({ color: 'red', message: t('database.relation.deleteFailed') })
          }
        },
      })
    }

    // ── Edge click ──
    const handleEdgeClick = (_e: any, edge: any) => {
      if (edge?.data) {
        handleEditRelationship(edge.data)
      }
    }

    // ── Handle connection creation ──
    const handleConnect = (connection: any) => {
      const sourceHandle = connection.sourceHandle || ''
      const targetHandle = connection.targetHandle || ''

      const sourceColumn = sourceHandle.replace('-source', '')
      const targetColumn = targetHandle.replace('-target', '')

      const sourceNode = nodesRef.current.find((n) => n.id === connection.source)
      const targetNode = nodesRef.current.find((n) => n.id === connection.target)

      if (!sourceNode || !targetNode) return

      setPendingConnection({
        source_table_id: connection.source,
        source_table_name: sourceNode.data.label,
        source_column: sourceColumn,
        target_table_id: connection.target,
        target_table_name: targetNode.data.label,
        target_column: targetColumn,
        relationship_type: 'many_to_one',
        description: '',
      })

      setConnectDialogVisible(true)
    }

    // Confirm creating connection relation
    const handleSaveConnection = async () => {
      if (!pendingConnection) return

      setSaving(true)
      try {
        const res: any = await createRelationshipReq(
          getCurrentProjectId(),
          databaseId,
          pendingConnection,
        )
        if (res?.success) {
          notifications.show({ color: 'green', message: t('database.relation.createSuccess') })
          setConnectDialogVisible(false)
          setPendingConnection(null)
          await loadRelationships()
        } else {
          notifications.show({
            color: 'red',
            message: res?.message || t('database.relation.createFailed'),
          })
        }
      } catch (e) {
        console.error('创建关系失败:', e)
        notifications.show({ color: 'red', message: t('database.relation.createFailed') })
      } finally {
        setSaving(false)
      }
    }

    // ── Highlight relationship ──
    const highlightRelation = (rel: any) => {
      setEdges((prev) =>
        prev.map((e) => ({
          ...e,
          animated: e.id === rel.id,
          style:
            e.id === rel.id
              ? { stroke: '#e6a23c', strokeWidth: 3 }
              : { stroke: '#6366f1', strokeWidth: 2 },
        })),
      )
      setNodes((prev) =>
        prev.map((n) => ({
          ...n,
          data: {
            ...n.data,
            highlighted: n.id === rel.source_table_id || n.id === rel.target_table_id,
          },
        })),
      )
    }

    const clearHighlight = () => {
      setEdges((prev) =>
        prev.map((e) => ({ ...e, animated: false, style: { stroke: '#6366f1', strokeWidth: 2 } })),
      )
      setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, highlighted: false } })))
    }

    // Expose to parent component
    useImperativeHandle(ref, () => ({ loadRelationships }), [loadRelationships])

    // Node types
    const nodeTypes = useMemo<NodeTypes>(() => ({ table: TableNode }), [])

    // Inject interaction callbacks/state into each node data (equivalent to Vue slot-scope variables)
    const renderNodes = useMemo(
      () =>
        nodes.map((n) => ({
          ...n,
          data: {
            ...n.data,
            selectedTableId,
            searchQuery,
            expanded: !!expandedNodes[n.id],
            onToggleExpand: toggleExpand,
            expandLabel: t('database.relation.expandRemaining', {
              count: (n.data.totalColumns || 0) - COLLAPSED_LIMIT,
            }),
            collapseLabel: t('database.relation.collapse'),
          },
        })),
      [nodes, selectedTableId, searchQuery, expandedNodes, toggleExpand, t],
    )

    const relTypeOptions = [
      { value: 'many_to_one', label: t('database.relation.manyToOne') },
      { value: 'one_to_one', label: t('database.relation.oneToOne') },
      { value: 'one_to_many', label: t('database.relation.oneToMany') },
      { value: 'many_to_many', label: t('database.relation.manyToMany') },
    ]

    return (
      <div className={styles.erDiagramContainer}>
        {/* ER diagram */}
        <div className={styles.erCanvas} ref={canvasRef}>
          <LoadingOverlay
            visible={graphLoading}
            loaderProps={{ children: t('database.relation.loadingStructure') }}
          />
          {/* Search box */}
          <div className={styles.canvasSearch}>
            <TextInput
              value={searchQuery}
              placeholder={t('database.relation.searchTable')}
              leftSection={<IconSearch size={14} />}
              size="xs"
              onChange={(e) => {
                const v = e.currentTarget.value
                setSearchQuery(v)
                handleSearchInput(v)
              }}
            />
          </div>
          {/* Bottom-left toolbar */}
          <div className={styles.canvasBottomActions}>
            <Tooltip label={t('database.relation.autoLayout')} position="top">
              <div className={styles.floatBtn} onClick={handleAutoLayout}>
                <IconRefresh size={18} />
              </div>
            </Tooltip>
          </div>
          <ReactFlow
            nodes={renderNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            defaultViewport={{ zoom: 0.8, x: 50, y: 50 }}
            minZoom={0.2}
            maxZoom={2}
            onlyRenderVisibleElements
            connectOnClick={false}
            onEdgeClick={handleEdgeClick}
            onConnect={handleConnect}
            onNodeClick={handleNodeClick}
          >
            <Background />
          </ReactFlow>
        </div>

        {/* Relations panel (collapsible) */}
        <div className={`${styles.relPanel} ${listCollapsed ? styles.collapsed : ''}`}>
          {listCollapsed ? (
            // Collapsed state: vertical tab labels
            <div className={styles.relPanelCollapsed} onClick={() => setListCollapsed(false)}>
              <div className={styles.collapsedIndicator}>
                <IconChevronLeft size={14} />
              </div>
              <span className={styles.collapsedLabel}>{t('database.relation.relations')}</span>
              <span className={styles.collapsedCount}>{relationships.length}</span>
            </div>
          ) : (
            // Expanded state
            <>
              <div className={styles.relPanelHeader}>
                <div className={styles.headerLeft}>
                  <span className={styles.headerTitle}>{t('database.relation.relations')}</span>
                  <span className={styles.headerBadge}>{relationships.length}</span>
                </div>
                <div className={styles.headerActions}>
                  <div
                    className={styles.actionBtn}
                    onClick={() => setManageDrawerVisible(true)}
                    title={t('database.relation.manage')}
                  >
                    <IconSettings size={14} />
                  </div>
                  <div
                    className={`${styles.actionBtn} ${styles.addBtn}`}
                    onClick={handleAddRelationship}
                  >
                    <IconPlus size={14} />
                  </div>
                  <div className={styles.actionBtn} onClick={() => setListCollapsed(true)}>
                    <IconChevronRight size={14} />
                  </div>
                </div>
              </div>

              <div className={styles.relPanelBody}>
                {relationships.length === 0 ? (
                  <div className={styles.relEmpty}>
                    <div className={styles.emptyIcon}>
                      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                        <circle
                          cx="20"
                          cy="20"
                          r="18"
                          stroke="#e0e0e6"
                          strokeWidth="2"
                          strokeDasharray="4 3"
                        />
                        <path
                          d="M14 20h12M26 20l-3-3M26 20l-3 3"
                          stroke="#c0c4cc"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    <span className={styles.emptyText}>{t('database.relation.noRelations')}</span>
                    <span className={styles.emptyHint}>{t('database.relation.clickToAdd')}</span>
                  </div>
                ) : (
                  <div className={styles.relList}>
                    {relationships.map((rel) => (
                      <div
                        key={rel.id}
                        className={styles.relCard}
                        onMouseEnter={() => highlightRelation(rel)}
                        onMouseLeave={clearHighlight}
                      >
                        <div className={styles.relCardContent}>
                          <div className={`${styles.relEndpoint} ${styles.source}`}>
                            <span className={styles.endpointTable}>{rel.source_table_name}</span>
                            <span className={styles.endpointCol}>.{rel.source_column}</span>
                          </div>
                          <div className={styles.relConnector}>
                            <span className={styles.connectorLine} />
                            <span className={styles.connectorType}>
                              {formatRelType(rel.relationship_type)}
                            </span>
                            <span className={styles.connectorLine} />
                          </div>
                          <div className={`${styles.relEndpoint} ${styles.target}`}>
                            <span className={styles.endpointTable}>{rel.target_table_name}</span>
                            <span className={styles.endpointCol}>.{rel.target_column}</span>
                          </div>
                        </div>
                        <div className={styles.relCardActions}>
                          <div
                            className={styles.cardAction}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleEditRelationship(rel)
                            }}
                          >
                            <IconEdit size={12} />
                            <span>{t('database.action.edit')}</span>
                          </div>
                          <div
                            className={`${styles.cardAction} ${styles.danger}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeleteRelationship(rel)
                            }}
                          >
                            <IconTrash size={12} />
                            <span>{t('database.action.delete')}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Add/edit relationship dialog */}
        <Modal
          opened={dialogVisible}
          onClose={() => setDialogVisible(false)}
          size="80%"
          withCloseButton={false}
          closeOnClickOutside={false}
          padding={0}
          radius={12}
          styles={{ body: { padding: 0 } }}
        >
          <div className={`${styles.rdLayout} ${editingRelationship ? styles.rdEditMode : ''}`}>
            {/* Left navigation (add mode only) */}
            {!editingRelationship && (
              <div className={styles.rdSidebar}>
                <div className={styles.rdSidebarTitle}>{t('database.relation.addRelation')}</div>
                <nav className={styles.rdNav}>
                  {dialogTabItems.map((tab) => {
                    const TabIcon = tab.icon
                    return (
                      <div
                        key={tab.key}
                        className={`${styles.rdNavItem} ${addMode === tab.key ? styles.active : ''}`}
                        onClick={() => setAddMode(tab.key)}
                      >
                        <div className={styles.navIconWrap}>
                          <TabIcon size={16} />
                        </div>
                        <div className={styles.navText}>
                          <span className={styles.navLabel}>{tab.label}</span>
                          <span className={styles.navDesc}>{tab.desc}</span>
                        </div>
                      </div>
                    )
                  })}
                </nav>
              </div>
            )}

            {/* Right content area */}
            <div className={styles.rdMain}>
              {/* Edit mode header */}
              {editingRelationship && (
                <div className={styles.rdMainHeader}>
                  <span className={styles.rdMainTitle}>{t('database.relation.editRelation')}</span>
                </div>
              )}

              <div className={styles.rdMainBody}>
                {/* Shared form for edit mode and manual add */}
                {editingRelationship || addMode === 'manual' ? (
                  <RelationManualForm
                    relationForm={relationForm}
                    tables={tables}
                    sourceColumns={sourceColumns}
                    targetColumns={targetColumns}
                    onSourceTableChange={handleSourceTableChange}
                    onTargetTableChange={handleTargetTableChange}
                  />
                ) : addMode === 'ai' ? (
                  // AI assist
                  <div className={styles.aiSection}>
                    <div className={styles.aiPromptArea}>
                      <label className={styles.fieldLabel}>
                        {t('database.relation.describeRelation')}
                      </label>
                      <div className={styles.aiInputWrap}>
                        <Textarea
                          className={styles.aiTextarea}
                          value={aiHint}
                          minRows={4}
                          autosize
                          placeholder={t('database.relation.aiPlaceholder')}
                          disabled={aiLoading}
                          onChange={(e) => setAiHint(e.currentTarget.value)}
                        />
                      </div>
                      <div className={styles.aiActionRow}>
                        <div className={styles.aiTips}>
                          <span className={styles.tipDot} />
                          {t('database.relation.aiTip')}
                        </div>
                        <Button
                          className={styles.aiRunBtn}
                          onClick={handleAISuggest}
                          loading={aiLoading}
                          disabled={!aiHint.trim()}
                          leftSection={!aiLoading ? <IconWand size={16} /> : undefined}
                        >
                          {aiLoading
                            ? t('database.relation.analyzing')
                            : t('database.relation.startAnalysis')}
                        </Button>
                      </div>
                    </div>

                    {/* AI loading */}
                    {aiLoading ? (
                      <div className={styles.aiLoading}>
                        <div className={styles.aiLoadingBar}>
                          <div className={styles.aiLoadingProgress} />
                        </div>
                        <span className={styles.aiLoadingText}>
                          {t('database.relation.analyzingStructure')}
                        </span>
                      </div>
                    ) : aiSuggestions.length > 0 ? (
                      // AI result
                      <div className={styles.aiResults}>
                        <div className={styles.resultsHeader}>
                          <div className={styles.resultsLeft}>
                            <span className={styles.resultsTitle}>
                              {t('database.relation.foundRelations', {
                                count: aiSuggestions.length,
                              })}
                            </span>
                            <span className={styles.resultsSub}>
                              {t('database.relation.allSelectedHint')}
                            </span>
                          </div>
                          <span
                            className={styles.resultsSelectAll}
                            onClick={handleSaveAllSuggestions}
                          >
                            {t('database.relation.selectAll')}
                          </span>
                        </div>
                        <div className={styles.sugGrid}>
                          {aiSuggestions.map((sug, idx) => (
                            <div
                              key={idx}
                              className={`${styles.sugItem} ${sug._selected ? styles.selected : ''}`}
                              onClick={() =>
                                setAiSuggestions((prev) =>
                                  prev.map((s, i) =>
                                    i === idx ? { ...s, _selected: !s._selected } : s,
                                  ),
                                )
                              }
                            >
                              <div className={styles.sugItemCheck}>
                                <div
                                  className={`${styles.sugCheckbox} ${sug._selected ? styles.on : ''}`}
                                >
                                  {sug._selected && (
                                    <svg width="10" height="8" viewBox="0 0 10 8">
                                      <path
                                        d="M1 4l2.8 2.8L9 1.2"
                                        stroke="#fff"
                                        strokeWidth="1.6"
                                        fill="none"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </div>
                              </div>
                              <div className={styles.sugItemBody}>
                                <div className={`${styles.sugRow} ${styles.sourceRow}`}>
                                  <span className={styles.sugLabel}>
                                    {t('database.relation.source')}
                                  </span>
                                  <span className={styles.sugTableName}>
                                    {sug.source_table_name}
                                  </span>
                                  <span className={styles.sugColName}>.{sug.source_column}</span>
                                </div>
                                <div className={styles.sugRowDivider}>
                                  <svg width="12" height="12" viewBox="0 0 12 12">
                                    <path
                                      d="M6 2v8M6 10l-2-2M6 10l2-2"
                                      stroke="#c0c4cc"
                                      strokeWidth="1.2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </div>
                                <div className={`${styles.sugRow} ${styles.targetRow}`}>
                                  <span className={styles.sugLabel}>
                                    {t('database.relation.target')}
                                  </span>
                                  <span className={styles.sugTableName}>
                                    {sug.target_table_name}
                                  </span>
                                  <span className={styles.sugColName}>.{sug.target_column}</span>
                                </div>
                              </div>
                              <div className={styles.sugItemType}>
                                {formatRelType(sug.relationship_type)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : aiSuggestDone ? (
                      <div className={styles.aiEmptyState}>
                        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                          <circle cx="24" cy="24" r="20" stroke="#e0e0e6" strokeWidth="1.5" />
                          <path d="M18 24h12" stroke="#c0c4cc" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                        <span>{t('database.relation.noMatchRelation')}</span>
                        <span className={styles.emptySub}>
                          {t('database.relation.tryMoreSpecific')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  // Auto discovery
                  <div className={styles.discoverContent}>
                        {/* Pre-discovery guide */}
                    {!discoverStats && !discovering && (
                      <>
                        <div className={styles.discoverHero}>
                          <div className={styles.discoverIconGroup}>
                            <div className={`${styles.discoverRing} ${styles.ring1}`} />
                            <div className={`${styles.discoverRing} ${styles.ring2}`} />
                            <div className={`${styles.discoverRing} ${styles.ring3}`} />
                            <div className={styles.discoverCenterDot} />
                            <div className={`${styles.discoverNode} ${styles.n1}`} />
                            <div className={`${styles.discoverNode} ${styles.n2}`} />
                            <div className={`${styles.discoverNode} ${styles.n3}`} />
                            <div className={`${styles.discoverNode} ${styles.n4}`} />
                          </div>
                        </div>
                        <div className={styles.discoverInfo}>
                          <h4>{t('database.relation.smartDiscovery')}</h4>
                          <p>{t('database.relation.smartDiscoveryDesc')}</p>
                          <div className={styles.discoverSteps}>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>1</span>
                              <span className={styles.stepText}>{t('database.relation.step1')}</span>
                            </div>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>2</span>
                              <span className={styles.stepText}>{t('database.relation.step2')}</span>
                            </div>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>3</span>
                              <span className={styles.stepText}>{t('database.relation.step3')}</span>
                            </div>
                            <div className={styles.stepItem}>
                              <span className={styles.stepNum}>4</span>
                              <span className={styles.stepText}>{t('database.relation.step4')}</span>
                            </div>
                          </div>
                        </div>
                        <Button
                          size="lg"
                          onClick={handleAutoDiscover}
                          className={styles.discoverStartBtn}
                          leftSection={<IconSearch size={16} />}
                        >
                          {t('database.relation.startAutoDiscover')}
                        </Button>
                      </>
                    )}

                    {/* Discovering: loading */}
                    {discovering && (
                      <div className={styles.discoverLoading}>
                        <IconRefresh size={32} color="#6366f1" className={styles.spin} />
                        <p>{t('database.relation.analyzingStructure')}</p>
                        <span className={styles.discoverLoadingSub}>
                          {t('database.relation.analyzingHint')}
                        </span>
                      </div>
                    )}

                    {/* After discovery: stats + candidate list */}
                    {discoverStats && !discovering && (
                      <div className={styles.discoverCandidates}>
                        {/* Stats summary */}
                        <div className={styles.discoverStats}>
                          <div className={styles.statItem}>
                            <span className={styles.statNum}>{discoverStats.total_analyzed}</span>
                            <span className={styles.statLabel}>
                              {t('database.relation.analyzedPairs')}
                            </span>
                          </div>
                          <div className={`${styles.statItem} ${styles.statNew}`}>
                            <span className={styles.statNum}>{discoverStats.new_candidates}</span>
                            <span className={styles.statLabel}>
                              {t('database.relation.newDiscovered')}
                            </span>
                          </div>
                          {discoverStats.already_existing ? (
                            <div className={`${styles.statItem} ${styles.statExist}`}>
                              <span className={styles.statNum}>
                                {discoverStats.already_existing}
                              </span>
                              <span className={styles.statLabel}>
                                {t('database.relation.alreadyExists')}
                              </span>
                            </div>
                          ) : null}
                          {discoverStats.low_score_filtered ? (
                            <div className={`${styles.statItem} ${styles.statLow}`}>
                              <span className={styles.statNum}>
                                {discoverStats.low_score_filtered}
                              </span>
                              <span className={styles.statLabel}>
                                {t('database.relation.lowScoreFiltered')}
                              </span>
                            </div>
                          ) : null}
                        </div>

                        {/* New candidate list */}
                        {discoverCandidates.length > 0 ? (
                          <>
                            <div className={styles.candidatesHeader}>
                              <span>
                                {t('database.relation.newFound')}{' '}
                                <strong>{discoverCandidates.length}</strong>{' '}
                                {t('database.relation.relationsCount')}
                              </span>
                              <Checkbox
                                checked={discoverSelectAll}
                                indeterminate={discoverSelectIndeterminate}
                                onChange={(e) => handleDiscoverSelectAll(e.currentTarget.checked)}
                                label={t('database.relation.selectAll')}
                              />
                            </div>
                            <div className={styles.candidatesList}>
                              {discoverCandidates.map((cand, idx) => (
                                <div
                                  key={'new-' + idx}
                                  className={`${styles.candidateCard} ${cand._selected ? styles.selected : ''}`}
                                >
                                  <div className={styles.candidateCheck}>
                                    <Checkbox
                                      checked={!!cand._selected}
                                      onChange={(e) =>
                                        setDiscoverCandidates((prev) =>
                                          prev.map((c, i) =>
                                            i === idx
                                              ? { ...c, _selected: e.currentTarget.checked }
                                              : c,
                                          ),
                                        )
                                      }
                                    />
                                  </div>
                                  <div className={styles.candidateBody}>
                                    <div className={styles.candidatePath}>
                                      <span className={styles.candTable}>
                                        {cand.source_table_name}
                                      </span>
                                      <span className={styles.candDot}>.</span>
                                      <span className={styles.candCol}>{cand.source_column}</span>
                                      <span className={styles.candArrow}>→</span>
                                      <span className={styles.candTable}>
                                        {cand.target_table_name}
                                      </span>
                                      <span className={styles.candDot}>.</span>
                                      <span className={styles.candCol}>{cand.target_column}</span>
                                    </div>
                                    <div className={styles.candidateMeta}>
                                      <span className={`${styles.candScore} ${scoreClass(cand.score)}`}>
                                        {(cand.score * 100).toFixed(0)}%
                                      </span>
                                      <span className={styles.candType}>
                                        {cand.relationship_type}
                                      </span>
                                      {cand.signals && (
                                        <>
                                          {cand.signals.name_pattern && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sName}`}
                                              title={
                                                t('database.relation.signalName') +
                                                ': ' +
                                                cand.signals.name_pattern
                                              }
                                            >
                                              name
                                            </span>
                                          )}
                                          {cand.signals.ind_overlap && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sInd}`}
                                              title={
                                                t('database.relation.signalInd') +
                                                ': ' +
                                                cand.signals.ind_overlap
                                              }
                                            >
                                              ind
                                            </span>
                                          )}
                                          {cand.signals.llm_semantic && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sLlm}`}
                                              title={
                                                t('database.relation.signalLlm') +
                                                ': ' +
                                                cand.signals.llm_semantic
                                              }
                                            >
                                              llm
                                            </span>
                                          )}
                                          {cand.signals.description_hint && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sDesc}`}
                                              title={
                                                t('database.relation.signalDesc') +
                                                ': ' +
                                                cand.signals.description_hint
                                              }
                                            >
                                              desc
                                            </span>
                                          )}
                                          {cand.signals.cardinality && (
                                            <span
                                              className={`${styles.candSignal} ${styles.sCard}`}
                                              title={
                                                t('database.relation.signalCard') +
                                                ': ' +
                                                cand.signals.cardinality
                                              }
                                            >
                                              card
                                            </span>
                                          )}
                                        </>
                                      )}
                                    </div>
                                    {cand.reasoning && (
                                      <div className={styles.candidateReason}>{cand.reasoning}</div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        ) : (
                          // Hint when no new candidates are found
                          <div className={styles.discoverEmptyHint}>
                            {discoverStats.already_existing ? (
                              <span>{t('database.relation.allExist')}</span>
                            ) : discoverStats.low_score_filtered ? (
                              <span>{t('database.relation.lowConfidence')}</span>
                            ) : (
                              <span>{t('database.relation.noCandidates')}</span>
                            )}
                          </div>
                        )}

                        {/* Collapsible skipped relations */}
                        {discoverSkipped.length > 0 && (
                          <Accordion className={styles.skippedCollapse} chevronPosition="left">
                            <Accordion.Item value="skipped">
                              <Accordion.Control>
                                <span className={styles.skippedTitle}>
                                  {t('database.relation.viewSkipped', {
                                    count: discoverSkipped.length,
                                  })}
                                </span>
                              </Accordion.Control>
                              <Accordion.Panel>
                                <div className={styles.skippedList}>
                                  {discoverSkipped.map((s, idx) => (
                                    <div key={'skip-' + idx} className={styles.skippedItem}>
                                      <span className={styles.skippedPath}>
                                        {s.source_table_name}.{s.source_column} →{' '}
                                        {s.target_table_name}.{s.target_column}
                                      </span>
                                      <span className={styles.skippedScore}>
                                        {(s.score * 100).toFixed(0)}%
                                      </span>
                                      <span className={styles.skippedReason}>
                                        {s.reject_reason === 'already_exists'
                                          ? t('database.relation.alreadyExists')
                                          : t('database.relation.lowScore')}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </Accordion.Panel>
                            </Accordion.Item>
                          </Accordion>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Footer action bar */}
              <div className={styles.rdMainFooter}>
                {editingRelationship ? (
                  <>
                    <Button variant="default" onClick={() => setDialogVisible(false)}>
                      {t('database.action.cancel')}
                    </Button>
                    <Button
                      color="red"
                      onClick={() => {
                        handleDeleteRelationship(editingRelationship)
                        setDialogVisible(false)
                      }}
                    >
                      {t('database.action.delete')}
                    </Button>
                    <Button onClick={handleSaveRelationship} loading={saving}>
                      {t('database.relation.saveChanges')}
                    </Button>
                  </>
                ) : addMode === 'ai' ? (
                  <>
                    <Button variant="default" onClick={() => setDialogVisible(false)}>
                      {t('database.action.close')}
                    </Button>
                    <Button
                      onClick={handleSaveSelectedSuggestions}
                      loading={saving}
                      disabled={selectedSuggestionCount === 0}
                    >
                      {t('database.relation.addSelected', { count: selectedSuggestionCount })}
                    </Button>
                  </>
                ) : addMode === 'manual' ? (
                  <>
                    <Button variant="default" onClick={() => setDialogVisible(false)}>
                      {t('database.action.cancel')}
                    </Button>
                    <Button onClick={handleSaveRelationship} loading={saving}>
                      {t('database.relation.createRelation')}
                    </Button>
                  </>
                ) : addMode === 'discover' &&
                  discoverStats &&
                  discoverCandidates.length > 0 ? (
                  <Button
                    onClick={handleSaveDiscoverCandidates}
                    loading={saving}
                    disabled={discoverSelectedCount === 0}
                  >
                    {t('database.relation.addSelectedCount', { count: discoverSelectedCount })}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </Modal>

        {/* Relationship management drawer */}
        <Drawer
          opened={manageDrawerVisible}
          onClose={() => setManageDrawerVisible(false)}
          title={t('database.relation.manageRelations')}
          position="right"
          size={480}
        >
          <div className={styles.manageDrawerContent}>
            {/* Search and action bar */}
            <div className={styles.manageToolbar}>
              <TextInput
                style={{ flex: 1 }}
                value={manageSearchQuery}
                placeholder={t('database.relation.searchTableOrColumn')}
                leftSection={<IconSearch size={14} />}
                onChange={(e) => setManageSearchQuery(e.currentTarget.value)}
              />
              <Button
                leftSection={<IconPlus size={14} />}
                onClick={() => {
                  setManageDrawerVisible(false)
                  handleAddRelationship()
                }}
              >
                {t('database.relation.add')}
              </Button>
            </div>

            {/* Stats */}
            <div className={styles.manageStats}>
              <span>
                {t('database.relation.totalRelations', { count: filteredRelationships.length })}
              </span>
              {manageSearchQuery && (
                <span className={styles.manageStatsFilter}>
                  ({t('database.relation.filteredFrom', { count: relationships.length })})
                </span>
              )}
            </div>

            {/* Relations list */}
            <div className={styles.manageList}>
              {filteredRelationships.length === 0 ? (
                <div className={styles.manageEmpty}>
                  {manageSearchQuery ? (
                    <span>{t('database.relation.noMatchRelation')}</span>
                  ) : (
                    <span>{t('database.relation.noRelations')}</span>
                  )}
                </div>
              ) : (
                filteredRelationships.map((rel) => (
                  <div key={rel.id} className={styles.manageCard}>
                    <div className={styles.manageCardBody}>
                      <div className={`${styles.manageRelEndpoint} ${styles.source}`}>
                        <span className={styles.mTable}>{rel.source_table_name}</span>
                        <span className={styles.mCol}>.{rel.source_column}</span>
                      </div>
                      <div className={styles.manageRelConnector}>
                        <span className={styles.connectorLine} />
                        <span className={styles.connectorType}>
                          {formatRelType(rel.relationship_type)}
                        </span>
                        <span className={styles.connectorLine} />
                      </div>
                      <div className={`${styles.manageRelEndpoint} ${styles.target}`}>
                        <span className={styles.mTable}>{rel.target_table_name}</span>
                        <span className={styles.mCol}>.{rel.target_column}</span>
                      </div>
                      {rel.description && (
                        <div className={styles.manageRelDesc}>{rel.description}</div>
                      )}
                    </div>
                    <div className={styles.manageCardActions}>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        onClick={() => {
                          setManageDrawerVisible(false)
                          handleEditRelationship(rel)
                        }}
                      >
                        <IconEdit size={14} />
                      </Button>
                      <Button
                        variant="subtle"
                        size="compact-sm"
                        color="red"
                        onClick={() => handleDeleteRelationship(rel)}
                      >
                        <IconTrash size={14} />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </Drawer>

        {/* Connection confirm dialog */}
        <Modal
          opened={connectDialogVisible}
          onClose={() => setConnectDialogVisible(false)}
          title={t('database.relation.confirmRelation')}
          size={800}
          closeOnClickOutside={false}
        >
          {pendingConnection && (
            <div className={styles.connectConfirm}>
              <div className={styles.connectPreview}>
                <div className={styles.connectEndpoint}>
                  <span className={styles.endpointTable}>
                    {pendingConnection.source_table_name}
                  </span>
                  <span className={styles.endpointCol}>.{pendingConnection.source_column}</span>
                </div>
                <div className={styles.connectArrow}>
                  <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
                    <path
                      d="M0 8h20M20 8l-4-4M20 8l-4 4"
                      stroke="#6366f1"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className={styles.connectEndpoint}>
                  <span className={styles.endpointTable}>
                    {pendingConnection.target_table_name}
                  </span>
                  <span className={styles.endpointCol}>.{pendingConnection.target_column}</span>
                </div>
              </div>
              <div className={styles.connectForm}>
                <Select
                  label={t('database.relation.relationType')}
                  value={pendingConnection.relationship_type}
                  data={relTypeOptions}
                  onChange={(val) =>
                    setPendingConnection((prev: any) => ({
                      ...prev,
                      relationship_type: val || prev.relationship_type,
                    }))
                  }
                />
                <Textarea
                  label={t('database.relation.description')}
                  value={pendingConnection.description}
                  minRows={3}
                  autosize
                  placeholder={t('database.relation.descriptionPlaceholder')}
                  onChange={(e) =>
                    setPendingConnection((prev: any) => ({
                      ...prev,
                      description: e.currentTarget.value,
                    }))
                  }
                />
              </div>
            </div>
          )}
          <div className={styles.rdMainFooter} style={{ border: 'none', background: 'transparent' }}>
            <Button size="md" variant="default" onClick={() => setConnectDialogVisible(false)}>
              {t('database.action.cancel')}
            </Button>
            <Button size="md" onClick={handleSaveConnection} loading={saving}>
              {t('database.relation.createRelation')}
            </Button>
          </div>
        </Modal>
      </div>
    )
  },
)

// External component: wrap with ReactFlowProvider (useReactFlow needs Provider context)
const RelationshipERDiagram = forwardRef<RelationshipERDiagramHandle, RelationshipERDiagramProps>(
  function RelationshipERDiagram(props, ref) {
    return (
      <ReactFlowProvider>
        <InnerERDiagram ref={ref} {...props} />
      </ReactFlowProvider>
    )
  },
)

export default RelationshipERDiagram
