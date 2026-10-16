import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const readJson = (name) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const release = readJson('VERSION.json');
const pkg = readJson('package.json');
const model = readJson('public/assets/roadster.source.json');
const version = release.version;
const semver = version.replace(/^(\d+\.\d+\.\d+)([a-z]+)$/, '$1-$2');
if (pkg.version !== semver || pkg.productVersion !== version || release.packageVersion !== semver || model.productVersion !== version) {
  throw new Error('Version surfaces do not match.');
}
if (!existsSync(resolve(root, 'dist/index.html'))) throw new Error('Run npm run build first.');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
if (hash(resolve(root, 'dist/assets/roadster.glb')) !== model.sha256) {
  throw new Error('Built model does not match its source metadata.');
}
const builtModel = readJson('dist/assets/roadster.source.json');
if (builtModel.productVersion !== version) throw new Error('Built model metadata is stale; run npm run build.');
const html = readFileSync(resolve(root, 'dist/index.html'), 'utf8');
if (!html.includes(`v${version}</span>`)) throw new Error('Built application version is stale; run npm run build.');

const buildId = new Date().toISOString().replace(/[-:.]/g, '');
const target = resolve(root, 'output', `Roadster-Flight-Lab-${version}-${buildId}`);
if (existsSync(target)) throw new Error('Build output already exists.');
mkdirSync(target, { recursive: true });
for (const name of ['dist', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'VERSION.json', '启动游戏.bat', 'scripts/serve.mjs']) {
  const destination = resolve(target, name);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  cpSync(resolve(root, name), destination, { recursive: true });
}
const collect = (folder) => readdirSync(folder).sort().flatMap((name) => {
  const file = resolve(folder, name);
  return statSync(file).isDirectory() ? collect(file) : [{ path: relative(target, file).replaceAll('\\', '/'), bytes: statSync(file).size, sha256: hash(file) }];
});
let sourceCommit = null;
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { /* ZIP source downloads do not contain Git metadata. */ }
const receipt = { product: release.product, version, buildId, sourceCommit, modelSha256: model.sha256, files: collect(target) };
writeFileSync(resolve(target, 'delivery.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ target, version, buildId, files: receipt.files.length, bytes: receipt.files.reduce((sum, file) => sum + file.bytes, 0) }));
