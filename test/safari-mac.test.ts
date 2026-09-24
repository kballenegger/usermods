// The Safari app builds for two platforms out of one pair of targets, and almost everything that
// makes that work is configuration: an xcconfig condition, a plist key, an entitlement, a `#if`.
// None of it is exercised by the other tests, and all of it fails quietly. A missing
// NSPrincipalClass launches an app with no window and no error; a missing `#if os(iOS)` breaks the
// iOS build with an error about AppKit that names nothing.
//
// So this file reads the real files in safari/ and asserts the handful of lines each platform
// needs. It does not replace building, which is `node scripts/safari-xcode.mjs mac` and
// `... simulator`; it catches the edit that deletes one of these lines months from now.
//
// The xcconfig, plist, entitlement and project checks read the config itself, which is the thing
// Xcode consumes. The checks on the Swift sources and scripts/safari-xcode.mjs are source lint:
// running them needs xcodebuild and codesign, which npm test does not have, so they pin the
// ordering and flags as text. A harmless rewrite can fail them; update the pattern when it does.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { colourKey, decodePNG } from '../scripts/lib/png.mjs';
import { buildManifest } from '../lib/manifest.ts';
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
  const ios = /^IPHONEOS_DEPLOYMENT_TARGET = (.+)$/m.exec(shared)?.[1];
  assert.equal(ios, '16.4');
  assert.equal(buildManifest('safari').browser_specific_settings?.safari?.strict_min_version, ios);
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

test('the Mac build preserves entitlements and never changes global Xcode selection', () => {
  const script = read('scripts/safari-xcode.mjs');
  // The app must be signed, even ad hoc, or the sandbox entitlements disappear and Safari has no
  // extension bundle to inspect. DEVELOPER_DIR must stay scoped to child processes as well.
  assert.match(script, /CODE_SIGNING_REQUIRED=YES/);
  assert.match(script, /CODE_SIGNING_ALLOWED=YES/);
  assert.match(script, /CODE_SIGN_IDENTITY=-/);
  assert.match(script, /DEVELOPER_DIR: developerDir/);
  assert.doesNotMatch(script, /xcode-select['\"], \['--switch'/);
});

test('the Mac host app opens its own extension row and reports failure', () => {
  const mac = read('safari/App/MacViewController.swift');
  // A custom bundle id is supported by the build script, so the settings button must derive the
  // extension id from the installed app rather than opening the public build's hard-coded row.
  assert.match(mac, /Bundle\.main\.bundleIdentifier/);
  assert.match(mac, /SFSafariApplication\.showPreferencesForExtension\(withIdentifier: extensionBundleIdentifier\)/);
  assert.match(mac, /Safari did not open its extension settings/);
  assert.match(mac, /Open Safari, then Settings, then Extensions by hand/);
});

test('the Mac extension receives network access but the host app does not', () => {
  const app = read('safari/App/usermods-macOS.entitlements');
  const ext = read('safari/Extension/usermods-extension-macOS.entitlements');
  // GM_xmlhttpRequest runs from the extension process. Granting the same entitlement to the host
  // app would widen the native app's sandbox for no reason.
  assert.doesNotMatch(app, /com\.apple\.security\.network\.client/);
  assert.match(ext, /com\.apple\.security\.network\.client/);
});

// ---------- the signature has to outlive the last step that writes into the bundle ----------

test('the staged web extension replaces what the last build staged', () => {
  const pbx = read('safari/usermods.xcodeproj/project.pbxproj');
  // Every file the web build emits carries a content hash, so a changed file arrives under a new
  // name and the old one stays unless something removes it. Left alone the bundle accumulates dead
  // chunks, and each one is a file the signature was never taken over.
  assert.match(pbx, /for staged in \\"\$STAGE\\"\/\*; do/);
  assert.match(pbx, /rm -rf \\"\$DEST\/\$\{staged##\*\/\}\\"/);
  // Deleting by name rather than with rsync --delete, because on iOS this destination is the
  // bundle root: --delete there would take Info.plist and the executable with it.
  assert.doesNotMatch(pbx, /rsync -a --delete/);
});

test('the Mac build signs the bundle after the staging phase, innermost first', () => {
  const script = read('scripts/safari-xcode.mjs');
  // Xcode re-signs a target when that target's own inputs change. The staging phase is not one of
  // them, so a build where only the web side changed leaves the .appex sealed against the files it
  // held one build ago, and `codesign --verify --deep --strict` rejects the app. Signing again here
  // is the only step that runs after everything that writes into the bundle.
  const body = /function mac\(\{[\s\S]*?\n\}/.exec(script)?.[0] ?? '';
  assert.ok(body.length > 0, 'mac() not found');
  const appex = body.indexOf('sign(appex)');
  const app = body.indexOf('sign(app)');
  const verify = body.indexOf('verifySeal(app)');
  assert.ok(appex > 0, 'mac() does not sign the extension');
  assert.ok(app > appex, 'the app must be signed after the extension it contains, not before');
  assert.ok(verify > app, 'the signature must be verified after both bundles are signed');
});

test('signing again preserves the identity, entitlements and hardened runtime already in place', () => {
  const script = read('scripts/safari-xcode.mjs');
  // Reading all three off the built bundle rather than off the repository. A Debug build carries
  // get-task-allow, which no .entitlements file here mentions, and signing from those files would
  // drop it. Dropping com.apple.security.app-sandbox would be worse: Safari ignores an extension
  // whose host app is not sandboxed.
  assert.match(script, /'-d', '--entitlements', '-', '--xml', target/);
  assert.match(script, /carries no entitlements to preserve/);
  assert.match(script, /flags=0x\[0-9a-f\]\+.*runtime/);
  assert.match(script, /args\.push\('--options', 'runtime'\)/);
  assert.match(script, /Signature=adhoc\$\/m\.test\(shown\) \? '-' : \/\^Authority=/);
});

test('the Mac build refuses to report success on a signature that does not hold', () => {
  const script = read('scripts/safari-xcode.mjs');
  // The first version of this build printed "signed" from `codesign -dvv`, which only reads what a
  // bundle claims about itself. It said the build was signed while the extension inside it failed
  // verification. Only --verify compares the seal against the files.
  assert.match(script, /'--verify', '--deep', '--strict', '--verbose=2', app/);
  assert.match(script, /does not match its own signature/);
  const verify = /function verifySeal\([\s\S]*?\n\}/.exec(script)?.[0] ?? '';
  assert.match(verify, /check\.status !== 0/);
  assert.match(verify, /fail\(/);
});

test('the Mac command prints the artifact only after its seal is verified', () => {
  const script = read('scripts/safari-xcode.mjs');
  const body = /function mac\(\{[\s\S]*?\n\}/.exec(script)?.[0] ?? '';
  const verify = body.indexOf('verifySeal(app)');
  const built = body.indexOf('console.log(`built');
  assert.ok(verify > 0, 'mac() does not verify the finished app');
  assert.ok(built > verify, 'mac() reports a built artifact before verification finishes');
});

// ---------------------------------------------------------------------------
// The app icon
// ---------------------------------------------------------------------------
//
// The host app shipped with the system's blank placeholder for a while, because the toolchain the
// branch was first built on could not run actool. Every part of the wiring below fails SILENTLY:
// a catalog that is not in the Resources phase, or an APPICON_NAME that is blank, produces a
// successful build and an app with no icon. Nothing in a build log says so.

test('the asset catalog is wired into the app target, for both SDKs', () => {
  const xcconfig = read('safari/Config/App.xcconfig');
  // Blank is what it was, and blank builds fine and ships no icon.
  assert.match(xcconfig, /^ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon$/m);

  const pbx = read('safari/usermods.xcodeproj/project.pbxproj');
  // A folder.assetcatalog reference, not a plain folder: the type is what makes Xcode run actool
  // over it rather than copying a directory of loose PNGs into the bundle.
  assert.match(pbx, /Assets\.xcassets \*\/ = \{isa = PBXFileReference; lastKnownFileType = folder\.assetcatalog;/);
  // In the APP target's Resources phase (…104), not the extension's (…204). The icon belongs to
  // the app, which is what /Applications, the Dock and the home screen show.
  const appResources = /1A0000000000000000000104 \/\* Resources \*\/ = \{[\s\S]*?\};/.exec(pbx)?.[0] ?? '';
  assert.match(appResources, /Assets\.xcassets in Resources/);
});

test('the icon set covers both platforms the app builds for', () => {
  const contents = JSON.parse(read('safari/App/Assets.xcassets/AppIcon.appiconset/Contents.json'));
  const images: { idiom: string; platform?: string; size: string; scale?: string; filename: string }[] = contents.images;

  // iOS: one full-bleed 1024, which is all current Xcode needs — it derives the rest. Full bleed
  // because the system applies the superellipse mask itself, and a pre-rounded icon gets rounded
  // twice and shows pale corners inside the mask.
  const ios = images.filter((i) => i.platform === 'ios');
  assert.equal(ios.length, 1, 'iOS should have exactly one universal icon');
  assert.equal(ios[0]?.size, '1024x1024');
  assert.equal(ios[0]?.idiom, 'universal');

  // macOS: every (size, scale) slot, because macOS does not derive them and a missing one falls
  // back to a scaled neighbour. Since macOS 26 these are full-bleed squares too — see below.
  const mac = images.filter((i) => i.idiom === 'mac');
  const slots = mac.map((i) => `${i.size}@${i.scale}`).sort();
  assert.deepEqual(slots, [
    '128x128@1x', '128x128@2x', '16x16@1x', '16x16@2x', '256x256@1x', '256x256@2x',
    '32x32@1x', '32x32@2x', '512x512@1x', '512x512@2x',
  ]);

  // Every file named actually exists, which a catalog does not check and actool warns about
  // rather than failing on.
  for (const image of images) {
    assert.doesNotThrow(
      () => readFileSync(root + `safari/App/Assets.xcassets/AppIcon.appiconset/${image.filename}`),
      `${image.filename} is named in Contents.json but not on disk`,
    );
  }
});

test('the icon is generated from the vector, not hand-exported', () => {
  const script = read('scripts/render-app-icon.mjs');
  // The mark is pixel art and its one invisible failure is interpolation, so the generator has to
  // verify its own output rather than trusting the renderer. Without this check a mushy icon
  // renders, ships and looks almost right.
  assert.match(script, /outside the source artwork/);
  assert.match(script, /assets[/\\]icon\.svg|'icon\.svg'/);
  // The exemption that used to exist for antialiased corner arcs is gone, because the artwork
  // carries its own bevel and nothing is rounded in CSS. If a slack band comes back, the strict
  // no-new-colours rule has been weakened and this should be reconsidered rather than silently so.
  assert.doesNotMatch(script, /cornerSlack/);
});

// macOS 26 (Tahoe) draws every app icon inside its own rounded-square container and clips the
// supplied artwork to it, the way iOS always has. The rasters used to be a 0.75 tile floating in a
// transparent margin, which was right through macOS 15 and is exactly what Tahoe wraps in a grey
// frame — the owner's report was "mac app icon doesn't fill". These two tests pin the fix at the
// level it actually fails: a transparent pixel anywhere in a macOS raster is a hole the Dock shows
// grey through, and it is invisible in every build log.
/**
 * Read one of the generated icons back through the generator's own decoder. Using the same module
 * the generator verifies with means one decoder rather than two that could drift apart.
 */
function pixels(rel: string): { width: number; height: number; px: Buffer } {
  return decodePNG(root + 'safari/App/Assets.xcassets/AppIcon.appiconset/' + rel);
}

/** How many pixels in a raster are fully transparent. */
function transparentCount(im: { width: number; height: number; px: Buffer }): number {
  let n = 0;
  for (let i = 0; i < im.width * im.height; i++) if (colourKey(im.px, i * 4) === 'transparent') n++;
  return n;
}

test('every macOS raster is opaque edge to edge', () => {
  const dir = root + 'safari/App/Assets.xcassets/AppIcon.appiconset/';
  const macs = readdirSync(dir).filter((f) => f.startsWith('mac-') && f.endsWith('.png'));
  assert.ok(macs.length >= 7, `expected every macOS raster, found ${macs.length}`);

  for (const file of macs) {
    const transparent = transparentCount(pixels(file));
    assert.equal(
      transparent,
      0,
      `${file} has ${transparent} transparent pixel(s); macOS 26 masks the icon itself and shows ` +
        'its own grey frame through any gap, which is the bug this replaced',
    );
  }
});

test('the iOS raster stays full bleed with its bevel corners clear', () => {
  // iOS is NOT given the macOS treatment: its superellipse mask cuts further in than the artwork's
  // pixel-art bevel, so those four corner blocks are never seen and painting them would be filling
  // in pixels nobody looks at. The corners staying transparent is what says the two platforms are
  // still rendered differently on purpose.
  const im = pixels('ios-1024.png');
  assert.ok(transparentCount(im) > 0, 'the iOS icon lost its bevel corners');
  assert.equal(colourKey(im.px, 0), 'transparent', 'the top-left bevel block should be transparent');
  // But the edges between the bevels must be opaque tile, or it is not full bleed at all.
  assert.notEqual(
    colourKey(im.px, (im.width / 2) * 4),
    'transparent',
    'the iOS icon is not full bleed along its top edge',
  );
});
