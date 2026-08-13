/**
 * Responsive-state hook
 *
 * Provides isMobile / isTablet / isDesktop responsive state.
 * Uses window.matchMedia to listen to breakpoint changes efficiently.
 * Collapses the sidebar automatically on mobile.
 */
import { useEffect, useState } from 'react'
import { useBasicStore } from '@/store/basic'

// Keep breakpoints in sync with responsive.scss.
const BREAKPOINT_MOBILE = 768
const BREAKPOINT_TABLET = 1024

interface DeviceState {
  isMobile: boolean
  isTablet: boolean
  isDesktop: boolean
}

// Global singleton state to avoid duplicate listeners across components.
let mqlMobile: MediaQueryList | null = null
let mqlTablet: MediaQueryList | null = null
let handleMobileChange: (() => void) | null = null
let handleTabletChange: (() => void) | null = null
let refCount = 0

// Current singleton breakpoint state plus subscribers for pushing updates.
let currentState: DeviceState = computeState()
const subscribers = new Set<(s: DeviceState) => void>()

function computeState(): DeviceState {
  if (typeof window === 'undefined') {
    return { isMobile: false, isTablet: false, isDesktop: true }
  }
  const width = window.innerWidth
  return {
    isMobile: width < BREAKPOINT_MOBILE,
    isTablet: width >= BREAKPOINT_MOBILE && width < BREAKPOINT_TABLET,
    isDesktop: width >= BREAKPOINT_TABLET
  }
}

function updateStates() {
  currentState = computeState()
  subscribers.forEach((fn) => fn(currentState))
}

function setupListeners() {
  if (typeof window === 'undefined') return

  mqlMobile = window.matchMedia(`(max-width: ${BREAKPOINT_MOBILE - 1}px)`)
  mqlTablet = window.matchMedia(`(min-width: ${BREAKPOINT_MOBILE}px) and (max-width: ${BREAKPOINT_TABLET - 1}px)`)

  handleMobileChange = () => updateStates()
  handleTabletChange = () => updateStates()

  mqlMobile.addEventListener('change', handleMobileChange)
  mqlTablet.addEventListener('change', handleTabletChange)

  // Initialize with current state.
  updateStates()
}

function teardownListeners() {
  if (mqlMobile && handleMobileChange) {
    mqlMobile.removeEventListener('change', handleMobileChange)
  }
  if (mqlTablet && handleTabletChange) {
    mqlTablet.removeEventListener('change', handleTabletChange)
  }
  mqlMobile = null
  mqlTablet = null
  handleMobileChange = null
  handleTabletChange = null
}

interface UseResponsiveOptions {
  /** Collapse sidebar automatically on mobile (default: false). */
  autoCollapseSidebar?: boolean
}

/**
 * Responsive breakpoint hook.
 *
 * @param options.autoCollapseSidebar - Collapse sidebar on mobile (default true).
 * @returns { isMobile, isTablet, isDesktop } Booleans.
 */
export function useResponsive(options: UseResponsiveOptions = {}): DeviceState {
  const { autoCollapseSidebar = false } = options

  const [state, setState] = useState<DeviceState>(currentState)

  useEffect(() => {
    // Subscribe to singleton state updates (onMounted).
    subscribers.add(setState)

    refCount++
    if (refCount === 1) {
      setupListeners()
    } else {
      // Refresh state once for additional mounted components.
      updateStates()
    }
    // Sync with latest singleton state.
    setState(currentState)

    // Collapse sidebar on mobile.
    if (autoCollapseSidebar && currentState.isMobile) {
      useBasicStore.getState().setSidebarHidden(true)
    }

    // Cleanup on unmount.
    return () => {
      subscribers.delete(setState)
      refCount--
      if (refCount <= 0) {
        teardownListeners()
        refCount = 0
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return state
}

/**
 * Get the current device type in non-component contexts (single-time evaluation).
 */
export function getDeviceType(): 'mobile' | 'tablet' | 'desktop' {
  if (typeof window === 'undefined') return 'desktop'
  const width = window.innerWidth
  if (width < BREAKPOINT_MOBILE) return 'mobile'
  if (width < BREAKPOINT_TABLET) return 'tablet'
  return 'desktop'
}
