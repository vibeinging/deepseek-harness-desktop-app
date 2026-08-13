import { dirname, resolve } from "node:path";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";

export const DSH_WORKSPACE_PERMISSION_PROFILE = "dsh-project";

function cleanPath(value) {
  const path = String(value || "").trim();
  return path ? resolve(path) : "";
}
function skillRoot(skill) {
  const path = cleanPath(skill?._runtimePath || skill?.path);
  if (!path) return "";
  return path.toLowerCase().endsWith("/skill.md") ? dirname(path) : path;
}

function capabilityRoot(capability) {
  return cleanPath(capability?.location?.path || capability?.path);
}

export function workspacePermissionReadRoots({ skills = [], capabilityRoots = [] } = {}) {
  return [...new Set([
    ...(skills || []).map(skillRoot),
    ...(capabilityRoots || []).map(capabilityRoot),
  ].filter(Boolean))].sort();
}

export function withWorkspacePermissionProfile(baseConfig = {}, { readOnlyRoots = [], excludeEnvKeys = [] } = {}) {
  const existingPermissions = baseConfig?.permissions && typeof baseConfig.permissions === "object"
    ? baseConfig.permissions
    : {};
  const filesystem = {
    ":minimal": "read",
    ":workspace_roots": { ".": "write" },
  };
  for (const root of [...new Set((readOnlyRoots || []).map(cleanPath).filter(Boolean))].sort()) {
    filesystem[root] = "read";
  }
  return {
    ...(baseConfig || {}),
    // Codex 0.147.0 otherwise inherits the entire app-server environment and
    // skips its default KEY/SECRET/TOKEN filtering for shell-like tools.
    shell_environment_policy: {
      inherit: "core",
      ignore_default_excludes: false,
      exclude: [
        "*PASSWORD*",
        "*PASSWD*",
        "*CREDENTIAL*",
        "DATABASE_URL",
        "PG*",
        "MYSQL*",
        "REDIS_URL",
        "AWS_*",
        "AZURE_*",
        "GOOGLE_*",
        "GITHUB_*",
        ...[...new Set((excludeEnvKeys || []).map((key) => String(key || "").trim()).filter(Boolean))].sort(),
      ],
      experimental_use_profile: false,
    },
    allow_login_shell: false,
    default_permissions: DSH_WORKSPACE_PERMISSION_PROFILE,
    permissions: {
      ...existingPermissions,
      [DSH_WORKSPACE_PERMISSION_PROFILE]: {
        description: `${APP_DISPLAY_NAME}项目工作区和已启用能力所需的最小文件权限。`,
        filesystem,
      },
    },
  };
}
