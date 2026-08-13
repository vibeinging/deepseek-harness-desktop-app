import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { Popover, ScrollArea, TextInput } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import ElSvgIcon from '@/components/ElSvgIcon'
import styles from './FilterableMultiSelect.module.scss'

// Filterable multi-select, aligned with original FilterableMultiSelect.vue:
// - Supports fuzzy subsequence matching, select-all for filtered items, and adding new options from input.
// - v-model:visible is managed by internal popoverVisible; @update:modelValue maps to onChange.

export interface FilterableMultiSelectProps {
  /** v-model:modelValue */
  modelValue?: string[]
  onChange?: (values: string[]) => void
  options?: string[]
  placeholder?: string
  disabled?: boolean
  /** selectStyle is stored as inline CSS string like "width:100%". */
  selectStyle?: string
  selectAllLabel?: string
  maxVisibleTags?: number
  /** @visible-change */
  onVisibleChange?: (visible: boolean) => void
}

function uniqueValues(values?: any[]): string[] {
  return [...new Set((values || []).filter(Boolean))] as string[]
}

function normalizeText(value: any): string {
  return String(value ?? '').trim()
}

function normalizeSearchText(value: any): string {
  return normalizeText(value).toLowerCase()
}

function fuzzyMatchOption(option: string, keyword: string): boolean {
  const text = normalizeSearchText(option)
  const query = normalizeSearchText(keyword)
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

// Parse inline style strings like "width:100%;color:red" into a React style object.
function parseStyleString(style?: string): CSSProperties {
  const result: Record<string, string> = {}
  if (!style) return result as CSSProperties
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':')
    if (idx === -1) continue
    const rawKey = decl.slice(0, idx).trim()
    const value = decl.slice(idx + 1).trim()
    if (!rawKey || !value) continue
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    result[key] = value
  }
  return result as CSSProperties
}

export default function FilterableMultiSelect({
  modelValue,
  onChange,
  options = [],
  placeholder: placeholderProp = '',
  disabled = false,
  selectStyle = 'width:100%',
  selectAllLabel: selectAllLabelProp = '',
  maxVisibleTags = 2,
  onVisibleChange,
}: FilterableMultiSelectProps) {
  const { t } = useTranslation()

  const triggerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [popoverVisible, setPopoverVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [localSelectedValues, setLocalSelectedValues] = useState<string[]>([])
  const [customOptions, setCustomOptions] = useState<string[]>([])
  const [panelWidth, setPanelWidth] = useState(360)

  // Sync internal state with external modelValue (watch equivalent: immediate + deep).
  useEffect(() => {
    setLocalSelectedValues(uniqueValues(modelValue))
  }, [modelValue])

  // When base options change, remove custom options that are now included.
  useEffect(() => {
    const baseOptions = uniqueValues(options || [])
    setCustomOptions((prev) => prev.filter((option) => !baseOptions.includes(option)))
  }, [options])

  const normalizedModelValue = useMemo(
    () => uniqueValues(localSelectedValues),
    [localSelectedValues],
  )

  const mergedOptions = useMemo(
    () => uniqueValues([...(options || []), ...customOptions, ...normalizedModelValue]),
    [options, customOptions, normalizedModelValue],
  )

  const normalizedSearchQuery = useMemo(() => normalizeText(searchQuery), [searchQuery])

  const filteredOptions = useMemo(() => {
    const query = normalizedSearchQuery
    if (!query) return mergedOptions
    return mergedOptions.filter((option) => fuzzyMatchOption(option, query))
  }, [normalizedSearchQuery, mergedOptions])

  const placeholder =
    placeholderProp || t('business.metricView.filterableMultiSelect.defaultPlaceholder')
  const selectAllLabel =
    selectAllLabelProp || t('business.metricView.filterableMultiSelect.selectAllFiltered')

  const isAllFilteredSelected = useMemo(() => {
    if (!filteredOptions.length) return false
    return filteredOptions.every((option) => normalizedModelValue.includes(option))
  }, [filteredOptions, normalizedModelValue])

  const isFilteredIndeterminate = useMemo(() => {
    if (!filteredOptions.length) return false
    const selectedCount = filteredOptions.filter((option) =>
      normalizedModelValue.includes(option),
    ).length
    return selectedCount > 0 && selectedCount < filteredOptions.length
  }, [filteredOptions, normalizedModelValue])

  const canCreateCurrentInput = useMemo(() => {
    const currentValue = normalizedSearchQuery
    if (!currentValue) return false
    return !mergedOptions.includes(currentValue)
  }, [normalizedSearchQuery, mergedOptions])

  const visibleTags = useMemo(
    () => normalizedModelValue.slice(0, maxVisibleTags),
    [normalizedModelValue, maxVisibleTags],
  )
  const hiddenTagCount = Math.max(0, normalizedModelValue.length - visibleTags.length)

  function emitValue(values: string[]) {
    const nextValues = uniqueValues(values)
    setLocalSelectedValues(nextValues)
    onChange?.(nextValues)
  }

  function isOptionSelected(option: string) {
    return normalizedModelValue.includes(option)
  }

  function updateOptionSelection(option: string, checked: boolean) {
    if (checked) {
      emitValue([...normalizedModelValue, option])
      return
    }
    emitValue(normalizedModelValue.filter((item) => item !== option))
  }

  function toggleOption(option: string) {
    updateOptionSelection(option, !isOptionSelected(option))
  }

  function handleSelectAllToggle() {
    if (!filteredOptions.length) return

    if (!isAllFilteredSelected) {
      emitValue([...normalizedModelValue, ...filteredOptions])
      return
    }

    const filteredSet = new Set(filteredOptions)
    emitValue(normalizedModelValue.filter((option) => !filteredSet.has(option)))
  }

  function removeValue(option: string) {
    emitValue(normalizedModelValue.filter((item) => item !== option))
  }

  function handleCreateCurrentInput() {
    const currentValue = normalizedSearchQuery
    if (!currentValue) return
    if (!mergedOptions.includes(currentValue)) {
      setCustomOptions((prev) => uniqueValues([...prev, currentValue]))
    }
    emitValue([...normalizedModelValue, currentValue])
    setSearchQuery('')
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleCreateCurrentInput()
    }
  }

  // Show handler: measure trigger width, set dropdown width, and focus search input.
  function handleShow() {
    onVisibleChange?.(true)
    queueMicrotask(() => {
      const triggerWidth = triggerRef.current?.offsetWidth || 0
      setPanelWidth(Math.max(triggerWidth, 360))
      searchInputRef.current?.focus?.()
    })
  }

  // Hide handler: clear search keyword.
  function handleHide() {
    setSearchQuery('')
    onVisibleChange?.(false)
  }

  function handlePopoverChange(opened: boolean) {
    if (disabled) return
    setPopoverVisible(opened)
    if (opened) handleShow()
    else handleHide()
  }

  const checkClass = (active: boolean, indeterminate = false) =>
    [
      styles.check,
      active ? styles.checkSelected : '',
      indeterminate ? styles.checkIndeterminate : '',
    ]
      .filter(Boolean)
      .join(' ')

  return (
    <div className={styles.filterableMultiSelect} style={parseStyleString(selectStyle)}>
      <Popover
        opened={popoverVisible}
        onChange={handlePopoverChange}
        disabled={disabled}
        position="bottom-start"
        width={panelWidth}
        withinPortal
        trapFocus={false}
        classNames={{ dropdown: 'filterable-multi-select-popover' }}
        styles={{ dropdown: { padding: 12, zIndex: 4000 } }}
      >
        <Popover.Target>
          <div
            ref={triggerRef}
            className={[
              styles.trigger,
              disabled ? styles.triggerDisabled : '',
              popoverVisible ? styles.triggerOpen : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => handlePopoverChange(!popoverVisible)}
          >
            {normalizedModelValue.length ? (
              <div className={styles.tags}>
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 6px',
                      borderRadius: 6,
                      background: 'var(--el-fill-color-light, #f0f2f5)',
                      fontSize: 12,
                      lineHeight: 1.4,
                      maxWidth: '100%',
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {tag}
                    </span>
                    <span
                      role="button"
                      aria-label="remove"
                      style={{ cursor: 'pointer', lineHeight: 0, display: 'inline-flex' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeValue(tag)
                      }}
                    >
                      <ElSvgIcon name="Close" size={12} />
                    </span>
                  </span>
                ))}
                {hiddenTagCount > 0 && (
                  <span className={styles.more}>+ {hiddenTagCount}</span>
                )}
              </div>
            ) : (
              <span className={styles.placeholder}>{placeholder}</span>
            )}
            <span className={styles.arrow}>
              <ElSvgIcon name="ArrowDown" size={16} />
            </span>
          </div>
        </Popover.Target>

        <Popover.Dropdown>
          <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
            <TextInput
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t('business.metricView.filterableMultiSelect.searchPlaceholder')}
            />

            <div className={styles.toolbar}>
              <button
                type="button"
                className={[
                  styles.toggleAll,
                  filteredOptions.length === 0 ? styles.toggleAllDisabled : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={filteredOptions.length === 0}
                onClick={handleSelectAllToggle}
              >
                <span className={checkClass(isAllFilteredSelected, isFilteredIndeterminate)}>
                  {isAllFilteredSelected && <IconCheck size={12} stroke={2} />}
                </span>
                <span>{selectAllLabel}</span>
              </button>
              <span className={styles.meta}>
                {t('business.metricView.filterableMultiSelect.meta', {
                  selected: normalizedModelValue.length,
                  filtered: filteredOptions.length,
                  total: mergedOptions.length,
                })}
              </span>
            </div>

            {canCreateCurrentInput && (
              <div className={styles.create} onClick={handleCreateCurrentInput}>
                {t('business.metricView.filterableMultiSelect.addOption', {
                  value: normalizedSearchQuery,
                })}
              </div>
            )}

            <ScrollArea.Autosize mah={260}>
              {filteredOptions.length ? (
                <div className={styles.options}>
                  {filteredOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={[
                        styles.option,
                        isOptionSelected(option) ? styles.optionSelected : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => toggleOption(option)}
                    >
                      <span className={checkClass(isOptionSelected(option))}>
                        {isOptionSelected(option) && <IconCheck size={12} stroke={2} />}
                      </span>
                      <span className={styles.optionLabel}>{option}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className={styles.empty}>
                  {t('business.metricView.filterableMultiSelect.noMatches')}
                </div>
              )}
            </ScrollArea.Autosize>
          </div>
        </Popover.Dropdown>
      </Popover>
    </div>
  )
}
