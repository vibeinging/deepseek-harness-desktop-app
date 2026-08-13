import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Switch, Tooltip, Popover, Text } from '@mantine/core'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './EntityToolbar.module.scss'

export interface EntityToolbarProps {
  hasEntities?: boolean
  // Whether there are entries with auto_promoted=true (controls batch revert button state)
  hasAutoPromoted?: boolean
  // Whether to show only auto-promoted items
  showAutoPromotedOnly?: boolean
  onAddColumnValue?: () => void
  onAddColumnName?: () => void
  onSearchTest?: () => void
  onToggleAutoPromotedFilter?: (v: boolean) => void
  onBatchRevertAutoPromoted?: () => void
}

export default function EntityToolbar({
  hasEntities = false,
  hasAutoPromoted = false,
  showAutoPromotedOnly = false,
  onAddColumnValue,
  onAddColumnName,
  onSearchTest,
  onToggleAutoPromotedFilter,
  onBatchRevertAutoPromoted,
}: EntityToolbarProps) {
  const { t } = useTranslation()

  // Batch revert confirm popover toggle
  const [revertConfirmOpened, setRevertConfirmOpened] = useState(false)

  return (
    <div className={styles.operationsHeader}>
      <div className={styles.headerLeft}>
        <span className={styles.headerDesc}>{t('business.entity.toolbarDesc')}</span>
        {/* Show only auto-promoted toggle (AgenticSearch fb_search fallback-promoted entities) */}
        <div className={styles.autoPromotedFilter}>
          <Switch
            size="sm"
            checked={showAutoPromotedOnly}
            onChange={(e) => onToggleAutoPromotedFilter?.(e.currentTarget.checked)}
          />
          <span className={styles.filterLabel}>
            {t('business.entity.showAutoPromotedOnly', '仅看自动生成')}
          </span>
          <Tooltip
            position="top"
            withArrow
            multiline
            w={260}
            label={t(
              'business.entity.autoPromotedFilterTooltip',
              '打开后只显示 AgenticSearch 自动 promote 出来的实体配置;关闭显示全部',
            )}
          >
            <span className={styles.tipIcon}>
              <ElSvgIcon name="QuestionFilled" size={14} />
            </span>
          </Tooltip>
        </div>
      </div>
      <div className={styles.headerActions}>
        <div className={styles.toolbarActionCell}>
          <Popover
            opened={revertConfirmOpened}
            onChange={setRevertConfirmOpened}
            position="bottom"
            withArrow
            width={320}
            disabled={!hasAutoPromoted}
          >
            <Popover.Target>
              <Button
                className={`${styles.toolbarRow} ${styles.toolbarRowRevert}`}
                size="sm"
                variant="default"
                disabled={!hasAutoPromoted}
                onClick={() => setRevertConfirmOpened((o) => !o)}
                leftSection={<ElSvgIcon name="RefreshLeft" size={16} />}
              >
                <span className={styles.toolbarRowLabel}>
                  {t('business.entity.batchRevertAutoPromoted', '批量撤销自动生成')}
                </span>
              </Button>
            </Popover.Target>
            <Popover.Dropdown>
              <Text size="sm" mb="sm">
                {t(
                  'business.entity.batchRevertConfirm',
                  '确认撤销本业务下所有自动生成的实体配置?此操作不可恢复',
                )}
              </Text>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button size="xs" variant="default" onClick={() => setRevertConfirmOpened(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="xs"
                  color="red"
                  onClick={() => {
                    setRevertConfirmOpened(false)
                    onBatchRevertAutoPromoted?.()
                  }}
                >
                  {t('common.confirm')}
                </Button>
              </div>
            </Popover.Dropdown>
          </Popover>
        </div>
        <div className={styles.toolbarActionCell}>
          <Tooltip
            position="bottom"
            withArrow
            multiline
            w={220}
            label={
              <>
                {t('business.entity.columnValueTooltip')}
                <br />
                {t('business.entity.columnValueExample')}
              </>
            }
          >
            <Button
              className={`${styles.toolbarRow} ${styles.toolbarRowValue}`}
              size="sm"
              variant="default"
              onClick={() => onAddColumnValue?.()}
              leftSection={<ElSvgIcon name="Plus" size={16} />}
            >
              <span className={styles.toolbarRowLabel}>
                {t('business.entity.columnValueNoun')}
              </span>
            </Button>
          </Tooltip>
        </div>
        <div className={styles.toolbarActionCell}>
          <Tooltip
            position="bottom"
            withArrow
            multiline
            w={220}
            label={
              <>
                {t('business.entity.columnNameTooltip')}
                <br />
                {t('business.entity.columnNameExample')}
              </>
            }
          >
            <Button
              className={`${styles.toolbarRow} ${styles.toolbarRowField}`}
              size="sm"
              variant="default"
              onClick={() => onAddColumnName?.()}
              leftSection={<ElSvgIcon name="Grid" size={16} />}
            >
              <span className={styles.toolbarRowLabel}>
                {t('business.entity.columnNameNoun')}
              </span>
            </Button>
          </Tooltip>
        </div>
        <div className={styles.toolbarActionCell}>
          <Button
            className={`${styles.toolbarRow} ${styles.toolbarRowRecall}`}
            size="sm"
            variant="default"
            onClick={() => onSearchTest?.()}
            disabled={!hasEntities}
            leftSection={<ElSvgIcon name="Search" size={16} />}
          >
            <span className={styles.toolbarRowLabel}>{t('business.entity.recallTest')}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
