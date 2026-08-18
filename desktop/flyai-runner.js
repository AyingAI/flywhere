const marker = '--flywhere-flyai-bundle';
const markerIndex = process.argv.indexOf(marker);

if (markerIndex < 0 || !process.argv[markerIndex + 1]) {
  console.error('FlyAI runner missing bundle path');
  process.exit(1);
}

const bundlePath = process.argv[markerIndex + 1];
const cliArgs = process.argv.slice(markerIndex + 2);
// Commander treats Electron processes differently from Node processes: it removes
// only the executable argument. Keep the bundle path only for plain Node runs.
process.argv = process.versions.electron
  ? [process.execPath, ...cliArgs]
  : [process.execPath, bundlePath, ...cliArgs];
require(bundlePath);
