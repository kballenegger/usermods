#!/usr/bin/env node
// Build the app that carries the Safari extension, for iOS or macOS, without touching the machine's
// Xcode selection.
//
//   node scripts/safari-xcode.mjs doctor              what is installed, and what that allows
//   node scripts/safari-xcode.mjs stage               npm build + copy the output into safari/
//   node scripts/safari-xcode.mjs build               stage, then xcodebuild for the simulator
//   node scripts/safari-xcode.mjs build --sdk iphoneos --team ABCDE12345
//   node scripts/safari-xcode.mjs simulator           build, boot a simulator, install, launch
//   node scripts/safari-xcode.mjs mac                 build the Mac app, check it, say what is next
//   node scripts/safari-xcode.mjs mac --launch        the same, then open it
//
// ---------------------------------------------------------------------------
// Why this script exists rather than "open Xcode and press play"
// ---------------------------------------------------------------------------
//
// A Safari web extension is not a folder you load, on either platform. It is an .appex inside an
// app: on iOS installed like any other app and enabled in Settings, on macOS registered by
// launching the app once and enabled in Safari's settings. So shipping the Safari target means
// shipping a native build, and a native build has two failure modes worth automating away:
//
//   1. The extension's web resources are produced by `wxt build -b safari` into .output/, whose
//      file names carry content hashes. Xcode cannot list those in a Copy Bundle Resources phase,
//      so they are staged into safari/Extension/Resources and copied into the bundle by a shell
//      phase. Forgetting the stage step gives you an app whose extension does not appear in
//      Safari at all, with no error. `stage` is that step, and the shell phase fails loudly when
//      it has not been run. `mac` re-checks the result inside the finished bundle, because on the
//      desktop the same mistake looks exactly like Safari refusing the extension for signing
//      reasons, and those two need different fixes.
//
//   2. Command Line Tools and Xcode are both "installed" on many machines, and `xcode-select -p`
//      often points at Command Line Tools, which cannot build an app. The fix people reach for is
//      `sudo xcode-select --switch`, which changes the whole machine for every other tool on it.
//      This script never does that: it finds a full Xcode and passes it to the child process as
//      DEVELOPER_DIR, which is scoped to that process and gone when it exits.
//
// What it will not do: turn anything on in Safari. Loading a locally built extension needs two
// Safari-wide developer settings, and flipping a browser's own security settings from a build
// script is not this script's business. `mac` names them and stops.

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

  const sdks = capture(path.join(dir, 'usr', 'bin', 'xcodebuild'), ['-showsdks'], { env: xcodeEnv(dir) }) ?? '';
  const macSdk = sdks.split('\n').map((l) => l.match(/-sdk (macosx[\d.]+)/)?.[1]).filter(Boolean).at(-1);
  console.log(`macOS SDK               ${macSdk ?? 'none (the mac command needs one)'}`);

  // Not a blocker: `mac` signs to run locally when there is no identity. It is worth printing
  // because it decides whether Safari needs its developer settings turned on to see the result.
  const identities = capture('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']) ?? '';
  const count = Number(identities.match(/(\d+) valid identities found/)?.[1] ?? 0);
  console.log(`codesigning identities  ${count || 'none (mac builds will be signed to run locally)'}`);

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
  if (sdk === 'macosx' && !team) {
    // Sign to run locally. A Mac app can be signed with no identity at all, which is what the "-"
    // means, and the result runs on this machine. Unlike the simulator case the signature cannot
    // simply be skipped: an unsigned bundle has no entitlements, so the sandbox is never applied,
    // and Safari will not look at the extension inside it at all. See MAC_UNSIGNED_NOTE below for
    // what an ad-hoc signature still does not buy you.
    args.push(
      'CODE_SIGN_STYLE=Manual',
      'CODE_SIGN_IDENTITY=-',
      'CODE_SIGNING_REQUIRED=YES',
      'CODE_SIGNING_ALLOWED=YES',
      'DEVELOPMENT_TEAM=',
      'PROVISIONING_PROFILE_SPECIFIER=',
    );
  }

  console.log(`xcodebuild with DEVELOPER_DIR=${developerDir}`);
  run(path.join(developerDir, 'usr', 'bin', 'xcodebuild'), args, { env: xcodeEnv(developerDir) });
  return { developerDir, configuration, sdk };
}

/** Where xcodebuild puts the app. macOS products get no platform suffix; iOS ones do. */
function productPath(configuration, sdk) {
  const suffix = { macosx: '', iphonesimulator: '-iphonesimulator' }[sdk] ?? '-iphoneos';
  return path.join(root, '.output', 'safari-xcode', 'Build', 'Products', `${configuration}${suffix}`, 'usermods.app');
}

/**
 * Every simulator this machine could actually use, newest runtime first.
 *
 * simctl groups devices under a runtime identifier like
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-4`, so the version is in the key rather than on the
 * device, and it has to be parsed back out to sort by it.
 */
function availableSimulators(env) {
  const json = capture('/usr/bin/xcrun', ['simctl', 'list', 'devices', '-j'], { env });
  const groups = JSON.parse(json ?? '{}').devices ?? {};
  const out = [];
  for (const [runtime, devices] of Object.entries(groups)) {
    const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
    if (!m) continue; // watchOS, tvOS, visionOS: not somewhere Safari extensions run.
    const version = [Number(m[1]), Number(m[2])];
    for (const d of devices) if (d.isAvailable) out.push({ ...d, runtime, version });
  }
  return out.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1]);
}

/**
 * Which iPhone to install on when nobody said.
 *
 * The default used to be the literal string "iPhone 15", and that is a name, not a capability:
 * Xcode ships whatever simulators its own SDK came with, and on a machine with Xcode 27 the
 * iPhone 15 family is simply not there — every device is iPhone 17-era on iOS 26.x, so the command
 * failed outright until `--device 'iPhone 17 Pro'` was passed by hand. A version number baked into
 * a script ages into a bug on a schedule.
 *
 * So the default is derived instead:
 *
 *   1. An iPhone that is ALREADY BOOTED, if there is one. Booting a second simulator is slow, and
 *      if someone has one open it is almost certainly the one they are watching.
 *   2. Otherwise the plain iPhone on the newest runtime — "iPhone 17" over "iPhone 17 Pro Max" —
 *      because the narrowest screen is where a popup sheet's layout is worth looking at, and the
 *      shortest name sorts to the smallest device.
 *
 * iPads are excluded: the extension runs there, but the popup's compact layout is drawn for a
 * phone and a phone is what a default should show. `--device 'iPad (A16)'` still works.
 *
 * Whatever it picks, it says so, because a default that chooses for you and stays quiet is worse
 * than one that fails.
 */
function pickSimulator(env) {
  const all = availableSimulators(env);
  const phones = all.filter((d) => /^iPhone/.test(d.name));
  if (!phones.length) {
    fail(
      'no available iPhone simulator',
      all.length
        ? `Installed: ${[...new Set(all.map((d) => d.name))].join(', ')}. Pass one with --device.`
        : 'Install a simulator runtime in Xcode > Settings > Components.',
    );
  }
  const booted = phones.find((d) => d.state === 'Booted');
  if (booted) return { device: booted, why: 'already booted' };
  // Newest runtime first from availableSimulators; within it, the shortest name is the plain model.
  const newest = phones.filter((d) => d.runtime === phones[0].runtime);
  const plain = [...newest].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))[0];
  return { device: plain, why: `newest runtime (iOS ${plain.version.join('.')})` };
}

function simulator({ configuration, bundleId, device }) {
  // The device is resolved BEFORE the build, because the build's -destination names it too, and a
  // name that does not exist fails xcodebuild with a far less helpful message than this one.
  const probeEnv = xcodeEnv(findXcode());
  let target;
  let why;
  if (device) {
    const all = availableSimulators(probeEnv);
    target = all.find((d) => d.name === device);
    if (!target) {
      fail(
        `no available simulator named ${device}`,
        `Pick one from: ${[...new Set(all.map((d) => d.name))].join(', ') || '(none installed)'}`,
      );
    }
    why = 'from --device';
  } else {
    ({ device: target, why } = pickSimulator(probeEnv));
  }
  console.log(`simulator  ${target.name} (iOS ${target.version.join('.')}, ${why})`);
  console.log('');

  const { developerDir } = xcodebuild({
    sdk: 'iphonesimulator',
    configuration,
    bundleId,
    destination: `platform=iOS Simulator,id=${target.udid}`,
  });
  const env = xcodeEnv(developerDir);
  const app = productPath(configuration, 'iphonesimulator');
  if (!fs.existsSync(app)) fail(`the build produced no app at ${app}`);

  if (target.state !== 'Booted') run('/usr/bin/xcrun', ['simctl', 'boot', target.udid], { env });
  run('/usr/bin/xcrun', ['simctl', 'install', target.udid, app], { env });
  const id = bundleId ?? 'io.github.kballenegger.usermods';
  run('/usr/bin/xcrun', ['simctl', 'launch', target.udid, id], { env });
  console.log('');
  console.log(`installed and launched ${id} on ${target.name} (${target.udid}).`);
  console.log('Enable it in the simulator: Settings > Apps > Safari > Extensions > usermods.');
  // Xcode 27 ships no Simulator.app. The window lives inside Xcode now, so say where rather than
  // leaving someone to conclude the boot silently failed.
  console.log('The simulator window: Xcode > Window > Devices, or open');
  console.log('  /Applications/Xcode.app/Contents/Applications/DeviceHub.app');
}

/**
 * The two Safari settings a locally built extension needs, named in one place.
 *
 * Safari only loads extensions signed by a Developer ID or a development certificate. A build
 * signed with "-" has neither, so Safari hides it until both of these are on, and the second resets
 * every time Safari quits. Both are Safari-wide developer settings: this script prints them and
 * changes nothing.
 */
const MAC_UNSIGNED_NOTE = [
  'This build is signed to run locally, which Safari counts as unsigned. It stays hidden until:',
  '  1. Safari > Settings > Advanced > Show features for web developers',
  '  2. Develop > Allow unsigned extensions  (resets when Safari quits)',
  'Both are Safari-wide developer settings. Turn them off again when you are done.',
];

// ---------------------------------------------------------------------------
// Signing the finished bundle
// ---------------------------------------------------------------------------
//
// Xcode re-signs a target when that target's own inputs change. The phase that copies the built web
// extension into the .appex is not one of those inputs, so an incremental build where only the web
// side changed runs the copy and skips the signature. The bundle is then sealed against the files it
// held one build ago, and `codesign --verify --deep --strict` on the app rejects it with "a sealed
// resource is missing or invalid" in the .appex. The build log says nothing: there is simply no
// CodeSign line for the extension.
//
// The fix is ordering, not settings. Sign again here, after every step that writes into the bundle,
// innermost first, because signing the extension invalidates the app's seal over it. Then verify,
// and refuse to report success if the seal does not hold.

/** codesign -d reports on stderr, so this one cannot go through capture(). */
function describeSignature(target) {
  const shown = spawnSync('/usr/bin/codesign', ['-dvv', target], { encoding: 'utf8', cwd: root });
  return shown.stderr ?? '';
}

/**
 * Sign a bundle again exactly as it is signed now: same identity, same entitlements, same hardened
 * runtime. Reading all three back off the bundle rather than off the build settings is deliberate.
 * Xcode adds things to a Debug build that no .entitlements file in the repository mentions, notably
 * get-task-allow, and signing from the source file would quietly drop them.
 */
function sign(target) {
  const shown = describeSignature(target);
  const identity = /^Signature=adhoc$/m.test(shown) ? '-' : /^Authority=(.+)$/m.exec(shown)?.[1];
  if (!identity) {
    fail(
      `cannot tell what ${path.basename(target)} is signed with`,
      'Delete .output/safari-xcode and build again.',
    );
  }

  const dumped = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', target], {
    encoding: 'utf8',
    cwd: root,
  });
  const entitlements = dumped.stdout ?? '';
  if (!entitlements.startsWith('<?xml')) {
    fail(
      `${path.basename(target)} carries no entitlements to preserve`,
      'A Mac bundle with no entitlements is never sandboxed, and Safari ignores the extension inside it.',
    );
  }
  const plist = path.join(root, '.output', 'safari-xcode', `${path.basename(target)}.entitlements.plist`);
  fs.writeFileSync(plist, entitlements);

  const args = ['--force', '--sign', identity, '--entitlements', plist];
  if (/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/m.test(shown)) args.push('--options', 'runtime');
  args.push(target);
  run('/usr/bin/codesign', args);
}

/** The check the whole thing is for: does the shipped app match what it says it is? */
function verifySeal(app) {
  const check = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    encoding: 'utf8',
    cwd: root,
  });
  if (check.status !== 0) {
    fail(
      `${path.relative(root, app)} does not match its own signature`,
      (check.stderr ?? 'codesign said nothing').trim().split('\n').slice(0, 8).join('\n  '),
    );
  }
  console.log(`verified ${path.relative(root, app)}  codesign --verify --deep --strict`);
}

function mac({ configuration, bundleId, team, launch }) {
  xcodebuild({ sdk: 'macosx', configuration, bundleId, team });

  const app = productPath(configuration, 'macosx');
  if (!fs.existsSync(app)) fail(`the build produced no app at ${app}`);

  // Check the bundle rather than trusting the build log. Two mistakes look identical from Safari
  // (an empty extension list) and have different fixes: web resources that were never staged, and
  // a signature Safari will not accept.
  const appex = path.join(app, 'Contents', 'PlugIns', 'usermods-extension.appex');
  if (!fs.existsSync(appex)) {
    fail(`no extension inside ${path.relative(root, app)}`, 'The app built but the .appex was not embedded.');
  }
  const manifest = path.join(appex, 'Contents', 'Resources', 'manifest.json');
  if (!fs.existsSync(manifest)) {
    fail(
      `no manifest.json inside ${path.relative(root, appex)}`,
      'Run `node scripts/safari-xcode.mjs stage`, then build again.',
    );
  }

  sign(appex);
  sign(app);
  verifySeal(app);

  const signature = describeSignature(appex)
    .split('\n')
    .filter((l) => /^(Identifier|Signature|TeamIdentifier)=/.test(l))
    .join('; ');
  const adhoc = !team;

  console.log('');
  console.log(`built    ${path.relative(root, app)}`);
  console.log(`         with ${path.relative(app, appex)}`);
  console.log(`         and ${path.relative(appex, manifest)}`);
  if (signature) console.log(`signed   ${signature}`);
  console.log('         signature verified against the bundle contents, extension included');
  console.log('');
  console.log('Safari finds the extension through the app, so the app has to be somewhere it stays:');
  console.log(`  cp -R "${app}" /Applications/`);
  console.log('  open /Applications/usermods.app');
  console.log('Then turn it on in Safari > Settings > Extensions, and give it every website.');
  if (adhoc) {
    console.log('');
    for (const line of MAC_UNSIGNED_NOTE) console.log(line);
  }

  if (launch) {
    console.log('');
    run('/usr/bin/open', [app]);
  }
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
    // No default here: pickSimulator() derives it from what this machine actually has.
    simulator({ configuration, bundleId, device: flag('device') });
    break;
  case 'mac':
    if (!has('no-stage')) stage({ build: !has('no-build') });
    mac({ configuration, bundleId, team, launch: has('launch') });
    break;
  default:
    fail(`unknown command "${command}"`, 'Try: doctor, stage, build, simulator, mac');
}
