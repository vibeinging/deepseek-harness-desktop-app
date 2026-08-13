// Unified empty state for semantic layer (metrics, views, entities, examples, memories),
// aligned with the empty state used for database / structured data.
// Top icon illustration (center hub + small surrounding icons), title, description,
// one-line feature badges, and action button.
// Uses short text only to match the lightweight style of database empty state.
import { type ReactNode } from 'react'
import styles from './SemanticEmptyState.module.scss'

export { styles as emptyStyles }

export interface EmptyFeature {
  icon?: ReactNode
  label: ReactNode
}

export interface SemanticEmptyStateProps {
  /** Center hub icon inside a gradient square */
  icon?: ReactNode
  /** 0~2 satellite icons above and around the hub */
  satellites?: ReactNode[]
  title: ReactNode
  description?: ReactNode
  /** Feature tag row (icon + short label), aligned with database empty state's featureItem */
  features?: EmptyFeature[]
  /** Centered action buttons at the bottom */
  actions?: ReactNode
  /** Optional fallback content (usually not used) */
  children?: ReactNode
}

export default function SemanticEmptyState({
  icon,
  satellites,
  title,
  description,
  features,
  actions,
  children
}: SemanticEmptyStateProps) {
  const sats = (satellites || []).filter(Boolean).slice(0, 2)

  return (
    <div className={styles.wrap}>
      <div className={styles.content}>
        {(icon || sats.length > 0) && (
          <div className={styles.illustration}>
            <div className={styles.illoContainer}>
              {sats[0] && <div className={`${styles.sat} ${styles.satLeft}`}>{sats[0]}</div>}
              {sats[1] && <div className={`${styles.sat} ${styles.satRight}`}>{sats[1]}</div>}
              {icon && <div className={styles.hub}>{icon}</div>}
            </div>
          </div>
        )}

        <div className={styles.intro}>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>

        {features && features.length > 0 && (
          <div className={styles.features}>
            {features.map((f, i) => (
              <div className={styles.featureItem} key={i}>
                {f.icon && <span className={styles.featureIcon}>{f.icon}</span>}
                <span>{f.label}</span>
              </div>
            ))}
          </div>
        )}

        {children}

        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </div>
  )
}
