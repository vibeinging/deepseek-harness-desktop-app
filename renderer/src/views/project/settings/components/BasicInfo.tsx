import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Group, Textarea, TextInput } from '@mantine/core'
import { useForm } from '@mantine/form'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import {
  IconArrowDown,
  IconArrowUp,
  IconExternalLink,
  IconFolder,
  IconFolderPlus,
  IconTrash
} from '@tabler/icons-react'
import {
  replaceProjectSourceFoldersReq,
  updateProjectReq,
  type ProjectSourceFolder
} from '@/api/project'
import WorktreeSection from './WorktreeSection'
import { basename, openLocalFile, pickFolder } from '@/views/agent/folders'
import styles from './BasicInfo.module.scss'

interface BasicInfoProps {
  project?: any
  onUpdated?: (data: any) => void
  onDelete?: (projectId: string) => void
}

interface SavedSnapshot {
  name: string
  description: string
  folders: ProjectSourceFolder[]
}

const normalizeFolders = (folders: ProjectSourceFolder[] = []): ProjectSourceFolder[] => {
  const normalized = folders.map((folder) => {
    const path = folder.path || folder.local_path || ''
    const writeTarget = folder.write_target === true || folder.access_mode === 'write'
    return {
      ...folder,
      path,
      name: folder.name || folder.display_name || basename(path),
      access_mode: writeTarget ? 'write' as const : 'read' as const,
      write_target: writeTarget
    }
  })
  .filter((folder) => folder.path)
  const selectedIndex = normalized.findIndex((folder) => folder.write_target)
  if (normalized.length && selectedIndex < 0) {
    normalized[0] = { ...normalized[0], access_mode: 'write', write_target: true }
  }
  return normalized.map<ProjectSourceFolder>((folder, index) => ({
    ...folder,
    access_mode: index === (selectedIndex < 0 ? 0 : selectedIndex) ? 'write' as const : 'read' as const,
    write_target: index === (selectedIndex < 0 ? 0 : selectedIndex)
  }))
}

const folderSignature = (folders: ProjectSourceFolder[]) => JSON.stringify(
  folders.map((folder) => ({
    path: folder.path,
    name: folder.name || '',
    write_target: folder.write_target === true || folder.access_mode === 'write'
  }))
)

const comparablePath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

const folderConflict = (left: string, right: string) => {
  const a = comparablePath(left)
  const b = comparablePath(right)
  if (a === b) return 'duplicate'
  if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return 'overlap'
  return null
}

export default function BasicInfo({ project = null, onUpdated, onDelete }: BasicInfoProps) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [folders, setFolders] = useState<ProjectSourceFolder[]>([])
  const [saved, setSaved] = useState<SavedSnapshot>({ name: '', description: '', folders: [] })
  const syncedProjectIdRef = useRef<string | null>(null)

  const form = useForm({
    initialValues: {
      name: '',
      description: ''
    },
    validate: {
      name: (value: string) => {
        if (!value.trim()) return t('project.rules.name')
        if (value.trim().length < 2 || value.trim().length > 100) return t('project.rules.nameLength')
        return null
      }
    }
  })

  const incomingFolders = useMemo(
    () => normalizeFolders(project?.source_folders || []),
    [project?.source_folders]
  )
  const incomingFolderSignature = folderSignature(incomingFolders)

  const infoChanged = form.values.name.trim() !== saved.name || form.values.description !== saved.description
  const foldersChanged = folderSignature(folders) !== folderSignature(saved.folders)
  const hasChanges = infoChanged || foldersChanged
  const canManage = project?.is_owner !== false

  // Refresh when project details arrive, but never overwrite edits that are still waiting to be saved.
  useEffect(() => {
    if (!project) return
    const switchedProject = syncedProjectIdRef.current !== project.id
    if (!switchedProject && hasChanges) return

    const next = {
      name: project.name || '',
      description: project.description || '',
      folders: incomingFolders
    }
    syncedProjectIdRef.current = project.id
    form.setValues({ name: next.name, description: next.description })
    setFolders(next.folders)
    setSaved(next)
    // The incoming folder signature makes same-project detail refreshes observable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.name, project?.description, incomingFolderSignature])

  const resetForm = () => {
    form.setValues({ name: saved.name, description: saved.description })
    setFolders(saved.folders)
  }

  const addFolder = async () => {
    const path = await pickFolder()
    if (!path) return
    setFolders((current) => {
      const conflict = current
        .map((folder) => ({ folder, kind: folderConflict(folder.path, path) }))
        .find((entry) => entry.kind)
      if (conflict) {
        notifications.show({
          color: conflict.kind === 'duplicate' ? 'yellow' : 'red',
          message: conflict.kind === 'duplicate'
            ? t('project.basicInfo.folderDuplicate')
            : t('project.basicInfo.folderOverlap')
        })
        return current
      }
      const writeTarget = !current.some((folder) => folder.write_target === true || folder.access_mode === 'write')
      return [...current, {
        path,
        name: basename(path),
        available: true,
        access_mode: writeTarget ? 'write' : 'read',
        write_target: writeTarget
      }]
    })
  }

  const selectWriteTarget = (path: string) => {
    setFolders((current) => current.map((folder) => ({
      ...folder,
      access_mode: folder.path === path ? 'write' : 'read',
      write_target: folder.path === path
    })))
  }

  const moveFolder = (index: number, offset: -1 | 1) => {
    setFolders((current) => {
      const target = index + offset
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const confirmRemoveFolder = (folder: ProjectSourceFolder) => {
    modals.openConfirmModal({
      title: t('project.basicInfo.removeFolder'),
      children: t('project.basicInfo.removeFolderConfirm', { name: folder.name || basename(folder.path) }),
      labels: { confirm: t('project.basicInfo.removeFolder'), cancel: t('common.cancel') },
      confirmProps: { color: 'red' },
      onConfirm: () => setFolders((current) => {
        const next = current.filter((item) => item.path !== folder.path)
        const removedWriteTarget = folder.write_target === true || folder.access_mode === 'write'
        if (!removedWriteTarget || !next.length) return next
        const fallbackIndex = next.findIndex((item) => item.available !== false)
        const selectedIndex = fallbackIndex >= 0 ? fallbackIndex : 0
        return next.map((item, index) => ({
          ...item,
          access_mode: index === selectedIndex ? 'write' : 'read',
          write_target: index === selectedIndex
        }))
      })
    })
  }

  const handleSave = async () => {
    if (!project || !canManage || saving || !hasChanges) return
    const validation = form.validate()
    if (validation.hasErrors) return

    const shouldSaveInfo = infoChanged
    const shouldSaveFolders = foldersChanged
    setSaving(true)
    try {
      const [infoResult, folderResult] = await Promise.allSettled([
        shouldSaveInfo
          ? updateProjectReq(project.id, {
              name: form.values.name.trim(),
              description: form.values.description
            })
          : Promise.resolve(null),
        shouldSaveFolders
          ? replaceProjectSourceFoldersReq(project.id, folders)
          : Promise.resolve(null)
      ])

      const infoSaved = !shouldSaveInfo || infoResult.status === 'fulfilled'
      const foldersSaved = !shouldSaveFolders || folderResult.status === 'fulfilled'
      const anySaved = (shouldSaveInfo && infoSaved) || (shouldSaveFolders && foldersSaved)
      let nextProject = { ...project }
      let nextFolders = saved.folders

      if (shouldSaveInfo && infoResult.status === 'fulfilled') {
        const response: any = infoResult.value
        nextProject = {
          ...nextProject,
          ...(response?.data || {}),
          id: project.id,
          name: form.values.name.trim(),
          description: form.values.description
        }
      }
      if (shouldSaveFolders && folderResult.status === 'fulfilled') {
        const response: any = folderResult.value
        nextFolders = normalizeFolders(Array.isArray(response?.data) ? response.data : folders)
        nextProject.source_folders = nextFolders
      }

      if (anySaved) {
        setSaved((current) => ({
          name: shouldSaveInfo && infoSaved ? form.values.name.trim() : current.name,
          description: shouldSaveInfo && infoSaved ? form.values.description : current.description,
          folders: shouldSaveFolders && foldersSaved ? nextFolders : current.folders
        }))
        onUpdated?.(nextProject)
      }

      if (infoSaved && foldersSaved) {
        notifications.show({ color: 'green', message: t('project.basicInfo.updateSuccess') })
      } else if (anySaved) {
        const failure = infoResult.status === 'rejected'
          ? infoResult.reason
          : folderResult.status === 'rejected'
            ? folderResult.reason
            : null
        notifications.show({
          color: 'yellow',
          message: `${t('project.basicInfo.partialUpdate')}${failure?.msg || failure?.message ? `：${failure?.msg || failure?.message}` : ''}`
        })
      } else {
        const failure = infoResult.status === 'rejected' ? infoResult.reason : folderResult.status === 'rejected' ? folderResult.reason : null
        notifications.show({ color: 'red', message: failure?.msg || failure?.message || t('project.basicInfo.updateFailed') })
      }
    } catch (err: any) {
      notifications.show({ color: 'red', message: err?.msg || err?.message || t('project.basicInfo.updateFailed') })
    } finally {
      setSaving(false)
    }
  }

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return (
    <div className={styles.basicInfo}>
      <div className={styles.identity}>
        <div className={styles.avatar}><IconFolder size={26} stroke={1.5} /></div>
        <div className={styles.identityMain}>
          <div className={styles.identityName} title={project?.name || ''}>{project?.name || '-'}</div>
          <div className={styles.identitySub}>
            <span>{project?.description || t('project.basicInfo.defaultDescription')}</span>
          </div>
        </div>
      </div>

      <form className={styles.form} onSubmit={form.onSubmit(() => handleSave())}>
        <TextInput
          classNames={{ label: styles.formLabel }}
          label={t('project.form.name')}
          placeholder={t('project.form.namePlaceholder')}
          maxLength={100}
          mb="md"
          disabled={!canManage}
          {...form.getInputProps('name')}
        />

        <Textarea
          classNames={{ label: styles.formLabel }}
          label={t('project.form.description')}
          placeholder={t('project.form.descriptionPlaceholder')}
          rows={4}
          maxLength={500}
          mb="md"
          disabled={!canManage}
          {...form.getInputProps('description')}
        />

        <section className={styles.folderSection} aria-labelledby="project-folder-heading">
          <div className={styles.sectionHeading}>
            <div>
              <h3 id="project-folder-heading">{t('project.basicInfo.folders')}</h3>
              <p>{t('project.basicInfo.folderHint')}</p>
            </div>
          </div>
          <div className={styles.folderList}>
            {folders.map((folder, index) => (
              <div className={styles.folderRow} key={folder.path}>
                <IconFolder size={18} stroke={1.6} />
                <div className={styles.folderText}>
                  <input
                    value={folder.name || ''}
                    maxLength={160}
                    disabled={!canManage}
                    aria-label={t('project.basicInfo.folderName')}
                    onChange={(event) => setFolders((current) => current.map((item) => item.path === folder.path
                      ? { ...item, name: event.target.value }
                      : item))}
                  />
                  <small title={folder.path}>{folder.path}</small>
                </div>
                <span className={folder.available === false ? styles.folderUnavailable : styles.folderAvailable}>
                  {folder.available === false ? t('project.basicInfo.unavailable') : t('project.basicInfo.available')}
                </span>
                <label
                  className={styles.writeTarget}
                  title={folder.available === false
                    ? t('project.basicInfo.writeTargetUnavailable')
                    : t('project.basicInfo.writeTargetHint')}
                >
                  <input
                    type="radio"
                    name={`project-write-target-${project?.id || 'draft'}`}
                    aria-label={`${t('project.basicInfo.writeTarget')} ${folder.name || basename(folder.path)}`}
                    checked={folder.write_target === true || folder.access_mode === 'write'}
                    disabled={!canManage || folder.available === false}
                    onChange={() => selectWriteTarget(folder.path)}
                  />
                  <span>{t('project.basicInfo.writeTarget')}</span>
                </label>
                {canManage && (
                  <div className={styles.folderActions}>
                    <button
                      type="button"
                      onClick={() => moveFolder(index, -1)}
                      disabled={index === 0}
                      aria-label={t('project.basicInfo.moveFolderUp')}
                      title={t('project.basicInfo.moveFolderUp')}
                    ><IconArrowUp size={15} stroke={1.7} /></button>
                    <button
                      type="button"
                      onClick={() => moveFolder(index, 1)}
                      disabled={index === folders.length - 1}
                      aria-label={t('project.basicInfo.moveFolderDown')}
                      title={t('project.basicInfo.moveFolderDown')}
                    ><IconArrowDown size={15} stroke={1.7} /></button>
                    <button
                      type="button"
                      onClick={() => void openLocalFile(folder.path)}
                      disabled={folder.available === false}
                      aria-label={t('project.basicInfo.openFolder')}
                      title={t('project.basicInfo.openFolder')}
                    ><IconExternalLink size={15} stroke={1.7} /></button>
                    <button
                      type="button"
                      className={styles.removeFolder}
                      onClick={() => confirmRemoveFolder(folder)}
                      aria-label={`${t('project.basicInfo.removeFolder')} ${folder.name || folder.path}`}
                      title={t('project.basicInfo.removeFolderHint')}
                    ><IconTrash size={15} stroke={1.7} /></button>
                  </div>
                )}
              </div>
            ))}
            {canManage && (
              <button type="button" className={styles.addFolder} onClick={addFolder}>
                <IconFolderPlus size={18} stroke={1.6} />
                <span>{t('project.basicInfo.addFolder')}</span>
              </button>
            )}
            {!folders.length && !canManage && (
              <div className={styles.folderEmpty}>{t('project.basicInfo.noFolders')}</div>
            )}
          </div>
        </section>

        {!canManage && <div className={styles.ownerHint}>{t('project.basicInfo.ownerOnly')}</div>}

        <Group className={styles.formActions}>
          <Button type="submit" loading={saving} disabled={!hasChanges || !canManage}>
            {t('project.basicInfo.save')}
          </Button>
          {hasChanges && canManage && (
            <Button variant="default" type="button" onClick={resetForm} disabled={saving}>
              {t('project.basicInfo.reset')}
            </Button>
          )}
        </Group>
      </form>

      <div className={styles.meta}>
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>{t('project.basicInfo.createdAt')}</span>
          <span className={styles.metaValue}>{formatDate(project?.created_at)}</span>
        </div>
      </div>

      {canManage && onDelete && (
        <section className={styles.dangerZone} aria-labelledby="project-delete-heading">
          <div>
            <h3 id="project-delete-heading">{t('project.basicInfo.deleteProject')}</h3>
            <p>{t('project.basicInfo.deleteDescription')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            color="red"
            leftSection={<IconTrash size={16} />}
            disabled={saving}
            onClick={() => onDelete(project.id)}
          >
            {t('project.basicInfo.deleteProject')}
          </Button>
        </section>
      )}
      {project?.id && (
        <WorktreeSection projectId={project.id} folders={folders} canManage={canManage} />
      )}
    </div>
  )
}
