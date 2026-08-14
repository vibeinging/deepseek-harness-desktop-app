const THEME_SETTINGS_NAMESPACE = "ui-theme";
const PRODUCT_DEFAULT_PREFERENCE = "dark";

function protocolError(message) {
  const error = new Error(message);
  error.code = "DSH_THEME_SETTINGS_INVALID";
  return error;
}

/**
 * Persist the product's dark default through the official DSH Settings API.
 *
 * @param {(method: string, payload: object) => Promise<unknown>} request call one ready DSH API method.
 * @returns {Promise<boolean>} whether a missing user preference was written.
 */
export async function ensureDshProductThemeDefault(request) {
  const described = await request("settings.describe", {});
  if (!described || !Array.isArray(described.namespaces)) {
    throw protocolError("DSH settings.describe 没有返回 namespace 列表");
  }
  const theme = described.namespaces.find((item) => item?.ns === THEME_SETTINGS_NAMESPACE);
  if (!theme || !Number.isSafeInteger(theme.revision)) {
    throw protocolError(`DSH settings namespace 不可用：${THEME_SETTINGS_NAMESPACE}`);
  }
  if (theme.user && typeof theme.user === "object" && Object.hasOwn(theme.user, "preference")) {
    return false;
  }
  await request("settings.mutate", {
    ns: THEME_SETTINGS_NAMESPACE,
    ops: [{ op: "set", path: ["preference"], value: PRODUCT_DEFAULT_PREFERENCE }],
    expectedRevision: theme.revision,
  });
  return true;
}
