// 主题管理器：外观模式、主题切换、预览、新建/编辑/删除与导入导出。
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Menu } from '@mantine/core'
import {
  IconAdjustmentsHorizontal,
  IconArrowLeft,
  IconCheck,
  IconChevronDown,
  IconDeviceLaptop,
  IconDownload,
  IconEye,
  IconLoader2,
  IconMoon,
  IconPalette,
  IconPencil,
  IconPlus,
  IconSun,
  IconTrash,
  IconUpload,
  IconDots,
  IconX
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import { useTranslation } from 'react-i18next'
import AppSelect from '@/components/AppSelect'
import settings from '@/settings'
import { useSkinsStore } from '@/store/skins'
import {
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  builtinAgentPalette,
  findBuiltinSkin
} from '@/theme/skins/builtin'
import { deriveMantineColors, normalizeHexColor } from '@/theme/skins/colors'
import {
  MAX_SKIN_IMPORT_BYTES,
  normalizeSkinDefinition,
  SkinValidationError
} from '@/theme/skins/import'
import type { SkinDefinition, SkinSourceBundle } from '@/theme/skins/types'
import AppearancePanel from './AppearancePanel'
import { useAgentTheme, type AgentThemeMode } from './themeContext'
import styles from './skinsManager.module.scss'

function primaryColorOf(skin: SkinDefinition, scheme: 'light' | 'dark' = 'light'): string {
  const base = findBuiltinSkin(skin.base || DEFAULT_SKIN_ID)
  const ownPrimary = normalizeHexColor(skin.vars?.['--el-color-primary'])
    || normalizeHexColor(skin.mantineColors?.[6])
  return (scheme === 'dark' ? normalizeHexColor(skin.dark?.vars?.['--el-color-primary']) : null)
    || ownPrimary
    || (scheme === 'dark' ? normalizeHexColor(base?.dark?.vars?.['--el-color-primary']) : null)
    || normalizeHexColor(base?.vars?.['--el-color-primary'])
    || '#59167e'
}

function themePreviewStyle(skin: SkinDefinition, scheme: 'light' | 'dark'): CSSProperties {
  const primary = primaryColorOf(skin, scheme)
  const palette = scheme === 'dark' ? skin.dark?.mantineColors || skin.mantineColors : skin.mantineColors
  const soft = normalizeHexColor(palette?.[2]) || primary
  const base = skin.builtIn ? skin : findBuiltinSkin(skin.base || DEFAULT_SKIN_ID) || BUILTIN_SKINS[0]
  const agentPalette = builtinAgentPalette(base.id, scheme)
  return {
    '--theme-preview-accent': primary,
    '--theme-preview-soft': soft,
    '--theme-preview-bg': agentPalette.bg,
    '--theme-preview-surface': agentPalette.surface,
    '--theme-preview-line': agentPalette.faint
  } as CSSProperties
}

function ThemePreview({
  skin,
  scheme,
  active,
  currentLabel
}: {
  skin: SkinDefinition
  scheme: 'light' | 'dark'
  active: boolean
  currentLabel: string
}) {
  return (
    <span className={styles.preview} style={themePreviewStyle(skin, scheme)} aria-hidden="true">
      <span className={styles.previewWindow}>
        <span className={styles.previewSidebar}>
          <i />
          <i className={styles.previewNavActive} />
          <i />
          <i />
        </span>
        <span className={styles.previewCanvas}>
          <i className={styles.previewTitleLine} />
          <span className={styles.previewPanelRow}>
            <i />
            <i />
          </span>
          <i className={styles.previewLongLine} />
          <i className={styles.previewShortLine} />
        </span>
      </span>
      {active && (
        <span className={styles.activeMark}>
          <IconCheck size={12} stroke={2.2} />
          {currentLabel}
        </span>
      )}
      <span className={styles.previewChips}>
        <span className={styles.previewChip} style={{ background: primaryColorOf(skin, 'light') }} />
        <span className={styles.previewChip} style={{ background: primaryColorOf(skin, 'dark') }} />
      </span>
    </span>
  )
}

function bundleNameOf(source: SkinSourceBundle | undefined): string | null {
  if (!source) return null
  return source.name || source.package_name || null
}

interface EditorState {
  editingId: string | null
  original: SkinDefinition | null
  id: string
  name: string
  description: string
  base: string
  primaryColor: string
  darkPrimaryColor: string
  clearAppearance: boolean
  removeLegacyCss: boolean
}

const EMPTY_EDITOR: EditorState = {
  editingId: null,
  original: null,
  id: '',
  name: '',
  description: '',
  base: DEFAULT_SKIN_ID,
  primaryColor: '#1e6fff',
  darkPrimaryColor: '',
  clearAppearance: false,
  removeLegacyCss: true
}

function legacyCssOf(skin: SkinDefinition | null): string {
  if (!skin) return ''
  const darkCss = (skin.dark as unknown as { extraCss?: string } | undefined)?.extraCss
  return [skin.extraCss, darkCss].filter(Boolean).join('\n').trim()
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function editorSignature(editor: EditorState): string {
  return JSON.stringify({
    id: editor.id,
    name: editor.name,
    description: editor.description,
    base: editor.base,
    primaryColor: editor.primaryColor,
    darkPrimaryColor: editor.darkPrimaryColor,
    clearAppearance: editor.clearAppearance,
    removeLegacyCss: editor.removeLegacyCss
  })
}

function createThemeId(skins: SkinDefinition[]): string {
  const used = new Set(skins.map((skin) => skin.id))
  const stem = `custom-${Date.now().toString(36)}`
  if (!used.has(stem)) return stem
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}`
    if (!used.has(candidate)) return candidate
  }
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function editorPreviewSkin(editor: EditorState): SkinDefinition {
  const primary = normalizeHexColor(editor.primaryColor) || '#1e6fff'
  const darkPrimary = normalizeHexColor(editor.darkPrimaryColor)
  return {
    id: editor.id || 'preview',
    name: editor.name || 'Theme',
    builtIn: false,
    source: 'user',
    base: editor.base,
    vars: { '--el-color-primary': primary },
    mantineColors: deriveMantineColors(primary),
    ...(darkPrimary ? {
      dark: {
        vars: { '--el-color-primary': darkPrimary },
        mantineColors: deriveMantineColors(darkPrimary)
      }
    } : {})
  }
}

export default function SkinsManager() {
  const { t } = useTranslation()
  const { mode, scheme, setMode } = useAgentTheme()
  const customThemesEnabled = settings.enableCustomThemes !== false
  const userSkins = useSkinsStore((state) => state.userSkins)
  const profileThemes = useSkinsStore((state) => state.profileThemes)
  const skins = useMemo(() => useSkinsStore.getState().listSkins(), [userSkins, profileThemes])
  const activeSkinId = useSkinsStore((state) => state.activeSkinId)
  const appliedSkinId = useSkinsStore((state) => state.appliedSkinId)
  const persistenceError = useSkinsStore((state) => state.persistenceError)
  const profileThemeWarnings = useSkinsStore((state) => state.profileThemeWarnings)
  const setActiveSkin = useSkinsStore((state) => state.setActiveSkin)
  const deleteUserSkin = useSkinsStore((state) => state.deleteUserSkin)
  const saveUserSkin = useSkinsStore((state) => state.saveUserSkin)
  const previewSkin = useSkinsStore((state) => state.previewSkin)
  const previewUserSkin = useSkinsStore((state) => state.previewUserSkin)
  const clearThemePreview = useSkinsStore((state) => state.clearThemePreview)
  const importSkinFromText = useSkinsStore((state) => state.importSkinFromText)
  const exportSkinToText = useSkinsStore((state) => state.exportSkinToText)
  const clearPersistenceError = useSkinsStore((state) => state.clearPersistenceError)

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorErr, setEditorErr] = useState<string | null>(null)
  const [savingEditor, setSavingEditor] = useState(false)
  const [pendingSkinId, setPendingSkinId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [dismissedProfileWarnings, setDismissedProfileWarnings] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorTitleRef = useRef<HTMLHeadingElement>(null)
  const editorBaselineRef = useRef('')
  const formId = useId()
  const profileWarningSignature = useMemo(() => profileThemeWarnings.join('\n'), [profileThemeWarnings])
  const showProfileWarnings = Boolean(
    profileWarningSignature && profileWarningSignature !== dismissedProfileWarnings
  )
  const editorOpen = editor !== null
  const editorDirty = Boolean(editor && editorSignature(editor) !== editorBaselineRef.current)

  useEffect(() => {
    if (!editor) return
    const frame = window.requestAnimationFrame(() => {
      const target = editorTitleRef.current
      if (!target) return
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      target.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' })
      target.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [editorOpen, editor?.editingId])

  const displayNameOf = (skin: SkinDefinition) => skin.builtIn
    ? t(`agentSkins.builtin.${skin.id}.name`, { defaultValue: skin.name })
    : skin.name
  const displayDescriptionOf = (skin: SkinDefinition) => skin.builtIn
    ? t(`agentSkins.builtin.${skin.id}.description`, { defaultValue: skin.description || '' })
    : skin.description
  const sourceLabelOf = (skin: SkinDefinition, bundleName: string | null) => bundleName
    ? t('agentSkins.source.profileNamed', { name: bundleName })
    : t(`agentSkins.source.${skin.source || 'user'}`, { defaultValue: skin.source || 'user' })
  const themeGroups = [
    {
      key: 'builtin',
      title: t('agentSkins.manager.builtinGroup'),
      description: t('agentSkins.manager.builtinGroupHint'),
      items: skins.filter((skin) => skin.builtIn)
    },
    {
      key: 'user',
      title: t('agentSkins.manager.userGroup'),
      description: t('agentSkins.manager.userGroupHint'),
      items: skins.filter((skin) => !skin.builtIn && skin.source !== 'profile')
    },
    {
      key: 'profile',
      title: t('agentSkins.manager.profileGroup'),
      description: t('agentSkins.manager.profileGroupHint'),
      items: skins.filter((skin) => skin.source === 'profile')
    }
  ].filter((group) => group.items.length > 0)

  const handleSelect = async (skin: SkinDefinition) => {
    if (pendingSkinId) return
    if (editorDirty && !window.confirm(t('agentSkins.editor.discardConfirm'))) return
    if (editor) {
      clearThemePreview()
      setEditor(null)
      setEditorErr(null)
    }
    if (skin.id === activeSkinId) return
    setPendingSkinId(skin.id)
    try {
      await setActiveSkin(skin.id)
      notifications.show({ color: 'brand', message: t('agentSkins.notice.switchSuccess', { name: displayNameOf(skin) }) })
    } catch (error) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.switchFailed', {
        message: errorMessage(error, t('agentSkins.error.generic'))
      }) })
    } finally {
      setPendingSkinId(null)
    }
  }

  const handleDelete = async (skin: SkinDefinition) => {
    if (skin.builtIn || skin.source === 'profile' || pendingSkinId) return
    const displayName = displayNameOf(skin)
    if (!window.confirm(t('agentSkins.notice.deleteConfirm', { name: displayName }))) return
    setPendingSkinId(skin.id)
    try {
      await deleteUserSkin(skin.id)
      if (editor?.editingId === skin.id) {
        clearThemePreview()
        setEditor(null)
        setEditorErr(null)
      }
      notifications.show({ color: 'green', message: t('agentSkins.notice.deleteSuccess', { name: displayName }) })
    } catch (error) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.deleteFailed', {
        message: errorMessage(error, t('agentSkins.error.generic'))
      }) })
    } finally {
      setPendingSkinId(null)
    }
  }

  const handleExport = (skin: SkinDefinition) => {
    try {
      const text = exportSkinToText(skin.id)
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${skin.builtIn ? `${skin.id}-copy` : skin.id}.theme.json`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (error) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.exportFailed', {
        message: errorMessage(error, t('agentSkins.error.generic'))
      }) })
    }
  }

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || importing) return
    if (file.size > MAX_SKIN_IMPORT_BYTES) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.importTooLarge') })
      return
    }
    setImporting(true)
    try {
      const skin = await importSkinFromText(await file.text())
      notifications.show({ color: 'green', message: t('agentSkins.notice.importSuccess', { name: skin.name }) })
    } catch (error) {
      notifications.show({ color: 'red', message: t('agentSkins.notice.importFailed', {
        message: errorMessage(error, t('agentSkins.error.generic'))
      }) })
    } finally {
      setImporting(false)
    }
  }

  const openEditor = (nextEditor: EditorState) => {
    if (editorDirty && !window.confirm(t('agentSkins.editor.discardConfirm'))) return
    clearThemePreview()
    editorBaselineRef.current = editorSignature(nextEditor)
    setEditor(nextEditor)
    setEditorErr(null)
  }

  const startCreate = () => {
    openEditor({ ...EMPTY_EDITOR, id: createThemeId(skins) })
  }

  const startEdit = (skin: SkinDefinition) => {
    openEditor({
      editingId: skin.id,
      original: skin,
      id: skin.id,
      name: skin.name,
      description: skin.description || '',
      base: skin.base || DEFAULT_SKIN_ID,
      primaryColor: primaryColorOf(skin),
      darkPrimaryColor: normalizeHexColor(skin.dark?.vars?.['--el-color-primary']) || '',
      clearAppearance: false,
      removeLegacyCss: !legacyCssOf(skin)
    })
  }

  const cancelEditor = () => {
    if (savingEditor) return
    if (editorDirty && !window.confirm(t('agentSkins.editor.discardConfirm'))) return
    clearThemePreview()
    setEditor(null)
    setEditorErr(null)
  }

  const handleImportClick = () => {
    if (editorDirty && !window.confirm(t('agentSkins.editor.discardConfirm'))) return
    if (editor) {
      clearThemePreview()
      setEditor(null)
      setEditorErr(null)
    }
    fileInputRef.current?.click()
  }

  const updateEditor = (patch: Partial<EditorState>) => {
    clearThemePreview()
    setEditor((current) => current ? { ...current, ...patch } : current)
  }

  const buildEditorTheme = (): SkinDefinition => {
    if (!editor) throw new SkinValidationError(t('agentSkins.editor.missingSkin'))
    if (legacyCssOf(editor.original) && !editor.removeLegacyCss) {
      throw new SkinValidationError(t('agentSkins.editor.removeCssFirst'))
    }
    const primary = normalizeHexColor(editor.primaryColor)
    if (!primary) throw new SkinValidationError(t('agentSkins.editor.invalidPrimary'))
    const darkPrimary = editor.darkPrimaryColor
      ? normalizeHexColor(editor.darkPrimaryColor)
      : null
    if (editor.darkPrimaryColor && !darkPrimary) {
      throw new SkinValidationError(t('agentSkins.editor.invalidDarkPrimary'))
    }
    const dark = darkPrimary
      ? {
          vars: { '--el-color-primary': darkPrimary },
          mantineColors: deriveMantineColors(darkPrimary)
        }
      : undefined
    const originalAppearance = editor.clearAppearance ? undefined : editor.original?.appearance
    const appearance = originalAppearance ? { ...originalAppearance } : undefined
    if (appearance) delete appearance.appName
    return normalizeSkinDefinition({
      ...(editor.original || {}),
      id: editor.id.trim(),
      name: editor.name.trim(),
      description: editor.description.trim() || undefined,
      base: editor.base,
      vars: { '--el-color-primary': primary },
      mantineColors: deriveMantineColors(primary),
      dark,
      appearance,
      extraCss: undefined
    })
  }

  const previewEditor = () => {
    if (!editor || savingEditor) return
    if (previewSkin) {
      clearThemePreview()
      return
    }
    setEditorErr(null)
    try {
      previewUserSkin(buildEditorTheme())
    } catch (error) {
      setEditorErr(errorMessage(error, t('agentSkins.error.generic')))
    }
  }

  const saveEditor = async () => {
    if (!editor || savingEditor) return
    setEditorErr(null)

    setSavingEditor(true)
    try {
      const normalized = buildEditorTheme()
      const saved = await saveUserSkin(normalized, editor.editingId)
      notifications.show({ color: 'green', message: t(
        editor.editingId ? 'agentSkins.notice.updateSuccess' : 'agentSkins.notice.createSuccess',
        { name: saved.name }
      ) })
      setEditor(null)
    } catch (error) {
      setEditorErr(errorMessage(error, t('agentSkins.error.generic')))
    } finally {
      setSavingEditor(false)
    }
  }

  const idFor = (field: string) => `${formId}-${field}`

  const renderThemeCard = (skin: SkinDefinition) => {
    const active = skin.id === appliedSkinId
    const editable = customThemesEnabled && !skin.builtIn && skin.source !== 'profile'
    const exportable = customThemesEnabled && skin.source !== 'profile'
    const bundleName = bundleNameOf(skin.source_bundle)
    const displayName = displayNameOf(skin)
    const displayDescription = displayDescriptionOf(skin)
    const pending = pendingSkinId === skin.id
    return (
      <article key={skin.id} className={`${styles.card} ${active ? styles.cardActive : ''}`}>
        <button
          type="button"
          className={styles.cardSelect}
          aria-pressed={active}
          aria-label={t(active ? 'agentSkins.manager.currentCard' : 'agentSkins.manager.switchCard', {
            name: displayName
          })}
          disabled={Boolean(pendingSkinId)}
          onClick={() => void handleSelect(skin)}
        >
          <ThemePreview
            skin={skin}
            scheme={scheme}
            active={active}
            currentLabel={t('agentSkins.manager.current')}
          />
          <span className={styles.cardCopy}>
            <strong className={styles.cardName}>{displayName}</strong>
            {displayDescription && <span className={styles.cardDesc}>{displayDescription}</span>}
            <span className={styles.cardSource}>{sourceLabelOf(skin, bundleName)}</span>
          </span>
        </button>

        {(editable || exportable) && (
          <Menu position="bottom-end" withinPortal shadow="sm">
            <Menu.Target>
              <button
                type="button"
                className={styles.cardMenuButton}
                aria-label={t('agentSkins.manager.actionsAria', { name: displayName })}
                disabled={Boolean(pendingSkinId)}
              >
                <IconDots size={15} stroke={1.8} aria-hidden="true" />
              </button>
            </Menu.Target>
            <Menu.Dropdown>
              {editable && (
                <Menu.Item
                  leftSection={<IconPencil size={14} stroke={1.8} />}
                  onClick={() => startEdit(skin)}
                >
                  {t('agentSkins.manager.edit')}
                </Menu.Item>
              )}
              {exportable && (
                <Menu.Item
                  leftSection={<IconDownload size={14} stroke={1.8} />}
                  onClick={() => handleExport(skin)}
                >
                  {skin.builtIn ? t('agentSkins.manager.exportBuiltin') : t('agentSkins.manager.export')}
                </Menu.Item>
              )}
              {editable && (
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} stroke={1.8} />}
                  onClick={() => void handleDelete(skin)}
                >
                  {t('agentSkins.manager.delete')}
                </Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
        )}

        {pending && (
          <span className={styles.pendingOverlay} role="status">
            <IconLoader2 size={14} stroke={1.8} className={styles.spinner} aria-hidden="true" />
            {t('agentSkins.manager.pending')}
          </span>
        )}
      </article>
    )
  }

  return (
    <div className={styles.manager}>
      {persistenceError && (
        <div className={styles.persistentWarning} role="alert">
          <span>{t('agentSkins.warning.skinPersistence', { message: persistenceError })}</span>
          <button
            type="button"
            className={styles.textBtn}
            aria-label={t('agentSkins.warning.dismissAria')}
            onClick={clearPersistenceError}
          >
            {t('agentSkins.warning.dismiss')}
          </button>
        </div>
      )}
      {showProfileWarnings && (
        <div className={styles.persistentWarning} role="alert">
          <div className={styles.warningBody}>
            <strong>{t('agentSkins.warning.profileTitle', { count: profileThemeWarnings.length })}</strong>
            <ul className={styles.warningList}>
              {profileThemeWarnings.slice(0, 5).map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
              {profileThemeWarnings.length > 5 && (
                <li>{t('agentSkins.warning.profileMore', { count: profileThemeWarnings.length - 5 })}</li>
              )}
            </ul>
          </div>
          <button
            type="button"
            className={styles.textBtn}
            aria-label={t('agentSkins.warning.dismissProfileAria')}
            onClick={() => setDismissedProfileWarnings(profileWarningSignature)}
          >
            {t('agentSkins.warning.dismiss')}
          </button>
        </div>
      )}
      <section className={styles.modeBar} aria-labelledby={idFor('mode-title')}>
        <div className={styles.modeCopy}>
          <span className={styles.modeIcon} aria-hidden="true"><IconAdjustmentsHorizontal size={17} /></span>
          <div>
            <h2 id={idFor('mode-title')} className={styles.modeTitle}>{t('agentSkins.mode.title')}</h2>
            <p className={styles.modeDesc}>{t('agentSkins.mode.resolved', {
              scheme: t(`agentSkins.mode.${scheme}`)
            })}</p>
          </div>
        </div>
        <div className={styles.modeSegments} role="group" aria-label={t('agentSkins.mode.aria')}>
          {([
            { value: 'system', label: t('agentSkins.mode.system'), Icon: IconDeviceLaptop },
            { value: 'light', label: t('agentSkins.mode.light'), Icon: IconSun },
            { value: 'dark', label: t('agentSkins.mode.dark'), Icon: IconMoon }
          ] as Array<{ value: AgentThemeMode; label: string; Icon: typeof IconSun }>).map((item) => (
            <button
              key={item.value}
              type="button"
              className={`${styles.modeSegment} ${mode === item.value ? styles.modeSegmentActive : ''}`}
              aria-pressed={mode === item.value}
              onClick={() => setMode(item.value)}
            >
              <item.Icon size={14} stroke={1.8} aria-hidden="true" />
              {item.label}
            </button>
          ))}
        </div>
      </section>

      <section className={styles.library} aria-labelledby={idFor('library-title')}>
        <header className={styles.libraryHeader}>
          <div>
            <span className={styles.eyebrow}>{t('agentSkins.manager.libraryEyebrow')}</span>
            <h2
              ref={editor ? editorTitleRef : undefined}
              id={idFor('library-title')}
              className={styles.libraryTitle}
              tabIndex={editor ? -1 : undefined}
            >
              {editor
                ? t(editor.editingId ? 'agentSkins.editor.editTitle' : 'agentSkins.editor.newTitle')
                : t('agentSkins.manager.libraryTitle')}
            </h2>
            <p className={styles.libraryDescription}>
              {editor ? t('agentSkins.editor.workspaceHint') : t('agentSkins.manager.libraryHint')}
            </p>
          </div>
          {!editor && customThemesEnabled && (
            <div className={styles.libraryActions}>
              <button
                type="button"
                className={styles.btn}
                onClick={handleImportClick}
                disabled={importing || Boolean(pendingSkinId)}
              >
                {importing
                  ? <IconLoader2 size={14} stroke={1.8} className={styles.spinner} aria-hidden="true" />
                  : <IconUpload size={14} stroke={1.8} aria-hidden="true" />}
                {importing ? t('agentSkins.manager.importing') : t('agentSkins.manager.importSkin')}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.primary}`}
                onClick={startCreate}
                disabled={Boolean(pendingSkinId)}
              >
                <IconPlus size={14} stroke={1.8} aria-hidden="true" />
                {t('agentSkins.manager.newSkin')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className={styles.fileInput}
                aria-label={t('agentSkins.manager.importFileAria')}
                onChange={(event) => void handleImportFile(event)}
              />
            </div>
          )}
        </header>

        {!editor && (
          <div className={styles.themeGroups} aria-label={t('agentSkins.manager.gridAria')}>
            {themeGroups.map((group) => (
              <section key={group.key} className={styles.themeGroup} aria-labelledby={idFor(`group-${group.key}`)}>
                <div className={styles.groupHeader}>
                  <div>
                    <h3 id={idFor(`group-${group.key}`)}>{group.title}</h3>
                    <p>{group.description}</p>
                  </div>
                  <span>{group.items.length}</span>
                </div>
                <div className={styles.grid}>
                  {group.items.map(renderThemeCard)}
                </div>
              </section>
            ))}
          </div>
        )}

      {editor && (
        <form
          className={styles.editor}
          aria-labelledby={idFor('library-title')}
          onSubmit={(event) => {
            event.preventDefault()
            void saveEditor()
          }}
        >
          <button type="button" className={styles.editorBack} onClick={cancelEditor} disabled={savingEditor}>
            <IconArrowLeft size={14} stroke={1.8} aria-hidden="true" />
            {t('agentSkins.editor.backToLibrary')}
          </button>

          {previewSkin && (
            <div className={styles.previewNotice} role="status">
              <div>
                <strong>{t('agentSkins.editor.previewTitle', { name: previewSkin.name })}</strong>
                <span>{t('agentSkins.editor.previewHint')}</span>
              </div>
              <button type="button" className={styles.textBtn} onClick={clearThemePreview}>
                {t('agentSkins.editor.endPreview')}
              </button>
            </div>
          )}

          <div className={styles.editorLayout}>
          <aside className={styles.editorPreviewPane} aria-label={t('agentSkins.editor.draftPreviewAria')}>
            <ThemePreview
              skin={editorPreviewSkin(editor)}
              scheme={scheme}
              active={false}
              currentLabel=""
            />
            <div className={styles.editorPreviewCopy}>
              <strong>{editor.name.trim() || t('agentSkins.editor.untitled')}</strong>
              <span>{t('agentSkins.editor.draftPreviewHint')}</span>
            </div>
          </aside>
          <fieldset className={styles.editorFields} disabled={savingEditor}>
          <div className={styles.field}>
            <label htmlFor={idFor('name')} className={styles.fieldLabel}>{t('agentSkins.editor.name')}</label>
            <input
              id={idFor('name')}
              className={styles.input}
              value={editor.name}
              maxLength={64}
              required
              placeholder={t('agentSkins.editor.namePlaceholder')}
              onChange={(event) => updateEditor({ name: event.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={idFor('description')} className={styles.fieldLabel}>{t('agentSkins.editor.description')}</label>
            <div className={styles.inputActionRow}>
              <input
                id={idFor('description')}
                className={styles.input}
                value={editor.description}
                maxLength={512}
                placeholder={t('agentSkins.editor.optional')}
                onChange={(event) => updateEditor({ description: event.target.value })}
              />
              <button
                type="button"
                className={styles.textBtn}
                disabled={!editor.description}
                onClick={() => updateEditor({ description: '' })}
              >
                {t('agentSkins.editor.clear')}
              </button>
            </div>
          </div>
          <div className={styles.field}>
            <label htmlFor={idFor('base')} className={styles.fieldLabel}>{t('agentSkins.editor.base')}</label>
            <AppSelect
              id={idFor('base')}
              aria-describedby={idFor('base-hint')}
              value={editor.base}
              disabled={savingEditor}
              onChange={(base) => updateEditor({ base })}
              options={BUILTIN_SKINS.map((skin) => ({
                value: skin.id,
                label: t(`agentSkins.builtin.${skin.id}.name`, { defaultValue: skin.name })
              }))}
            />
            <span id={idFor('base-hint')} className={styles.fieldHint}>{t('agentSkins.editor.baseHint')}</span>
          </div>
          <div className={styles.field}>
            <label htmlFor={idFor('primary')} className={styles.fieldLabel}>{t('agentSkins.editor.primary')}</label>
            <div className={styles.colorRow}>
              <input
                type="color"
                className={styles.colorSwatch}
                aria-label={t('agentSkins.editor.selectPrimary')}
                value={normalizeHexColor(editor.primaryColor) || '#1e6fff'}
                onChange={(event) => updateEditor({ primaryColor: event.target.value })}
              />
              <input
                id={idFor('primary')}
                className={styles.input}
                value={editor.primaryColor}
                required
                maxLength={7}
                placeholder="#1e6fff"
                aria-describedby={idFor('primary-hint')}
                onChange={(event) => updateEditor({ primaryColor: event.target.value })}
              />
            </div>
            <span id={idFor('primary-hint')} className={styles.fieldHint}>{t('agentSkins.editor.primaryHint')}</span>
          </div>
          <div className={styles.field}>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={Boolean(editor.darkPrimaryColor)}
                onChange={(event) => updateEditor({
                  darkPrimaryColor: event.target.checked ? editor.primaryColor : ''
                })}
              />
              {t('agentSkins.editor.separateDark')}
            </label>
            {editor.darkPrimaryColor && (
              <div className={styles.colorRow}>
                <input
                  type="color"
                  className={styles.colorSwatch}
                  aria-label={t('agentSkins.editor.selectDark')}
                  value={normalizeHexColor(editor.darkPrimaryColor) || '#9aa0aa'}
                  onChange={(event) => updateEditor({ darkPrimaryColor: event.target.value })}
                />
                <input
                  id={idFor('dark-primary')}
                  className={styles.input}
                  aria-label={t('agentSkins.editor.darkHexAria')}
                  value={editor.darkPrimaryColor}
                  maxLength={7}
                  onChange={(event) => updateEditor({ darkPrimaryColor: event.target.value })}
                />
                <button type="button" className={styles.textBtn} onClick={() => updateEditor({ darkPrimaryColor: '' })}>
                  {t('agentSkins.editor.clearDark')}
                </button>
              </div>
            )}
          </div>

          {editor.original?.appearance && (
            <div className={styles.preservedRow}>
              <span>{t(editor.clearAppearance
                ? 'agentSkins.editor.appearanceCleared'
                : 'agentSkins.editor.appearanceKept')}</span>
              <button
                type="button"
                className={styles.textBtn}
                onClick={() => updateEditor({ clearAppearance: !editor.clearAppearance })}
              >
                {t(editor.clearAppearance
                  ? 'agentSkins.editor.restoreKept'
                  : 'agentSkins.editor.clearAppearance')}
              </button>
            </div>
          )}

          {legacyCssOf(editor.original) && (
            <div className={styles.securityWarning} role="alert">
              <span>{t('agentSkins.editor.legacyCssWarning')}</span>
              <button
                type="button"
                className={styles.textBtn}
                disabled={editor.removeLegacyCss}
                onClick={() => updateEditor({ removeLegacyCss: true })}
              >
                {t(editor.removeLegacyCss
                  ? 'agentSkins.editor.legacyCssRemoved'
                  : 'agentSkins.editor.removeLegacyCss')}
              </button>
            </div>
          )}
          <p className={styles.fieldHint}>{t('agentSkins.editor.noRawCss')}</p>
          </fieldset>
          </div>
          {editorErr && <div className={styles.errText} role="alert">{editorErr}</div>}
          <div className={styles.editorActions}>
            <button type="button" className={styles.btn} onClick={cancelEditor} disabled={savingEditor}>
              <IconX size={14} stroke={1.8} aria-hidden="true" />
              {t('agentSkins.editor.cancel')}
            </button>
            <button type="button" className={styles.btn} onClick={previewEditor} disabled={savingEditor}>
              <IconEye size={14} stroke={1.8} aria-hidden="true" />
              {t(previewSkin ? 'agentSkins.editor.endPreview' : 'agentSkins.editor.preview')}
            </button>
            <button type="submit" className={`${styles.btn} ${styles.primary}`} disabled={savingEditor}>
              {savingEditor
                ? <IconLoader2 size={14} stroke={1.8} className={styles.spinner} aria-hidden="true" />
                : <IconCheck size={14} stroke={1.8} aria-hidden="true" />}
              {t(savingEditor ? 'agentSkins.editor.saving' : 'agentSkins.editor.saveApply')}
            </button>
          </div>
        </form>
      )}
      </section>

      <section className={styles.appearanceDisclosure}>
        <button
          type="button"
          className={styles.appearanceTrigger}
          aria-expanded={appearanceOpen}
          aria-controls={idFor('appearance-content')}
          onClick={() => setAppearanceOpen((value) => !value)}
        >
          <span className={styles.appearanceIcon} aria-hidden="true"><IconPalette size={17} /></span>
          <span className={styles.appearanceTriggerCopy}>
            <strong>{t('agentSkins.appearance.title')}</strong>
            <span>{t('agentSkins.appearance.disclosureHint')}</span>
          </span>
          <IconChevronDown
            size={16}
            className={`${styles.disclosureChevron} ${appearanceOpen ? styles.disclosureChevronOpen : ''}`}
            aria-hidden="true"
          />
        </button>
        {appearanceOpen && (
          <div id={idFor('appearance-content')} className={styles.appearanceContent}>
            <AppearancePanel />
          </div>
        )}
      </section>
    </div>
  )
}
