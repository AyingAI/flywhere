const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');

function loadCli(platform, execute = execFile) {
  const filename = path.join(__dirname, '..', 'server.js');
  const localRequire = createRequire(filename);
  const context = vm.createContext({
    require: name => name === 'child_process' ? { execFile: execute } : localRequire(name),
    module: { exports: {} }, __dirname: path.dirname(filename), console,
    process: { platform, env: { FLYWHERE_DESKTOP: '1', FLYWHERE_CONFIG_PATH: path.join(os.tmpdir(), 'flywhere-cli-test-unused.json') } }
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { execCapture, runAiCli };', context);
  vm.runInContext('detectCli = async () => ({ installed: true, authenticated: true });', context);
  return context.module.exports;
}

test('shell execution rejects command syntax before spawning', async () => {
  let calls = 0;
  const { execCapture } = loadCli('win32', () => { calls++; });
  for (const value of ['safe&ver', 'safe|ver', 'safe" --version', '%PATH%', '!PATH!', 'a^b', 'a>b', '<file', 'a\nb', 'a\rb', 'a\0b', 42, {}]) {
    await assert.rejects(execCapture('codex', ['-m', value], { shell: true }), /CLI 参数/);
  }
  await assert.rejects(execCapture('codex&ver', [], { shell: true }), /CLI 参数/);
  assert.equal(calls, 0);
});

test('every AI CLI rejects an injected model before spawning', async () => {
  let calls = 0;
  const { runAiCli } = loadCli('win32', () => { calls++; });
  for (const cli of ['codex', 'claude', 'gemini', 'pi', 'kimi', 'opencode']) {
    await assert.rejects(runAiCli('正常提示词', cli, 'safe&ver'), /CLI 参数/);
  }
  assert.equal(calls, 0);
});

test('Windows cmd shim preserves ordinary arguments and stdin', { skip: process.platform !== 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flywhere-cli-'));
  try {
    const script = path.join(directory, 'echo.js');
    const shim = path.join(directory, 'echo cli.cmd');
    fs.writeFileSync(script, "let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => console.log(JSON.stringify({args: process.argv.slice(2), input})));");
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const args = ['kimi-code/kimi-for-coding', 'openai/gpt-5.4', 'model@v1:latest+test', 'C:\\用户 目录 (test)\\answer.txt', 'C:\\directory with spaces\\', ''];
    const input = '航班提示词 "quoted" & ver\n%PATH% !PATH!';
    const { execCapture } = loadCli('win32');
    const result = JSON.parse(await execCapture(shim, args, { shell: true, input }));
    assert.deepEqual(result, { args, input });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Windows Kimi uses print mode and sends the prompt only through stdin', async () => {
  let command, input;
  const { runAiCli } = loadCli('win32', (file, args, options, callback) => {
    command = file;
    callback(null, '{"advice":[]}', '');
    return { stdin: { end: value => { input = value; } } };
  });
  const prompt = '航班 & "报价"\n%PATH%';
  assert.equal(await runAiCli(prompt, 'kimi', 'kimi-code/kimi-for-coding'), '{"advice":[]}');
  assert.match(command, /"--print"/);
  assert.match(command, /"--plan"/);
  assert.ok(!command.includes(prompt));
  assert.equal(input, prompt);
});

test('non-shell execution keeps arguments literal', async () => {
  const { execCapture } = loadCli(process.platform);
  const value = 'safe&ver %PATH% "quoted"';
  assert.equal(await execCapture(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]), value);
});
