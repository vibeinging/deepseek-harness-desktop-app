// Lightweight router matching: (method, pathPattern) => extract :param.
// Handles the only routing features we need from express.
// Split by '/': ':x' becomes capture group and key; literal segments are escaped.

function compile(pattern) {
  const keys = [];
  const rxStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape literal segments
    })
    .join('/');
  return { rx: new RegExp('^' + rxStr + '$'), keys };
}

export function makeRouter(routes) {
  const compiled = routes.map((r) => ({ ...r, ...compile(r.p) }));
  return function match(method, path) {
    for (const r of compiled) {
      if (r.m !== method) continue;
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
    return null;
  };
}
