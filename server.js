const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

loadEnv();
const port = Number(process.env.PORT || 4173);
const configPath = path.join(__dirname, '.flymap-config.json');
let localConfig = loadLocalConfig();
const feePolicy = { airportConstruction: 50, fuelSurcharge: 60, updatedAt: '2026-08-09', source: 'FlyAI 未返回费用明细时的预算兜底' };
const chinaMapUrl = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const echartsUrl = 'https://cdn.jsdelivr.net/npm/echarts@5.6.0/dist/echarts.min.js';
let chinaMapCache = { expiresAt: 0, data: null };
let echartsSourceCache = '';
const flyaiCache = new Map();
const flyaiInflight = new Map();
let flyaiQueue = Promise.resolve();
let flyaiNextRunAt = 0;
const searchCache = new Map();
const searchInflight = new Map();
const weatherCache = new Map();
const geocodeCache = new Map();

function loadEnv() {
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
  return Object.prototype.hasOwnProperty.call(localConfig, key) ? localConfig[key] : (process.env[name] || '');
}

function writeLocalConfig(next) {
  localConfig = next;
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  modelsCache = { expiresAt: 0, models: [] };
}

function execCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout || 10000, maxBuffer: 4 * 1024 * 1024, env: options.env || process.env, cwd: __dirname }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolve(String(stdout || stderr).trim());
    });
  });
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
    const output = await execCapture('codex', ['login', 'status']);
    const authenticated = /logged in/i.test(output);
    return { authenticated, authDetail: authenticated ? output.replace(/^Logged in using\s*/i, '已通过 ') : '尚未登录' };
  }
  if (id === 'claude') {
    const output = await execCapture('claude', ['auth', 'status']);
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
    const output = await execCapture('opencode', ['auth', 'list']);
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
    executable = await execCapture('which', [definition.command]);
    version = (await execCapture(definition.command, ['--version'])).split('\n')[0];
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
  const cli = await Promise.all(Object.keys(cliDefinitions).map(detectCli));
  let flyaiCliInstalled = false;
  try { flyaiCliInstalled = Boolean(await execCapture('which', ['flyai'])); } catch {}
  const aiApiKey = effective('AI_API_KEY');
  const flyaiApiKey = effective('FLYAI_API_KEY');
  return {
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

function saveSettings(payload) {
  const next = { ...localConfig };
  if (payload.aiMode === 'api' || payload.aiMode === 'cli') next.aiMode = payload.aiMode;
  if (cliDefinitions[payload.aiCli]) next.aiCli = payload.aiCli;
  if (typeof payload.aiBaseUrl === 'string') {
    const aiBaseUrl = payload.aiBaseUrl.trim();
    if (aiBaseUrl) {
      let parsed;
      try { parsed = new URL(aiBaseUrl); } catch { throw new Error('请输入有效的 OpenAI 兼容接口地址'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('接口地址仅支持 http 或 https');
      next.aiBaseUrl = aiBaseUrl.replace(/\/+$/, '');
    } else next.aiBaseUrl = '';
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
  const response = await fetch(chinaMapUrl);
  if (!response.ok) throw new Error(`地图数据读取失败（HTTP ${response.status}）`);
  const data = await response.json();
  chinaMapCache = { expiresAt: Date.now() + 24 * 60 * 60 * 1000, data };
  return data;
}

async function getEchartsSource() {
  if (echartsSourceCache) return echartsSourceCache;
  const response = await fetch(echartsUrl);
  if (!response.ok) throw new Error(`地图组件读取失败（HTTP ${response.status}）`);
  echartsSourceCache = await response.text();
  return echartsSourceCache;
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

function runFlyaiOnce(args, model) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FLYAI_API_KEY: effective('FLYAI_API_KEY') };
    if (model) env.MODEL_NAME = model;
    execFile('flyai', ['search-flight', ...args], { env, timeout: 90000, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('FlyAI 返回了无法解析的数据')); }
    });
  });
}

function flyaiCacheKey(args, model) { return JSON.stringify({ args, model: model || '' }); }
function isRateLimited(error) { return /\b429\b|rate limit|too many requests/i.test(String(error?.message || error)); }

function runFlyai(args, model) {
  const key = flyaiCacheKey(args, model);
  const cached = flyaiCache.get(key);
  if (cached?.expiresAt > Date.now()) return Promise.resolve(cached.data);
  if (flyaiInflight.has(key)) return flyaiInflight.get(key);

  const task = flyaiQueue.then(async () => {
    const cooldown = Math.max(0, flyaiNextRunAt - Date.now());
    if (cooldown) await wait(cooldown);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await runFlyaiOnce(args, model);
        flyaiNextRunAt = Date.now() + 450;
        flyaiCache.set(key, { data, expiresAt: Date.now() + 10 * 60 * 1000 });
        if (flyaiCache.size > 120) flyaiCache.delete(flyaiCache.keys().next().value);
        return data;
      } catch (error) {
        lastError = error;
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
function openAiCompatibleUrl(pathname) {
  const baseUrl = effective('AI_BASE_URL').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('未配置 OpenAI 兼容接口地址');
  return `${baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`}/${pathname.replace(/^\//, '')}`;
}

async function listModels() {
  if (modelsCache.expiresAt > Date.now()) return modelsCache.models;
  const apiKey = effective('AI_API_KEY');
  if (!apiKey) throw new Error('未配置 AI API Key');
  const response = await fetch(openAiCompatibleUrl('models'), { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`模型列表请求失败（HTTP ${response.status}）`);
  const payload = await response.json();
  const models = (Array.isArray(payload?.data) ? payload.data : [])
    .filter(model => model?.id)
    .map(model => ({ id: String(model.id), ownedBy: model.owned_by || '', endpoints: model.supported_endpoint_types || [] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const configured = effective('MODEL_NAME').split(',').map(item => item.trim()).filter(item => item && item !== '*');
  for (const id of configured) if (!models.some(model => model.id === id)) models.unshift({ id, ownedBy: 'env', endpoints: [] });
  modelsCache = { expiresAt: Date.now() + 5 * 60 * 1000, models };
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
function normalize(data) {
  return (data?.data?.itemList || []).map(item => {
    const journey = item?.journeys?.[0];
    const segments = journey?.segments || [];
    const first = segments[0], last = segments.at(-1);
    const flightMinutes = segments.reduce((total, segment) => total + durationMinutes(segment?.duration), 0);
    const elapsedMinutes = durationMinutes(journey?.totalDuration || item?.totalDuration) || flightMinutes;
    const airlines = [...new Set(segments.map(segment => segment?.marketingTransportName).filter(Boolean))].join(' / ');
    return { item, city: last?.arrCityName, code: last?.arrCityCode, date: first?.depDateTime?.slice(0, 10), time: first?.depDateTime?.slice(11, 16), arrivalTime: last?.arrDateTime?.slice(11, 16), airline: airlines, flightMinutes, elapsedMinutes, layoverMinutes: Math.max(0, elapsedMinutes - flightMinutes), duration: Number((flightMinutes / 60).toFixed(1)), direct: journey?.journeyType === '直达', fare: value(item, ['ticketPrice', 'adultPrice', 'price']), fee: value(item, ['taxFee', 'tax', 'fuelSurcharge', 'airportConstructionFee', 'airportFee']), jumpUrl: item.jumpUrl };
  }).filter(item => item.city && item.code && item.date && item.time && item.fare !== null);
}
function inTime(time, start, end) { return !start || !end || time >= start && time <= end; }
function reasonableItinerary(flight) { return flight.direct || flight.layoverMinutes <= 4 * 60; }
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
function airportFee(item) { return item.fee === null ? { amount: feePolicy.airportConstruction + feePolicy.fuelSurcharge, source: '预估' } : { amount: item.fee, source: '接口' }; }
function uniqueFlights(flights) {
  const seen = new Set();
  return flights.filter(flight => {
    const key = `${flight.airline}|${flight.time}|${flight.direct ? 'direct' : 'transfer'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchCacheKey(query) {
  return JSON.stringify({ origin: query.origin || '广州', destination: query.destination || 'all', trip: query.trip || 'round', depDate: query.depDate, backDate: query.backDate || '', outTimeStart: query.outTimeStart || '', outTimeEnd: query.outTimeEnd || '', backTimeStart: query.backTimeStart || '', backTimeEnd: query.backTimeEnd || '', model: query.model || effective('MODEL_NAME') });
}

async function searchFresh(query) {
  const origin = query.origin || '广州';
  const destination = query.destination && query.destination !== 'all' ? query.destination : null;
  const common = ['--origin', origin];
  if (query.outTimeStart) common.push('--dep-hour-start', String(Number(query.outTimeStart.slice(0, 2))));
  if (query.outTimeEnd) common.push('--dep-hour-end', String(Number(query.outTimeEnd.slice(0, 2))));
  const model = query.model || effective('MODEL_NAME');
  const sortTypes = ['3', '4', '2', '8'];
  const outboundSearches = await Promise.allSettled(sortTypes.map(sortType => runFlyai([...common, '--sort-type', sortType, ...(destination ? ['--destination', destination] : []), ...dateArgs(query, 'dep')], model)));
  const successful = outboundSearches.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!successful.length) throw outboundSearches[0]?.reason || new Error('航班查询没有返回结果');
  const outboundNormalized = successful.flatMap(normalize);
  const outbound = outboundNormalized.filter(f => inTime(f.time, query.outTimeStart, query.outTimeEnd) && reasonableItinerary(f));
  const groups = new Map();
  outbound.forEach(f => {
    if (!groups.has(f.code)) groups.set(f.code, []);
    groups.get(f.code).push(f);
  });
  const destinations = [...groups.values()].sort((a, b) => Math.min(...a.map(item => item.fare)) - Math.min(...b.map(item => item.fare)) || Math.min(...a.map(item => item.duration)) - Math.min(...b.map(item => item.duration))).map(uniqueFlights);
  if (query.trip === 'oneway') {
    return destinations.flat().map(f => makeResult(f, null, query)).sort((a, b) => a.totalPrice - b.totalPrice).map((item, index) => ({ ...item, rank: index + 1 }));
  }
  const results = [];
  for (const outboundOptions of destinations) {
      const outboundItem = outboundOptions[0];
      const inboundArgs = ['--origin', outboundItem.code, '--destination', origin, '--sort-type', '3', ...dateArgs(query, 'back')];
      if (query.backTimeStart) inboundArgs.push('--dep-hour-start', String(Number(query.backTimeStart.slice(0, 2))));
      if (query.backTimeEnd) inboundArgs.push('--dep-hour-end', String(Number(query.backTimeEnd.slice(0, 2))));
      const inboundOptions = uniqueFlights(normalize(await runFlyai(inboundArgs)).filter(f => inTime(f.time, query.backTimeStart, query.backTimeEnd) && reasonableItinerary(f)));
      const combinations = [];
      for (const out of outboundOptions) for (const back of inboundOptions) {
        if (out.layoverMinutes + back.layoverMinutes <= 4 * 60) combinations.push(makeResult(out, back, query));
      }
      results.push(...combinations);
  }
  return results.filter(Boolean).sort((a, b) => a.totalPrice - b.totalPrice).map((item, index) => ({ ...item, rank: index + 1 }));
}

async function search(query) {
  validateTripDates(query);
  const key = searchCacheKey(query);
  const cached = searchCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.results;
  if (searchInflight.has(key)) return searchInflight.get(key);
  const task = searchFresh(query).then(results => {
    searchCache.set(key, { results, expiresAt: Date.now() + 30 * 60 * 1000 });
    if (searchCache.size > 16) searchCache.delete(searchCache.keys().next().value);
    return results;
  });
  searchInflight.set(key, task);
  task.finally(() => searchInflight.delete(key)).catch(() => undefined);
  return task;
}
function parseAiJson(content) {
  const clean = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 未返回有效排序');
  return JSON.parse(clean.slice(start, end + 1));
}

async function runAiCli(prompt, cli, model) {
  const status = await detectCli(cli);
  if (!status.installed) throw new Error(`${status.label} 未安装`);
  if (!status.authenticated) throw new Error(`${status.label} 尚未授权，请先运行 ${status.loginCommand}`);
  if (cli === 'codex') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flymap-ai-'));
    const outputPath = path.join(tempDir, 'answer.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only', '--color', 'never', '-o', outputPath];
    if (model) args.push('-m', model);
    args.push(prompt);
    try { await execCapture('codex', args, { timeout: 90000 }); return fs.readFileSync(outputPath, 'utf8'); }
    finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
  }
  if (cli === 'claude') {
    const args = ['-p', '--output-format', 'text', '--disable-slash-commands'];
    if (model) args.push('--model', model);
    args.push(prompt);
    return execCapture('claude', args, { timeout: 90000 });
  }
  if (cli === 'gemini') {
    const args = ['-p', prompt, '--output-format', 'text', '--approval-mode', 'plan'];
    if (model) args.push('--model', model);
    return execCapture('gemini', args, { timeout: 90000 });
  }
  if (cli === 'pi') {
    const args = ['--print', '--no-session', '--tools', 'read,grep,find,ls'];
    if (model) args.push('--model', model);
    args.push(prompt);
    return execCapture('pi', args, { timeout: 90000 });
  }
  if (cli === 'kimi') {
    const args = ['--plan', '--prompt', prompt, '--output-format', 'text'];
    if (model) args.unshift('--model', model);
    return execCapture('kimi', args, { timeout: 90000 });
  }
  if (cli === 'opencode') {
    const args = ['run'];
    if (model) args.push('--model', model);
    args.push(prompt);
    return execCapture('opencode', args, { timeout: 90000 });
  }
  throw new Error(`暂不支持通过 ${status.label} 调用 AI`);
}

async function aiRank(payload) {
  const mode = localConfig.aiMode || 'api';
  const model = payload.model || effective('MODEL_NAME');
  const prompt = `你是机票决策助手。请根据用户偏好给候选航班组合排序，不要创造数据。偏好：${JSON.stringify(payload.preferences)}。候选：${JSON.stringify(payload.results)}。只返回 JSON：{\"order\":[候选id按推荐顺序],\"reasons\":{\"候选id\":\"不超过18字的理由\"}}。必须使用每条候选中的 id，不能用城市 code。优先考虑时间合适、直飞、较短、价格合理；如果用户没有明确排除，不要因为廉航自动淘汰。`;
  if (mode === 'cli') {
    const cli = localConfig.aiCli || 'codex';
    const result = parseAiJson(await runAiCli(prompt, cli, model));
    return { ...result, model: model || cliDefinitions[cli].label, channel: cli };
  }
  const apiKey = effective('AI_API_KEY');
  if (!apiKey) throw new Error('未配置 OpenAI 兼容接口地址或 API Key');
  if (!model) throw new Error('请选择一个 AI 模型');
  const response = await fetch(openAiCompatibleUrl('chat/completions'), { method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${apiKey}`}, body:JSON.stringify({model, temperature:0.2, messages:[{role:'user', content:prompt}]}) });
  if (!response.ok) throw new Error(`AI 排序请求失败（HTTP ${response.status}）`);
  const data = await response.json(); const content = data?.choices?.[0]?.message?.content || '';
  return { ...parseAiJson(content), model, channel: 'api' };
}
function makeResult(outbound, inbound, query) {
  const people = Math.max(1, Number(query.passengers || 1));
  const outboundFee = airportFee(outbound); const inboundFee = inbound ? airportFee(inbound) : { amount: 0, source: '预估' };
  const perPerson = outbound.fare + (inbound?.fare || 0) + outboundFee.amount + inboundFee.amount;
  const id = [outbound.code, outbound.airline, outbound.date, outbound.time, inbound?.airline || '', inbound?.date || '', inbound?.time || ''].join('::');
  const flightMinutes = outbound.flightMinutes + (inbound?.flightMinutes || 0);
  const journeyMinutes = outbound.elapsedMinutes + (inbound?.elapsedMinutes || 0);
  const transferWaitMinutes = outbound.layoverMinutes + (inbound?.layoverMinutes || 0);
  return { id, city: outbound.city, code: outbound.code, date: outbound.date, backDate: inbound?.date, outboundAirline: outbound.airline, inboundAirline: inbound?.airline || '', airline: inbound ? `${outbound.airline} / ${inbound.airline}` : outbound.airline, out: outbound.time, outArr: outbound.arrivalTime || '—', back: inbound?.time || '—', backArr: inbound?.arrivalTime || '—', outboundDirect: outbound.direct, inboundDirect: inbound?.direct ?? true, duration: Number((flightMinutes / 60).toFixed(1)), journeyDuration: Number((journeyMinutes / 60).toFixed(1)), transferWait: Number((transferWaitMinutes / 60).toFixed(1)), direct: outbound.direct && (!inbound || inbound.direct), fare: outbound.fare + (inbound?.fare || 0), fees: outboundFee.amount + inboundFee.amount, feeSource: outboundFee.source === '接口' && inboundFee.source === '接口' ? '接口' : '预估', perPerson: Math.round(perPerson), totalPrice: Math.round(perPerson * people), jumpUrl: outbound.jumpUrl };
}

const server = http.createServer(async (request, response) => {
  if (request.url === '/api/fee-policy') return send(response, 200, feePolicy);
  if (request.url === '/api/china-map' && request.method === 'GET') {
    try { return send(response, 200, await getChinaMap()); }
    catch (error) { return send(response, 502, { error: error.message }); }
  }
  if (request.url === '/vendor/echarts.min.js' && request.method === 'GET') {
    try { response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }); return response.end(await getEchartsSource()); }
    catch (error) { response.writeHead(502, { 'Content-Type': 'application/javascript; charset=utf-8' }); return response.end(`console.error(${JSON.stringify(error.message)})`); }
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
  if (request.url === '/api/models' && request.method === 'GET') {
    try { return send(response, 200, { models: await listModels(), configured: effective('MODEL_NAME') }); }
    catch (error) { return send(response, 502, { error: error.message, models: [] }); }
  }
  if (request.url === '/api/weather' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => { try { send(response, 200, await weatherForecast(JSON.parse(body))); } catch (error) { send(response, 502, { error: error.message, weather: {} }); } }); return;
  }
  if (request.url === '/api/ai-rank' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => { try { send(response, 200, await aiRank(JSON.parse(body))); } catch (error) { send(response, 502, { error: error.message }); } }); return;
  }
  if (request.url === '/api/search' && request.method === 'POST') {
    let body = ''; request.on('data', chunk => body += chunk); request.on('end', async () => { try { send(response, 200, { results: await search(JSON.parse(body)) }); } catch (error) { send(response, error.statusCode || 502, { error: error.message }); } }); return;
  }
  if ((request.url === '/' || request.url === '/index.html') && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(response);
  }
  send(response, 404, { error: 'Not found' });
});
function send(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
server.listen(port, () => console.log(`飞哪里 FlyWhere running at http://localhost:${port}`));
