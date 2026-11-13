const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { createHash } = require('node:crypto');
const internationalDestinations = require('./assets/international-destinations');

loadEnv();
const defaultPort = Number(process.env.PORT || 4173);
const defaultHost = process.env.HOST || '127.0.0.1';
const desktopMode = process.env.FLYWHERE_DESKTOP === '1';
const bundledFlyaiPath = process.env.FLYAI_CLI_PATH || '';
const configPath = process.env.FLYWHERE_CONFIG_PATH ? path.resolve(process.env.FLYWHERE_CONFIG_PATH) : path.join(__dirname, '.flymap-config.json');
const encryptedValuePrefix = 'safe-storage:';
let localConfig = loadLocalConfig();
const feePolicy = { airportConstruction: 50, shortHaulFuelSurcharge: 40, longHaulFuelSurcharge: 70, thresholdKm: 800, updatedAt: '2026-08-05', source: '按航段大圆距离估算；FlyAI 返回实际费用时以接口为准' };
const airportCoordinates = {
  CAN: [113.30, 23.39], SZX: [113.81, 22.64], ZUH: [113.38, 22.01], FUO: [113.07, 23.08], HKG: [113.92, 22.31], MFM: [113.59, 22.15],
  PEK: [116.60, 40.08], PKX: [116.41, 39.51], BJS: [116.40, 39.90], SHA: [121.34, 31.20], PVG: [121.80, 31.14],
  CTU: [103.95, 30.58], TFU: [104.44, 30.31], CKG: [106.64, 29.72], XIY: [108.75, 34.45], KMG: [102.93, 25.10],
  XMN: [118.13, 24.54], FOC: [119.66, 25.93], HAK: [110.46, 19.94], SYX: [109.41, 18.30], HGH: [120.43, 30.23],
  NKG: [118.86, 31.74], WUH: [114.21, 30.78], CSX: [113.22, 28.19], CGO: [113.84, 34.52], TAO: [120.37, 36.27],
  DLC: [121.54, 38.97], SHE: [123.48, 41.64], HRB: [126.25, 45.62], URC: [87.47, 43.91], KHG: [76.02, 39.54],
  LHW: [103.62, 36.51], XNN: [101.45, 36.53], LXA: [90.91, 29.30], NNG: [108.17, 22.61], KWE: [106.80, 26.54],
  LYG: [119.18, 34.62]
};
const cityCoordinates = { 喀什: airportCoordinates.KHG, 北京: airportCoordinates.BJS, 广州: airportCoordinates.CAN, 上海: airportCoordinates.SHA, 成都: airportCoordinates.CTU, 深圳: airportCoordinates.SZX, 连云港: airportCoordinates.LYG };
// FlyAI can resolve these codes as cities, so use unambiguous airport names.
const airportSearchNames = { SHA: '上海虹桥', CTU: '成都双流国际机场' };
const domesticExplorationCities = [
  '北京', '上海', '成都', '重庆', '昆明', '西安', '厦门', '福州', '泉州', '海口', '三亚', '杭州', '南京', '宁波', '温州', '武汉', '长沙', '郑州', '青岛', '济南',
  '大连', '沈阳', '长春', '哈尔滨', '贵阳', '桂林', '南宁', '北海', '珠海', '兰州', '西宁', '银川', '乌鲁木齐', '喀什', '拉萨', '大理', '丽江', '西双版纳',
  '南昌', '合肥', '太原', '石家庄', '呼和浩特', '烟台', '威海', '张家界', '宜昌', '徐州', '无锡', '常州', '扬州', '台州', '揭阳', '湛江', '惠州',
  '香港', '澳门', '台北', '高雄'
];
const domesticCitySet = new Set(['广州', '深圳', ...domesticExplorationCities]);
const regionalAirportCodes = new Set(['HKG', 'MFM', 'TPE', 'TSA', 'KHH', 'RMQ', 'TNN', 'TTT', 'HUN', 'MZG', 'KNH', 'CYI']);
const explorationDestinationLimit = 10;
const minimumExplorationDestinations = 6;
const explorationFallbackAttempts = 12;
const chinaMapUrl = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const echartsUrl = 'https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js';
const echartsSha256 = 'b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0';
const brandLogoUrl = 'https://gitee.com/ayingsxcw/gameimg/raw/master/img/20260811074953392.webp';
let chinaMapCache = { expiresAt: 0, data: null };
let echartsSourceCache = '';
let brandLogoCache = { expiresAt: 0, contentType: 'image/webp', data: null };
const flyaiCache = new Map();
const flyaiInflight = new Map();
let flyaiRunner = null;
let flyaiQueue = Promise.resolve();
let flyaiNextRunAt = 0;
const searchCache = new Map();
const searchInflight = new Map();
const weatherCache = new Map();
const geocodeCache = new Map();
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function loadEnv() {
  if (process.env.FLYWHERE_DESKTOP === '1') return;
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function loadLocalConfig() {
  if (!fs.existsSync(configPath)) return {};
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch { return {}; }
}

function effective(name) {
  const mapping = { FLYAI_API_KEY: 'flyaiApiKey', AI_BASE_URL: 'aiBaseUrl', AI_API_KEY: 'aiApiKey', MODEL_NAME: 'model' };
  const key = mapping[name];
  if (!Object.prototype.hasOwnProperty.call(localConfig, key)) return process.env[name] || '';
  return ['flyaiApiKey', 'aiApiKey'].includes(key) ? decryptStoredSecret(localConfig[key]) : localConfig[key];
}

function safeStorage() {
  if (!desktopMode) return null;
  const storage = require('electron').safeStorage;
  if (!storage.isEncryptionAvailable()) throw new Error('macOS Keychain 当前不可用，无法安全保存 API Key');
  return storage;
}

function decryptStoredSecret(value) {
  const stored = String(value || '');
  if (!stored.startsWith(encryptedValuePrefix)) return stored;
  try {
    return safeStorage().decryptString(Buffer.from(stored.slice(encryptedValuePrefix.length), 'base64'));
  } catch {
    return '';
  }
}

function encryptSecret(value) {
  const plain = decryptStoredSecret(value);
  if (!plain || !desktopMode) return plain;
  return `${encryptedValuePrefix}${safeStorage().encryptString(plain).toString('base64')}`;
}

function writeLocalConfig(next) {
  const stored = { ...next };
  for (const key of ['flyaiApiKey', 'aiApiKey']) {
    if (Object.prototype.hasOwnProperty.call(stored, key)) stored[key] = encryptSecret(stored[key]);
  }
  localConfig = stored;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  modelsCache = { expiresAt: 0, models: [] };
}

function execCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const shellCommand = options.shell ? [command, ...args].map(arg => {
      if (typeof arg !== 'string' || /[\x00-\x1f"%!^&|<>]/.test(arg)) throw new Error('CLI 参数包含不支持的命令行字符');
      return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
    }).join(' ') : command;
    const child = execFile(shellCommand, options.shell ? [] : args, { timeout: options.timeout || 10000, maxBuffer: options.maxBuffer || 4 * 1024 * 1024, env: options.env || process.env, cwd: __dirname, shell: options.shell }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolve(String(stdout || stderr).trim());
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

const pathLocator = process.platform === 'win32' ? 'where' : 'which';
const cliSpawnShell = process.platform === 'win32';

async function installFlyaiCli() {
  if (desktopMode && bundledFlyaiPath) return;
  try {
    await execCapture('npm', ['--version']);
  } catch {
    throw new Error('没有找到 Node.js/npm，暂时无法自动安装。请先安装 Node.js 20 或更高版本后重试。');
  }
  try {
    await execCapture('npm', ['install', '-g', '@fly-ai/flyai-cli', '--no-fund', '--no-audit'], { timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const message = String(error.message || '');
    if (/EACCES|permission denied/i.test(message)) throw new Error('当前用户没有全局安装权限。请用拥有 Node.js 安装权限的账户重试，或联系设备管理员。');
    if (/ENOTFOUND|network|fetch failed|timed out/i.test(message)) throw new Error('无法下载飞猪查询组件，请检查网络后重试。');
    throw new Error('安装飞猪查询组件失败，请稍后重试。');
  }
  try { await execCapture('which', ['flyai']); }
  catch { throw new Error('组件已下载，但当前服务还未找到 flyai。请关闭并重新打开本应用后再次检测。'); }
}

const cliDefinitions = {
  codex: { label: 'Codex CLI', command: 'codex', loginCommand: 'codex login' },
  claude: { label: 'Claude Code', command: 'claude', loginCommand: 'claude auth login' },
  gemini: { label: 'Gemini CLI', command: 'gemini', loginCommand: 'gemini' },
  pi: { label: 'Pi', command: 'pi', loginCommand: 'pi' },
  kimi: { label: 'Kimi Code', command: 'kimi', loginCommand: 'kimi' },
  opencode: { label: 'OpenCode', command: 'opencode', loginCommand: 'opencode auth login' }
};

function hasFileContent(filePath) {
  try { return fs.statSync(filePath).size > 2; } catch { return false; }
}

function hasCredentialFile(directory) {
  try { return fs.readdirSync(directory).some(name => hasFileContent(path.join(directory, name))); } catch { return false; }
}

function hasEnvironmentCredential(names) {
  return names.some(name => Boolean(String(process.env[name] || '').trim()));
}

async function cliAuthorization(id) {
  const home = os.homedir();
  if (id === 'codex') {
    const output = await execCapture('codex', ['login', 'status'], { shell: cliSpawnShell });
    const authenticated = /logged in/i.test(output);
    return { authenticated, authDetail: authenticated ? output.replace(/^Logged in using\s*/i, '已通过 ') : '尚未登录' };
  }
  if (id === 'claude') {
    const output = await execCapture('claude', ['auth', 'status'], { shell: cliSpawnShell });
    const status = JSON.parse(output);
    const authenticated = Boolean(status.loggedIn);
    return { authenticated, authDetail: authenticated ? `已授权 · ${status.apiProvider || status.authMethod || '本地账户'}` : '尚未登录' };
  }
  if (id === 'gemini') {
    const authenticated = hasEnvironmentCredential(['GEMINI_API_KEY', 'GOOGLE_API_KEY']) || hasFileContent(path.join(home, '.gemini', 'oauth_creds.json')) || hasFileContent(path.join(home, '.config', 'gemini', 'oauth_creds.json'));
    return { authenticated, authDetail: authenticated ? '已发现本地授权凭据' : '已安装，请先在终端完成登录' };
  }
  if (id === 'pi') {
    const authenticated = hasEnvironmentCredential(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY']) || hasFileContent(path.join(home, '.pi', 'agent', 'auth.json'));
    return { authenticated, authDetail: authenticated ? '已发现本地授权凭据' : '已安装，请在 Pi 中执行 /login' };
  }
  if (id === 'kimi') {
    const kimiHome = process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
    const authenticated = hasCredentialFile(path.join(kimiHome, 'credentials')) || /(?:^|\n)\s*(?:api_key|oauth)\s*=/m.test(fs.existsSync(path.join(kimiHome, 'config.toml')) ? fs.readFileSync(path.join(kimiHome, 'config.toml'), 'utf8') : '');
    return { authenticated, authDetail: authenticated ? '已发现本地授权凭据' : '已安装，请在 Kimi Code 中执行 /login' };
  }
  if (id === 'opencode') {
    const output = await execCapture('opencode', ['auth', 'list'], { shell: cliSpawnShell });
    const matched = output.match(/(\d+)\s+credentials?/i);
    const authenticated = Number(matched?.[1] || 0) > 0 || hasFileContent(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
    return { authenticated, authDetail: authenticated ? '已发现本地授权凭据' : '已安装，请运行 opencode auth login' };
  }
  return { authenticated: false, authDetail: '已安装，尚未确认授权' };
}

async function detectCli(id) {
  const definition = cliDefinitions[id];
  let executable; let version;
  try {
    executable = await execCapture(pathLocator, [definition.command]);
    version = (await execCapture(definition.command, ['--version'], { shell: cliSpawnShell })).split('\n')[0];
  } catch {
    return { id, label: definition.label, installed: false, authenticated: false, version: '', path: '', authDetail: '未安装', loginCommand: definition.loginCommand };
  }
  try {
    const { authenticated, authDetail } = await cliAuthorization(id);
    return { id, label: definition.label, installed: true, authenticated, version, path: executable, authDetail, loginCommand: definition.loginCommand };
  } catch (error) {
    return { id, label: definition.label, installed: true, authenticated: false, version, path: executable, authDetail: '已安装，尚未登录', loginCommand: definition.loginCommand };
  }
}

async function publicSettings() {
  const detectedCli = await Promise.all(Object.keys(cliDefinitions).map(detectCli));
  const cli = detectedCli.map(({ path: _localPath, ...status }) => status);
  let flyaiCliInstalled = Boolean(bundledFlyaiPath && fs.existsSync(bundledFlyaiPath));
  if (!flyaiCliInstalled) try { flyaiCliInstalled = Boolean(await execCapture('which', ['flyai'])); } catch {}
  const aiApiKey = effective('AI_API_KEY');
  const flyaiApiKey = effective('FLYAI_API_KEY');
  return {
    desktopApp: desktopMode,
    aiMode: localConfig.aiMode || 'api',
    aiCli: localConfig.aiCli || 'codex',
    aiBaseUrl: effective('AI_BASE_URL'),
    model: effective('MODEL_NAME'),
    hasAiApiKey: Boolean(aiApiKey),
    hasFlyaiApiKey: Boolean(flyaiApiKey),
    aiApiKeyMask: aiApiKey ? '••••••••' : '',
    flyaiApiKeyMask: flyaiApiKey ? '••••••••' : '',
    flyaiCliInstalled,
    cli
  };
}

function normalizedAiBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new Error('请输入有效的 OpenAI 兼容接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址需使用 HTTP 或 HTTPS，且只包含域名、端口和路径');
  }
  const base = url.href.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

function sameAiEndpoint(first, second) {
  if (!first || !second) return false;
  try { return normalizedAiBaseUrl(first) === normalizedAiBaseUrl(second); }
  catch { return false; }
}

function saveSettings(payload) {
  const next = { ...localConfig };
  if (payload.aiMode === 'api' || payload.aiMode === 'cli') next.aiMode = payload.aiMode;
  if (cliDefinitions[payload.aiCli]) next.aiCli = payload.aiCli;
  if (typeof payload.aiBaseUrl === 'string') {
    const aiBaseUrl = payload.aiBaseUrl.trim();
    if (aiBaseUrl) normalizedAiBaseUrl(aiBaseUrl);
    if (aiBaseUrl !== effective('AI_BASE_URL') && !sameAiEndpoint(aiBaseUrl, effective('AI_BASE_URL'))) {
      next.aiApiKey = '';
    }
    next.aiBaseUrl = aiBaseUrl.replace(/\/+$/, '');
  }
  if (typeof payload.model === 'string') next.model = payload.model.trim();
  if (typeof payload.aiApiKey === 'string' && payload.aiApiKey.trim()) next.aiApiKey = payload.aiApiKey.trim();
  if (typeof payload.flyaiApiKey === 'string' && payload.flyaiApiKey.trim()) next.flyaiApiKey = payload.flyaiApiKey.trim();
  if (payload.clearAiApiKey) next.aiApiKey = '';
  if (payload.clearFlyaiApiKey) next.flyaiApiKey = '';
  writeLocalConfig(next);
}

async function getChinaMap() {
  if (chinaMapCache.data && chinaMapCache.expiresAt > Date.now()) return chinaMapCache.data;
  const response = await fetch(chinaMapUrl, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`地图数据读取失败（HTTP ${response.status}）`);
  const data = await response.json();
  chinaMapCache = { expiresAt: Date.now() + 24 * 60 * 60 * 1000, data };
  return data;
}

async function getEchartsSource() {
  if (echartsSourceCache) return echartsSourceCache;
  const response = await fetch(echartsUrl, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`地图组件读取失败（HTTP ${response.status}）`);
  const source = await response.text();
  if (createHash('sha256').update(source).digest('hex') !== echartsSha256) {
    throw new Error('地图组件完整性校验失败');
  }
  echartsSourceCache = source;
  return echartsSourceCache;
}

async function getBrandLogo() {
  if (brandLogoCache.data && brandLogoCache.expiresAt > Date.now()) return brandLogoCache;
  const response = await fetch(brandLogoUrl, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Logo 读取失败（HTTP ${response.status}）`);
  const contentType = String(response.headers.get('content-type') || 'image/webp').split(';')[0];
  if (!contentType.startsWith('image/')) throw new Error('Logo 源文件不是图片');
  const data = Buffer.from(await response.arrayBuffer());
  brandLogoCache = { expiresAt: Date.now() + 24 * 60 * 60 * 1000, contentType, data };
  return brandLogoCache;
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function resolveWeatherLocation(location) {
  const latitude = Number(location.latitude); const longitude = Number(location.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { ...location, latitude, longitude };
  const city = String(location.city || '').trim();
  if (!city) return null;
  if (geocodeCache.has(city)) return { ...location, ...geocodeCache.get(city) };
  async function geocode(term) {
    const params = new URLSearchParams({ name: term, count: '5', language: 'zh', countryCode: 'CN' });
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return [];
    return (await response.json())?.results || [];
  }
  const fullCityName = /(?:市|自治州|地区|盟)$/.test(city) ? city : `${city}市`;
  let matches = await geocode(fullCityName);
  if (!matches.length) matches = await geocode(city);
  const match = matches.sort((a, b) => Number(b.name === fullCityName) - Number(a.name === fullCityName) || Number(/^PPLA\d?$/.test(b.feature_code)) - Number(/^PPLA\d?$/.test(a.feature_code)) || Number(b.population || 0) - Number(a.population || 0))[0];
  if (!match) return null;
  const resolved = { latitude: Number(match.latitude), longitude: Number(match.longitude) };
  geocodeCache.set(city, resolved);
  return { ...location, ...resolved };
}

async function weatherForecast(payload) {
  const locations = (Array.isArray(payload.locations) ? payload.locations : []).filter(item => item?.code && item?.city).slice(0, 20);
  if (!locations.length) return { weather: {}, available: false, reason: '没有可查询的目的地' };
  const resolved = (await Promise.all(locations.map(resolveWeatherLocation))).filter(Boolean);
  const coordinates = Object.fromEntries(resolved.map(location => [location.code, { latitude: location.latitude, longitude: location.longitude }]));
  if (!resolved.length) return { weather: {}, coordinates, available: false, reason: '暂时无法定位目的地' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lastForecastDay = new Date(today); lastForecastDay.setDate(lastForecastDay.getDate() + 15);
  const requestedStart = new Date(`${payload.startDate}T00:00:00`);
  const requestedEnd = new Date(`${payload.endDate || payload.startDate}T00:00:00`);
  if (!Number.isFinite(requestedStart.getTime()) || requestedStart > lastForecastDay || requestedEnd < today) return { weather: {}, coordinates, available: false, reason: '目的地天气仅在出发前 16 天内提供' };
  const startDate = isoDate(requestedStart < today ? today : requestedStart);
  const endDate = isoDate(requestedEnd > lastForecastDay ? lastForecastDay : requestedEnd);
  const cacheKey = JSON.stringify({ locations: locations.map(item => [item.code, item.city, item.latitude, item.longitude]), startDate, endDate });
  const cached = weatherCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.data;
  const params = new URLSearchParams({
    latitude: resolved.map(item => item.latitude).join(','),
    longitude: resolved.map(item => item.longitude).join(','),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Asia/Shanghai',
    start_date: startDate,
    end_date: endDate
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`天气服务暂不可用（HTTP ${response.status}）`);
  const raw = await response.json(); const forecasts = Array.isArray(raw) ? raw : [raw]; const weather = {};
  resolved.forEach((location, index) => {
    const daily = forecasts[index]?.daily || {}; const minValues = (daily.temperature_2m_min || []).map(Number).filter(Number.isFinite); const maxValues = (daily.temperature_2m_max || []).map(Number).filter(Number.isFinite); const rainValues = (daily.precipitation_probability_max || []).map(Number).filter(Number.isFinite);
    if (!minValues.length || !maxValues.length) return;
    weather[location.code] = { city: location.city, latitude: location.latitude, longitude: location.longitude, code: Number(daily.weather_code?.[0] ?? -1), min: Math.round(Math.min(...minValues)), max: Math.round(Math.max(...maxValues)), rain: rainValues.length ? Math.round(Math.max(...rainValues)) : null, startDate, endDate, provider: 'Open-Meteo' };
  });
  const data = { weather, coordinates, available: Boolean(Object.keys(weather).length), startDate, endDate };
  weatherCache.set(cacheKey, { data, expiresAt: Date.now() + 30 * 60 * 1000 });
  if (weatherCache.size > 40) weatherCache.delete(weatherCache.keys().next().value);
  return data;
}

function runFlyaiOnce(args, model, timeout = 90000) {
  const apiKey = effective('FLYAI_API_KEY');
  if (flyaiRunner) return flyaiRunner({ args, model, apiKey, timeout });
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FLYAI_API_KEY: apiKey };
    if (model) env.MODEL_NAME = model;
    const command = bundledFlyaiPath ? process.execPath : 'flyai';
    const commandArgs = bundledFlyaiPath ? [bundledFlyaiPath, 'search-flight', ...args] : ['search-flight', ...args];
    if (bundledFlyaiPath && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    execFile(command, commandArgs, { env, timeout, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('FlyAI 返回了无法解析的数据')); }
    });
  });
}

function flyaiCacheKey(args, model, strict) { return JSON.stringify({ args, model: model || '', strict }); }
function isRateLimited(error) { return /\b429\b|rate limit|too many requests/i.test(String(error?.message || error)); }

function runFlyai(args, model, { deadline, strict = false } = {}) {
  const key = flyaiCacheKey(args, model, strict);
  const cached = flyaiCache.get(key);
  if (cached?.expiresAt > Date.now()) return Promise.resolve(cached.data);
  if (flyaiInflight.has(key)) return flyaiInflight.get(key);

  const task = flyaiQueue.then(async () => {
    const cooldown = Math.max(0, flyaiNextRunAt - Date.now());
    if (cooldown) await wait(cooldown);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const remaining = deadline ? deadline - Date.now() : 90000;
        if (remaining <= 0) throw new Error('FlyAI 查询超时');
        const timeout = strict ? Math.min(remaining, 12000) : remaining;
        const data = await runFlyaiOnce(args, model, timeout);
        if (strict && data?.status != null && Number(data.status) !== 0) {
          throw new Error(String(data.message || '航班查询未完成'));
        }
        flyaiNextRunAt = Date.now() + 450;
        const hasFlightItems = !strict || data?.data?.itemList?.length > 0;
        if (hasFlightItems) {
          flyaiCache.set(key, { data, expiresAt: Date.now() + 10 * 60 * 1000 });
          if (flyaiCache.size > 120) flyaiCache.delete(flyaiCache.keys().next().value);
        }
        return data;
      } catch (error) {
        lastError = error;
        flyaiNextRunAt = Date.now() + 450;
        if (!isRateLimited(error) || attempt === 2) throw error;
        const delay = 1000 * (attempt + 1);
        flyaiNextRunAt = Date.now() + delay;
        await wait(delay);
      }
    }
    throw lastError;
  });
  flyaiQueue = task.catch(() => undefined);
  flyaiInflight.set(key, task);
  task.finally(() => flyaiInflight.delete(key)).catch(() => undefined);
  return task;
}

let modelsCache = { expiresAt: 0, models: [] };
function openAiCompatibleUrl(pathname, overrideBaseUrl) {
  const baseUrl = String(overrideBaseUrl === undefined ? effective('AI_BASE_URL') : overrideBaseUrl).trim();
  if (!baseUrl) throw new Error('未配置 OpenAI 兼容接口地址');
  return `${normalizedAiBaseUrl(baseUrl)}/${pathname}`;
}

async function listModels(options = {}) {
  const useConfigured = options.baseUrl === undefined && options.apiKey === undefined;
  if (useConfigured && modelsCache.expiresAt > Date.now()) return modelsCache.models;
  const apiKey = String(useConfigured ? effective('AI_API_KEY') : options.apiKey || '').trim();
  if (!apiKey) throw new Error('未配置 AI API Key');
  const response = await fetch(openAiCompatibleUrl('models', useConfigured ? undefined : options.baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
  const payload = await response.json();
  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .filter(model => model?.id)
    .map(model => ({ id: String(model.id), ownedBy: model.owned_by || '', endpoints: model.supported_endpoint_types || [] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const configured = useConfigured ? effective('MODEL_NAME').split(',').map(item => item.trim()).filter(item => item && item !== '*') : [];
  for (const id of configured) if (!models.some(model => model.id === id)) models.unshift({ id, ownedBy: 'env', endpoints: [] });
  if (useConfigured) modelsCache = { expiresAt: Date.now() + 5 * 60 * 1000, models };
  return models;
}

function value(item, keys) {
  for (const key of keys) {
    const raw = item?.[key];
    if (raw !== undefined && raw !== null && raw !== '') {
      const number = Number(String(raw).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(number)) return number;
    }
  }
  return null;
}

function durationMinutes(raw) {
  const minutes = Number(String(raw ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(minutes) ? minutes : 0;
}

function segmentCoordinate(segment, side) {
  const stationCode = String(segment?.[`${side}StationCode`] || '').toUpperCase();
  const cityCode = String(segment?.[`${side}CityCode`] || '').toUpperCase();
  const cityName = String(segment?.[`${side}CityName`] || '').trim();
  return airportCoordinates[stationCode] || airportCoordinates[cityCode] || cityCoordinates[cityName] || null;
}

function greatCircleDistanceKm(from, to) {
  if (!from || !to) return null;
  const radians = value => value * Math.PI / 180;
  const [fromLongitude, fromLatitude] = from, [toLongitude, toLatitude] = to;
  const latitudeDelta = radians(toLatitude - fromLatitude);
  const longitudeDelta = radians(toLongitude - fromLongitude);
  const arc = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(fromLatitude)) * Math.cos(radians(toLatitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc)));
}

function estimatedSegmentFee(segment) {
  const distanceKm = greatCircleDistanceKm(segmentCoordinate(segment, 'dep'), segmentCoordinate(segment, 'arr'));
  if (!Number.isFinite(distanceKm)) return null;
  const fuelSurcharge = distanceKm <= feePolicy.thresholdKm ? feePolicy.shortHaulFuelSurcharge : feePolicy.longHaulFuelSurcharge;
  return { distanceKm, amount: feePolicy.airportConstruction + fuelSurcharge };
}

function estimatedJourneyFee(segments) {
  const fees = segments.map(estimatedSegmentFee);
  if (!fees.length || fees.some(fee => !fee)) return null;
  return { amount: fees.reduce((total, fee) => total + fee.amount, 0), distanceKm: fees.reduce((total, fee) => total + fee.distanceKm, 0), segments: fees };
}

function segmentAirport(segment, side) {
  const code = String(segment?.[`${side}StationCode`] || '').trim().toUpperCase();
  if (!code) return null;
  const name = segment[`${side}StationShortName`] || segment[`${side}StationName`] || code;
  return { code, name };
}

function normalizeJourney(journey, fallbackDuration) {
  const segments = journey?.segments;
  if (!Array.isArray(segments) || !segments.length || segments.some(segment => !segment)) return null;
  const first = segments[0], last = segments.at(-1);
  if (!last.arrCityName || !last.arrCityCode || typeof first.depDateTime !== 'string') return null;
  const flightMinutes = segments.reduce((total, segment) => total + durationMinutes(segment.duration), 0);
  const elapsedMinutes = durationMinutes(journey.totalDuration || fallbackDuration) || flightMinutes;
  const airlines = [...new Set(segments.map(segment => segment.marketingTransportName).filter(Boolean))].join(' / ');
  const flightKey = JSON.stringify(segments.map(segment => [
    segment.depStationCode || segment.depCityCode, segment.depDateTime,
    segment.arrStationCode || segment.arrCityCode, segment.arrDateTime,
    segment.marketingTransportNo || segment.marketingTransportName
  ]));
  const international = segments.some(segment =>
    segment.depCityAbroad === true || segment.arrCityAbroad === true ||
    [segment.depCityCode, segment.arrCityCode, segment.depStationCode, segment.arrStationCode].some(code => regionalAirportCodes.has(code))
  );
  return {
    flightKey, city: last.arrCityName, code: last.arrCityCode, departureCityCode: first.depCityCode,
    departureAirport: segmentAirport(first, 'dep'), arrivalAirport: segmentAirport(last, 'arr'),
    date: first.depDateTime.slice(0, 10), time: first.depDateTime.slice(11, 16),
    arrivalDate: last.arrDateTime?.slice(0, 10), arrivalTime: last.arrDateTime?.slice(11, 16),
    airline: airlines, flightMinutes, elapsedMinutes, international, segments,
    layoverMinutes: durationMinutes(journey.transferDuration) || Math.max(0, elapsedMinutes - flightMinutes),
    duration: Number((flightMinutes / 60).toFixed(1)), direct: journey.journeyType === '直达'
  };
}

function normalize(data) {
  const items = data?.data?.itemList || [];
  return items.flatMap(item => {
    if (item?.journeys?.length !== 1) return [];
    const flight = normalizeJourney(item.journeys[0], item.totalDuration);
    const fare = value(item, ['ticketPrice', 'adultPrice', 'price']);
    if (!flight || !flight.time || fare === null) return [];
    return [{
      ...flight, fare, fee: value(item, ['taxFee', 'tax']),
      estimatedFee: flight.international ? null : estimatedJourneyFee(flight.segments), jumpUrl: item.jumpUrl
    }];
  });
}
function inTime(time, start, end) { return !start || !end || time >= start && time <= end; }
function reasonableItinerary(flight) { return flight.direct || flight.layoverMinutes <= 4 * 60; }
function matchesDomesticPreferences(flight, query) {
  if (query.maxFlightHours && (!flight.flightMinutes || flight.flightMinutes > query.maxFlightHours * 60)) return false;
  return !query.avoidRedeye || !flight.segments.some(segment =>
    [segment.depDateTime, segment.arrDateTime].some(time => /^0[0-5]:/.test(String(time || '').slice(11, 16)))
  );
}
function dateArgs(query, prefix) {
  const fixedDate = query[`${prefix}Date`];
  if (fixedDate) return ['--dep-date', fixedDate];
  const start = query[`${prefix}DateStart`], end = query[`${prefix}DateEnd`];
  if (start && end) return ['--dep-date-start', start, '--dep-date-end', end];
  throw new Error(prefix === 'dep' ? '请选择出发日期' : '请选择回程日期');
}
function validateTripDates(query) {
  const depDate = String(query.depDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(depDate)) {
    const error = new Error('请选择有效的出发日期'); error.statusCode = 400; throw error;
  }
  if (query.trip === 'oneway') return;
  const backDate = String(query.backDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(backDate)) {
    const error = new Error('请选择有效的回程日期'); error.statusCode = 400; throw error;
  }
  if (backDate < depDate) {
    const error = new Error('回程日期不能早于出发日期'); error.statusCode = 400; throw error;
  }
}
function airportFee(item) {
  if (item.fee !== null) return { amount: item.fee, source: '接口', distanceKm: null };
  if (item.international) return { amount: 0, source: '', distanceKm: null, pending: true };
  if (item.estimatedFee) return { amount: item.estimatedFee.amount, source: '航程估算', distanceKm: item.estimatedFee.distanceKm, segments: item.estimatedFee.segments };
  return { amount: feePolicy.airportConstruction + feePolicy.longHaulFuelSurcharge, source: '兜底估算', distanceKm: null };
}
function uniqueFlights(flights) {
  const byFlight = new Map();
  for (const flight of flights) {
    const previous = byFlight.get(flight.flightKey);
    if (!previous || flight.fare + airportFee(flight).amount < previous.fare + airportFee(previous).amount) {
      byFlight.set(flight.flightKey, flight);
    }
  }
  return [...byFlight.values()];
}

function normalizedDomesticCityName(value) {
  return String(value || '').trim().replace(/^中国/, '').replace(/(?:特别行政区|市)$/, '');
}

function isDomesticDestination(item) {
  return domesticCitySet.has(normalizedDomesticCityName(item?.city));
}

function stableExplorationTargets(query, existingCities) {
  const origin = normalizedDomesticCityName(query.origin || '广州');
  const pool = domesticExplorationCities.filter(city => city !== origin && !existingCities.has(city));
  const seed = `${origin}|${query.depDate || ''}|${query.backDate || ''}`;
  const hash = [...seed].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
  const offset = pool.length ? hash % pool.length : 0;
  return [...pool.slice(offset), ...pool.slice(0, offset)];
}

function domesticPriceSort(a, b) {
  return Number(!isDomesticDestination(a)) - Number(!isDomesticDestination(b)) || Number(a.totalPrice ?? a.fare) - Number(b.totalPrice ?? b.fare);
}

function roundTripCombinations(outboundOptions, inboundOptions, query) {
  const combinations = [];
  for (const out of outboundOptions) for (const back of inboundOptions) {
    if (out.layoverMinutes + back.layoverMinutes <= 4 * 60) combinations.push(makeResult(out, back, query));
  }
  return combinations;
}

function searchCacheKey(query) {
  return JSON.stringify({ scope: query.scope, origin: query.origin || '广州', originAirport: query.originAirport, passengers: query.passengers || 1, destination: query.destination || 'all', trip: query.trip || 'round', depDate: query.depDate, backDate: query.backDate || '', outTimeStart: query.outTimeStart || '', outTimeEnd: query.outTimeEnd || '', backTimeStart: query.backTimeStart || '', backTimeEnd: query.backTimeEnd || '', avoidRedeye: query.avoidRedeye, maxFlightHours: query.maxFlightHours, model: query.model || effective('MODEL_NAME') });
}

async function searchFresh(query) {
  const airport = query.originAirport;
  const origin = airport ? (airportSearchNames[airport] || airport) : (query.origin || '广州');
  const destination = query.destination && query.destination !== 'all' ? query.destination : null;
  const common = ['--origin', origin];
  if (query.outTimeStart) common.push('--dep-hour-start', String(Number(query.outTimeStart.slice(0, 2))));
  if (query.outTimeEnd) common.push('--dep-hour-end', String(Number(query.outTimeEnd.slice(0, 2))));
  const model = query.model || effective('MODEL_NAME');
  const inScope = flight => query.scope !== 'domestic' || !flight.international;
  const normalizeOutbound = data => normalize(data).filter(flight => inScope(flight) && (!airport || flight.departureAirport?.code === airport));
  const matches = (flight, start, end) => inTime(flight.time, start, end) &&
    reasonableItinerary(flight) && matchesDomesticPreferences(flight, query);
  const outboundMatches = flight => matches(flight, query.outTimeStart, query.outTimeEnd);
  async function returnFlights(from) {
    const args = ['--origin', from, '--destination', origin, '--sort-type', '3', ...dateArgs(query, 'back')];
    if (query.backTimeStart) args.push('--dep-hour-start', String(Number(query.backTimeStart.slice(0, 2))));
    if (query.backTimeEnd) args.push('--dep-hour-end', String(Number(query.backTimeEnd.slice(0, 2))));
    const data = await runFlyai(args, model);
    return uniqueFlights(normalize(data).filter(flight =>
      inScope(flight) && (!airport || flight.arrivalAirport?.code === airport) &&
      matches(flight, query.backTimeStart, query.backTimeEnd)
    ));
  }
  const sortTypes = ['3', '4', '2', '8'];
  const outboundSearches = await Promise.allSettled(sortTypes.map(sortType => runFlyai([...common, '--sort-type', sortType, ...(destination ? ['--destination', destination] : []), ...dateArgs(query, 'dep')], model)));
  const successful = outboundSearches.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!successful.length) throw outboundSearches[0]?.reason || new Error('航班查询没有返回结果');
  const outboundNormalized = successful.flatMap(normalizeOutbound);
  const attemptedDomesticCities = new Set(outboundNormalized.filter(isDomesticDestination).map(item => normalizedDomesticCityName(item.city)));
  if (!destination) {
    const eligibleCities = new Set(outboundNormalized.filter(flight => isDomesticDestination(flight) && outboundMatches(flight))
      .map(flight => normalizedDomesticCityName(flight.city)));
    const needed = Math.max(0, explorationDestinationLimit - eligibleCities.size);
    const targets = stableExplorationTargets(query, attemptedDomesticCities).slice(0, needed);
    targets.forEach(city => attemptedDomesticCities.add(city));
    const supplements = await Promise.allSettled(targets.map(city => runFlyai([...common, '--sort-type', '3', '--destination', city, ...dateArgs(query, 'dep')], model)));
    outboundNormalized.push(...supplements.filter(item => item.status === 'fulfilled').flatMap(item => normalizeOutbound(item.value)));
  }
  const outbound = outboundNormalized.filter(outboundMatches);
  const groups = new Map();
  outbound.forEach(f => {
    if (!groups.has(f.code)) groups.set(f.code, []);
    groups.get(f.code).push(f);
  });
  const destinations = [...groups.values()].sort((a, b) => Number(!isDomesticDestination(a[0])) - Number(!isDomesticDestination(b[0])) || Math.min(...a.map(item => item.fare)) - Math.min(...b.map(item => item.fare)) || Math.min(...a.map(item => item.duration)) - Math.min(...b.map(item => item.duration))).map(uniqueFlights);
  if (query.trip === 'oneway') {
    return destinations.flat().map(f => makeResult(f, null, query)).sort(domesticPriceSort).map((item, index) => ({ ...item, rank: index + 1 }));
  }
  const results = [];
  for (const outboundOptions of destinations) {
    try {
      const inboundOptions = await returnFlights(outboundOptions[0].code);
      results.push(...roundTripCombinations(outboundOptions, inboundOptions, query));
    } catch {
      continue;
    }
  }
  if (!destination) {
    const matchedDestinations = new Set(results.map(item => item.code));
    const fallbackTargets = stableExplorationTargets(query, attemptedDomesticCities);
    let fallbackAttempts = 0;
    for (const city of fallbackTargets) {
      if (matchedDestinations.size >= minimumExplorationDestinations || fallbackAttempts >= explorationFallbackAttempts) break;
      fallbackAttempts++;
      try {
        const outboundData = await runFlyai([...common, '--sort-type', '3', '--destination', city, ...dateArgs(query, 'dep')], model);
        const outboundOptions = uniqueFlights(normalizeOutbound(outboundData).filter(outboundMatches));
        if (!outboundOptions.length) continue;
        const fallbackAirport = outboundOptions[0];
        const fallbackOutboundOptions = outboundOptions.filter(item => item.code === fallbackAirport.code);
        const inboundOptions = await returnFlights(fallbackAirport.code);
        const combinations = roundTripCombinations(fallbackOutboundOptions, inboundOptions, query);
        if (combinations.length) {
          results.push(...combinations);
          matchedDestinations.add(fallbackAirport.code);
        }
      } catch {
        continue;
      }
    }
  }
  return results.filter(Boolean).sort(domesticPriceSort).map((item, index) => ({ ...item, rank: index + 1 }));
}

function yuanAmount(item, fields) {
  for (const field of fields) {
    const raw = String(item?.[field] ?? '').trim().replace(/^(?:CNY|RMB|[¥￥])\s*/i, '').replace(/[,，]/g, '');
    if (/^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))) return Number(raw);
  }
  return null;
}

function specifiedAirport(value, cityCode) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) && code !== cityCode ? code : '';
}

function internationalQuote(item) {
  const currency = String(item?.currencyCode || item?.currency || 'CNY').trim().toUpperCase();
  if (!['CNY', 'RMB', '¥', '￥'].includes(currency)) return null;
  const fare = yuanAmount(item, ['ticketPrice', 'adultPrice', 'price']);
  if (fare === null) return null;
  return { fare, fee: yuanAmount(item, ['taxFee', 'tax']), jumpUrl: item.jumpUrl };
}

function matchingInternationalLegs(out, back, query) {
  if (!out?.time || out.date !== query.depDate || !inTime(out.time, query.outTimeStart, query.outTimeEnd)) return false;
  if (query.trip !== 'oneway' && (!back?.time || back.date !== query.backDate ||
    !inTime(back.time, query.backTimeStart, query.backTimeEnd))) return false;
  const fromAirport = query.originAirport || specifiedAirport(query.origin, out.departureCityCode);
  if (fromAirport && (out.departureAirport?.code !== fromAirport ||
    (back && back.arrivalAirport?.code !== fromAirport))) return false;
  const toAirport = query.destination === 'all' ? '' : specifiedAirport(query.destination, out.code);
  if (toAirport && (out.arrivalAirport?.code !== toAirport ||
    (back && back.departureAirport?.code !== toAirport))) return false;
  if (back && (out.code !== back.departureCityCode || out.departureCityCode !== back.code)) return false;
  return !back || !(out.arrivalDate > back.date ||
    (out.arrivalDate === back.date && out.arrivalTime >= back.time));
}

function internationalItinerary(item, query) {
  const round = query.trip !== 'oneway';
  if (item?.journeys?.length !== (round ? 2 : 1)) return null;
  const quote = internationalQuote(item);
  if (!quote) return null;
  const out = normalizeJourney(item.journeys[0], round ? null : item.totalDuration);
  const back = round ? normalizeJourney(item.journeys[1]) : null;
  return matchingInternationalLegs(out, back, query) ? makeResult(out, back, query, quote) : null;
}

async function internationalItems(args, model, deadline) {
  const response = await runFlyai(args, model, { deadline, strict: true });
  const items = response?.data?.itemList;
  if (!Array.isArray(items)) throw new Error('航班数据源未返回有效结果');
  return items;
}

function internationalFlightArgs(origin, destination, date, start, end, sort = '3') {
  const args = ['--origin', origin, '--destination', destination, '--dep-date', date, '--sort-type', sort];
  if (start && start !== '00:00') args.push('--dep-hour-start', String(Number(start.slice(0, 2))));
  if (end && end !== '23:59') args.push('--dep-hour-end', String(Number(end.slice(0, 2))));
  return args;
}

async function searchSeparateInternationalTickets(query, origin, model, deadline) {
  const loadLegs = async args => {
    const items = await internationalItems(args, model, deadline);
    return items.flatMap(item => {
      if (item?.journeys?.length !== 1) return [];
      const quote = internationalQuote(item);
      const flight = normalizeJourney(item.journeys[0], item.totalDuration);
      return quote && flight ? [{ flight, quote }] : [];
    });
  };
  const outbound = await loadLegs(internationalFlightArgs(
    origin, query.destination, query.depDate, query.outTimeStart, query.outTimeEnd
  ));
  if (!outbound.length) return [];
  const inbound = await loadLegs(internationalFlightArgs(
    query.destination, origin, query.backDate, query.backTimeStart, query.backTimeEnd
  ));
  const results = [];
  for (const out of outbound) {
    for (const back of inbound) {
      if (!matchingInternationalLegs(out.flight, back.flight, query)) continue;
      results.push(makeResult(out.flight, back.flight, query, {
        fare: out.quote.fare + back.quote.fare,
        fee: (out.quote.fee ?? 0) + (back.quote.fee ?? 0),
        feesPending: out.quote.fee === null || back.quote.fee === null,
        jumpUrl: out.quote.jumpUrl, backJumpUrl: back.quote.jumpUrl, separateTickets: true
      }));
    }
  }
  return results;
}

function compareQuotedPrice(a, b) {
  return Number(Boolean(a.feesPending)) - Number(Boolean(b.feesPending)) || a.totalPrice - b.totalPrice;
}

async function searchInternational(query, reportProgress) {
  const airport = query.originAirport;
  const origin = airport ? (airportSearchNames[airport] || airport) : (query.origin || '广州');
  const exploring = !query.destination || query.destination === 'all';
  const round = query.trip !== 'oneway';
  const targets = exploring
    ? internationalDestinations.filter(city => !city.directedOnly &&
      ![city.code, city.cityCode, city.name, ...(city.airports || [])].includes(origin.toUpperCase())).map(city => city.code)
    : [query.destination];
  const deadline = Date.now() + (exploring ? 35000 : 22000);
  const firstPassDeadline = exploring && round ? deadline - 12000 : deadline;
  const model = query.model || effective('MODEL_NAME');
  const statuses = new Map(targets.map(code => [code, 'unqueried']));
  function summarizeCoverage() {
    const counts = { quoted: 0, empty: 0, failed: 0, unqueried: 0 };
    for (const status of statuses.values()) counts[status]++;
    return {
      attempted: targets.length - counts.unqueried, completed: counts.quoted + counts.empty,
      failed: counts.failed, planned: targets.length
    };
  }
  const flightArgs = (target, sort) => internationalFlightArgs(
    origin, target, query.depDate, query.outTimeStart, query.outTimeEnd, sort
  );

  const byItinerary = new Map();
  const foundCities = new Set();
  function publish(phase, details) {
    if (exploring) reportProgress({ ...summarizeCoverage(), matched: foundCities.size, phase, ...details });
  }
  function addResult(result) {
    foundCities.add(result.code);
    const previous = byItinerary.get(result.id);
    if (!previous || compareQuotedPrice(result, previous) < 0) byItinerary.set(result.id, result);
  }
  let failure, accessRestricted = false;
  function recordFailure(error) {
    if (/risk control|风控/i.test(error.message)) {
      accessRestricted = true;
      failure = error;
    } else {
      failure ||= error;
    }
  }
  publish('search');
  for (const target of targets) {
    if (Date.now() >= firstPassDeadline) break;
    let completed = false, matched = false;
    for (const sort of exploring ? ['3'] : ['3', '8']) {
      if (Date.now() >= firstPassDeadline) break;
      try {
        const args = flightArgs(target, sort);
        if (round) args.push('--back-date', query.backDate);
        const items = await internationalItems(args, model, firstPassDeadline);
        completed = true;
        for (const item of items) {
          const result = internationalItinerary(item, query);
          if (!result) continue;
          if (exploring && result.code !== target && result.outArrivalAirport?.code !== target) continue;
          addResult(result);
          matched = true;
        }
      } catch (error) {
        recordFailure(error);
        if (accessRestricted) break;
      }
    }
    statuses.set(target, matched ? 'quoted' : completed ? 'empty' : 'failed');
    publish('search');
    if (accessRestricted) break;
  }
  // Use the remaining time to recover sparse or heavily interrupted searches.
  const firstPass = summarizeCoverage();
  if (exploring && !accessRestricted && (foundCities.size < 4 || firstPass.failed > firstPass.completed) && Date.now() < deadline) {
    const recoveryRoutes = ['failed', 'empty', ...(round ? ['unqueried'] : [])]
      .flatMap(status => targets.filter(target => statuses.get(target) === status))
      .slice(0, round ? targets.length : 4);
    let rechecked = 0;
    const publishRecovery = () => publish('recovery', { rechecked, toRecheck: recoveryRoutes.length });
    if (recoveryRoutes.length) publishRecovery();
    for (const target of recoveryRoutes) {
      if (Date.now() >= deadline) break;
      const routeQuery = { ...query, destination: target };
      try {
        const recovered = round
          ? await searchSeparateInternationalTickets(routeQuery, origin, model, deadline)
          : (await internationalItems(flightArgs(target, '8'), model, deadline))
            .map(item => internationalItinerary(item, routeQuery)).filter(Boolean);
        recovered.forEach(addResult);
        statuses.set(target, recovered.length ? 'quoted' : 'empty');
      } catch (error) {
        recordFailure(error);
        if (statuses.get(target) === 'unqueried') statuses.set(target, 'failed');
      }
      rechecked++;
      publishRecovery();
      if (accessRestricted) break;
    }
  }
  if (!exploring && round && !accessRestricted && !byItinerary.size && Date.now() < deadline) {
    try {
      const separate = await searchSeparateInternationalTickets(query, origin, model, deadline);
      separate.forEach(addResult);
      statuses.set(query.destination, separate.length ? 'quoted' : 'empty');
    } catch (error) {
      recordFailure(error);
    }
  }
  const coverage = summarizeCoverage();
  if (exploring) coverage.destinations = targets.map(code => ({ code, status: statuses.get(code) }));
  if (!coverage.completed && failure) {
    if (exploring) failure.coverage = coverage;
    throw failure;
  }
  const results = [...byItinerary.values()].sort(compareQuotedPrice).map((item, index) => ({ ...item, rank: index + 1 }));
  return { results, coverage };
}

async function search(query, onProgress) {
  validateTripDates(query);
  const originAirport = String(query.originAirport || '').trim().toUpperCase();
  if (originAirport && !/^[A-Z]{3}$/.test(originAirport)) {
    const error = new Error('请选择有效的出发机场');
    error.statusCode = 400;
    throw error;
  }
  const maxFlightHours = Number(query.maxFlightHours);
  query = {
    ...query, originAirport,
    maxFlightHours: query.scope !== 'international' && Number.isFinite(maxFlightHours) && maxFlightHours > 0 ? maxFlightHours : 0,
    avoidRedeye: query.scope !== 'international' && query.avoidRedeye === true
  };
  const key = searchCacheKey(query);
  const cached = searchCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.response;
  let job = searchInflight.get(key);
  if (!job) {
    job = { listeners: new Set(), progress: null };
    const publish = progress => {
      job.progress = progress;
      for (const listener of job.listeners) listener(progress);
    };
    const load = query.scope === 'international' ? searchInternational(query, publish) : searchFresh(query).then(results => ({ results }));
    job.task = load.then(response => {
      if (!response.coverage || (response.results.length && response.coverage.completed === response.coverage.planned)) {
        searchCache.set(key, { response, expiresAt: Date.now() + 30 * 60 * 1000 });
        if (searchCache.size > 16) searchCache.delete(searchCache.keys().next().value);
      }
      return response;
    });
    searchInflight.set(key, job);
    job.task.finally(() => searchInflight.delete(key)).catch(() => undefined);
  }
  if (onProgress) {
    job.listeners.add(onProgress);
    if (job.progress) onProgress(job.progress);
  }
  try {
    return await job.task;
  } finally {
    if (onProgress) job.listeners.delete(onProgress);
  }
}
function parseAiJson(content) {
  const clean = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 未返回有效建议');
  return JSON.parse(clean.slice(start, end + 1));
}

async function runAiCli(prompt, cli, model) {
  const status = await detectCli(cli);
  if (!status.installed) throw new Error(`${status.label} 未安装`);
  if (!status.authenticated) throw new Error(`${status.label} 尚未授权，请先运行 ${status.loginCommand}`);
  // Windows 需经 shell 启动 npm shim（.cmd）；参数由 execCapture 校验，prompt 走 stdin 避免长度上限
  const promptViaStdin = process.platform === 'win32';
  const spawnCli = args => execCapture(cli, args, { timeout: 90000, shell: cliSpawnShell, input: promptViaStdin ? prompt : undefined });
  if (cli === 'codex') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flymap-ai-'));
    const outputPath = path.join(tempDir, 'answer.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only', '--color', 'never', '-o', outputPath];
    if (model) args.push('-m', model);
    if (!promptViaStdin) args.push(prompt);
    try { await spawnCli(args); return fs.readFileSync(outputPath, 'utf8'); }
    finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  }
  if (cli === 'claude') {
    const args = ['-p', '--output-format', 'text', '--disable-slash-commands'];
    if (model) args.push('--model', model);
    if (!promptViaStdin) args.push(prompt);
    return spawnCli(args);
  }
  if (cli === 'gemini') {
    const args = promptViaStdin ? ['--output-format', 'text', '--approval-mode', 'plan'] : ['-p', prompt, '--output-format', 'text', '--approval-mode', 'plan'];
    if (model) args.push('--model', model);
    return spawnCli(args);
  }
  if (cli === 'pi') {
    const args = ['--print', '--no-session', '--tools', 'read,grep,find,ls'];
    if (model) args.push('--model', model);
    if (!promptViaStdin) args.push(prompt);
    return spawnCli(args);
  }
  if (cli === 'kimi') {
    const args = promptViaStdin ? ['--print', '--plan', '--output-format', 'text'] : ['--plan', '--prompt', prompt, '--output-format', 'text'];
    if (model) args.unshift('--model', model);
    return spawnCli(args);
  }
  if (cli === 'opencode') {
    const args = ['run'];
    if (model) args.push('--model', model);
    if (!promptViaStdin) args.push(prompt);
    return spawnCli(args);
  }
  throw new Error(`暂不支持通过 ${status.label} 调用 AI`);
}

function normalizeAiAdvice(result, candidates) {
  const availableIds = new Set((candidates || []).map(item => item.id));
  const defaults = ['优先考虑', '最省钱', '少折腾'];
  const advice = (Array.isArray(result?.advice) ? result.advice : [])
    .filter(item => item && availableIds.has(item.id))
    .slice(0, 3)
    .map((item, index) => ({
      id: item.id,
      label: String(item.label || defaults[index] || '建议').slice(0, 12),
      reason: String(item.reason || '').slice(0, 80),
    }));
  return { summary: String(result?.summary || '').slice(0, 120), advice };
}

async function aiAdvice(payload) {
  const mode = localConfig.aiMode || 'api';
  const model = payload.model || effective('MODEL_NAME');
  const candidates = Array.isArray(payload.results) ? payload.results : [];
  if (!candidates.length) throw new Error('没有可供 AI 分析的航班组合');
  const fareGuidance = candidates.some(item => item.feesPending)
    ? ' feesPending 为 true 时，价格是税费待确认的报价。最低价建议写作“报价较低”，理由中注明税费待确认。'
    : '';
  const prompt = `你是机票决策助手。请分析以下真实航班候选，为用户给出可并列比较的建议。不要筛选、不要修改排序、不要创造或推测数据。请从候选中分别选择：优先考虑（平衡总价、总行程、直飞）、最省钱（总价最低）、少折腾（优先直飞和较短总行程；没有直飞时说明取舍）。仅返回 JSON：{"summary":"一句不超过50字的整体建议","advice":[{"label":"优先考虑","id":"候选id","reason":"不超过40字，具体说明价格、时长、直飞等取舍"},{"label":"最省钱","id":"候选id","reason":"不超过40字"},{"label":"少折腾","id":"候选id","reason":"不超过40字"}]}。每个 id 必须来自候选中的 id；候选不足三个时允许复用。不要把“已配对”当作理由。${fareGuidance}候选：${JSON.stringify(candidates)}。`;
  if (mode === 'cli') {
    const cli = localConfig.aiCli || 'codex';
    const result = normalizeAiAdvice(parseAiJson(await runAiCli(prompt, cli, model)), candidates);
    if (!result.advice.length) throw new Error('AI 未返回可用建议');
    return { ...result, model: model || cliDefinitions[cli].label, channel: cli };
  }
  const apiKey = effective('AI_API_KEY');
  if (!apiKey) throw new Error('未配置 OpenAI 兼容接口地址或 API Key');
  if (!model) throw new Error('请选择一个 AI 模型');
  const response = await fetch(openAiCompatibleUrl('chat/completions'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
    redirect: 'error', signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`AI 建议请求失败（HTTP ${response.status}）`);
  const data = await response.json(); const content = data?.choices?.[0]?.message?.content || '';
  const result = normalizeAiAdvice(parseAiJson(content), candidates);
  if (!result.advice.length) throw new Error('AI 未返回可用建议');
  return { ...result, model, channel: 'api' };
}
function segmentDetails(flight) {
  return flight?.segments.map(segment => ({
    from: segmentAirport(segment, 'dep'), to: segmentAirport(segment, 'arr'),
    departure: segment.depDateTime, arrival: segment.arrDateTime,
    airline: segment.marketingTransportName, number: segment.marketingTransportNo
  }));
}

function makeResult(outbound, inbound, query, quote) {
  const people = Math.max(1, Number(query.passengers || 1));
  const outboundFee = quote ? { amount: quote.fee ?? 0, source: '接口', pending: quote.feesPending ?? quote.fee === null } : airportFee(outbound);
  const inboundFee = inbound && !quote ? airportFee(inbound) : { amount: 0 };
  const feeItems = [outboundFee, inboundFee].filter(item => item.amount > 0);
  const feeSources = quote?.fee === 0 ? ['接口'] : [...new Set(feeItems.map(item => item.source))];
  const feeDistanceKm = feeItems.every(item => Number.isFinite(item.distanceKm)) ? feeItems.reduce((total, item) => total + item.distanceKm, 0) : null;
  const fare = quote?.fare ?? (outbound.fare + (inbound?.fare || 0));
  const fees = outboundFee.amount + inboundFee.amount;
  const feesPending = Boolean(outboundFee.pending || inboundFee.pending);
  const perPerson = fare + fees;
  const flightKeys = [outbound.flightKey, inbound?.flightKey];
  if (quote?.separateTickets) flightKeys.push('separate');
  const id = createHash('sha256').update(JSON.stringify(flightKeys)).digest('base64url');
  const flightMinutes = outbound.flightMinutes + (inbound?.flightMinutes || 0);
  const journeyMinutes = outbound.elapsedMinutes + (inbound?.elapsedMinutes || 0);
  const transferWaitMinutes = outbound.layoverMinutes + (inbound?.layoverMinutes || 0);
  return {
    id, city: outbound.city, code: outbound.code, domestic: isDomesticDestination(outbound),
    feesPending, ...(quote ? {
      providerQuote: true, separateTickets: Boolean(quote.separateTickets), backJumpUrl: quote.backJumpUrl,
      outSegments: segmentDetails(outbound), backSegments: segmentDetails(inbound)
    } : {}),
    date: outbound.date, outArrivalDate: outbound.arrivalDate, backDate: inbound?.date, backArrivalDate: inbound?.arrivalDate,
    outDepartureAirport: outbound.departureAirport, outArrivalAirport: outbound.arrivalAirport,
    backDepartureAirport: inbound?.departureAirport, backArrivalAirport: inbound?.arrivalAirport,
    outboundAirline: outbound.airline, inboundAirline: inbound?.airline || '',
    airline: inbound ? `${outbound.airline} / ${inbound.airline}` : outbound.airline,
    out: outbound.time, outArr: outbound.arrivalTime || '—', back: inbound?.time || '—', backArr: inbound?.arrivalTime || '—',
    outboundDirect: outbound.direct, inboundDirect: inbound?.direct ?? true,
    duration: Number((flightMinutes / 60).toFixed(1)), journeyDuration: Number((journeyMinutes / 60).toFixed(1)),
    transferWait: Number((transferWaitMinutes / 60).toFixed(1)), direct: outbound.direct && (!inbound || inbound.direct),
    fare, fees,
    feeSource: feeSources.join(' + '), feeDistanceKm,
    perPerson: quote ? Math.round(perPerson * 100) / 100 : Math.round(perPerson),
    totalPrice: quote ? Math.round(perPerson * people * 100) / 100 : Math.round(perPerson * people),
    jumpUrl: quote?.jumpUrl || outbound.jumpUrl
  };
}

function requestAllowed(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const requestHost = String(request.headers.host || '');
    return url.host === requestHost && ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}

function createServer(listenHost) { return http.createServer(async (request, response) => {
  if (['127.0.0.1', 'localhost', '::1'].includes(listenHost)) {
    const port = request.socket.localPort;
    if (![listenHost, 'localhost', '127.0.0.1', '[::1]'].some(host => request.headers.host === `${host}:${port}`)) {
      return send(response, 403, { error: '请通过本机服务地址访问' });
    }
  }
  if (!requestAllowed(request)) return send(response, 403, { error: '仅接受来自当前页面的 JSON 请求' });
  if (request.url === '/api/fee-policy') return send(response, 200, feePolicy);
  if (request.url === '/api/china-map' && request.method === 'GET') {
    try { return send(response, 200, await getChinaMap()); }
    catch (error) { return send(response, 502, { error: error.message }); }
  }
  if (request.url === '/api/world-map' && request.method === 'GET') {
    try {
      const map = await fs.promises.readFile(path.join(__dirname, 'assets', 'world-land.geojson'));
      response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/geo+json', 'Cache-Control': 'public, max-age=86400' });
      return response.end(map);
    } catch {
      return send(response, 500, { error: '世界地图底图读取失败' });
    }
  }
  if (request.url === '/assets/international-destinations.js' && request.method === 'GET') {
    try {
      const catalog = await fs.promises.readFile(path.join(__dirname, 'assets', 'international-destinations.js'));
      response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/javascript; charset=utf-8' });
      return response.end(catalog);
    } catch {
      return send(response, 500, { error: '目的地目录读取失败' });
    }
  }
  if (request.url === '/api/airport-coordinates' && request.method === 'GET') {
    try {
      const coordinates = await fs.promises.readFile(path.join(__dirname, 'assets', 'airport-coordinates.json'));
      response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      return response.end(coordinates);
    } catch {
      return send(response, 500, { error: '机场坐标读取失败' });
    }
  }
  if (request.url?.split('?')[0] === '/vendor/echarts.min.js' && request.method === 'GET') {
    try {
      const source = await getEchartsSource();
      response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      return response.end(source);
    } catch (error) {
      return send(response, 502, { error: error.message });
    }
  }
  if (request.url === '/assets/departure-map.webp' && request.method === 'GET') {
    const illustration = path.join(__dirname, 'assets', 'departure-map.webp');
    if (!fs.existsSync(illustration)) return send(response, 404, { error: 'Not found' });
    response.writeHead(200, { ...securityHeaders, 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(illustration).pipe(response);
  }
  if (request.url === '/assets/brand-logo' && request.method === 'GET') {
    try {
      const logo = await getBrandLogo();
      response.writeHead(200, { ...securityHeaders, 'Content-Type': logo.contentType, 'Cache-Control': 'public, max-age=86400' });
      return response.end(logo.data);
    } catch (error) { return send(response, 502, { error: error.message }); }
  }
  if (request.url === '/api/settings' && request.method === 'GET') {
    try { return send(response, 200, await publicSettings()); }
    catch (error) { return send(response, 500, { error: error.message }); }
  }
  if (request.url === '/api/settings' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => {
      try { saveSettings(JSON.parse(body)); return send(response, 200, await publicSettings()); }
      catch (error) { return send(response, 400, { error: error.message }); }
    }); return;
  }
  if (request.url === '/api/flyai/install' && request.method === 'POST') {
    try {
      await installFlyaiCli();
      return send(response, 200, { installed: true, message: '飞猪查询组件已安装，可以开始搜索航班。' });
    } catch (error) { return send(response, 502, { installed: false, error: error.message }); }
  }
  if (request.url === '/api/models' && request.method === 'GET') {
    try { return send(response, 200, { models: await listModels(), configured: effective('MODEL_NAME') }); }
    catch (error) { return send(response, 502, { error: error.message, models: [] }); }
  }
  if (request.url === '/api/models' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        let apiKey = String(payload.apiKey || '').trim();
        if (!apiKey && payload.useSavedKey) {
          if (!sameAiEndpoint(payload.baseUrl, effective('AI_BASE_URL'))) {
            return send(response, 400, { error: '接口地址已变更，请填写该地址的 API Key', models: [] });
          }
          apiKey = effective('AI_API_KEY');
        }
        const models = await listModels({ baseUrl: payload.baseUrl, apiKey });
        return send(response, 200, { models, configured: effective('MODEL_NAME') });
      } catch (error) { return send(response, 502, { error: redactError(error), models: [] }); }
    }); return;
  }
  if (request.url === '/api/weather' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => { try { send(response, 200, await weatherForecast(JSON.parse(body))); } catch (error) { send(response, 502, { error: error.message, weather: {} }); } }); return;
  }
  if (request.url === '/api/geocode' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => {
      try {
        const city = String(JSON.parse(body).city || '').trim();
        const location = await resolveWeatherLocation({ city });
        if (!location) return send(response, 404, { error: '暂时无法定位该出发地' });
        return send(response, 200, { city, longitude: location.longitude, latitude: location.latitude });
      } catch (error) { return send(response, 502, { error: error.message }); }
    }); return;
  }
  if (request.url === '/api/ai-advice' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => { try { send(response, 200, await aiAdvice(JSON.parse(body))); } catch (error) { send(response, 502, { error: redactError(error) }); } }); return;
  }
  if (request.url === '/api/search' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', async () => {
      try {
        const query = JSON.parse(body);
        const stream = request.headers.accept === 'application/x-ndjson' &&
          query.scope === 'international' && (!query.destination || query.destination === 'all');
        if (!stream) return send(response, 200, await search(query));
        response.writeHead(200, {
          ...securityHeaders, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store'
        });
        response.flushHeaders();
        const write = event => {
          if (!response.destroyed) response.write(JSON.stringify(event) + '\n');
        };
        try {
          const result = await search(query, coverage => write({ type: 'progress', coverage }));
          write({ type: 'result', ...result });
        } catch (error) {
          write({ type: 'error', error: redactError(error), coverage: error.coverage });
        }
        return response.end();
      } catch (error) {
        return send(response, error.statusCode || 502, { error: redactError(error), coverage: error.coverage });
      }
    });
    return;
  }
  if ((request.url === '/' || request.url === '/index.html') && request.method === 'GET') {
    response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(response);
  }
  send(response, 404, { error: 'Not found' });
}); }
function redactError(error) {
  let message = String(error.message || '请求未完成');
  for (const key of [effective('AI_API_KEY'), effective('FLYAI_API_KEY')]) {
    if (key) message = message.replaceAll(key, '[已隐藏]');
  }
  return message;
}

function send(response, status, data) { response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); }

function startServer(options = {}) {
  const host = options.host || defaultHost;
  const port = Number.isFinite(options.port) ? options.port : defaultPort;
  flyaiRunner = typeof options.flyaiRunner === 'function' ? options.flyaiRunner : null;
  const server = createServer(host);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      const url = `http://${host}:${address.port}`;
      console.log(`飞哪里 FlyWhere running at ${url}`);
      resolve({ server, url });
    });
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
