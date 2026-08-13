function proxyError(message) {
  const error = new Error(message);
  error.code = 'NETWORK_PROXY_INVALID';
  return error;
}

function normalizeProxyUrl(raw, { strict = false } = {}) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const withScheme = value.includes('://') ? value : `http://${value}`;
  try {
    const parsed = new URL(withScheme);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      if (strict) throw proxyError('代理地址只支持 http:// 或 https://');
      return '';
    }
    if (parsed.username || parsed.password) {
      if (strict) throw proxyError('代理地址不能包含用户名或密码；当前版本不保存代理凭证');
      return '';
    }
    if (parsed.search || parsed.hash) {
      if (strict) throw proxyError('代理地址不能包含 query 或 fragment');
      return '';
    }
    return parsed.toString().replace(/\/$/, '');
  } catch (error) {
    if (strict) {
      if (error?.code === 'NETWORK_PROXY_INVALID') throw error;
      throw proxyError('代理地址格式无效');
    }
    return '';
  }
}

function proxyLogLabel(raw) {
  const value = String(raw || '').trim();
  if (!value) return '(empty)';
  try {
    const parsed = new URL(value.includes('://') ? value : `http://${value}`);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '(configured)';
  }
}

module.exports = { normalizeProxyUrl, proxyLogLabel };
