import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** The DOM-facing half of DSH ThemeRuntime used by the dsh-work shell. */
export interface DshThemePresenter {
  /** Present one immutable runtime snapshot and replace the previously owned token layer. */
  present(snapshot: ThemeSnapshot): void
  /** Remove only the scheme and token state owned by this presenter. */
  dispose(): void
}

/**
 * Project ThemeRuntime snapshots onto the document without taking ownership of
 * product-theme variables or unrelated inline body styles.
 *
 * @param documentRef - document whose root and body host the DSH Client UI.
 * @returns a presenter with explicit replacement and disposal semantics.
 */
export function createDshThemePresenter(documentRef: Document): DshThemePresenter {
  const appliedTokens = new Set<string>()

  const removeAppliedTokens = () => {
    for (const name of appliedTokens) documentRef.body.style.removeProperty(name)
    appliedTokens.clear()
  }

  return {
    present(snapshot) {
      removeAppliedTokens()
      const scheme = snapshot.active.colorScheme
      documentRef.documentElement.style.colorScheme = scheme
      documentRef.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')
      for (const [name, value] of Object.entries(snapshot.active.tokens)) {
        documentRef.body.style.setProperty(name, value)
        appliedTokens.add(name)
      }
    },
    dispose() {
      removeAppliedTokens()
      documentRef.documentElement.style.removeProperty('color-scheme')
      documentRef.body.removeAttribute('data-ds-dark-theme')
    }
  }
}
