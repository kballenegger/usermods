#!/usr/bin/env node
// Build the app that carries the Safari extension, for iOS or macOS, without touching the machine's
// Xcode selection.
//
//   node scripts/safari-xcode.mjs doctor              what is installed, and what that allows
//   node scripts/safari-xcode.mjs stage               npm build + copy the output into safari/
//   node scripts/safari-xcode.mjs stage --store       the same, from the App Store build (no
//                                                     subscription sign-in; see lib/buildflags.ts)
//   node scripts/safari-xcode.mjs build               stage, then xcodebuild for the simulator
//   node scripts/safari-xcode.mjs build --sdk iphoneos --team ABCDE12345
//   node scripts/safari-xcode.mjs simulator           build, boot a simulator, install, launch
//   node scripts/safari-xcode.mjs mac                 build the Mac app, check it, say what is next
//   node scripts/safari-xcode.mjs mac --launch        the same, then open it
//   node scripts/safari-xcode.mjs archive --team ABCDE12345
//                                                     stage, archive for iOS devices, export an
//                                                     App Store .ipa, check what is inside it
//   node scripts/safari-xcode.mjs archive --team ABCDE12345 --upload
//                                                     the same, then upload it to App Store
//                                                     Connect through the Xcode account on
//                                                     this Mac (TestFlight)
//   node scripts/safari-xcode.mjs dmg --team ABCDE12345
//                                                     stage, archive for macOS, export with
//                                                     Developer ID, lay out dist/usermods.dmg,
//                                                     notarize, staple, mount it and check it
//   node scripts/safari-xcode.mjs dmg --team ABCDE12345 --skip-notarize
//                                                     the same without the trip to Apple (an
//                                                     image Gatekeeper will refuse on a fresh Mac)
//   node scripts/safari-xcode.mjs dmg --check         mount and check the image in dist/ only
//   node scripts/safari-xcode.mjs dmg --team ABCDE12345 --no-build --no-stage --publish
//                                                     the same image again, then put it on the
//                                                     GitHub release for this version
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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = path.join(root, 'safari');
const project = path.join(projectDir, 'usermods.xcodeproj');
const stageDir = path.join(projectDir, 'Extension', 'Resources');
/**
 * Which build gets staged into the .appex.
 *
 * `--store` selects the App Store variant (`USERMODS_STORE=1 wxt build -b safari`), which drops
 * subscription sign-in; without it, the ordinary Safari build, which has it. They land in separate
 * .output folders on purpose — staging the wrong one produces an app that builds, installs, runs
 * and is simply missing the sign-in, with nothing in any log to say which build it came from.
 */
const storeVariant = process.argv.includes('--store');
const buildOutput = path.join(root, '.output', storeVariant ? 'store-safari-mv3' : 'safari-mv3');
const buildScript = storeVariant ? 'build:safari:store' : 'build:safari';

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
  console.log(`stage source            ${path.relative(root, buildOutput)}${storeVariant ? '  (--store)' : ''}`);
}

function stage({ build = true } = {}) {
  console.log(`staging the ${storeVariant ? 'App Store' : 'ordinary'} Safari build (${path.relative(root, buildOutput)})`);
  if (build) run('npm', ['run', buildScript]);
  if (!fs.existsSync(path.join(buildOutput, 'manifest.json'))) {
    fail(
      `${buildOutput} has no manifest.json`,
      `Run \`npm run ${buildScript}\` first, or drop --no-build.`,
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
  const id = bundleId ?? 'com.kballenegger.usermods';
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

/**
 * Does the web extension inside the bundle match the one that was just staged?
 *
 * This is not paranoia; it was hit while writing the subscription work. The copy phase is a shell
 * script Xcode treats as up to date when its declared inputs have not changed, so a build whose
 * ONLY change was on the web side ran the app target, reported ** BUILD SUCCEEDED **, and left the
 * previous web extension inside the .appex. The app that came out was signed, verified, installed
 * and ran — carrying a background.js from the build before. In that instance the stale copy was
 * the App Store variant, so the shipped app was silently missing subscription sign-in, which is
 * precisely the bug this branch exists to fix, reintroduced by the build system rather than by the
 * code.
 *
 * It fails the same way the signing bug did: no error, no log line, a successful build and a wrong
 * artifact. So the finished bundle is compared against the stage directory byte for byte, by size,
 * for every staged file. Nothing else in the pipeline would notice.
 */
function assertBundleMatchesStage(bundleResources) {
  const staged = execFileSync('/usr/bin/find', [stageDir, '-type', 'f'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
  const wrong = [];
  for (const file of staged) {
    const rel = path.relative(stageDir, file);
    const inBundle = path.join(bundleResources, rel);
    if (!fs.existsSync(inBundle)) {
      wrong.push(`${rel}: staged but not in the bundle`);
      continue;
    }
    const a = fs.statSync(file).size;
    const b = fs.statSync(inBundle).size;
    if (a !== b) wrong.push(`${rel}: staged ${a} bytes, bundle has ${b}`);
  }
  if (wrong.length) {
    fail(
      `the extension inside the app is not the one that was staged (${wrong.length} file${wrong.length === 1 ? '' : 's'} differ)`,
      `${wrong.slice(0, 5).join('\n  ')}\n  Xcode skipped the copy phase. Delete .output/safari-xcode and build again.`,
    );
  }
  console.log(`bundle matches the staged build  ${staged.length} files, ${path.relative(root, stageDir)}`);
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
  assertBundleMatchesStage(path.join(appex, 'Contents', 'Resources'));

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
// App Store: archive, export, upload
// ---------------------------------------------------------------------------

/**
 * The App Store path, which is a different shape from every other command here: an .xcarchive
 * built for real devices, exported into an .ipa with a distribution signature, then handed to
 * App Store Connect. Automatic signing with -allowProvisioningUpdates lets xcodebuild mint the
 * Apple Distribution certificate and the App Store profiles itself, through the Apple account
 * signed in to Xcode on this machine; nothing is stored in the repository.
 *
 * Two exports rather than one: `export` writes the .ipa to disk so it can be inspected before
 * anything leaves the machine, and `upload` (only with --upload) sends the same archive. The
 * inspection matters for the same reason `mac` has it: the copy phase that puts the web extension
 * into the .appex can silently ship the previous web build, and nothing in an upload receipt
 * would say so.
 */
const archiveDir = path.join(root, '.output', 'safari-archive');

function exportOptions({ team, destination }) {
  const plist = path.join(archiveDir, `ExportOptions-${destination}.plist`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>${destination}</string>
	<key>teamID</key>
	<string>${team}</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>uploadSymbols</key>
	<true/>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
`;
  fs.writeFileSync(plist, xml);
  return plist;
}

/** Read one string value out of a binary or XML Info.plist without a dependency. */
function plistValue(file, key) {
  return capture('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file]);
}

function archive({ bundleId, team, upload, buildNumber }) {
  if (!team) fail('archive needs --team <id>', 'An App Store archive has to be signed by a team.');
  if (storeVariant) {
    console.log('note: --store given, so the archive carries the variant WITHOUT subscription sign-in');
  }
  const developerDir = requireXcode();
  const xcodebuildBin = path.join(developerDir, 'usr', 'bin', 'xcodebuild');
  const env = xcodeEnv(developerDir);
  fs.mkdirSync(archiveDir, { recursive: true });

  const overrides = [`DEVELOPMENT_TEAM=${team}`, 'CODE_SIGN_STYLE=Automatic'];
  if (bundleId) overrides.push(`USERMODS_BUNDLE_ID=${bundleId}`);
  if (buildNumber) overrides.push(`USERMODS_BUILD_NUMBER=${buildNumber}`);

  const archivePath = path.join(archiveDir, 'usermods-ios.xcarchive');
  fs.rmSync(archivePath, { recursive: true, force: true });
  console.log(`archiving for iOS devices with DEVELOPER_DIR=${developerDir}`);
  run(xcodebuildBin, [
    '-project', project,
    '-scheme', 'usermods',
    '-configuration', 'Release',
    '-sdk', 'iphoneos',
    '-destination', 'generic/platform=iOS',
    '-archivePath', archivePath,
    '-derivedDataPath', path.join(root, '.output', 'safari-xcode'),
    '-allowProvisioningUpdates',
    'archive',
    ...overrides,
  ], { env });

  // Check the archive before signing anything for distribution: the app, the extension inside it,
  // the manifest at the extension's root, and the staged files byte for byte by size.
  const app = path.join(archivePath, 'Products', 'Applications', 'usermods.app');
  if (!fs.existsSync(app)) fail(`the archive has no app at ${path.relative(root, app)}`);
  const appex = path.join(app, 'PlugIns', 'usermods-extension.appex');
  if (!fs.existsSync(appex)) fail(`no extension inside ${path.relative(root, app)}`, 'The app archived but the .appex was not embedded.');
  if (!fs.existsSync(path.join(appex, 'manifest.json'))) {
    fail(`no manifest.json inside ${path.relative(root, appex)}`, 'Run `node scripts/safari-xcode.mjs stage`, then archive again.');
  }
  assertBundleMatchesStage(appex);

  const info = path.join(app, 'Info.plist');
  const version = plistValue(info, 'CFBundleShortVersionString');
  const build = plistValue(info, 'CFBundleVersion');
  const exempt = plistValue(info, 'ITSAppUsesNonExemptEncryption');
  const minOS = plistValue(info, 'MinimumOSVersion');
  const extVersion = plistValue(path.join(appex, 'Info.plist'), 'CFBundleShortVersionString');
  if (version !== extVersion) fail(`app is ${version} but the extension is ${extVersion}`);
  if (exempt !== 'false') {
    fail('ITSAppUsesNonExemptEncryption is not false in the archived Info.plist', 'App Store Connect would hold the build on the export-compliance question.');
  }
  // What the manifest says it is, so a wrong variant is visible here rather than in a review.
  const manifest = JSON.parse(fs.readFileSync(path.join(appex, 'manifest.json'), 'utf8'));
  console.log(`archived  ${path.relative(root, archivePath)}`);
  console.log(`          app ${version} (${build}), extension ${extVersion}, manifest ${manifest.version}, iOS ${minOS}+`);
  console.log(`          variant: ${storeVariant ? 'App Store (no subscription sign-in)' : 'ordinary (subscription sign-in included)'}`);

  // Export to disk, then look inside the .ipa rather than trusting the export log.
  const exportPath = path.join(archiveDir, 'export');
  fs.rmSync(exportPath, { recursive: true, force: true });
  console.log('exporting an App Store .ipa (distribution signature, automatic)');
  run(xcodebuildBin, [
    '-exportArchive',
    '-archivePath', archivePath,
    '-exportOptionsPlist', exportOptions({ team, destination: 'export' }),
    '-exportPath', exportPath,
    '-allowProvisioningUpdates',
  ], { env });
  const ipa = fs.readdirSync(exportPath).map((f) => path.join(exportPath, f)).find((f) => f.endsWith('.ipa'));
  if (!ipa) fail(`the export produced no .ipa in ${path.relative(root, exportPath)}`);
  const listing = execFileSync('/usr/bin/unzip', ['-l', ipa], { encoding: 'utf8' });
  const must = [
    'Payload/usermods.app/Info.plist',
    'Payload/usermods.app/PlugIns/usermods-extension.appex/manifest.json',
    'Payload/usermods.app/embedded.mobileprovision',
    'Payload/usermods.app/PlugIns/usermods-extension.appex/embedded.mobileprovision',
  ];
  const missing = must.filter((m) => !listing.includes(m));
  if (missing.length) fail(`the .ipa is missing ${missing.join(', ')}`);
  console.log(`exported  ${path.relative(root, ipa)}  ${(fs.statSync(ipa).size / 1048576).toFixed(1)} MB`);
  // Who signed the exported app: unzip the one Info.plist's neighbour, the code signature, is not
  // worth it; codesign on the archive's copy says which identity the export was asked for, and
  // the .ipa listing above proves the distribution profiles went in.
  const authority = describeSignature(app).split('\n').find((l) => l.startsWith('Authority=Apple'));
  if (authority) console.log(`          ${authority}`);

  if (!upload) {
    console.log('');
    console.log('Nothing has left this machine. To upload the same archive to App Store Connect:');
    console.log(`  node scripts/safari-xcode.mjs archive --no-build --no-stage --team ${team} --upload`);
    console.log('(or drop the .ipa on Transporter.app)');
    return;
  }

  console.log('');
  console.log('uploading to App Store Connect through the Xcode account on this Mac');
  const uploadPath = path.join(archiveDir, 'upload');
  fs.rmSync(uploadPath, { recursive: true, force: true });
  run(xcodebuildBin, [
    '-exportArchive',
    '-archivePath', archivePath,
    '-exportOptionsPlist', exportOptions({ team, destination: 'upload' }),
    '-exportPath', uploadPath,
    '-allowProvisioningUpdates',
  ], { env });
  console.log('');
  console.log(`uploaded  usermods ${version} (${build}) for iOS`);
  console.log('          App Store Connect processes it for a few minutes, then it appears under TestFlight > iOS builds.');
}

// ---------------------------------------------------------------------------
// macOS: Developer ID archive, disk image, notarization, release
// ---------------------------------------------------------------------------
//
// The Mac release path, shaped like the one Caret and Feke use for their Mac apps: a Release
// archive, a Developer ID export, a disk image laid out by dmgbuild (which writes the Finder
// window's .DS_Store itself, so no Finder scripting and no Automation permission), a signature on
// the image, notarization with the ticket stapled to both the image and the app, and then a
// mount-and-look before anything is called finished. Developer ID is what makes the extension
// appear in Safari's list on another Mac without the two developer settings `mac` prints; the
// notarization ticket is what lets Gatekeeper open a fresh download at all.
//
// Everything builds under ~/Library/Caches rather than .output/ on purpose. This checkout can live
// in a synced folder (it does, on the release Mac), and the sync client tags every file it sees
// with its own extended attribute, which would otherwise ride inside the app. The exported app has
// its attributes cleared anyway, after the export and before the image, and its seal is verified
// again afterwards, so the two measures back each other up.
//
// Notarization needs App Store Connect API credentials. They come from one of two places and
// never from this repository:
//   - a notarytool keychain profile (`--notary-profile NAME`, default "usermods"), created once with
//     `xcrun notarytool store-credentials usermods --key AuthKey.p8 --key-id ID --issuer ISSUER`;
//   - or USERMODS_ASC_KEY_PATH, USERMODS_ASC_KEY_ID and USERMODS_ASC_ISSUER_ID in the environment.

const DMGBUILD_VERSION = '1.6.5';
const PILLOW_VERSION = '11.3.0';
const dmgWorkDir = process.env.USERMODS_DMG_WORK_DIR || path.join(os.homedir(), 'Library', 'Caches', 'usermods-mac-dmg');
const distDir = path.join(root, 'dist');
const dmgPath = path.join(distDir, 'usermods.dmg');
const dmgDir = path.join(projectDir, 'dmg');
const DMG_APP_NAME = 'usermods.app';
const DMG_VOLUME_NAME = 'usermods';

function developerIdExportOptions({ team }) {
  const plist = path.join(dmgWorkDir, 'ExportOptions-developer-id.plist');
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>developer-id</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>teamID</key>
	<string>${team}</string>
</dict>
</plist>
`);
  return plist;
}

/** The "Developer ID Application" identity for the team, as the keychain names it, or null. */
function developerIdIdentity(team) {
  const listed = capture('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']) ?? '';
  const re = new RegExp(`"(Developer ID Application: [^"]*\\(${team}\\))"`);
  return re.exec(listed)?.[1] ?? null;
}

/** notarytool's credential arguments: the environment's API key if it is complete, else a profile. */
function notaryCredentials(profile) {
  const keyPath = process.env.USERMODS_ASC_KEY_PATH;
  const keyId = process.env.USERMODS_ASC_KEY_ID;
  const issuer = process.env.USERMODS_ASC_ISSUER_ID;
  if (keyPath || keyId || issuer) {
    if (!(keyPath && keyId && issuer)) {
      fail('USERMODS_ASC_KEY_PATH, USERMODS_ASC_KEY_ID and USERMODS_ASC_ISSUER_ID go together', 'Set all three, or none and use a notarytool keychain profile.');
    }
    if (!fs.existsSync(keyPath)) fail(`no App Store Connect key at ${keyPath}`);
    return { args: ['--key', keyPath, '--key-id', keyId, '--issuer', issuer], source: `API key ${keyId}` };
  }
  return { args: ['--keychain-profile', profile], source: `keychain profile "${profile}"` };
}

function hasHardenedRuntime(target) {
  return /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/m.test(describeSignature(target));
}

/**
 * Mount the image without showing it in Finder and check what a person would get: the app and
 * the Applications alias on a laid-out window, a Developer ID signature that verifies with the
 * extension inside it, and (unless told the image was never notarized) a stapled ticket that
 * Gatekeeper accepts. Returns the app's version and build so callers can name what they made.
 */
function verifyDmg({ notarized }) {
  if (!fs.existsSync(dmgPath)) fail(`no disk image at ${path.relative(root, dmgPath)}`, 'Run `node scripts/safari-xcode.mjs dmg --team <id>` first.');
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'usermods-dmg-'));
  const problems = [];
  const check = (ok, good, bad) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${ok ? good : bad}`);
    if (!ok) problems.push(bad);
  };
  let version = '';
  let build = '';
  try {
    run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-quiet', '-mountpoint', mount, dmgPath]);
    console.log(`${path.relative(root, dmgPath)}  ${(fs.statSync(dmgPath).size / 1048576).toFixed(1)} MB`);

    const app = path.join(mount, DMG_APP_NAME);
    check(fs.existsSync(app), `${DMG_APP_NAME} is on the image`, `${DMG_APP_NAME} is missing from the image`);
    const appex = path.join(app, 'Contents', 'PlugIns', 'usermods-extension.appex');
    const manifest = path.join(appex, 'Contents', 'Resources', 'manifest.json');
    check(fs.existsSync(manifest), 'the Safari extension and its manifest are inside the app', 'the app on the image has no extension inside it');

    let link = null;
    try { link = fs.readlinkSync(path.join(mount, 'Applications')); } catch { /* not a symlink */ }
    check(link === '/Applications', 'Applications is a symlink to /Applications', 'the Applications symlink is wrong or missing');
    check(fs.existsSync(path.join(mount, '.DS_Store')), '.DS_Store carries the window layout', '.DS_Store is missing, so Finder would lay the window out itself');

    // dmgbuild hides the background at the volume root. Both representations have to be there, or
    // a Retina display gets the 1x upscaled.
    const background = path.join(mount, '.background.tiff');
    const reps = fs.existsSync(background)
      ? ((capture('/usr/bin/tiffutil', ['-info', background]) ?? '').match(/Image Width/g) ?? []).length
      : 0;
    check(reps >= 2, `the background is on the image, HiDPI (${reps} representations)`, `the background has ${reps} representation(s) at the volume root`);

    if (fs.existsSync(app)) {
      const info = path.join(app, 'Contents', 'Info.plist');
      version = plistValue(info, 'CFBundleShortVersionString') ?? '';
      build = plistValue(info, 'CFBundleVersion') ?? '';
      const extVersion = fs.existsSync(appex) ? plistValue(path.join(appex, 'Contents', 'Info.plist'), 'CFBundleShortVersionString') : null;
      check(version && version === extVersion, `app and extension are both ${version} (${build})`, `app is ${version || '?'} but the extension is ${extVersion || '?'}`);

      const sealed = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
      check(sealed.status === 0, 'the signature verifies, extension included', `the signature does not verify: ${(sealed.stderr ?? '').trim().split('\n')[0]}`);
      const authority = /^Authority=(.+)$/m.exec(describeSignature(app))?.[1] ?? 'none';
      check(authority.startsWith('Developer ID Application:'), `signed by ${authority}`, `not Developer ID signed (authority: ${authority})`);
      check(hasHardenedRuntime(app) && (!fs.existsSync(appex) || hasHardenedRuntime(appex)), 'hardened runtime on the app and the extension', 'hardened runtime is missing on the app or the extension; notarization would refuse it');

      if (notarized) {
        const stapled = spawnSync('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], { encoding: 'utf8' });
        check(stapled.status === 0, 'the notarization ticket is stapled to the image', 'no stapled notarization ticket on the image');
        const assessed = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app], { encoding: 'utf8' });
        const verdict = `${assessed.stdout ?? ''}${assessed.stderr ?? ''}`;
        check(/source=Notarized Developer ID/.test(verdict), 'Gatekeeper accepts the app (Notarized Developer ID)', `Gatekeeper does not accept the app: ${verdict.trim().replace(/\s+/g, ' ')}`);
      } else {
        console.log('  --   notarization not checked (--skip-notarize): a fresh Mac will refuse to open this image');
      }
    }
  } finally {
    spawnSync('/usr/bin/hdiutil', ['detach', mount, '-quiet', '-force']);
    try { fs.rmdirSync(mount); } catch { /* already gone */ }
  }
  if (problems.length) fail(`the disk image failed ${problems.length} check${problems.length === 1 ? '' : 's'}`, 'Rebuild it with `node scripts/safari-xcode.mjs dmg --team <id>`.');
  return { version, build };
}

/**
 * Put the finished image on this version's GitHub release, as both usermods-<version>.dmg and a
 * plain usermods.dmg (the name /releases/latest/download/ resolves). The release is created as a
 * draft when it does not exist yet, so nothing is public until someone reads the notes and presses
 * Publish; an existing release gets its assets replaced.
 */
function publishDmg({ version, build }) {
  if (capture('git', ['status', '--porcelain', '--untracked-files=no'])) {
    fail('the working tree has uncommitted changes', 'A release names a commit. Commit first.');
  }
  const sha = capture('git', ['rev-parse', 'HEAD']);
  const onRemote = capture('git', ['branch', '-r', '--contains', sha]);
  if (!onRemote) fail(`commit ${sha.slice(0, 7)} is not on any remote branch`, 'Push it first, so the release tag points at something others can see.');
  const tag = `v${version}`;
  const versioned = path.join(dmgWorkDir, `usermods-${version}.dmg`);
  fs.copyFileSync(dmgPath, versioned);

  const exists = spawnSync('gh', ['release', 'view', tag, '--json', 'url,isDraft'], { encoding: 'utf8', cwd: root });
  if (exists.status !== 0) {
    console.log(`creating draft release ${tag} at ${sha.slice(0, 7)}`);
    run('gh', [
      'release', 'create', tag,
      '--draft',
      '--target', sha,
      '--title', `usermods ${version}`,
      '--notes', `usermods ${version} (${build}) for Safari on macOS: a signed and notarized disk image. Drag usermods to Applications, open it once, then turn it on in Safari > Settings > Extensions.`,
    ]);
  } else {
    const info = JSON.parse(exists.stdout);
    console.log(`release ${tag} exists${info.isDraft ? ' (draft)' : ''}: ${info.url}; replacing its disk image`);
  }
  run('gh', ['release', 'upload', tag, '--clobber', versioned, dmgPath]);
  const url = capture('gh', ['release', 'view', tag, '--json', 'url', '--jq', '.url']);
  console.log('');
  console.log(`published usermods-${version}.dmg and usermods.dmg to ${url}`);
  console.log('          A draft is visible to the repository\'s owners only; publish it from that page.');
}

function dmg({ bundleId, team, notarize, publish, notaryProfile, buildNumber }) {
  if (!team) fail('dmg needs --team <id>', 'A Developer ID export has to be signed by a team.');
  if (!fs.existsSync(path.join(dmgDir, 'settings.py')) || !fs.existsSync(path.join(dmgDir, 'background.png'))) {
    fail(`${path.relative(root, dmgDir)} needs settings.py and background.png`, 'The layout and the artwork of the installer window live there.');
  }
  if (!capture('/usr/bin/env', ['uvx', '--version'])) fail('uvx not found (brew install uv)', 'dmgbuild runs through it, pinned, so nothing is installed globally.');
  const identity = developerIdIdentity(team);
  if (!identity) {
    fail(
      `no "Developer ID Application" identity for team ${team} in the keychain`,
      'Xcode > Settings > Accounts > the team > Manage Certificates > + > Developer ID Application (the account holder creates it).',
    );
  }
  const credentials = notarize ? notaryCredentials(notaryProfile) : null;
  if (storeVariant) console.log('note: --store given, so the image carries the variant WITHOUT subscription sign-in');

  const developerDir = requireXcode();
  const xcodebuildBin = path.join(developerDir, 'usr', 'bin', 'xcodebuild');
  const env = xcodeEnv(developerDir);
  fs.mkdirSync(dmgWorkDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 1. Archive for macOS.
  const overrides = [`DEVELOPMENT_TEAM=${team}`, 'CODE_SIGN_STYLE=Automatic'];
  if (bundleId) overrides.push(`USERMODS_BUNDLE_ID=${bundleId}`);
  if (buildNumber) overrides.push(`USERMODS_BUILD_NUMBER=${buildNumber}`);
  const archivePath = path.join(dmgWorkDir, 'usermods-mac.xcarchive');
  fs.rmSync(archivePath, { recursive: true, force: true });
  console.log(`archiving for macOS with DEVELOPER_DIR=${developerDir} (work dir ${dmgWorkDir})`);
  run(xcodebuildBin, [
    '-project', project,
    '-scheme', 'usermods',
    '-configuration', 'Release',
    '-sdk', 'macosx',
    '-destination', 'generic/platform=macOS',
    '-archivePath', archivePath,
    '-derivedDataPath', path.join(dmgWorkDir, 'DerivedData'),
    '-allowProvisioningUpdates',
    'archive',
    ...overrides,
  ], { env });
  const archivedApp = path.join(archivePath, 'Products', 'Applications', DMG_APP_NAME);
  if (!fs.existsSync(archivedApp)) fail(`the archive has no app at ${archivedApp}`);
  const archivedAppex = path.join(archivedApp, 'Contents', 'PlugIns', 'usermods-extension.appex');
  if (!fs.existsSync(path.join(archivedAppex, 'Contents', 'Resources', 'manifest.json'))) {
    fail('the archived app has no extension with a manifest inside it', 'Run `node scripts/safari-xcode.mjs stage`, then again.');
  }
  assertBundleMatchesStage(path.join(archivedAppex, 'Contents', 'Resources'));

  // 2. Export with Developer ID. Automatic signing picks the identity found above.
  const exportPath = path.join(dmgWorkDir, 'export');
  fs.rmSync(exportPath, { recursive: true, force: true });
  console.log('exporting with Developer ID (automatic signing)');
  run(xcodebuildBin, [
    '-exportArchive',
    '-archivePath', archivePath,
    '-exportOptionsPlist', developerIdExportOptions({ team }),
    '-exportPath', exportPath,
    '-allowProvisioningUpdates',
  ], { env });
  const app = path.join(exportPath, DMG_APP_NAME);
  if (!fs.existsSync(app)) fail(`the export produced no ${DMG_APP_NAME} in ${exportPath}`);
  const appex = path.join(app, 'Contents', 'PlugIns', 'usermods-extension.appex');
  // Clear the sync client's attributes (see the section comment), then prove the seal survived.
  run('/usr/bin/xattr', ['-cr', app]);
  verifySeal(app);
  const authority = /^Authority=(.+)$/m.exec(describeSignature(app))?.[1] ?? 'none';
  if (!authority.startsWith('Developer ID Application:')) fail(`the exported app is signed by ${authority}, not Developer ID`);
  if (!hasHardenedRuntime(app) || !hasHardenedRuntime(appex)) fail('the export lacks the hardened runtime on the app or the extension', 'ENABLE_HARDENED_RUNTIME[sdk=macosx*] = YES is expected in both xcconfigs.');
  const info = path.join(app, 'Contents', 'Info.plist');
  const version = plistValue(info, 'CFBundleShortVersionString');
  const build = plistValue(info, 'CFBundleVersion');
  const minOS = plistValue(info, 'LSMinimumSystemVersion');
  console.log(`exported  ${app}`);
  console.log(`          usermods ${version} (${build}), macOS ${minOS}+, ${authority}`);
  console.log(`          variant: ${storeVariant ? 'App Store (no subscription sign-in)' : 'ordinary (subscription sign-in included)'}`);

  // 3. The disk image, laid out by dmgbuild from safari/dmg/settings.py and the artwork beside it.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usermods-dmgbuild-'));
  try {
    fs.rmSync(dmgPath, { force: true });
    console.log(`laying out ${path.relative(root, dmgPath)} (dmgbuild ${DMGBUILD_VERSION} through uvx)`);
    run('uvx', [
      '--quiet',
      '--from', `dmgbuild==${DMGBUILD_VERSION}`,
      '--with', `Pillow==${PILLOW_VERSION}`,
      'dmgbuild',
      '-s', path.join(dmgDir, 'settings.py'),
      '-D', `app=${app}`,
      '-D', `background_source=${path.join(dmgDir, 'background.png')}`,
      '-D', `scratch=${scratch}`,
      DMG_VOLUME_NAME, dmgPath,
    ]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  if (!fs.existsSync(dmgPath)) fail('dmgbuild reported success but wrote no image');
  run('/usr/bin/codesign', ['--force', '--timestamp', '--sign', identity, dmgPath]);
  console.log(`signed    the image as ${identity}`);

  // 4. Notarize and staple: the image, and the exported app so a copy taken from it carries the
  //    ticket too. Apple's ticket covers the app inside the image as well.
  if (notarize) {
    console.log(`notarizing with ${credentials.source} (waits for Apple)`);
    const log = path.join(dmgWorkDir, 'notarize.log');
    const submitted = spawnSync('/usr/bin/xcrun', ['notarytool', 'submit', dmgPath, ...credentials.args, '--wait'], { encoding: 'utf8', cwd: root });
    const output = `${submitted.stdout ?? ''}${submitted.stderr ?? ''}`;
    fs.writeFileSync(log, output);
    process.stdout.write(output.split('\n').filter((l) => /^\s*(id|status|message):/.test(l)).join('\n') + '\n');
    if (submitted.status !== 0 || !/status: Accepted/.test(output)) {
      const id = /^\s*id: ([0-9a-f-]+)/m.exec(output)?.[1];
      fail(
        'notarization was not accepted',
        id ? `xcrun notarytool log ${id} ${credentials.args.join(' ')}  has the reasons (full output in ${log})` : `full output in ${log}`,
      );
    }
    run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
    run('/usr/bin/xcrun', ['stapler', 'staple', app]);
    console.log('notarized and stapled, image and app');
  } else {
    console.log('skipping notarization (--skip-notarize): this image is NOT one to hand out');
  }

  // 5. Look at what was made.
  console.log('');
  verifyDmg({ notarized: notarize });

  console.log('');
  console.log(`built     ${path.relative(root, dmgPath)}  usermods ${version} (${build}) for macOS`);
  if (!publish) {
    console.log('Nothing has left this machine. To put it on the GitHub release for this version:');
    console.log(`  node scripts/safari-xcode.mjs dmg --team ${team} --no-build --no-stage --publish`);
    console.log('(which builds it again, so the published image is the checked one)');
    return;
  }
  console.log('');
  publishDmg({ version, build });
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
  case 'archive':
    if (!team) fail('archive needs --team <id>', 'An App Store archive has to be signed by a team.');
    if (!has('no-stage')) stage({ build: !has('no-build') });
    archive({ bundleId, team, upload: has('upload'), buildNumber: flag('build') });
    break;
  case 'dmg':
    if (has('check')) {
      verifyDmg({ notarized: !has('skip-notarize') });
      break;
    }
    // Refuse before the minutes of staging, not after.
    if (!team) fail('dmg needs --team <id>', 'A Developer ID export has to be signed by a team.');
    if (!has('no-stage')) stage({ build: !has('no-build') });
    dmg({
      bundleId,
      team,
      notarize: !has('skip-notarize'),
      publish: has('publish'),
      notaryProfile: flag('notary-profile', 'usermods'),
      buildNumber: flag('build'),
    });
    break;
  default:
    fail(`unknown command "${command}"`, 'Try: doctor, stage, build, simulator, mac, archive, dmg');
}
