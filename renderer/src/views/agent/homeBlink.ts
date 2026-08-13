export const HOME_BLINK_MIN_DELAY_MS = 3_000
export const HOME_BLINK_MAX_DELAY_MS = 9_000
export const HOME_DOUBLE_BLINK_CHANCE = 0.15
export const HOME_DOUBLE_BLINK_DELAY_MS = 180

/** Returns a non-repeating-looking wait within the homepage blink range. */
export function randomHomeBlinkDelay(random: () => number = Math.random): number {
  const sample = Math.min(1, Math.max(0, random()))
  return Math.round(HOME_BLINK_MIN_DELAY_MS + sample * (HOME_BLINK_MAX_DELAY_MS - HOME_BLINK_MIN_DELAY_MS))
}

/** Occasionally turns one blink event into a short natural double blink. */
export function shouldDoubleHomeBlink(random: () => number = Math.random): boolean {
  return random() < HOME_DOUBLE_BLINK_CHANCE
}
