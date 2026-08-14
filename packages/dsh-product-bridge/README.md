# dsh-work Product Bridge

English | [中文](README.zh.md)

This private Profile Bundle extends the official DSH Web Profile without importing or changing a DSH source checkout. It registers `project_list`, `conversation_list`, four dsh-work Canvas/Site tools, three Office artifact tools, and `ui_render` on the Agent-scoped DSH tool registry. Its `product.json` also contributes the review, browser, files, artifacts, and sites pages to dsh-work's `agent.workbench.tool` product position. The app shell reads these contributions from the current Profile catalog instead of maintaining a second page roster in `AgentShell`.

The child sends only a DSH Session id. The parent binds it to one authorized dsh-work Session, user, and project, then handles project, conversation, Canvas/Site, and Office requests through one controlled IPC dispatcher. Requests cannot select another identity or project. Canvas/Site creation, editing, suggestions, and Office creation or editing require DSH approval. Every call produces normal durable DSH tool events; successful writes also project a hidden workspace event so the live interface and recovered history open the same Canvas, Site, or artifact.

Before every model step enters, the same parent-owned binding resolves the allowed App instructions, project instructions, and global/project memory. The bridge adds them as immutable user messages to the `agent/pre-step` entering batch and logs them in the DSH Session Log with `dsh-work-context` and `dsh-work-memory` provenance. A read failure skips only that addition; it does not replace the user's messages or create a second history.

The bridge also tracks the provider/model finally resolved for a parent Agent. When DSH creates a sub-Agent, it pins that target before the first request so the child cannot fall back to the process startup default. Later parent requests continue through normal settings resolution.

Runtime readiness and product IPC use callback-owned sends, so parent shutdown wins cleanly over late Loader settlement without an unhandled channel error.

The removed project Plugin mount, Skill, and MCP stores are not projected through ProductHost. Their catalog methods return an empty generation, while Profile Bundle Skills and tools remain owned by DSH's native registries.

The workbench product position runs on the official rc.6 `SlotCore` and `createSlotRenderer`, but its SlotMap and host services belong to dsh-work rather than DSH Web. The main interface enters the current Profile's Client graph through the reviewed `dsh-work-shell` Client Plugin. Workbench pages render only allowlisted local components, and community Bundles containing `dsh.client` are rejected during preflight until they can run outside the privileged Electron renderer. A user-installed Bundle therefore cannot enter the Renderer through Client code or by naming a component in JSON.

## Model Experience

The model receives `project_list`, `conversation_list`, `canvas_inspect`, `canvas_create`, `canvas_edit`, `canvas_suggest`, the three `artifact_office_*` tools, and `ui_render` through DSH, plus authorized instructions and memory in the same Session Log. Canvas and Site writes use immutable base versions, while Office inspection retains stable edit anchors and omits UI preview SVG data from model results. `ui_render` validates a bounded structured document in the parent process and restores the same interactive surface from DSH history.

#### KV Cache effect

The tool schemas are stable for one Bundle version. Profile order or Bundle version changes restart the DSH runtime and may change the reusable tool prefix.

## Known Limitations and Deferred Work

- The rc.6 SDK no longer publishes the former ProductHost and project-tool packages, so this app-owned Bundle directly owns the ten product tools and their secure parent-process bridge.
- The rc.6 SDK packages are publicly readable and do not require `NPM_TOKEN`, but development must explicitly pin the `next`/rc.6 release family because `latest` still points to older releases for some leaf packages. Development must not link DSH source or mix different RC families.
- The package is private; a packaged build must include the same reviewed Bundle revision and matching official NPM SDK versions.
