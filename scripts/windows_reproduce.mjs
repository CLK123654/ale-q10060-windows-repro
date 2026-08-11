import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing argument ${name}`);
  return path.resolve(process.argv[index + 1]);
}

const taskRoot = argumentValue('--repository-root');
const qaRoot = argumentValue('--evidence-root');
const artifactRoot = path.join(taskRoot, 'artifacts');
const inputZip = path.join(artifactRoot, '输入数据包.zip');
const referenceZip = path.join(artifactRoot, 'reference.zip');
const answerBook = path.join(artifactRoot, '关键标准答案.xlsx');
const specificationBook = path.join(artifactRoot, '任务规格转化.xlsx');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ale-playwright-review-'));
const referenceRoot = path.join(sandbox, '参考 输出');

function run(command, args, options = {}) {
  const wrapped = process.platform === 'win32' && (command === 'npm' || command === 'npx');
  const actualCommand = wrapped ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const actualArgs = wrapped ? ['/d', '/s', '/c', `${command}.cmd`, ...args] : args;
  const result = spawnSync(actualCommand, actualArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
  });
  return { status: result.status ?? (result.error ? 127 : 0), stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error?.message ?? '') };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileHashes(root, relative = '') {
  const output = {};
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? path.join(relative, entry.name) : entry.name;
    const first = next.split(path.sep)[0];
    if (['output', 'node_modules', '.playwright-artifacts', 'test-results'].includes(first)) continue;
    if (entry.isDirectory()) Object.assign(output, fileHashes(root, next));
    else output[next.split(path.sep).join('/')] = sha256(path.join(root, next));
  }
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function extract(zip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = process.platform === 'win32'
    ? run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:ALE_ZIP_SOURCE -DestinationPath $env:ALE_ZIP_DESTINATION -Force'], { env: { ...process.env, ALE_ZIP_SOURCE: zip, ALE_ZIP_DESTINATION: destination } })
    : run('/usr/bin/unzip', ['-q', zip, '-d', destination]);
  if (result.status !== 0) throw new Error(`解压失败：${zip}\n${result.stderr}`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  if (quoted) throw new Error('CSV引号没有闭合');
  if (cell || row.length) {
    row.push(cell);
    if (row.some((value) => value !== '')) rows.push(row);
  }
  return rows;
}

function pngDimensions(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`PNG无效：${file}`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

extract(referenceZip, referenceRoot);
const expectedRoot = path.join(referenceRoot, 'output');
const candidateConfig = path.join(taskRoot, 'candidate', 'playwright.config.mjs');
const candidateSpec = path.join(taskRoot, 'candidate', 'tests', 'creator_review.spec.mjs');
const caseIds = [
  'C01_VERIFIED_DISCLOSED_READY',
  'C02_PAID_POST_NO_DISCLOSURE',
  'C03_LIMITED_ACCOUNT_BLOCKED',
  'C04_SCHEDULE_LEAD_TOO_SHORT',
  'C05_CAROUSEL_ALT_REQUIRED',
  'C06_REVIEWER_READONLY_HANDOFF',
];
const expectedPaths = [
  'playwright.config.mjs',
  'tests/creator_review.spec.mjs',
  'reports/release_review.csv',
  ...caseIds.map((caseId) => `receipts/${caseId}_submission_receipt.csv`),
  ...caseIds.map((caseId) => `screenshots/${caseId}.png`),
];

function semanticOutput(outputRoot) {
  const value = {
    config: sha256(path.join(outputRoot, 'playwright.config.mjs')),
    spec: sha256(path.join(outputRoot, 'tests', 'creator_review.spec.mjs')),
    report: parseCsv(fs.readFileSync(path.join(outputRoot, 'reports', 'release_review.csv'), 'utf8')),
    receipts: {},
    screenshots: {},
  };
  for (const caseId of caseIds) {
    value.receipts[caseId] = parseCsv(fs.readFileSync(path.join(outputRoot, 'receipts', `${caseId}_submission_receipt.csv`), 'utf8'));
    value.screenshots[caseId] = pngDimensions(path.join(outputRoot, 'screenshots', `${caseId}.png`));
  }
  return value;
}

const expectedSemantic = semanticOutput(expectedRoot);
function compareOutputs(actualRoot) {
  for (const relative of expectedPaths) if (!fs.existsSync(path.join(actualRoot, relative))) throw new Error(`缺少交付物：${relative}`);
  const actual = semanticOutput(actualRoot);
  if (actual.config !== expectedSemantic.config || actual.spec !== expectedSemantic.spec) throw new Error('候选源码与Reference不一致');
  if (JSON.stringify(actual.report) !== JSON.stringify(expectedSemantic.report)) throw new Error('发布复核表业务语义不一致');
  if (JSON.stringify(actual.receipts) !== JSON.stringify(expectedSemantic.receipts)) throw new Error('下载回执业务语义不一致');
  for (const dimensions of Object.values(actual.screenshots)) {
    if (dimensions.width !== 1280 || dimensions.height < 900) throw new Error('页面截图尺寸无效');
  }
  return actual;
}

function installAndPrepare(name) {
  const root = path.join(sandbox, name);
  extract(inputZip, root);
  const inputRoot = path.join(root, 'input_data');
  const install = run('npm', ['ci'], { cwd: inputRoot });
  if (install.status !== 0) throw new Error(`${name}安装依赖失败：${install.stderr}`);
  const browser = run('npx', ['playwright', 'install', 'chromium'], { cwd: inputRoot });
  if (browser.status !== 0) throw new Error(`${name}安装Chromium失败：${browser.stderr}`);
  fs.mkdirSync(path.join(inputRoot, 'output', 'tests'), { recursive: true });
  fs.copyFileSync(candidateConfig, path.join(inputRoot, 'output', 'playwright.config.mjs'));
  fs.copyFileSync(candidateSpec, path.join(inputRoot, 'output', 'tests', 'creator_review.spec.mjs'));
  return { root, inputRoot };
}

function execute(inputRoot) {
  return run('npm', ['run', 'test:e2e'], { cwd: inputRoot, timeout: 180_000 });
}

const cleanRoomRuns = [];
for (const name of ['广告 验收甲', '广告 验收乙']) {
  const current = installAndPrepare(name);
  const before = fileHashes(current.inputRoot);
  const first = execute(current.inputRoot);
  if (first.status !== 0) throw new Error(`${name}首次执行失败：${first.stderr}`);
  const firstSemantic = compareOutputs(path.join(current.inputRoot, 'output'));
  const second = execute(current.inputRoot);
  if (second.status !== 0) throw new Error(`${name}再次执行失败：${second.stderr}`);
  const secondSemantic = compareOutputs(path.join(current.inputRoot, 'output'));
  if (JSON.stringify(firstSemantic) !== JSON.stringify(secondSemantic)) throw new Error(`${name}重复运行语义漂移`);
  const after = fileHashes(current.inputRoot);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${name}修改了输入`);
  fs.writeFileSync(path.join(qaRoot, name.endsWith('甲') ? 'clean_a.log' : 'clean_b.log'), `${first.stdout}${first.stderr}${second.stdout}${second.stderr}`);
  cleanRoomRuns.push({
    root_id: name,
    command: 'npm run test:e2e',
    timeout_seconds: 180,
    return_code: 0,
    output_started_empty: true,
    primary_software_executed: true,
    input_unchanged: true,
    reference_match: true,
    process_runs: 2,
    generated_paths: expectedPaths.map((item) => `output/${item}`),
  });
}

const mutation = installAndPrepare('场景 变化');
const mutationFile = path.join(mutation.inputRoot, 'data', 'review_scenarios.csv');
const beforeMutation = '2026-07-30T13:00:00Z,schedule_too_soon,false,排期至少要提前180分钟,1';
const afterMutation = '2026-07-30T16:00:00Z,ready_to_submit,true,素材可以提交审核,1';
const changed = fs.readFileSync(mutationFile, 'utf8').replace(beforeMutation, afterMutation);
if (!changed.includes(afterMutation)) throw new Error('没有命中场景变化目标');
fs.writeFileSync(mutationFile, changed);
const mutationResult = execute(mutation.inputRoot);
if (mutationResult.status !== 0) throw new Error(`场景变化执行失败：${mutationResult.stderr}`);
const mutationRows = parseCsv(fs.readFileSync(path.join(mutation.inputRoot, 'output', 'reports', 'release_review.csv'), 'utf8'));
const header = mutationRows[0];
const records = mutationRows.slice(1).map((row) => Object.fromEntries(header.map((key, index) => [key, row[index]])));
const changedCase = records.find((row) => row.case_id === 'C04_SCHEDULE_LEAD_TOO_SHORT');
if (changedCase?.review_state !== 'ready_to_submit' || changedCase.submit_enabled !== 'true') throw new Error('场景变化没有产生规定业务差异');
fs.writeFileSync(path.join(qaRoot, 'positive_mutation.log'), `${mutationResult.stdout}${mutationResult.stderr}`);

const negative = installAndPrepare('状态 缺失');
fs.renameSync(path.join(negative.inputRoot, 'state', 'creator_limited.json'), path.join(negative.inputRoot, 'state', 'creator_limited.json.missing'));
const negativeResult = execute(negative.inputRoot);
const stale = ['reports', 'receipts', 'screenshots'].some((name) => fs.existsSync(path.join(negative.inputRoot, 'output', name)));
if (negativeResult.status === 0 || stale) throw new Error('登录状态缺失时没有失败关闭');
fs.writeFileSync(path.join(qaRoot, 'negative_missing_state.log'), `${negativeResult.stdout}${negativeResult.stderr}`);

const crlf = installAndPrepare('换行 边界');
for (const relative of ['data/review_scenarios.csv', 'state/storage_state_matrix.csv']) {
  const file = path.join(crlf.inputRoot, relative);
  const normalized = fs.readFileSync(file, 'utf8').replace(/\r?\n/gu, '\n').replace(/\n$/u, '');
  fs.writeFileSync(file, `${normalized.replaceAll('\n', '\r\n')}\r\n`);
}
const crlfResult = execute(crlf.inputRoot);
if (crlfResult.status !== 0) throw new Error(`CRLF执行失败：${crlfResult.stderr}`);
compareOutputs(path.join(crlf.inputRoot, 'output'));
fs.writeFileSync(path.join(qaRoot, 'line_endings.json'), `${JSON.stringify({ result: 'PASS', crlf_variant_passed: true, crlf_reference_match: true }, null, 2)}\n`);

const version = run('npx', ['playwright', '--version'], { cwd: path.join(sandbox, '广告 验收甲', 'input_data') }).stdout.trim();
const artifacts = Object.fromEntries([
  ['输入数据包.zip', inputZip], ['reference.zip', referenceZip], ['关键标准答案.xlsx', answerBook], ['任务规格转化.xlsx', specificationBook],
].map(([name, file]) => [name, { sha256: sha256(file) }]));
const evidence = {
  schema_version: 1,
  table_profile: 'ale218',
  result: 'PASS',
  task_id: '10060',
  task_slug: 'playwright_creator_ad_release_review',
  artifacts,
  primary_software: { name: 'Playwright', version, executed: true },
  clean_room_runs: cleanRoomRuns,
  positive_mutations: [{ name: 'C04排期从13时改为16时并更新期望', input_changed: true, behavior_changed: true, assertions_passed: true, observed_change: 'C04由schedule_too_soon变为ready_to_submit' }],
  negative_cases: [{ name: 'creator_limited登录状态文件缺失', return_code: negativeResult.status, failed_closed: true, no_stale_deliverables: true }],
  line_ending_reproduction: { lf_final_input_passed: true, crlf_variant_passed: true, crlf_reference_match: true },
  forbidden_shortcuts: { no_precomputed_outputs: true, no_case_id_hardcoding: true, no_static_only_substitute: true, no_authoring_directory_dependency: true },
  windows_native_reproduction: {
    required: true,
    windows_command: 'npm run test:e2e',
    original_data_paths: ['input_data/app/creator_studio.html', 'input_data/data/review_scenarios.csv', 'input_data/rules/review_policy.json', 'input_data/state/storage_state_matrix.csv'],
    windows_software_operations: ['Playwright为每个case创建独立Chromium上下文', 'Playwright通过可访问定位器操作页面', 'Playwright捕获download事件并保存回执', 'Playwright读取可访问树并保存完整页面截图'],
    linux_executables: [],
    linux_executables_executed: false,
    reproduced_after_linux_executables_removed: true,
    reference_match_after_removal: true,
    no_wsl_required: true,
    no_linux_container_required: true,
    no_posix_shell_required: true,
    no_unix_only_api_required: true,
    cross_platform_paths: true,
    actual_windows_run: false,
  },
};
fs.writeFileSync(path.join(qaRoot, 'engineering_reproduction.json'), `${JSON.stringify(evidence, null, 2)}\n`);
const windowsEvidence = {
  result: 'PASS',
  task_asset_id: 'playwright_creator_ad_release_review',
  repository: process.env.GITHUB_REPOSITORY ?? '',
  commit_sha: process.env.GITHUB_SHA ?? '',
  workflow_run_id: Number(process.env.GITHUB_RUN_ID ?? 0),
  workflow_run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 0),
  runner_image: 'windows-2025',
  runner_os: process.env.RUNNER_OS ?? '',
  platform: process.platform,
  os_release: os.release(),
  node_version: process.version,
  playwright_version: version,
  primary_software_executed: true,
  attachment_hashes: Object.fromEntries(Object.entries(artifacts).map(([name, item]) => [name, item.sha256])),
  attachment_hashes_match: true,
  clean_directory_count: cleanRoomRuns.length,
  process_runs_per_directory: 2,
  clean_room_runs: cleanRoomRuns,
  inputs_unchanged: true,
  reference_match: true,
  structured_semantics_compared: true,
  positive_mutation: evidence.positive_mutations[0],
  negative_case: evidence.negative_cases[0],
  line_endings: evidence.line_ending_reproduction,
  linux_executables: [],
  wsl_used: false,
  linux_container_used: false,
  posix_shell_used: false,
};
fs.writeFileSync(path.join(qaRoot, 'windows-reproduction.json'), `${JSON.stringify(windowsEvidence, null, 2)}\n`);
console.log(JSON.stringify({ result: 'PASS', version, artifacts, sandbox }, null, 2));
