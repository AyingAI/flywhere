const path = require('path');

const shouldSign = Boolean(process.env.APPLE_TEAM_ID);
const shouldNotarize = shouldSign && Boolean(process.env.APPLE_ID && process.env.APPLE_APP_PASSWORD);

module.exports = {
  appId: 'com.ayingai.flywhere',
  productName: '飞哪里 FlyWhere',
  asar: true,
  directories: { output: 'out' },
  files: [
    'desktop/**/*',
    'server.js',
    'index.html',
    'assets/**/*',
    'package.json',
    '!node_modules/**/*'
  ],
  extraResources: [
    {
      from: path.join(__dirname, 'node_modules', '@fly-ai', 'flyai-cli', 'dist', 'flyai-bundle.cjs'),
      to: 'flyai-bundle.cjs'
    },
    {
      from: path.join(__dirname, 'desktop', 'flyai-runner.js'),
      to: 'flyai-runner.cjs'
    }
  ],
  mac: {
    category: 'public.app-category.travel',
    icon: 'assets/app-icon.icns',
    target: 'dmg',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    identity: shouldSign ? 'Developer ID Application' : null,
    notarize: shouldNotarize ? {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    } : false
  },
  dmg: {
    title: '飞哪里 FlyWhere ${version}',
    icon: 'assets/app-icon.icns',
    backgroundColor: '#fffdf8',
    contents: [
      { x: 180, y: 190, type: 'file' },
      { x: 480, y: 190, type: 'link', path: '/Applications' }
    ]
  },
  win: {
    icon: 'assets/app-icon.png',
    target: 'nsis'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'FlyWhere'
  },
  artifactName: 'FlyWhere-${version}-${arch}.${ext}'
};
