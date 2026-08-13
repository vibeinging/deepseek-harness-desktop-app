// Chat 域只暴露 Agent Thread/Turn 主协议和周边非流式端点。
import * as agentTurns from "../app/chat/agent_turns.js";
import * as dshProtocol from "../app/chat/dsh_protocol.js";
import * as agentMisc from "../app/chat/agent_misc.js";
import * as conversationStatusStream from "../app/chat/conversation_status_stream.js";
import * as canvases from "../app/chat/canvases.js";
import * as fileSearch from "../app/chat/file_search.js";
import * as globalMemory from "../app/chat/global_memory.js";
import * as messageActions from "../app/chat/message_actions.js";
import * as projectArtifacts from "../app/chat/project_artifacts.js";
import * as projectMemory from "../app/chat/project_memory.js";
import * as pluginCatalog from "../app/plugins/catalog.js";
import * as pluginCatalogStream from "../app/plugins/catalog_stream.js";
import * as pluginLifecycle from "../app/plugins/lifecycle.js";
import * as skillHub from "../app/plugins/skillhub.js";

export const chatRoutes = [
  // ── Agent Thread / Turn ──
  { m: "POST", p: "/api/agent/projects/:pid/threads/:threadId/turns", fn: agentTurns.startAgentTurn, auth: true, stream: true },
  { m: "POST", p: "/api/agent/projects/:pid/threads/:threadId/review", fn: agentTurns.startAgentReview, auth: true, stream: true },
  { m: "POST", p: "/api/agent/threads/:threadId/turns/:turnId/steer", fn: agentTurns.steerAgentTurn, auth: true },
  { m: "POST", p: "/api/agent/threads/:threadId/turns/:turnId/interrupt", fn: agentTurns.interruptAgentTurn, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/threads/:threadId/dsh-state", fn: dshProtocol.getDshProtocolState, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/threads/:threadId/dsh-skills", fn: dshProtocol.listDshSkills, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/threads/:threadId/dsh-events", fn: dshProtocol.watchDshProtocol, auth: true, stream: true },
  { m: "POST", p: "/api/agent/projects/:pid/threads/:threadId/dsh-permission", fn: dshProtocol.setDshPermission, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/threads/:threadId/dsh-prompt", fn: dshProtocol.promptDshQueue, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/threads/:threadId/dsh-queue/:itemId", fn: dshProtocol.updateDshQueueItem, auth: true },
  { m: "GET", p: "/api/agent/sessions/:sid/dsh-attachments/:attachmentId", fn: dshProtocol.readDshAttachment, auth: true },
  { m: "POST", p: "/api/agent/threads/:threadId/turns/:turnId/workspace-actions", fn: agentTurns.revertWorkspaceChange, auth: true },
  { m: "POST", p: "/api/agent/threads/:threadId/turns/:turnId/workspace-edit", fn: agentTurns.applyWorkspaceEdit, auth: true },
  { m: "POST", p: "/api/agent/threads/:threadId/file-references/resolve", fn: agentTurns.resolveFileReference, auth: true },
  { m: "GET", p: "/api/agent/threads/:threadId/workspace-diff", fn: agentTurns.getCurrentWorkspaceDiff, auth: true },
  { m: "POST", p: "/api/agent/runtime-threads/:threadId/turns/:turnId/items/:itemId/approval", fn: agentTurns.resolveAgentApproval, auth: true },
  { m: "POST", p: "/api/agent/runtime-threads/:threadId/turns/:turnId/items/:itemId/user-input", fn: agentTurns.resolveAgentUserInput, auth: true },

  // ── Agent 工作区周边非流式端点 ──
  { m: "GET", p: "/api/agent/plugins", fn: pluginCatalog.listAgentPluginCatalog, auth: true },
  { m: "GET", p: "/api/agent/plugins/:id", fn: pluginCatalog.getAgentPluginDetail, auth: true },
  { m: "GET", p: "/api/agent/plugin-catalog/events", fn: pluginCatalogStream.watchAgentPluginCatalogEvents, auth: true, stream: true },
  { m: "POST", p: "/api/agent/profile-bundles/preflight", fn: pluginLifecycle.preflightProfileBundle, auth: true },
  { m: "POST", p: "/api/agent/profile-bundles", fn: pluginLifecycle.installProfileBundle, auth: true },
  { m: "DELETE", p: "/api/agent/profile-bundles/:id", fn: pluginLifecycle.uninstallProfileBundle, auth: true },
  { m: "GET", p: "/api/agent/skill-market", fn: skillHub.listSkillHubMarket, auth: true },
  { m: "GET", p: "/api/agent/skill-market/:slug", fn: skillHub.getSkillHubMarketDetail, auth: true },
  { m: "POST", p: "/api/agent/skill-market/:slug/install", fn: skillHub.installSkillHubMarketSkill, auth: true },
  { m: "GET", p: "/api/agent/skills", fn: agentMisc.listAppAgentSkills, auth: true },
  { m: "POST", p: "/api/agent/skills", fn: agentMisc.createAppAgentSkill, auth: true },
  { m: "GET", p: "/api/agent/skills/enabled/list", fn: agentMisc.listEnabledAppAgentSkills, auth: true },
  { m: "POST", p: "/api/agent/skills/ai-generate", fn: agentMisc.aiGenerateAppAgentSkill, auth: true },
  { m: "PATCH", p: "/api/agent/skills/:skillName/toggle", fn: agentMisc.toggleAppAgentSkill, auth: true },
  { m: "GET", p: "/api/agent/skills/:skillName", fn: agentMisc.getAppAgentSkill, auth: true },
  { m: "PUT", p: "/api/agent/skills/:skillName", fn: agentMisc.updateAppAgentSkill, auth: true },
  { m: "DELETE", p: "/api/agent/skills/:skillName", fn: agentMisc.deleteAppAgentSkill, auth: true },
  { m: "GET", p: "/api/agent/search/conversations", fn: agentMisc.searchAgentConversations, auth: true },
  { m: "GET", p: "/api/agent/search/files", fn: fileSearch.searchAgentFiles, auth: true },
  { m: "GET", p: "/api/agent/search/artifacts", fn: projectArtifacts.searchAgentArtifacts, auth: true },
  { m: "GET", p: "/api/agent/search/web-sources", fn: agentMisc.searchAgentWebSources, auth: true },
  { m: "GET", p: "/api/agent/chat-memory", fn: globalMemory.getGlobalChatMemory, auth: true },
  { m: "PUT", p: "/api/agent/chat-memory", fn: globalMemory.updateGlobalChatMemory, auth: true },
  { m: "POST", p: "/api/agent/chat-memory/entries", fn: globalMemory.createGlobalChatMemoryEntry, auth: true },
  { m: "PUT", p: "/api/agent/chat-memory/entries/:id", fn: globalMemory.updateGlobalChatMemoryEntry, auth: true },
  { m: "DELETE", p: "/api/agent/chat-memory/entries/:id", fn: globalMemory.deleteGlobalChatMemoryEntry, auth: true },
  { m: "POST", p: "/api/agent/chat-memory/exclusions/:sid", fn: globalMemory.excludeGlobalChatMemoryConversation, auth: true },
  { m: "DELETE", p: "/api/agent/chat-memory/exclusions/:sid", fn: globalMemory.includeGlobalChatMemoryConversation, auth: true },
  { m: "GET", p: "/api/agent/sessions/:sid/canvases", fn: canvases.listCanvases, auth: true },
  { m: "POST", p: "/api/agent/sessions/:sid/canvases", fn: canvases.createSessionCanvas, auth: true },
  { m: "GET", p: "/api/agent/sessions/:sid/canvases/:canvasId", fn: canvases.getSessionCanvas, auth: true },
  { m: "GET", p: "/api/agent/sessions/:sid/canvases/:canvasId/versions/:versionId", fn: canvases.getSessionCanvasVersion, auth: true },
  { m: "POST", p: "/api/agent/sessions/:sid/canvases/:canvasId/edits", fn: canvases.editSessionCanvas, auth: true },
  { m: "POST", p: "/api/agent/sessions/:sid/canvases/:canvasId/restore", fn: canvases.restoreSessionCanvas, auth: true },
  { m: "POST", p: "/api/agent/sessions/:sid/canvases/:canvasId/suggestions", fn: canvases.addSessionCanvasSuggestion, auth: true },
  { m: "POST", p: "/api/agent/sessions/:sid/canvases/:canvasId/suggestions/:suggestionId/decision", fn: canvases.decideSessionCanvasSuggestion, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/chat-memory", fn: projectMemory.getProjectChatMemory, auth: true },
  { m: "PUT", p: "/api/agent/projects/:pid/chat-memory", fn: projectMemory.updateProjectChatMemory, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/chat-memory/exclusions/:sid", fn: projectMemory.excludeProjectChatMemorySession, auth: true },
  { m: "DELETE", p: "/api/agent/projects/:pid/chat-memory/exclusions/:sid", fn: projectMemory.includeProjectChatMemorySession, auth: true },
  { m: "GET", p: "/api/agent/session-status/events", fn: conversationStatusStream.watchAgentSessionStatusEvents, auth: true, stream: true },
  { m: "GET", p: "/api/agent/projects/:pid/sessions", fn: agentMisc.listAgentSessions, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/sessions/:sid/viewed", fn: agentMisc.markAgentSessionViewed, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/sessions/:sid/messages/:mid/branch", fn: messageActions.branchAgentMessage, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/model", fn: agentMisc.getAgentModel, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/files", fn: agentMisc.getAgentFiles, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/file", fn: agentMisc.getAgentFile, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/artifacts", fn: projectArtifacts.listProjectArtifacts, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/artifacts", fn: projectArtifacts.createProjectArtifact, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/artifacts/office", fn: projectArtifacts.createProjectOfficeDocument, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/artifacts/:artifactId", fn: projectArtifacts.getProjectArtifactDetail, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/artifacts/:artifactId/versions/:versionId/preview", fn: projectArtifacts.previewProjectArtifactVersion, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/artifacts/:artifactId/office", fn: projectArtifacts.inspectProjectOfficeDocument, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/artifacts/:artifactId/office/edits", fn: projectArtifacts.editProjectOfficeDocument, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/artifacts/:artifactId/office/diff", fn: projectArtifacts.compareProjectOfficeDocument, auth: true },
  { m: "GET", p: "/api/agent/projects/:pid/artifacts/:artifactId/diff", fn: projectArtifacts.compareProjectArtifact, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/artifacts/:artifactId/restore", fn: projectArtifacts.restoreProjectArtifact, auth: true },
  { m: "POST", p: "/api/agent/projects/:pid/sessions/:sid/compact", fn: agentMisc.compactAgentSession, auth: true },
];
