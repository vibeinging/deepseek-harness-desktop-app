// ScrollableTabs: a horizontally scrollable Tabs wrapper (based on components/ScrollableTabs.vue).
// When switching/clicking a tab, smoothly scroll the active tab to the center of the scroll container.
// TODO(migration): The original component is based on el-tabs (.el-tabs__item.is-active / .el-tabs__nav-scroll).
//   Mantine Tabs has a different DOM structure: the active item is marked by [data-active],
//   and the horizontal scroll container is the parent ScrollArea of .mantine-Tabs-list.
//   This uses Mantine Tabs + ScrollArea and centers the active tab via Mantine selectors, matching the original behavior.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
} from 'react'
import { ScrollArea, Tabs } from '@mantine/core'
import styles from './ScrollableTabs.module.scss'

// defineProps → interface
interface ScrollableTabsProps {
  // v-model="modelValue"
  modelValue?: string | number
  // el-tabs type ('border-card' | 'card' | '')
  type?: string
  // Forward class to Tabs root node
  tabsClass?: string
  // Custom selector for locating the tabs scroll container (supports multiple instances)
  navScrollSelector?: string
  // defineEmits(['update:modelValue', 'tab-click'])
  onUpdateModelValue?: (value: string) => void
  onTabClick?: (value: string, event: React.MouseEvent) => void
  // Default slot: Tabs.List / Tabs.Tab / Tabs.Panel
  children?: ReactNode
}

// defineExpose({ scrollActiveTabToCenter }) → forwardRef + useImperativeHandle
export interface ScrollableTabsHandle {
  scrollActiveTabToCenter: () => void
}

const ScrollableTabs = forwardRef<ScrollableTabsHandle, ScrollableTabsProps>(
  function ScrollableTabs(
    {
      modelValue = '',
      type = 'border-card',
      tabsClass = '',
      navScrollSelector = '',
      onUpdateModelValue,
      onTabClick,
      children,
    },
    ref
  ) {
    // ref="tabsRef" points to Tabs root DOM
    const tabsRef = useRef<HTMLDivElement>(null)

    /**
     * Scroll active tab to center
     */
    const scrollActiveTabToCenter = useCallback(() => {
      // nextTick equivalent: requestAnimationFrame waits for DOM/active-state updates before calculation
      requestAnimationFrame(() => {
        // Get the tabs container element
        const tabsEl = tabsRef.current
        if (!tabsEl) return

        // Find the active tab element (Mantine marks active tabs with [data-active] / aria-selected)
        const activeTab =
          tabsEl.querySelector<HTMLElement>('[role="tab"][data-active]') ||
          tabsEl.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        if (!activeTab) return

        // Find the scroll container
        const navScroll = navScrollSelector
          ? document.querySelector<HTMLElement>(navScrollSelector)
          : tabsEl.querySelector<HTMLElement>(
              '[data-scrollarea-viewport], .mantine-ScrollArea-viewport'
            )
        if (!navScroll) return

        // Calculate scroll position: center active tab
        const tabCenter = activeTab.offsetLeft + activeTab.offsetWidth / 2
        const navCenter = navScroll.offsetWidth / 2
        const scrollLeft = tabCenter - navCenter

        // Smoothly scroll to target position
        navScroll.scrollTo({
          left: Math.max(0, scrollLeft),
          behavior: 'smooth',
        })
      })
    }, [navScrollSelector])

    // Handle tab change events (Mantine Tabs onChange gives the new value)
    const handleChange = (value: string | null) => {
      const name = value ?? ''
      onUpdateModelValue?.(name)
      // Scroll to center after switch
      scrollActiveTabToCenter()
    }

    // Handle tab click events and forward tab-click (keep event object)
    const handleTabClick = (value: string, event: React.MouseEvent) => {
      onTabClick?.(value, event)
    }

    // watch(() => props.modelValue) equivalent: auto-scroll when modelValue changes
    useEffect(() => {
      scrollActiveTabToCenter()
    }, [modelValue, scrollActiveTabToCenter])

    // Expose methods for external calls (defineExpose)
    useImperativeHandle(ref, () => ({ scrollActiveTabToCenter }), [
      scrollActiveTabToCenter,
    ])

    // Map el-tabs type to Mantine variant
    // border-card -> outline, card -> outline (with card class), others -> default
    const variant = type === 'border-card' || type === 'card' ? 'outline' : 'default'

    return (
      <Tabs
        ref={tabsRef}
        value={String(modelValue)}
        onChange={handleChange}
        variant={variant}
        keepMounted={false}
        className={[styles.scrollableTabs, tabsClass].filter(Boolean).join(' ')}
        data-tabs-type={type}
        onClick={(e) => {
          // Capture tab click and forward tab-click (corresponds to source @tab-click emit)
          // Mantine tab has no data-value, derive value from aria-controls (panel id, like *-panel-{value})
          const tabEl = (e.target as HTMLElement).closest<HTMLElement>(
            '[role="tab"]'
          )
          if (!tabEl) return
          const panelId = tabEl.getAttribute('aria-controls') || ''
          const value = panelId.split('-panel-').pop() || ''
          if (value) handleTabClick(value, e)
        }}
      >
        {/* Default slot: wrap with ScrollArea for horizontal scrolling */}
        <ScrollArea type="never" scrollbarSize={0}>
          {children}
        </ScrollArea>
      </Tabs>
    )
  }
)

export default ScrollableTabs
