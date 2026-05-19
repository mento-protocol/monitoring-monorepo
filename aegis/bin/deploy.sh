#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
app_root="$repo_root/aegis"

# Build the App Engine entrypoint before uploading this checkout.
cd "$repo_root"
pnpm --filter @mento-protocol/aegis build

deploy_dir="$(mktemp -d "${TMPDIR:-/tmp}/aegis-app-engine.XXXXXX")"
cleanup() {
  rm -rf "$deploy_dir"
}
trap cleanup EXIT

cp "$app_root/app.yaml" "$deploy_dir/app.yaml"
cp "$app_root/config.yaml" "$deploy_dir/config.yaml"
cp -R "$app_root/dist" "$deploy_dir/dist"

node - "$repo_root/package.json" "$app_root/package.json" "$deploy_dir/package.json" <<'NODE'
const fs = require('fs');

const rootPackagePath = process.argv[2];
const aegisPackagePath = process.argv[3];
const deployPackagePath = process.argv[4];

const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
const aegisPackage = JSON.parse(fs.readFileSync(aegisPackagePath, 'utf8'));

const deployPackage = {
  ...aegisPackage,
  packageManager: rootPackage.packageManager,
  pnpm: rootPackage.pnpm,
};

if (deployPackage.scripts) {
  delete deployPackage.scripts.build;
  delete deployPackage.scripts.prepare;
  delete deployPackage.scripts.preinstall;
  delete deployPackage.scripts.postinstall;
}

fs.writeFileSync(
  deployPackagePath,
  `${JSON.stringify(deployPackage, null, 2)}\n`,
);
NODE

node - "$repo_root/pnpm-lock.yaml" "$deploy_dir/pnpm-lock.yaml" <<'NODE'
const fs = require('fs');

const rootLockPath = process.argv[2];
const deployLockPath = process.argv[3];
const lines = fs.readFileSync(rootLockPath, 'utf8').split('\n');

const importersIndex = lines.findIndex((line) => line === 'importers:');
const aegisIndex = lines.findIndex((line) => line === '  aegis:');
const packagesIndex = lines.findIndex(
  (line, index) => index > importersIndex && /^[^ ].*:$/.test(line),
);

if (importersIndex === -1 || aegisIndex === -1 || packagesIndex === -1) {
  throw new Error('Unexpected pnpm-lock.yaml structure');
}

let aegisEndIndex = packagesIndex;
for (let index = aegisIndex + 1; index < packagesIndex; index += 1) {
  if (/^  [^ ].*:$/.test(lines[index])) {
    aegisEndIndex = index;
    break;
  }
}

const aegisImporter = lines.slice(aegisIndex, aegisEndIndex);
aegisImporter[0] = '  .:';

const deployLock = [
  ...lines.slice(0, importersIndex + 1),
  '',
  ...aegisImporter,
  '',
  ...lines.slice(packagesIndex),
].join('\n');

fs.writeFileSync(deployLockPath, deployLock);
NODE

cat >"$deploy_dir/.gcloudignore" <<'EOF'
.gcloudignore
node_modules/
EOF

# Deploy aegis to the monitoring project.
gcloud app deploy "$deploy_dir/app.yaml" --project mento-monitoring --quiet
