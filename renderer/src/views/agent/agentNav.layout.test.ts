import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const navSource = readFileSync(fileURLToPath(new URL('./AgentNav.tsx', import.meta.url)), 'utf8')
const stylesheet = readFileSync(fileURLToPath(new URL('./agent.module.scss', import.meta.url)), 'utf8')

describe('agent navigation layout', () => {
  it('uses the compact new action label while keeping the action explicit', () => {
    expect(navSource).toContain('<span>新建</span>')
    expect(navSource).toContain('title="新建对话"')
    expect(navSource).not.toContain('<span>新建对话</span>')
  })

  it('keeps global conversations content-sized and leaves remaining height to projects', () => {
    expect(navSource).toContain('`${styles.wsTree} ${styles.chatTree}`')

    const workspaceTreeRule = stylesheet.match(/\.wsTree\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const chatTreeRule = stylesheet.match(/\.chatTree\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(workspaceTreeRule).toMatch(/^\s*flex:\s*1 1 0\s*;/m)
    expect(chatTreeRule).toMatch(/^\s*flex:\s*0 1 auto\s*;/m)
    expect(chatTreeRule).toMatch(/^\s*max-height:\s*min\(240px, 30vh\)\s*;/m)
  })

  it('overlays project actions on hover without showing conversation counts', () => {
    expect(navSource).not.toContain('styles.wsCount')
    expect(navSource).toContain('className={styles.wsMore}')
    expect(navSource).toContain('className={styles.wsPlus}')
    expect(navSource).toContain('className={styles.wsActions}')

    const actionsRule = stylesheet.match(/\.wsActions,\s*\n\.convActions\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(actionsRule).toMatch(/^\s*position:\s*absolute\s*;/m)
    expect(actionsRule).toMatch(/^\s*padding-left:\s*6px\s*;/m)
    expect(actionsRule).toMatch(/^\s*opacity:\s*0\s*;/m)
    expect(actionsRule).toMatch(/^\s*pointer-events:\s*none\s*;/m)
    expect(actionsRule).toMatch(/^\s*background:\s*var\(--dsh-nav-action-bg\)\s*;/m)
    expect(actionsRule).not.toContain('linear-gradient')
    expect(stylesheet).toContain('.wsFolder:hover .wsActions')
  })

  it('marquees only overflowing workspace names and respects reduced motion', () => {
    expect(navSource).toContain('text.scrollWidth - visibleWidth')
    expect(navSource).toContain('styles.navMarqueeOverflow')
    expect(stylesheet).toContain('@keyframes wsNameMarquee')
    expect(stylesheet).toContain('.wsFolder:hover .navMarqueeOverflow .navMarqueeText')
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('gives conversations one overflow trigger backed by the same menu as right click', () => {
    expect(navSource).toContain('className={styles.convName}')
    expect(navSource).toContain('className={styles.convActions}')
    expect(navSource).toContain('data-agent-conversation-menu-trigger')
    expect(navSource).toContain('onContextMenu={(e) => openConvMenu(e, wsId, c, archived)}')
    expect(navSource).toContain('onClick={(event) => openConvMenu(event, wsId, c, archived, true)}')
    expect(navSource).toContain('items: conversationMenuItems(wsId, c, archived)')
    expect(navSource).toContain('aria-haspopup="menu"')
    expect(stylesheet).toContain('.convItem:hover .convActions')
    expect(stylesheet).toContain('.convItemActionsOpen .convActions')
    expect(stylesheet).toContain('.convItem:hover .navMarqueeOverflow .navMarqueeText')
  })

  it('uses the workspace context menu for the project overflow trigger', () => {
    expect(navSource).toContain('data-agent-workspace-menu-trigger')
    expect(navSource).toContain('aria-label={`查看项目 ${ws.name}`}')
    expect(navSource).toContain('ariaLabel: `打开${ws.name}的项目设置`')
    expect(navSource).toContain('onContextMenu={(e) => openWsMenu(e, ws)}')
    expect(navSource).toContain('onClick={(event) => openWsMenu(event, ws, true)}')
    expect(navSource).toContain('items: workspaceMenuItems(ws)')
    expect(navSource).not.toContain('<Popover.Dropdown className={styles.projectCard}')
  })

  it('shows compact, accessible conversation states without dropping them from pinned rows', () => {
    expect(navSource).toContain('conversationStatusBadge({')
    expect(navSource).toContain('liveInteractionStatus: c.live_interaction_status')
    expect(navSource).toContain('locallyRunning: wsId === runningWorkspaceId && c.id === runningConversationId')
    expect(navSource).toContain('data-agent-conv-status={statusBadge.kind}')
    expect(navSource).toContain('data-agent-conv-status-icon')
    expect(navSource).toContain('aria-label={`对话状态：${statusBadge.label}`}')
    expect(navSource).toContain('<ConversationStatusIcon kind={statusBadge.kind} />')
    expect(navSource).not.toContain('>{statusBadge.label}<')
    expect(navSource).toContain("convRow(info.wsId, info.conversation, 'pc')")
    expect(stylesheet).toContain(".convStatus[data-status='needs_reply']")
    expect(stylesheet).toContain(".convStatus[data-status='ready']")
    expect(stylesheet).toContain('@keyframes convStatusSpin')
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('uses distinct status shapes and makes conversation rows keyboard operable', () => {
    expect(navSource).toContain("kind === 'needs_confirmation') return <IconShieldCheck")
    expect(navSource).toContain("kind === 'failed') return <IconAlertCircle")
    expect(navSource).toContain('role="button"')
    expect(navSource).toContain('tabIndex={editing ? -1 : 0}')
    expect(navSource).toContain("event.key !== 'Enter' && event.key !== ' '")
    expect(navSource).toContain('event.target !== event.currentTarget')
    expect(navSource).toContain('aria-label={`打开对话 ${title}${statusBadge ? `，状态：${statusBadge.label}` : \'\'}`}')
    expect(stylesheet).toContain('.convItem:focus-visible')
  })
})
