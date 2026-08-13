# dsh-work Product Bridge

English | [中文](README.zh.md)

This private Profile Bundle extends the official DSH Web Profile without importing or changing a DSH source checkout. It registers `project_list`, `conversation_list`, and the dsh-work-owned Office artifact tools on the Agent-scoped DSH tool registry. Its `product.json` also contributes the review, browser, files, artifacts, and sites pages to dsh-work's `agent.workbench.tool` product position. The app shell reads these contributions from the current Profile catalog instead of maintaining a second page roster in `AgentShell`.

The child sends only a DSH Session id. The parent binds it to one authorized dsh-work Session, user, and project, then handles project, conversation, and Office requests through one controlled IPC dispatcher. Requests cannot select another identity or project, Office create and edit require DSH approval, and every call produces normal durable DSH tool events.

The removed project Plugin mount, Skill, and MCP stores are not projected through ProductHost. Their catalog methods return an empty generation, while Profile Bundle Skills and tools remain owned by DSH's native registries.

The workbench product position runs on the official rc.2 `SlotCore` and `createSlotRenderer`, but its SlotMap and host services belong to dsh-work rather than DSH Web. Bundle/Profile remains the shared installation and lifecycle authority; DSH browser plugins use nested `dsh.client` and official Slots, while the dsh-work host page renders only allowlisted local components. Only app-shipped Bundles currently receive that component authority, so a user-installed Bundle cannot enter the Electron renderer by naming a component in JSON.

## Model Experience

The model receives `project_list`, `conversation_list`, and the three `artifact_office_*` tools through DSH. Office inspection retains stable edit anchors and omits UI preview SVG data from model results.

#### KV Cache effect

The tool schemas are stable for one Bundle version. Profile order or Bundle version changes restart the DSH runtime and may change the reusable tool prefix.

## Known Limitations and Deferred Work

- The rc.2 SDK no longer publishes the former ProductHost and project-tool packages, so this app-owned Bundle directly owns the five product tools and their secure parent-process bridge.
- Private npm SDK access requires an authorized `NPM_TOKEN` and one explicitly pinned release family. Development must not use an unauthorized stale npm login, trust the misleading `latest` tag, link DSH source, or mix different RC families.
- The package is private; a packaged build must include the same reviewed Bundle revision and matching official NPM SDK versions.
