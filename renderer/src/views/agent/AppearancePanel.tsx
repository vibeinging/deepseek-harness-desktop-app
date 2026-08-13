// 品牌外观面板：显示当前有效值及其来源，编辑用户覆盖层。
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { IconCheck, IconPhoto, IconRefresh, IconUpload } from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import { resolveAppearanceForScheme, useBrandAppearanceStore } from '@/store/brandAppearance'
import { DEFAULT_APP_NAME, useBrandStore } from '@/store/brand'
import {
  BUILTIN_BG_PRESETS,
  findBgPreset,
  isLocalBgImage
} from '@/theme/skins/backgrounds'
import { normalizeHexColor } from '@/theme/skins/colors'
import type { BrandAppearance } from '@/theme/skins/types'
import styles from './skinsManager.module.scss'

const MAX_LOCAL_IMAGE_BYTES = 8 * 1024 * 1024
type AppearanceField = 'bgColor' | 'bgImage' | 'bgImageSize' | 'bgOpacity' | 'panelOpacity'
type AppearanceSource = 'mine' | 'mineDark' | 'skin' | 'skinDark' | 'default'

function fieldSource(
  field: AppearanceField,
  skin: BrandAppearance | null,
  user: BrandAppearance,
  scheme: 'light' | 'dark'
): { key: AppearanceSource; userOverride: boolean } {
  if (scheme === 'dark') {
    if (user.dark?.[field] !== undefined) return { key: 'mineDark', userOverride: true }
  }
  if (user[field] !== undefined) return { key: 'mine', userOverride: true }
  if (scheme === 'dark' && skin?.dark?.[field] !== undefined) {
    return { key: 'skinDark', userOverride: false }
  }
  if (skin?.[field] !== undefined) return { key: 'skin', userOverride: false }
  return { key: 'default', userOverride: false }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** 只生成当前字段的最小 patch，让 store 在调用时与最新状态合并，避免异步上传覆盖并发编辑。 */
export function appearanceFieldPatch(
  scheme: 'light' | 'dark',
  field: AppearanceField,
  value: BrandAppearance[AppearanceField]
): Partial<BrandAppearance> {
  return scheme === 'dark' ? { dark: { [field]: value } } : { [field]: value }
}

export default function AppearancePanel() {
  const { t } = useTranslation()
  const appearance = useBrandAppearanceStore((state) => state.appearance)
  const skinAppearance = useBrandAppearanceStore((state) => state.skinAppearance)
  const scheme = useBrandAppearanceStore((state) => state.scheme)
  const setAppearance = useBrandAppearanceStore((state) => state.setAppearance)
  const resetAppearance = useBrandAppearanceStore((state) => state.resetAppearance)
  const appearancePersistenceError = useBrandAppearanceStore((state) => state.persistenceError)
  const clearAppearancePersistenceError = useBrandAppearanceStore((state) => state.clearPersistenceError)

  const userName = useBrandStore((state) => state.name)
  const setUserName = useBrandStore((state) => state.setName)
  const brandPersistenceError = useBrandStore((state) => state.persistenceError)
  const clearBrandPersistenceError = useBrandStore((state) => state.clearPersistenceError)

  const effective = useMemo(
    () => resolveAppearanceForScheme(skinAppearance, appearance, scheme),
    [appearance, scheme, skinAppearance]
  )
  const [nameDraft, setNameDraft] = useState(userName)
  const [nameDirty, setNameDirty] = useState(false)
  const [bgColorDraft, setBgColorDraft] = useState(effective.bgColor || '')
  const [bgColorDirty, setBgColorDirty] = useState(false)
  const [savingName, setSavingName] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [appearanceError, setAppearanceError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const nameDraftRevision = useRef(0)
  const bgColorDraftRevision = useRef(0)
  const formId = useId()

  useEffect(() => {
    if (!nameDirty) setNameDraft(userName)
  }, [nameDirty, userName])
  useEffect(() => {
    if (!bgColorDirty) setBgColorDraft(effective.bgColor || '')
  }, [bgColorDirty, effective.bgColor])
  useEffect(() => {
    // 明暗切换时不能把上一模式尚未保存的底色草稿误写到新模式。
    bgColorDraftRevision.current += 1
    setBgColorDirty(false)
    setBgColorDraft(effective.bgColor || '')
  }, [scheme])

  const bgOpacity = effective.bgOpacity ?? 100
  const panelOpacity = effective.panelOpacity ?? 100
  const currentBgImage = effective.bgImage || 'none'
  const nameSourceKey: AppearanceSource = userName !== DEFAULT_APP_NAME ? 'mine' : 'default'
  const sourceText = (key: AppearanceSource) => t(`agentSkins.source.${key}`)
  const nameSource = sourceText(nameSourceKey)

  const patchField = (field: AppearanceField, value: BrandAppearance[AppearanceField]): Partial<BrandAppearance> => {
    return appearanceFieldPatch(scheme, field, value)
  }

  const updateField = async (
    field: AppearanceField,
    value: BrandAppearance[AppearanceField]
  ): Promise<boolean> => {
    setAppearanceError(null)
    try {
      await setAppearance(patchField(field, value))
      return true
    } catch (error) {
      const message = errorMessage(error, t('agentSkins.error.generic'))
      setAppearanceError(message)
      notifications.show({ color: 'red', message: t('agentSkins.notice.appearanceFailed', { message }) })
      return false
    }
  }

  const saveName = async () => {
    if (savingName) return
    const submittedRevision = nameDraftRevision.current
    setSavingName(true)
    try {
      await setUserName(nameDraft)
      if (nameDraftRevision.current === submittedRevision) {
        setNameDraft(useBrandStore.getState().name)
        setNameDirty(false)
      }
      notifications.show({ color: 'green', message: t('agentSkins.notice.nameSaved') })
    } catch (error) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.nameSaveFailed', {
        message: errorMessage(error, t('agentSkins.error.generic'))
      }) })
    } finally {
      setSavingName(false)
    }
  }

  const saveBgColor = async () => {
    const trimmed = bgColorDraft.trim()
    if (trimmed && !normalizeHexColor(trimmed)) {
      setAppearanceError(t('agentSkins.error.invalidBgColor'))
      return
    }
    const normalized = trimmed ? normalizeHexColor(trimmed)! : undefined
    const submittedRevision = bgColorDraftRevision.current
    const saved = await updateField('bgColor', normalized)
    if (saved && bgColorDraftRevision.current === submittedRevision) {
      setBgColorDraft(normalized || '')
      setBgColorDirty(false)
    }
  }

  const inheritBgColor = async () => {
    bgColorDraftRevision.current += 1
    setBgColorDirty(false)
    setBgColorDraft('')
    await updateField('bgColor', undefined)
  }

  const handleImageFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || uploadingImage) return
    if (file.size > MAX_LOCAL_IMAGE_BYTES) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.imageTooLarge') })
      return
    }
    const api = (window as { electronAPI?: { copyBgImage?: (file: File) => Promise<string | null> } }).electronAPI
    if (!api?.copyBgImage) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.localUnsupported') })
      return
    }
    const uploadScheme = scheme
    setUploadingImage(true)
    try {
      const url = await api.copyBgImage(file)
      if (!url || !isLocalBgImage(url)) throw new Error(t('agentSkins.notice.imageInvalid'))
      // copyBgImage 可能等待较久；此处从 store 取最新 action，并提交最小字段 patch。
      await useBrandAppearanceStore.getState().setAppearance(
        appearanceFieldPatch(uploadScheme, 'bgImage', url)
      )
      notifications.show({ color: 'green', message: t('agentSkins.notice.imageSaved') })
    } catch (error) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.imageFailed', {
        message: errorMessage(error, t('agentSkins.error.generic'))
      }) })
    } finally {
      setUploadingImage(false)
    }
  }

  const handleReset = async () => {
    if (resetting) return
    if (!window.confirm(t('agentSkins.appearance.resetConfirm'))) return
    setResetting(true)
    setAppearanceError(null)
    try {
      await resetAppearance()
      notifications.show({ color: 'green', message: t('agentSkins.notice.resetSuccess') })
    } catch (error) {
      const message = errorMessage(error, t('agentSkins.error.generic'))
      setAppearanceError(message)
      notifications.show({ color: 'red', message: t('agentSkins.notice.resetFailed', { message }) })
    } finally {
      setResetting(false)
    }
  }

  const fieldId = (name: string) => `${formId}-${name}`
  const bgSource = fieldSource('bgImage', skinAppearance, appearance, scheme)
  const colorSource = fieldSource('bgColor', skinAppearance, appearance, scheme)
  const bgOpacitySource = fieldSource('bgOpacity', skinAppearance, appearance, scheme)
  const panelOpacitySource = fieldSource('panelOpacity', skinAppearance, appearance, scheme)
  const bgDisplay = isLocalBgImage(currentBgImage)
    ? t('agentSkins.appearance.localImage')
    : t(`agentSkins.backgrounds.${findBgPreset(currentBgImage)?.id || 'none'}`, {
        defaultValue: findBgPreset(currentBgImage)?.name || t('agentSkins.appearance.noImage')
      })

  return (
    <section className={styles.appearanceSection} aria-label={t('agentSkins.appearance.title')}>
      {brandPersistenceError && (
        <div className={styles.persistentWarning} role="alert">
          <span>{t('agentSkins.warning.brandPersistence', { message: brandPersistenceError })}</span>
          <button
            type="button"
            className={styles.textBtn}
            aria-label={t('agentSkins.warning.dismissAria')}
            onClick={clearBrandPersistenceError}
          >
            {t('agentSkins.warning.dismiss')}
          </button>
        </div>
      )}
      {appearancePersistenceError && (
        <div className={styles.persistentWarning} role="alert">
          <span>{t('agentSkins.warning.appearancePersistence', { message: appearancePersistenceError })}</span>
          <button
            type="button"
            className={styles.textBtn}
            aria-label={t('agentSkins.warning.dismissAria')}
            onClick={clearAppearancePersistenceError}
          >
            {t('agentSkins.warning.dismiss')}
          </button>
        </div>
      )}

      <div className={styles.effectiveSummary} aria-label={t('agentSkins.appearance.effectiveAria')}>
        <strong>{t('agentSkins.appearance.effectiveTitle', {
          scheme: t(`agentSkins.appearance.${scheme}`)
        })}</strong>
        <span>{t('agentSkins.appearance.effectiveName', { value: userName, source: nameSource })}</span>
        <span>{t('agentSkins.appearance.effectiveImage', {
          value: bgDisplay,
          source: sourceText(bgSource.key)
        })}</span>
        <span>{t('agentSkins.appearance.effectiveColor', {
          value: effective.bgColor || (scheme === 'dark' ? '#36313f' : '#fbfaf7'),
          source: sourceText(colorSource.key)
        })}</span>
        <span>{t('agentSkins.appearance.effectiveOpacity', {
          background: bgOpacity,
          panel: panelOpacity
        })}</span>
      </div>

      <div className={styles.subsectionHead}>
        <h4 className={styles.subsectionTitle}>{t('agentSkins.appearance.brandTitle')}</h4>
        <span className={styles.fieldHint}>{t('agentSkins.appearance.brandHint')}</span>
      </div>
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label htmlFor={fieldId('app-name')} className={styles.fieldLabel}>{t('agentSkins.appearance.appName')}</label>
          <span className={styles.sourceBadge}>{nameSource}</span>
        </div>
        <div className={styles.inputActionRow}>
          <input
            id={fieldId('app-name')}
            className={styles.input}
            value={nameDraft}
            placeholder={DEFAULT_APP_NAME}
            maxLength={32}
            onChange={(event) => {
              nameDraftRevision.current += 1
              setNameDraft(event.target.value)
              setNameDirty(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void saveName()
              }
            }}
          />
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            disabled={savingName || !nameDirty}
            onClick={() => void saveName()}
          >
            <IconCheck size={14} stroke={1.8} aria-hidden="true" />
            {t(savingName ? 'agentSkins.appearance.savingName' : 'agentSkins.appearance.saveName')}
          </button>
          <button
            type="button"
            className={styles.textBtn}
            disabled={savingName || nameDraft === DEFAULT_APP_NAME}
            onClick={() => {
              nameDraftRevision.current += 1
              setNameDraft(DEFAULT_APP_NAME)
              setNameDirty(true)
            }}
          >
            {t('agentSkins.appearance.fillDefaultName')}
          </button>
        </div>
        <span className={styles.fieldHint}>{t('agentSkins.appearance.nameHint')}</span>
      </div>

      <div className={styles.subsectionHead}>
        <h4 className={styles.subsectionTitle}>{t('agentSkins.appearance.overrideTitle')}</h4>
        <span className={styles.fieldHint}>{t('agentSkins.appearance.overrideHint')}</span>
      </div>
      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>{t('agentSkins.appearance.background')}</legend>
        <div className={styles.labelRow}>
          <span className={styles.fieldHint}>{t('agentSkins.appearance.currentSource', {
            source: sourceText(bgSource.key)
          })}</span>
          {bgSource.userOverride && (
            <button type="button" className={styles.textBtn} onClick={() => void updateField('bgImage', undefined)}>
              {t('agentSkins.appearance.useInherited')}
            </button>
          )}
        </div>
        <div className={styles.presetGrid}>
          {BUILTIN_BG_PRESETS.map((preset) => {
            const active = currentBgImage === preset.id
            const presetName = t(`agentSkins.backgrounds.${preset.id}`, { defaultValue: preset.name })
            return (
              <button
                type="button"
                key={preset.id}
                className={`${styles.presetCard} ${active ? styles.presetCardActive : ''}`}
                style={preset.none ? { background: 'var(--dsh-surface)' } : { background: preset.cssValue }}
                aria-pressed={active}
                aria-label={t('agentSkins.appearance.presetAria', { name: presetName })}
                onClick={() => void updateField('bgImage', preset.id)}
              >
                <span className={`${styles.presetName} ${preset.none ? styles.presetNamePlain : ''}`}>{presetName}</span>
              </button>
            )
          })}
        </div>
        <div className={styles.toolbar}>
          <button type="button" className={styles.btn} onClick={() => fileInputRef.current?.click()} disabled={uploadingImage}>
            <IconUpload size={14} stroke={1.8} aria-hidden="true" />
            {t(uploadingImage ? 'agentSkins.appearance.processing' : 'agentSkins.appearance.chooseLocal')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className={styles.fileInput}
            aria-label={t('agentSkins.appearance.localFileAria')}
            onChange={(event) => void handleImageFile(event)}
          />
        </div>
        <span className={styles.fieldHint}>{t('agentSkins.appearance.localHint')}</span>
      </fieldset>

      <div className={styles.row2}>
        <div className={styles.half}>
          <div className={styles.field}>
            <div className={styles.labelRow}>
              <label htmlFor={fieldId('bg-color')} className={styles.fieldLabel}>{t('agentSkins.appearance.bgColor')}</label>
              <span className={styles.sourceBadge}>{sourceText(colorSource.key)}</span>
              {colorSource.userOverride && (
                <button type="button" className={styles.textBtn} onClick={() => void inheritBgColor()}>
                  {t('agentSkins.appearance.useInherited')}
                </button>
              )}
            </div>
            <div className={styles.colorRow}>
              <input
                type="color"
                className={styles.colorSwatch}
                aria-label={t('agentSkins.appearance.chooseColor')}
                value={normalizeHexColor(effective.bgColor) || (scheme === 'dark' ? '#36313f' : '#fbfaf7')}
                onChange={(event) => {
                  bgColorDraftRevision.current += 1
                  setBgColorDirty(false)
                  setBgColorDraft(event.target.value)
                  void updateField('bgColor', event.target.value)
                }}
              />
              <input
                id={fieldId('bg-color')}
                className={styles.input}
                value={bgColorDraft}
                maxLength={7}
                placeholder={t('agentSkins.appearance.colorPlaceholder')}
                onChange={(event) => {
                  bgColorDraftRevision.current += 1
                  setBgColorDraft(event.target.value)
                  setBgColorDirty(true)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void saveBgColor()
                  }
                }}
              />
              <button type="button" className={styles.textBtn} onClick={() => void saveBgColor()}>
                {t('agentSkins.appearance.apply')}
              </button>
            </div>
          </div>
        </div>

        <div className={styles.half}>
          <div className={styles.sliderRow}>
            <label htmlFor={fieldId('bg-opacity')} className={styles.sliderLabel}>
              <IconPhoto size={13} stroke={1.8} aria-hidden="true" />
              {t('agentSkins.appearance.bgOpacity')}
            </label>
            <input
              id={fieldId('bg-opacity')}
              type="range"
              min={0}
              max={100}
              className={styles.slider}
              value={bgOpacity}
              aria-valuetext={t('agentSkins.appearance.valueWithSource', {
                value: bgOpacity,
                source: sourceText(bgOpacitySource.key)
              })}
              onChange={(event) => void updateField('bgOpacity', Number(event.target.value))}
            />
            <output htmlFor={fieldId('bg-opacity')} className={styles.sliderValue}>{bgOpacity}%</output>
            {bgOpacitySource.userOverride && (
              <button type="button" className={styles.textBtn} onClick={() => void updateField('bgOpacity', undefined)}>
                {t('agentSkins.appearance.inherit')}
              </button>
            )}
          </div>
          <div className={styles.sliderRow}>
            <label htmlFor={fieldId('panel-opacity')} className={styles.sliderLabel}>{t('agentSkins.appearance.panelOpacity')}</label>
            <input
              id={fieldId('panel-opacity')}
              type="range"
              min={20}
              max={100}
              className={styles.slider}
              value={panelOpacity}
              aria-valuetext={t('agentSkins.appearance.valueWithSource', {
                value: panelOpacity,
                source: sourceText(panelOpacitySource.key)
              })}
              onChange={(event) => void updateField('panelOpacity', Number(event.target.value))}
            />
            <output htmlFor={fieldId('panel-opacity')} className={styles.sliderValue}>{panelOpacity}%</output>
            {panelOpacitySource.userOverride && (
              <button type="button" className={styles.textBtn} onClick={() => void updateField('panelOpacity', undefined)}>
                {t('agentSkins.appearance.inherit')}
              </button>
            )}
          </div>
          <span className={styles.fieldHint}>{t('agentSkins.appearance.editingScheme', {
            scheme: t(`agentSkins.appearance.${scheme}`)
          })}</span>
        </div>
      </div>

      {appearanceError && <div className={styles.errText} role="alert">{appearanceError}</div>}
      <div className={styles.resetRow}>
        <button type="button" className={`${styles.btn} ${styles.resetBtn}`} onClick={() => void handleReset()} disabled={resetting}>
          <IconRefresh size={14} stroke={1.8} aria-hidden="true" />
          {t(resetting ? 'agentSkins.appearance.resetting' : 'agentSkins.appearance.reset')}
        </button>
        <span className={styles.fieldHint}>{t('agentSkins.appearance.resetHint')}</span>
      </div>
    </section>
  )
}
