#!/usr/bin/env node
// Build the iOS app that carries the Safari extension, without touching the machine's Xcode
// selection.
//
//   node scripts/safari-xcode.mjs doctor              what is installed, and what that allows
//   node scripts/safari-xcode.mjs stage               npm build + copy the output into safari/
//   node scripts/safari-xcode.mjs build               stage, then xcodebuild for the simulator
//   node scripts/safari-xcode.mjs build --sdk iphoneos --team ABCDE12345
//   node scripts/safari-xcode.mjs simulator           build, boot a simulator, install, launch
//
// ---------------------------------------------------------------------------
// Why this script exists rather than "open Xcode and press play"
// ---------------------------------------------------------------------------
//
// On iOS a Safari web extension is not a folder you load. It is an .appex inside an app, installed
// like any other app, and enabled in Settings. So shipping the Safari target means shipping a
// native build, and a native build has two failure modes worth automating away:
//
//   1. The extension's web resources are produced by `wxt build -b safari` into .output/, whose
//      file names carry content hashes. Xcode cannot list those in a Copy Bundle Resources phase,
//      so they are staged into safari/Extension/Resources and copied into the bundle by a shell
//      phase. Forgetting the stage step gives you an app whose extension does not appear in
//      Safari at all, with no error. `stage` is that step, and the shell phase fails loudly when
//      it has not been run.
//
//   2. Command Line Tools and Xcode are both "installed" on many machines, and `xcode-select -p`
//      often points at Command Line Tools, which cannot build an app. The fix people reach for is
//      `sudo xcode-select --switch`, which changes the whole machine for every other tool on it.
//      This script never does that: it finds a full Xcode and passes it to the child process as
//      DEVELOPER_DIR, which is scoped to that process and gone when it exits.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(root, 'safari');
const project = path.join(projectDir, 'usermods.xcodeproj');
const stageDir = path.join(projectDir, 'Extension', 'Resources');
const buildOutput = path.join(root, '.output', 'safari-mv3');

/** Bail with one readable line rather than a stack trace at whoever is reading a build log. */
function fail(message, hint) {
  console.error(`safari-xcode: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function run(file, args, opts = {}) {
  const res = spawnSync(file, args, { stdio: 'inherit', cwd: root, ...opts });
  if (res.error) fail(`could not run ${file}: ${res.error.message}`);
  if (res.status !== 0) fail(`${file} ${args.join(' ')} exited ${res.status}`);
  return res;
}

function capture(file, args, opts = {}) {
  const res = spawnSync(file, args, { encoding: 'utf8', cwd: root, ...opts });
  return res.status === 0 ? (res.stdout ?? '').trim() : null;
}

// ---------------------------------------------------------------------------
// Finding a full Xcode
// ---------------------------------------------------------------------------

function isFullXcode(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'usr', 'bin', 'xcodebuild')) && dir.includes('.app/Contents/Developer');
}

function xcodeVersion(developerDir) {
  const plist = path.resolve(developerDir, '..', 'version.plist');
  const out = capture('/usr/bin/defaults', ['read', plist.replace(/\.plist$/, ''), 'CFBundleShortVersionString']);
  return out ?? 'unknown';
}

/**
 * A full Xcode's Developer directory, or null.
 *
 * Order matters: an explicit DEVELOPER_DIR is the caller saying which Xcode to use and is always
 * honoured. The machine's own selection comes next, so a machine that is already set up correctly
 * behaves exactly as it would without this script. Only then does it go looking in /Applications,
 * which is a convenience for the common case where the selection points at Command Line Tools.
 */
function findXcode() {
  if (process.env.DEVELOPER_DIR) {
    if (!isFullXcode(process.env.DEVELOPER_DIR)) {
      fail(
        `DEVELOPER_DIR is set to ${process.env.DEVELOPER_DIR}, which is not a full Xcode`,
        'Unset it, or point it at /Applications/Xcode.app/Contents/Developer.',
      );
    }
    return process.env.DEVELOPER_DIR;
  }

  const selected = capture('/usr/bin/xcode-select', ['-p']);
  if (isFullXcode(selected)) return selected;

  const apps = fs
    .readdirSync('/Applications', { withFileTypes: true })
    .filter((e) => e.name.startsWith('Xcode') && e.name.endsWith('.app'))
    .map((e) => path.join('/Applications', e.name, 'Contents', 'Developer'))
    .filter(isFullXcode)
    .sort();
  return apps.at(-1) ?? null;
}

function requireXcode() {
  const dir = findXcode();
  if (!dir) {
    fail(
      'no full Xcode found',
      'Install Xcode from the App Store. Command Line Tools alone cannot build an iOS app. ' +
        'Nothing here changes your xcode-select setting.',
    );
  }
  return dir;
}

/** The environment for every xcodebuild/xcrun call: this process only, never the machine. */
function xcodeEnv(developerDir) {
  return { ...process.env, DEVELOPER_DIR: developerDir };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function doctor() {
  const selected = capture('/usr/bin/xcode-select', ['-p']) ?? '(none)';
  console.log(`xcode-select -p         ${selected}${isFullXcode(selected) ? '' : '  (cannot build an iOS app)'}`);

  const dir = findXcode();
  if (!dir) {
    console.log('full Xcode              not found');
    console.log('');
    console.log('Install Xcode to build the iOS app. `npm run build:safari` still produces the');
    console.log('extension itself, which is enough to inspect the manifest and load it on macOS.');
    return;
  }
  console.log(`full Xcode              ${dir}  (${xcodeVersion(dir)})`);
  console.log(`this script will use    DEVELOPER_DIR=${dir}  (for its own child processes only)`);

  const runtimes = capture('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '-j'], { env: xcodeEnv(dir) });
  let ios = [];
  try {
    ios = JSON.parse(runtimes ?? '{}').runtimes?.filter((r) => r.platform === 'iOS' && r.isAvailable) ?? [];
  } catch {
    ios = [];
  }
  console.log(`iOS simulator runtimes  ${ios.length ? ios.map((r) => r.version).join(', ') : 'none installed'}`);

  const staged = fs.existsSync(path.join(stageDir, 'manifest.json'));
  console.log(`staged web extension    ${staged ? stageDir : 'not staged yet (run: stage)'}`);
}

function stage({ build = true } = {}) {
  if (build) run('npm', ['run', 'build:safari']);
  if (!fs.existsSync(path.join(buildOutput, 'manifest.json'))) {
    fail(
      `${buildOutput} has no manifest.json`,
      'Run `npm run build:safari` first, or drop --no-build.',
    );
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  // rsync rather than cp -R so the trailing-slash semantics are explicit: the CONTENTS of the
  // build output land at the root of the stage directory, which is where the .appex needs
  // manifest.json to be.
  run('/usr/bin/rsync', ['-a', '--exclude', '.DS_Store', `${buildOutput}/`, `${stageDir}/`]);
  const files = execFileSync('/usr/bin/find', [stageDir, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n');
  console.log(`staged ${files.length} files into ${path.relative(root, stageDir)}`);
}

function xcodebuild({ sdk, configuration, bundleId, team, destination, action = 'build' }) {
  const developerDir = requireXcode();
  const args = [
    '-project', project,
    '-scheme', 'usermods',
    '-configuration', configuration,
    '-sdk', sdk,
    '-derivedDataPath', path.join(root, '.output', 'safari-xcode'),
  ];
  if (destination) args.push('-destination', destination);
  args.push(action);

  if (bundleId) args.push(`USERMODS_BUNDLE_ID=${bundleId}`);
  if (team) args.push(`DEVELOPMENT_TEAM=${team}`);
  if (sdk === 'iphonesimulator' && !team) {
    // A simulator build needs no identity, and asking for one is the single most common reason an
    // otherwise fine checkout will not build on a machine with no Apple account signed in.
    args.push('CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=');
  }

  console.log(`xcodebuild with DEVELOPER_DIR=${developerDir}`);
  run(path.join(developerDir, 'usr', 'bin', 'xcodebuild'), args, { env: xcodeEnv(developerDir) });
  return { developerDir, configuration, sdk };
}

function productPath(configuration, sdk) {
  const suffix = sdk === 'iphonesimulator' ? '-iphonesimulator' : '-iphoneos';
  return path.join(root, '.output', 'safari-xcode', 'Build', 'Products', `${configuration}${suffix}`, 'usermods.app');
}

function simulator({ configuration, bundleId, device }) {
  const { developerDir } = xcodebuild({
    sdk: 'iphonesimulator',
    configuration,
    bundleId,
    destination: `platform=iOS Simulator,name=${device}`,
  });
  const env = xcodeEnv(developerDir);
  const app = productPath(configuration, 'iphonesimulator');
  if (!fs.existsSync(app)) fail(`the build produced no app at ${app}`);

  const json = capture('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'], { env });
  const all = Object.values(JSON.parse(json ?? '{}').devices ?? {}).flat();
  const target = all.find((d) => d.name === device && d.isAvailable);
  if (!target) {
    fail(
      `no available simulator named ${device}`,
      `Pick one from: ${all.filter((d) => d.isAvailable).map((d) => d.name).join(', ') || '(none installed)'}`,
    );
  }
  if (target.state !== 'Booted') run('/usr/bin/xcrun', ['simctl', 'boot', target.udid], { env });
  run('/usr/bin/xcrun', ['simctl', 'install', target.udid, app], { env });
  const id = bundleId ?? 'io.github.kballenegger.usermods';
  run('/usr/bin/xcrun', ['simctl', 'launch', target.udid, id], { env });
  console.log('');
  console.log(`installed and launched ${id} on ${device} (${target.udid}).`);
  console.log('Enable it in the simulator: Settings > Apps > Safari > Extensions > usermods.');
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-')) ?? 'doctor';
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const configuration = flag('configuration', 'Debug');
const sdk = flag('sdk', 'iphonesimulator');
const bundleId = flag('bundle-id');
const team = flag('team');

switch (command) {
  case 'doctor':
    doctor();
    break;
  case 'stage':
    stage({ build: !has('no-build') });
    break;
  case 'build':
    if (!has('no-stage')) stage({ build: !has('no-build') });
    xcodebuild({ sdk, configuration, bundleId, team });
    console.log('');
    console.log(`built ${path.relative(root, productPath(configuration, sdk))}`);
    break;
  case 'simulator':
    if (!has('no-stage')) stage({ build: !has('no-build') });
    simulator({ configuration, bundleId, device: flag('device', 'iPhone 15') });
    break;
  default:
    fail(`unknown command "${command}"`, 'Try: doctor, stage, build, simulator');
}
