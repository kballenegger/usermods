// The Safari app builds for two platforms out of one pair of targets, and almost everything that
// makes that work is configuration: an xcconfig condition, a plist key, an entitlement, a `#if`.
// None of it is exercised by the other tests, and all of it fails quietly. A missing
// NSPrincipalClass launches an app with no window and no error; a missing `#if os(iOS)` breaks the
// iOS build with an error about AppKit that names nothing.
//
// So this file reads the real files in safari/ and asserts the handful of lines each platform
// needs. It does not replace building, which is `node scripts/safari-xcode.mjs mac` and
// `... simulator`; it catches the edit that deletes one of these lines months from now.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(root + rel, 'utf8');

// ---------- one pair of targets, two platforms ----------

test('the shared xcconfig lets a build pick its own SDK', () => {
  const shared = read('safari/Config/Shared.xcconfig');
  // Without auto, SDKROOT is whichever platform was written down and -destination is ignored.
  assert.match(shared, /^SDKROOT = auto$/m);
  const supported = (/^SUPPORTED_PLATFORMS = (.+)$/m.exec(shared)?.[1] ?? '').split(/\s+/);
  for (const platform of ['iphoneos', 'iphonesimulator', 'macosx']) {
    assert.ok(supported.includes(platform), `SUPPORTED_PLATFORMS is missing ${platform}`);
  }
});

test('each platform has a deployment floor, and iOS matches the manifest', () => {
  const shared = read('safari/Config/Shared.xcconfig');
  // 16.4 is where WebKit got MV3 web extensions. lib/manifest.ts writes the same number into
  // browser_specific_settings.safari.strict_min_version, and the two drifting apart means an
  // install that fails on a device the project says it supports.
  assert.match(shared, /^IPHONEOS_DEPLOYMENT_TARGET = 16\.4$/m);
  assert.match(read('lib/manifest.ts'), /strict_min_version.{0,20}16\.4/s);
  // Ventura, which is where Safari 16.4 landed on the desktop.
  assert.match(shared, /^MACOSX_DEPLOYMENT_TARGET = 13\.0$/m);
});

test('the iPhone-and-iPad setting is asked of the iOS SDK only', () => {
  // Unqualified, TARGETED_DEVICE_FAMILY reads as a claim that the Mac build is a Catalyst one.
  assert.match(read('safari/Config/Shared.xcconfig'), /^TARGETED_DEVICE_FAMILY\[sdk=iphone\*\] = 1,2$/m);
});

// ---------- the Mac app bundle ----------

test('the Mac build gets its own Info.plist and the key that starts AppKit', () => {
  assert.match(read('safari/Config/App.xcconfig'), /^INFOPLIST_FILE\[sdk=macosx\*\] = App\/Info-macOS\.plist$/m);
  const plist = read('safari/App/Info-macOS.plist');
  // Without NSPrincipalClass the bundle launches, never starts NSApplication, and dies silently.
  assert.match(plist, /<key>NSPrincipalClass<\/key>\s*<string>NSApplication<\/string>/);
  assert.match(plist, /<key>LSMinimumSystemVersion<\/key>\s*<string>\$\(MACOSX_DEPLOYMENT_TARGET\)<\/string>/);
});

test('both Mac bundles are sandboxed and hardened', () => {
  // Entitlements are applied at signing, so unlike the simulator this cannot be skipped: an
  // unsandboxed app is one Safari declines to load an extension out of.
  const app = read('safari/Config/App.xcconfig');
  assert.match(app, /^CODE_SIGN_ENTITLEMENTS\[sdk=macosx\*\] = App\/usermods-macOS\.entitlements$/m);
  assert.match(app, /^ENABLE_HARDENED_RUNTIME\[sdk=macosx\*\] = YES$/m);

  const ext = read('safari/Config/Extension.xcconfig');
  assert.match(ext, /^CODE_SIGN_ENTITLEMENTS\[sdk=macosx\*\] = Extension\/usermods-extension-macOS\.entitlements$/m);
  assert.match(ext, /^ENABLE_HARDENED_RUNTIME\[sdk=macosx\*\] = YES$/m);

  for (const file of ['safari/App/usermods-macOS.entitlements', 'safari/Extension/usermods-extension-macOS.entitlements']) {
    assert.match(read(file), /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/, `${file} is not sandboxed`);
  }
});

test('the Mac app claims nothing it does not need', () => {
  const app = read('safari/App/usermods-macOS.entitlements');
  // The host app opens a window and a settings pane. It talks to nothing.
  assert.doesNotMatch(app, /com\.apple\.security\.network/);
  assert.doesNotMatch(app, /com\.apple\.security\.files/);
});

// ---------- one @main per SDK ----------

test('each platform has exactly one entry point, and neither compiles into the other', () => {
  const sources = {
    'safari/App/AppDelegate.swift': 'iOS',
    'safari/App/ViewController.swift': 'iOS',
    'safari/App/MacAppDelegate.swift': 'macOS',
    'safari/App/MacViewController.swift': 'macOS',
  } as const;
  for (const [file, platform] of Object.entries(sources)) {
    const text = read(file);
    // Both files are in the same target, compiled for both SDKs. The guard is the whole reason
    // the iOS build does not try to import AppKit.
    assert.ok(text.startsWith(`#if os(${platform})\n`), `${file} does not open with #if os(${platform})`);
    assert.ok(text.trimEnd().endsWith('#endif'), `${file} does not close its guard`);
  }
  // Two @main attributes, one per SDK. A third, or one outside a guard, is a build failure.
  assert.match(read('safari/App/AppDelegate.swift'), /^@main$/m);
  assert.match(read('safari/App/MacAppDelegate.swift'), /^@main$/m);
  // NSApplication.delegate is weak and there is no nib to hold the delegate, so the Mac entry
  // point is written out by hand and keeps its own reference. Losing either line launches an app
  // that draws nothing and reports no error.
  const mac = read('safari/App/MacAppDelegate.swift');
  assert.match(mac, /static func main\(\)/);
  assert.match(mac, /static var shared: MacAppDelegate\?/);
  assert.match(mac, /setActivationPolicy\(\.regular\)/);
});

// ---------- the project file ----------

test('the Mac sources and config files are in the project', () => {
  const pbx = read('safari/usermods.xcodeproj/project.pbxproj');
  for (const name of ['MacAppDelegate.swift', 'MacViewController.swift', 'Info-macOS.plist', 'usermods-macOS.entitlements', 'usermods-extension-macOS.entitlements']) {
    assert.ok(pbx.includes(name), `${name} has no file reference`);
  }
  // A file reference alone compiles nothing. Both Swift files have to be in the app's Sources
  // phase, which is the one thing about a hand-written pbxproj that is easy to half-do.
  const sources = /1A0000000000000000000102 \/\* Sources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/.exec(pbx)?.[1] ?? '';
  for (const name of ['MacAppDelegate.swift', 'MacViewController.swift']) {
    assert.ok(sources.includes(name), `${name} is not in the app's Sources build phase`);
  }
});

test('the extension is embedded where Safari looks for it', () => {
  // 13 is PlugIns. On both platforms the appex has to land in the app bundle's PlugIns directory
  // or Safari never sees an extension at all.
  assert.match(read('safari/usermods.xcodeproj/project.pbxproj'), /dstSubfolderSpec = 13;/);
});

// ---------- the build script ----------

test('the build script has a Mac command and says what Safari still needs', () => {
  const script = read('scripts/safari-xcode.mjs');
  assert.match(script, /'mac'/);
  // An ad-hoc signed extension does not appear in Safari's list, and the two settings that reveal
  // it are Safari-wide developer settings a person has to turn on themselves. Printing the exact
  // labels is the difference between a build that looks broken and one that looks finished.
  assert.match(script, /Show features for web developers/);
  assert.match(script, /Allow unsigned extensions/i);
});
