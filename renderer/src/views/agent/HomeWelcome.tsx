import { useEffect, useRef, useState, type ReactNode } from 'react'
import homeCharacterImage from '@/assets/dsh-home-character.png'
import homeCharacterVideo from '@/assets/dsh-home-character-loop.webm'
import { HOME_DOUBLE_BLINK_DELAY_MS, randomHomeBlinkDelay, shouldDoubleHomeBlink } from './homeBlink'
import { resolveHomeGreeting } from './homeGreeting'
import styles from './HomeWelcome.module.scss'

interface Props {
  prompt: string
  subtitle: string
  composer?: ReactNode
  showCharacter: boolean
}

/** Renders the empty-conversation welcome area and its optional homepage character. */
export default function HomeWelcome({ prompt, subtitle, composer, showCharacter }: Props) {
  const [greeting, setGreeting] = useState(() => resolveHomeGreeting())
  const characterVideoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (!showCharacter) return
    const refreshGreeting = () => {
      const next = resolveHomeGreeting()
      setGreeting((current) => current.period === next.period ? current : next)
    }
    const timer = window.setInterval(refreshGreeting, 60_000)
    window.addEventListener('focus', refreshGreeting)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshGreeting)
    }
  }, [showCharacter])

  useEffect(() => {
    if (!showCharacter) return
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let blinkTimer: number | undefined
    let doubleBlinkTimer: number | undefined
    let disposed = false

    const clearTimers = () => {
      if (blinkTimer !== undefined) window.clearTimeout(blinkTimer)
      if (doubleBlinkTimer !== undefined) window.clearTimeout(doubleBlinkTimer)
      blinkTimer = undefined
      doubleBlinkTimer = undefined
    }
    const canBlink = () => !disposed && !document.hidden && !motionPreference.matches
    const playBlink = async () => {
      const video = characterVideoRef.current
      if (!video || !canBlink()) return
      video.currentTime = 0
      await video.play().catch(() => {})
    }
    const scheduleBlink = () => {
      if (blinkTimer !== undefined) window.clearTimeout(blinkTimer)
      blinkTimer = undefined
      if (!canBlink()) return
      blinkTimer = window.setTimeout(() => {
        blinkTimer = undefined
        void playBlink()
        if (shouldDoubleHomeBlink()) {
          doubleBlinkTimer = window.setTimeout(() => void playBlink(), HOME_DOUBLE_BLINK_DELAY_MS)
        }
        scheduleBlink()
      }, randomHomeBlinkDelay())
    }
    const syncBlinking = () => {
      const video = characterVideoRef.current
      if (!canBlink()) {
        clearTimers()
        video?.pause()
        return
      }
      scheduleBlink()
    }

    characterVideoRef.current?.pause()
    scheduleBlink()
    document.addEventListener('visibilitychange', syncBlinking)
    motionPreference.addEventListener('change', syncBlinking)
    return () => {
      disposed = true
      clearTimers()
      document.removeEventListener('visibilitychange', syncBlinking)
      motionPreference.removeEventListener('change', syncBlinking)
    }
  }, [showCharacter])

  return (
    <section className={styles.welcome} data-show-character={showCharacter ? 'true' : 'false'}>
      {!showCharacter && (
        <div className={styles.copy}>
          <h1 className={styles.title}>{prompt}</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
      )}
      {(showCharacter || composer) && (
        <div className={styles.interaction} data-has-character={showCharacter ? 'true' : 'false'}>
          {showCharacter && (
            <>
              <div className={styles.speechBubble} data-greeting-period={greeting.period}>
                <span className={styles.speaker}>DeepSeek Harness Desktop App</span>
                <h1 className={styles.title}>{greeting.title}</h1>
                <p className={styles.subtitle}>{greeting.subtitle}</p>
              </div>
              <div className={styles.character} aria-hidden="true">
                <div className={styles.characterGlow} />
                <img className={styles.characterFallback} src={homeCharacterImage} alt="" draggable={false} />
                <video
                  ref={characterVideoRef}
                  className={styles.characterVideo}
                  src={homeCharacterVideo}
                  poster={homeCharacterImage}
                  muted
                  playsInline
                  preload="auto"
                />
              </div>
            </>
          )}
          {composer && <div className={styles.composer}>{composer}</div>}
        </div>
      )}
    </section>
  )
}
