const fs = require('node:fs');
const path = require('node:path');

const STATE_SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 20;
const METADATA_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SUPPORTED_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);

function trustedApiBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DSH_UPDATE_API_BASE_URL 不是有效地址');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('DSH_UPDATE_API_BASE_URL 必须是无凭据、无查询参数的 HTTPS 地址');
  }
  return raw;
}

function cleanError(error, fallback = '更新失败，请稍后重试') {
  const message = String(error?.message || error || fallback).trim();
  return message.slice(0, 300) || fallback;
}

function safeReadJson(filePath, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function validReleaseNotes(value) {
  if (!value || typeof value !== 'object') return null;
  const list = (items) => (Array.isArray(items) ? items.filter((item) => typeof item === 'string').slice(0, 100) : []);
  return {
    id: String(value.id || ''),
    version: String(value.version || ''),
    released_at: String(value.released_at || ''),
    notes: {
      features: list(value.notes?.features),
      improvements: list(value.notes?.improvements),
      fixes: list(value.notes?.fixes),
    },
  };
}

function sanitizeMetadata(payload) {
  const data = payload?.data;
  if (!data || data.schema_version !== 1 || !data.current || typeof data.current.version !== 'string') {
    throw new Error('更新服务返回了无法识别的数据');
  }
  const current = {
    version: data.current.version,
    release: validReleaseNotes(data.current.release),
  };
  let latest = null;
  if (data.latest) {
    const release = validReleaseNotes(data.latest);
    if (!release?.version) throw new Error('更新服务缺少版本号');
    latest = {
      ...release,
      min_supported_version: String(data.latest.min_supported_version || ''),
      update_available: Boolean(data.latest.update_available),
      mandatory: Boolean(data.latest.mandatory),
      feed_url: String(data.latest.feed_url || ''),
    };
  }
  return { schema_version: 1, checked_at: String(data.checked_at || ''), current, latest };
}

class AppUpdateController {
  constructor(options) {
    this.app = options.app;
    this.updater = options.updater;
    this.fetch = options.fetch;
    this.apiBaseUrl = trustedApiBaseUrl(options.apiBaseUrl);
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.channel = options.channel || 'stable';
    this.locale = options.locale || 'zh-CN';
    this.userDataPath = options.userDataPath;
    this.dataRoot = options.dataRoot;
    this.isPackaged = Boolean(options.isPackaged);
    this.onStateChange = options.onStateChange || (() => {});
    this.prepareToInstall = options.prepareToInstall || (async () => {});
    this.recoverInstallFailure = options.recoverInstallFailure || (async () => {});
    this.logger = options.logger || console;
    this.checkIntervalMs = options.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS;
    this.statePath = path.join(this.userDataPath, 'app-update-state.json');
    this.metadataCachePath = path.join(this.userDataPath, 'app-update-metadata-cache.json');
    this.historyPath = path.join(this.userDataPath, 'app-update-history.json');
    this.pendingPath = path.join(this.userDataPath, 'pending-app-update.json');
    this.target = `${this.platform}-${this.arch}`;
    this.enabled = Boolean(this.apiBaseUrl) && this.isPackaged && SUPPORTED_TARGETS.has(this.target);
    this.checkPromise = null;
    this.downloadPromise = null;
    this.installPromise = null;
    this.installFailureHandled = false;
    this.initialTimer = null;
    this.intervalTimer = null;
    this.history = this._loadHistory();
    this.state = {
      schemaVersion: STATE_SCHEMA_VERSION,
      enabled: this.enabled,
      status: this.enabled ? 'idle' : 'disabled',
      currentVersion: this.app.getVersion(),
      platform: this.platform,
      arch: this.arch,
      channel: this.channel,
      current: null,
      latest: null,
      progress: null,
      error: null,
      checkedAt: null,
      history: this.history,
    };
    try {
      const cachedMetadata = sanitizeMetadata({ data: safeReadJson(this.metadataCachePath, null) });
      if (cachedMetadata.current.version === this.app.getVersion()) {
        this.state.current = cachedMetadata.current;
        this.state.latest = cachedMetadata.latest || null;
        this.state.checkedAt = cachedMetadata.checked_at || null;
      }
    } catch {
      // Missing, old, or user-edited cache is ignored. A live check will replace it.
    }

    this._reconcilePendingInstall();
    this.state.history = this.history;
    if (this.enabled) this._configureUpdater();
  }

  _configureUpdater() {
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowDowngrade = false;
    this.updater.fullChangelog = false;
    this.updater.disableWebInstaller = true;
    this.updater.disableDifferentialDownload = false;
    this.updater.logger = this.logger;
    this.updater.on('download-progress', (progress) => {
      this._setState({
        status: 'downloading',
        progress: {
          percent: Number.isFinite(progress?.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
          transferred: Number(progress?.transferred || 0),
          total: Number(progress?.total || 0),
          bytesPerSecond: Number(progress?.bytesPerSecond || 0),
        },
        error: null,
      });
    });
    this.updater.on('update-downloaded', () => {
      this._setState({ status: 'downloaded', progress: { ...(this.state.progress || {}), percent: 100 }, error: null });
      void this._installDownloaded();
    });
    this.updater.on('error', (error) => {
      if (this.state.status === 'installing') {
        void this._handleInstallFailure(error);
        return;
      }
      this._setState({ status: 'error', error: cleanError(error), progress: null });
    });
  }

  _loadHistory() {
    const raw = safeReadJson(this.historyPath, { schemaVersion: STATE_SCHEMA_VERSION, entries: [] });
    return Array.isArray(raw.entries) ? raw.entries.slice(0, HISTORY_LIMIT) : [];
  }

  _saveHistory() {
    atomicWriteJson(this.historyPath, { schemaVersion: STATE_SCHEMA_VERSION, entries: this.history.slice(0, HISTORY_LIMIT) });
  }

  _recordHistory(entry) {
    this.history = [{ at: new Date().toISOString(), ...entry }, ...this.history].slice(0, HISTORY_LIMIT);
    this._saveHistory();
  }

  _reconcilePendingInstall() {
    const pending = safeReadJson(this.pendingPath, null);
    if (!pending?.toVersion) return;
    const succeeded = String(pending.toVersion) === String(this.app.getVersion());
    this._recordHistory({
      fromVersion: String(pending.fromVersion || ''),
      toVersion: String(pending.toVersion || ''),
      result: succeeded ? 'success' : 'incomplete',
    });
    try { fs.unlinkSync(this.pendingPath); } catch { /* already removed */ }
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch, history: this.history };
    try {
      atomicWriteJson(this.statePath, {
        schemaVersion: STATE_SCHEMA_VERSION,
        lastCheckedAt: this.state.checkedAt,
        currentVersion: this.state.currentVersion,
        latestVersion: this.state.latest?.version || null,
        status: this.state.status,
      });
    } catch (error) {
      this.logger.warn?.('[updater] 状态保存失败:', cleanError(error));
    }
    this.onStateChange(this.getState());
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  start() {
    if (!this.enabled || this.initialTimer) return;
    this.initialTimer = setTimeout(() => void this.check(), 4_000);
    this.initialTimer.unref?.();
    this.intervalTimer = setInterval(() => void this.check(), this.checkIntervalMs);
    this.intervalTimer.unref?.();
  }

  destroy() {
    clearTimeout(this.initialTimer);
    clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
  }

  async _fetchMetadata() {
    const query = new URLSearchParams({
      current_version: this.app.getVersion(),
      platform: this.platform,
      arch: this.arch,
      channel: this.channel,
      locale: this.locale,
    });
    const response = await this.fetch(`${this.apiBaseUrl}/api/desktop/releases/check?${query}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`更新服务请求失败（${response.status}）`);
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength > METADATA_LIMIT_BYTES) throw new Error('更新服务响应过大');
    const text = await response.text();
    if (Buffer.byteLength(text) > METADATA_LIMIT_BYTES) throw new Error('更新服务响应过大');
    return sanitizeMetadata(JSON.parse(text));
  }

  _trustedFeedUrl(candidate) {
    const expected = `${this.apiBaseUrl}/api/desktop/updates/${this.channel}/${this.platform}/${this.arch}`;
    if (candidate !== expected) throw new Error('更新下载地址不受信任');
    const parsed = new URL(candidate);
    const base = new URL(this.apiBaseUrl);
    if (parsed.protocol !== 'https:' || parsed.origin !== base.origin) throw new Error('更新下载地址不受信任');
    return candidate;
  }

  check() {
    if (!this.enabled) return Promise.resolve(this.getState());
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise || this.installPromise) return Promise.resolve(this.getState());
    this._setState({ status: 'checking', error: null });
    this.checkPromise = (async () => {
      try {
        const metadata = await this._fetchMetadata();
        atomicWriteJson(this.metadataCachePath, metadata);
        const latest = metadata.latest;
        const feedUrl = latest?.feed_url || `${this.apiBaseUrl}/api/desktop/updates/${this.channel}/${this.platform}/${this.arch}`;
        this.updater.setFeedURL({ provider: 'generic', url: this._trustedFeedUrl(feedUrl), useMultipleRangeRequest: false });
        const result = await this.updater.checkForUpdates();
        const updaterVersion = String(result?.updateInfo?.version || '');
        const available = Boolean(result?.isUpdateAvailable && latest?.update_available && latest.version === updaterVersion);
        if (result?.isUpdateAvailable && (!latest || latest.version !== updaterVersion)) {
          throw new Error('更新说明与安装包版本不一致');
        }
        this._setState({
          status: available ? 'available' : 'up-to-date',
          current: metadata.current,
          latest: latest ? { ...latest, update_available: available } : null,
          checkedAt: metadata.checked_at || new Date().toISOString(),
          progress: null,
          error: null,
        });
      } catch (error) {
        this._setState({ status: 'error', error: cleanError(error), progress: null });
      } finally {
        this.checkPromise = null;
      }
      return this.getState();
    })();
    return this.checkPromise;
  }

  async downloadAndInstall() {
    if (!this.enabled) return this.getState();
    if (this.downloadPromise || this.installPromise) return this.getState();
    if (this.state.status !== 'available') await this.check();
    if (this.state.status !== 'available' || !this.state.latest?.update_available) return this.getState();
    this._setState({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: null });
    this.downloadPromise = this.updater.downloadUpdate()
      .catch((error) => {
        this._setState({ status: 'error', error: cleanError(error), progress: null });
      })
      .finally(() => { this.downloadPromise = null; });
    await this.downloadPromise;
    return this.getState();
  }

  _installDownloaded() {
    if (this.installPromise) return this.installPromise;
    this.installFailureHandled = false;
    this.installPromise = (async () => {
      const toVersion = this.state.latest?.version;
      if (!toVersion) throw new Error('缺少待安装版本');
      atomicWriteJson(this.pendingPath, {
        schemaVersion: STATE_SCHEMA_VERSION,
        fromVersion: this.app.getVersion(),
        toVersion,
        requestedAt: new Date().toISOString(),
        preservedPaths: [this.userDataPath, this.dataRoot],
      });
      this._setState({ status: 'installing', error: null });
      await this.prepareToInstall();
      this.updater.quitAndInstall(false, true);
    })().catch((error) => this._handleInstallFailure(error));
    return this.installPromise;
  }

  async _handleInstallFailure(error) {
    if (this.installFailureHandled) return;
    this.installFailureHandled = true;
    try { fs.unlinkSync(this.pendingPath); } catch { /* ignore */ }
    this._recordHistory({
      fromVersion: this.app.getVersion(),
      toVersion: this.state.latest?.version || '',
      result: 'failed-to-start',
      error: cleanError(error),
    });
    await this.recoverInstallFailure();
    this._setState({ status: 'error', error: cleanError(error), progress: null });
    this.installPromise = null;
  }
}

module.exports = {
  AppUpdateController,
  sanitizeMetadata,
  trustedApiBaseUrl,
  SUPPORTED_TARGETS,
};
