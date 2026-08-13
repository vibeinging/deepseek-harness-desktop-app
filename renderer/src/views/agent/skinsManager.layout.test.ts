import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manager = readFileSync(new URL('./SkinsManager.tsx', import.meta.url), 'utf8')
const appearance = readFileSync(new URL('./AppearancePanel.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./AgentSettings.tsx', import.meta.url), 'utf8')
const theme = readFileSync(new URL('./agent-theme.scss', import.meta.url), 'utf8')
const agentStyles = readFileSync(new URL('./agent.module.scss', import.meta.url), 'utf8')
const managerStyles = readFileSync(new URL('./skinsManager.module.scss', import.meta.url), 'utf8')
const settingsStyles = readFileSync(new URL('./AgentSettings.module.scss', import.meta.url), 'utf8')

describe('皮肤管理器交互与主题布局', () => {
  it('卡片使用真实按钮且无嵌套 role=button', () => {
    expect(manager).toContain('className={styles.cardSelect}')
    expect(manager).toContain('className={styles.themeGroups}')
    expect(manager).toContain('<div className={styles.grid}>')
    expect(manager).toContain('<Menu')
    expect(manager).toContain('role="group"')
    expect(manager).toContain('aria-pressed={active}')
    expect(manager).toContain('state.appliedSkinId')
    expect(manager).toContain('const active = skin.id === appliedSkinId')
    expect(manager).not.toContain('role="button"')
    expect(appearance).not.toContain('role="button"')
  })

  it('内置皮肤仅可导出，自定义可编辑/导出/删除，Profile 主题不导出', () => {
    expect(manager).toContain("const editable = customThemesEnabled && !skin.builtIn && skin.source !== 'profile'")
    expect(manager).toContain("const exportable = customThemesEnabled && skin.source !== 'profile'")
    expect(manager).toContain("skin.builtIn ? t('agentSkins.manager.exportBuiltin')")
    expect(manager).toContain('{editable && (')
    expect(manager).toContain('{exportable && (')
  })

  it('表单字段有 label 关联与错误播报', () => {
    expect(manager).toContain('htmlFor={idFor(\'name\')}')
    expect(manager).toContain('htmlFor={idFor(\'primary\')}')
    expect(manager).toContain('role="alert"')
    expect(appearance).toContain('htmlFor={fieldId(\'app-name\')}')
    expect(appearance).toContain('aria-valuetext=')
    expect(manager).toContain('<fieldset className={styles.editorFields} disabled={savingEditor}>')
  })

  it('基础皮肤使用统一 AppSelect 并保留标签、提示和禁用契约', () => {
    expect(manager).toContain("import AppSelect from '@/components/AppSelect'")
    expect(manager).toContain('htmlFor={idFor(\'base\')}')
    expect(manager).toContain('aria-describedby={idFor(\'base-hint\')}')
    expect(manager).toContain('disabled={savingEditor}')
    expect(manager).toContain('onChange={(base) => updateEditor({ base })}')
    expect(manager).toContain('options={BUILTIN_SKINS.map((skin) => ({')
    expect(manager).toContain("t(`agentSkins.builtin.${skin.id}.name`")
    expect(manager).not.toContain('<select')
  })

  it('外观模式与主题选择分层，编辑器支持不持久化预览和保存并应用', () => {
    expect(manager).toContain("t('agentSkins.mode.title')")
    expect(manager).toContain('className={styles.modeSegments}')
    expect(manager).toContain('aria-pressed={mode === item.value}')
    expect(manager).toContain('onClick={() => setMode(item.value)}')
    expect(manager).toContain('previewUserSkin(buildEditorTheme())')
    expect(manager).toContain('clearThemePreview()')
    expect(manager).toContain('saveUserSkin(normalized, editor.editingId)')
    expect(settings).not.toContain('label="界面主题"')
  })

  it('新建主题隐藏内部 ID，编辑切换保护未保存草稿并把编辑区带入视野', () => {
    expect(manager).toContain('id: createThemeId(skins)')
    expect(manager).toContain("window.confirm(t('agentSkins.editor.discardConfirm'))")
    expect(manager).toContain("target.scrollIntoView({ block: 'nearest'")
    expect(manager).toContain('target.focus({ preventScroll: true })')
    expect(manager).not.toContain("htmlFor={idFor('id')}")
    expect(manager).not.toContain("id={idFor('id')}")
  })

  it('自定义主题参数默认配置在 settings，并同时控制管理入口和卡片操作', () => {
    expect(manager).toContain("import settings from '@/settings'")
    expect(manager).toContain('const customThemesEnabled = settings.enableCustomThemes !== false')
    expect(manager).toContain('!editor && customThemesEnabled && (')
    expect(manager).toContain('className={styles.libraryActions}')
    expect(manager).toContain('const editable = customThemesEnabled &&')
    expect(manager).toContain('const exportable = customThemesEnabled &&')
  })

  it('主题按来源分组，卡片使用真实界面缩略图并把管理操作收进菜单', () => {
    expect(manager).toContain('themeGroups.map((group) =>')
    expect(manager).toContain("key: 'builtin'")
    expect(manager).toContain("key: 'user'")
    expect(manager).toContain("key: 'profile'")
    expect(manager).toContain('function ThemePreview')
    expect(manager).toContain('className={styles.previewWindow}')
    expect(manager).toContain('<Menu.Target>')
    expect(manager).toContain('<Menu.Dropdown>')
  })

  it('主题编辑是独立工作区，个人外观默认收起并按需展开', () => {
    expect(manager).toContain('{!editor && (')
    expect(manager).toContain('{editor && (')
    expect(manager).toContain('className={styles.editorLayout}')
    expect(manager).toContain('skin={editorPreviewSkin(editor)}')
    expect(manager).toContain('const [appearanceOpen, setAppearanceOpen] = useState(false)')
    expect(manager).toContain('aria-expanded={appearanceOpen}')
    expect(manager).toContain('{appearanceOpen && (')
    expect(appearance).not.toContain("className={styles.editorTitle}>{t('agentSkins.appearance.title')}")
  })

  it('预览有明确的未保存状态并可一键结束，活动卡片与忙碌状态有可见反馈', () => {
    expect(manager).toContain("t('agentSkins.editor.previewTitle', { name: previewSkin.name })")
    expect(manager).toContain("t('agentSkins.editor.previewHint')")
    expect(manager).toContain("t('agentSkins.editor.endPreview')")
    expect(manager).toContain('className={styles.activeMark}')
    expect(manager).toContain('className={styles.spinner}')
    expect(manager).toContain('role="status"')
  })

  it('应用名使用本地草稿，外观 reset 文案接入翻译并说明继承关系', () => {
    expect(appearance).toContain('useState(userName)')
    expect(appearance).toContain('setNameDraft(event.target.value)')
    expect(appearance).not.toContain('onChange={(event) => setUserName')
    expect(appearance).toContain("t('agentSkins.appearance.resetConfirm')")
    expect(appearance).toContain("t('agentSkins.appearance.resetHint')")
    expect(appearance).toContain('nameDraftRevision.current === submittedRevision')
    expect(appearance).toContain('bgColorDraftRevision.current += 1')
  })

  it('皮肤管理、外观与设置入口都使用同一组 i18n 文案', () => {
    expect(manager).toContain('useTranslation()')
    expect(appearance).toContain('useTranslation()')
    expect(settings).toContain("t('agentSkins.settings.navLabel')")
    expect(settings).toContain("t('agentSkins.settings.pageLead')")
  })

  it('启动恢复或保存错误会直接渲染可关闭的持久警告', () => {
    expect(manager).toContain('state.persistenceError')
    expect(manager).toContain('state.profileThemeWarnings')
    expect(manager).toContain('onClick={clearPersistenceError}')
    expect(manager).toContain('setDismissedProfileWarnings(profileWarningSignature)')
    expect(appearance).toContain('state.persistenceError')
    expect(appearance).toContain('onClick={clearBrandPersistenceError}')
    expect(appearance).toContain('onClick={clearAppearancePersistenceError}')
    expect(manager).toContain('role="alert"')
    expect(appearance).toContain('role="alert"')
  })

  it('本地图异步复制完成后基于最新 store 提交最小字段 patch', () => {
    expect(appearance).toContain('useBrandAppearanceStore.getState().setAppearance(')
    expect(appearance).toContain("appearanceFieldPatch(uploadScheme, 'bgImage', url)")
    expect(appearance).not.toContain("...(appearance.dark || {})")
  })

  it('html 品牌变量通过继承生效，不在 dsh-root 内重新遮蔽', () => {
    expect(theme).toContain('background: var(--brand-bg-color, var(--dsh-bg));')
    expect(theme).toContain('background: var(--brand-bg-image, none);')
    expect(theme).toContain('opacity: var(--brand-bg-opacity, 0);')
    expect(theme).not.toContain('--brand-bg-image: none;')
    expect(theme).toContain('--dsh-accent: var(--el-color-primary, #8b8f9c);')
  })

  it('会话区直接消费品牌底图，不再被 center 固定表面盖住', () => {
    expect(agentStyles).toContain("html[data-active-brand-image='true']")
    expect(agentStyles).toContain('background: var(--brand-bg-image, none);')
    expect(agentStyles).toContain('background-size: var(--brand-bg-size, cover);')
    expect(agentStyles).toContain('opacity: var(--brand-bg-opacity, 1);')
    expect(agentStyles).toContain('var(--dsh-surface-raw) 62%')
  })

  it('主题和明暗模式共同驱动正文、弱文字、表面与 Element 字体', () => {
    expect(theme).toContain('--dsh-text: var(--skin-dsh-text')
    expect(theme).toContain('--dsh-surface-raw: var(--skin-dsh-surface')
    expect(theme).toContain('--el-text-color-primary: var(--skin-dsh-text);')
    expect(theme).toContain('--el-text-color-regular: var(--skin-dsh-text-soft);')
    expect(manager).toContain('builtinAgentPalette(base.id, scheme)')
  })

  it('修正首屏叠加留白、点击面积和窄窗口外层 padding', () => {
    expect(managerStyles).toContain('padding: 0 0 16px;')
    expect(managerStyles).toContain('min-height: 34px;')
    expect(managerStyles).toContain('width: 32px;')
    expect(settingsStyles).toContain('@media (max-width: 900px)')
    expect(settingsStyles).toContain('padding: 22px 20px 28px;')
  })
})
