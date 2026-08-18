const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, session, shell, utilityProcess } = require('electron');

let localServer;
let localUrl = '';

app.setName('飞哪里 FlyWhere');

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function bundledFlyaiPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'flyai-bundle.cjs');
  return path.join(app.getAppPath(), 'node_modules', '@fly-ai', 'flyai-cli', 'dist', 'flyai-bundle.cjs');
}

function flyaiRunnerPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'flyai-runner.cjs');
  return path.join(app.getAppPath(), 'desktop', 'flyai-runner.js');
}

function isExternalUrlAllowed(value) {
  try { return new URL(value).protocol === 'https:'; }
  catch { return false; }
}

function openExternal(value) {
  if (isExternalUrlAllowed(value)) shell.openExternal(value);
}

function runFlyaiUtility({ args, model, apiKey }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, FLYAI_API_KEY: apiKey };
    delete env.ELECTRON_RUN_AS_NODE;
    if (model) env.MODEL_NAME = model;

    let child;
    try {
      child = utilityProcess.fork(flyaiRunnerPath(), ['--flywhere-flyai-bundle', bundledFlyaiPath(), 'search-flight', ...args], {
        env,
        cwd: app.getPath('userData'),
        stdio: ['ignore', 'pipe', 'pipe'],
        serviceName: 'FlyAI Flight Search'
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const maxBuffer = 12 * 1024 * 1024;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(data);
    };
    const append = (target, chunk) => {
      const next = target + String(chunk);
      if (Buffer.byteLength(next) > maxBuffer) {
        child.kill();
        finish(new Error('FlyAI 返回数据过大，查询已停止'));
      }
      return next;
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('FlyAI 查询超时，请稍后重试'));
    }, 90000);

    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', (type, location) => finish(new Error(`FlyAI 子进程异常：${type}${location ? ` · ${location}` : ''}`)));
    child.once('exit', code => {
      if (code !== 0) return finish(new Error(stderr.trim() || `FlyAI 查询失败（退出码 ${code}）`));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new Error('FlyAI 返回了无法解析的数据')); }
    });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    title: '飞哪里 FlyWhere',
    backgroundColor: '#fffdf8',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, targetUrl) => {
    try { if (new URL(targetUrl).origin === localUrl) return; }
    catch {}
    event.preventDefault();
    openExternal(targetUrl);
  });

  window.once('ready-to-show', () => window.show());
  window.loadURL(localUrl).catch(error => {
    dialog.showErrorBox('飞哪里启动失败', error.message);
  });
  return window;
}

async function startDesktopApp() {
  const dataDirectory = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  app.setAppLogsPath();

  process.env.FLYWHERE_DESKTOP = '1';
  process.env.FLYWHERE_CONFIG_PATH = path.join(dataDirectory, 'settings.json');
  process.env.FLYAI_CLI_PATH = bundledFlyaiPath();

  if (!fs.existsSync(process.env.FLYAI_CLI_PATH)) {
    throw new Error('应用内置的飞猪查询组件缺失，请重新下载安装包。');
  }
  if (!fs.existsSync(flyaiRunnerPath())) {
    throw new Error('应用内置的飞猪查询启动器缺失，请重新下载安装包。');
  }

  const { startServer } = require('../server');
  const started = await startServer({ host: '127.0.0.1', port: 0, flyaiRunner: runFlyaiUtility });
  localServer = started.server;
  localUrl = started.url;
  createWindow();
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return createWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    await startDesktopApp();
  }).catch(error => {
    dialog.showErrorBox('飞哪里启动失败', error.message);
    app.quit();
  });

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length && localUrl) createWindow();
  });

  app.on('before-quit', () => {
    if (localServer?.listening) localServer.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
