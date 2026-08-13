import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function windowsExecutable(dir) {
  const preferred = join(dir, 'dsh-work.exe');
  if (existsSync(preferred)) return preferred;
  const candidates = readdirSync(dir)
    .filter((name) => extname(name).toLowerCase() === '.exe')
    .filter((name) => !/^(uninstall|elevate|squirrel)/i.test(name));
  if (candidates.length !== 1) {
    throw new Error(`无法确定 Windows 主程序，请直接传入 .exe 路径: ${dir}`);
  }
  return join(dir, candidates[0]);
}

export function resolvePackagedLayout(input) {
  if (!input) throw new Error('请传入 .app、Windows .exe 或 win-unpacked 目录');
  const target = resolve(input);

  if (target.endsWith('.app') && isDirectory(target)) {
    const appName = basename(target, '.app');
    return {
      platform: 'darwin',
      executable: join(target, 'Contents', 'MacOS', appName),
      resourcesDir: join(target, 'Contents', 'Resources'),
    };
  }

  const windowsDir = isDirectory(target) ? target : dirname(target);
  const executable = isDirectory(target) ? windowsExecutable(target) : target;
  if (extname(executable).toLowerCase() === '.exe' && isDirectory(join(windowsDir, 'resources'))) {
    return {
      platform: 'win32',
      executable,
      resourcesDir: join(windowsDir, 'resources'),
    };
  }

  throw new Error(`不支持的打包产物: ${target}`);
}
