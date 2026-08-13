// session 域路由表(会话与消息操作 + 会话分享,抽自 routes/session_actions.js)。一域一文件,避免多 agent 扇出冲突。
import * as session from '../app/session/index.js';

export const sessionRoutes = [
  { m: 'POST', p: '/api/sessions/temporary/cleanup', fn: session.cleanupTemporarySessions, auth: true },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/memory/auto_apply', fn: session.setSessionAutoApplyMemory, auth: true },
  { m: 'POST', p: '/api/projects/:pid/sessions', fn: session.createSession, auth: true },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/move', fn: session.moveSession, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/sessions/:sid', fn: session.updateSession, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/sessions/:sid', fn: session.deleteSession, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/sessions/:sid/messages/:mid', fn: session.deleteMessage, auth: true },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/messages/:mid/feedback', fn: session.createMessageFeedback, auth: true },
  { m: 'GET', p: '/api/projects/:pid/sessions/:sid/share', fn: session.getSessionShare, auth: true },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/share', fn: session.createSessionShare, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/sessions/:sid/share', fn: session.deleteSessionShare, auth: true },
  { m: 'GET', p: '/api/public/v1/shared-sessions/:token', fn: session.getSharedSession, auth: false },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/stop-task', fn: session.stopSessionTask, auth: true },
  { m: 'GET', p: '/api/projects/:pid/sessions/:sid/task-status', fn: session.getSessionTaskStatus, auth: true },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/intermediate-generate-description', fn: session.generateIntermediateDescription, auth: true },
  { m: 'POST', p: '/api/projects/:pid/sessions/:sid/persist-intermediate', fn: session.persistIntermediate, auth: true },
];
