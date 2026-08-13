export const APP_ONBOARDING_COMPLETED_KEY = 'dsh:onboarding:completed:v1'

function canUseStorage() {
  return typeof window !== 'undefined' && !!window.localStorage
}

export function isAppOnboardingCompleted() {
  if (!canUseStorage()) return true
  return window.localStorage.getItem(APP_ONBOARDING_COMPLETED_KEY) === 'true'
}

export function markAppOnboardingCompleted() {
  if (!canUseStorage()) return
  window.localStorage.setItem(APP_ONBOARDING_COMPLETED_KEY, 'true')
}
