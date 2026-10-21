#!/usr/bin/env node
// Fill in and submit the iOS App Store record through the App Store Connect API, from the files in
// docs/store/appstore/, so the submission is the reviewed text and images and not a paste.
//
//   node scripts/appstore-connect.mjs status     the record, the iOS version, the builds, what is set
//   node scripts/appstore-connect.mjs prepare    version string, build, copy, screenshots, review
//                                                notes, manual release: everything but Submit
//   node scripts/appstore-connect.mjs submit     add the version to a review submission and submit it
//
// Flags: --replace-screenshots (delete what the sets hold and upload again), --env <file>.
//
// ---------------------------------------------------------------------------
// Credentials and the two secrets the notes need
// ---------------------------------------------------------------------------
//
// Nothing here is in the repository. One env file, by default ~/.config/usermods/appstore.env,
// KEY=VALUE per line, holds all of it (the environment overrides any line):
//
//   ASC_KEY_PATH=/Users/you/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
//   ASC_KEY_ID=XXXXXXXXXX
//   ASC_ISSUER_ID=<issuer id>            App Store Connect > Users and Access > Integrations
//   REVIEW_BASE_URL=https://...          the reviewer's model endpoint (fills <BASE_URL> in the notes)
//   REVIEW_API_KEY=...                   its key (fills <API_KEY>)
//   CONTACT_FIRST_NAME=..., CONTACT_LAST_NAME=..., CONTACT_PHONE=+..., CONTACT_EMAIL=...
//
// The API key needs the App Manager role (or Admin) to write to the record; the Developer role
// can notarize and read but not change a version. The script never prints a secret: the notes are
// sent, not shown, and `status` reports only whether the notes field is filled.
//
// ---------------------------------------------------------------------------
// What the record needs before Submit, and where each thing comes from
// ---------------------------------------------------------------------------
//
//   version string           package.json "version"; the record was created as 1.0 and is renamed
//   build                    the processed build whose CFBundleShortVersionString is that version
//                            and CFBundleVersion is USERMODS_BUILD_NUMBER (Shared.xcconfig); it
//                            has to have finished processing (TestFlight > iOS builds shows it)
//   export compliance        ITSAppUsesNonExemptEncryption=false in the Info.plist answers it; if
//                            Apple still asks, the build is marked exempt here
//   copy                     docs/store/appstore/listing.md, the fenced blocks under Promotional
//                            text, Description, Keywords, What's New, Copyright, and the URLs
//   screenshots              docs/store/appstore/screenshots/iphone-*.png into the iPhone 6.7"/6.9"
//                            set, ipad-*.png into the iPad 13" set, in filename order
//   review information       docs/store/appstore/reviewer-notes.md, the fenced block under Notes,
//                            with the two placeholders filled from the env file; contact from
//                            the env file; sign-in required: no
//   release                  manual, so approval does not publish before the announcement
//
// Categories, subtitle, pricing, availability, age rating and the privacy answers were set when
// the record was created and are reported by `status`, not changed here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.appstoreconnect.apple.com';
const BUNDLE_ID = 'com.kballenegger.usermods';
const storeDir = path.join(root, 'docs', 'store', 'appstore');
const screenshotDir = path.join(storeDir, 'screenshots');
// Apple's display types: the 6.7" set takes the 6.9" sizes (1320x2868), and the 12.9" 3rd-gen
// iPad set takes the 13" sizes (2064x2752).
const SETS = [
  { type: 'APP_IPHONE_67', prefix: 'iphone-', label: 'iPhone 6.9"' },
  { type: 'APP_IPAD_PRO_3GEN_129', prefix: 'ipad-', label: 'iPad 13"' },
];

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith('-')) ?? 'status';
const has = (name) => argv.includes(`--${name}`);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

function fail(message, hint) {
  console.error(`appstore-connect: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function loadEnv() {
  const file = flag('env', path.join(os.homedir(), '.config', 'usermods', 'appstore.env'));
  const values = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  for (const k of Object.keys(process.env)) if (/^(ASC_|REVIEW_|CONTACT_)/.test(k)) values[k] = process.env[k];
  const need = ['ASC_KEY_PATH', 'ASC_KEY_ID', 'ASC_ISSUER_ID'];
  const missing = need.filter((k) => !values[k]);
  if (missing.length) fail(`${missing.join(', ')} not set`, `Put them in ${file} (see the header of this script) or in the environment.`);
  values.ASC_KEY_PATH = values.ASC_KEY_PATH.replace(/^~/, os.homedir());
  if (!fs.existsSync(values.ASC_KEY_PATH)) fail(`no key at ${values.ASC_KEY_PATH}`);
  return values;
}

const env = loadEnv();
const privateKey = fs.readFileSync(env.ASC_KEY_PATH, 'utf8');

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

let tokenValue = null;
let tokenAt = 0;
function token() {
  if (tokenValue && Date.now() - tokenAt < 15 * 60 * 1000) return tokenValue;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' })}.${b64({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' })}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  tokenValue = `${signingInput}.${signature.toString('base64url')}`;
  tokenAt = Date.now();
  return tokenValue;
}

async function api(method, pathOrUrl, body) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

async function must(method, p, body) {
  const { status, json } = await api(method, p, body);
  if (status < 200 || status >= 300) {
    const errors = (json.errors ?? []).map((e) => `${e.status} ${e.code}: ${e.title}${e.detail ? ` (${e.detail})` : ''}`).join('\n  ');
    fail(`${method} ${p} answered ${status}`, errors || JSON.stringify(json).slice(0, 600));
  }
  return json;
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

/** The first fenced block after a `## heading` in a markdown file. */
function fenced(markdown, heading) {
  const start = markdown.indexOf(`\n## ${heading}`);
  if (start === -1) fail(`no "## ${heading}" section`);
  const open = markdown.indexOf('\n```', start);
  const close = markdown.indexOf('\n```', open + 4);
  if (open === -1 || close === -1) fail(`no fenced block under "## ${heading}"`);
  return markdown.slice(markdown.indexOf('\n', open + 1) + 1, close).replace(/\n+$/, '');
}

function listing() {
  const md = fs.readFileSync(path.join(storeDir, 'listing.md'), 'utf8');
  const urls = {};
  const section = md.slice(md.indexOf('\n## URLs'), md.indexOf('\n## ', md.indexOf('\n## URLs') + 5));
  for (const line of section.split('\n')) {
    const url = /https?:\/\/[^\s`)>|]+/.exec(line)?.[0];
    if (!url) continue;
    const label = line.toLowerCase();
    if (label.includes('privacy')) urls.privacy = url;
    else if (label.includes('marketing')) urls.marketing = url;
    else if (label.includes('support')) urls.support = url;
  }
  const copy = {
    promotionalText: fenced(md, 'Promotional text'),
    description: fenced(md, 'Description'),
    keywords: fenced(md, 'Keywords').replace(/\s*\n\s*/g, ''),
    whatsNew: fenced(md, "What's New in This Version"),
    copyright: fenced(md, 'Copyright'),
    supportUrl: urls.support,
    marketingUrl: urls.marketing,
  };
  const limits = { promotionalText: 170, description: 4000, keywords: 100, whatsNew: 4000 };
  for (const [k, max] of Object.entries(limits)) {
    if (copy[k].length > max) fail(`${k} is ${copy[k].length} characters; Apple's limit is ${max}`);
  }
  if (!copy.supportUrl) fail('no support URL in listing.md under URLs');
  return copy;
}

/**
 * The review information, or null with a printed reason when the env file lacks the endpoint, the
 * key or the contact. `prepare` then does everything else and says what is left, so the record can
 * be filled in two sittings without anything being done twice.
 */
function reviewNotes() {
  const md = fs.readFileSync(path.join(storeDir, 'reviewer-notes.md'), 'utf8');
  let notes = fenced(md, 'Notes');
  const contact = {
    contactFirstName: env.CONTACT_FIRST_NAME,
    contactLastName: env.CONTACT_LAST_NAME,
    contactPhone: env.CONTACT_PHONE,
    contactEmail: env.CONTACT_EMAIL,
  };
  const missing = [
    ...['REVIEW_BASE_URL', 'REVIEW_API_KEY'].filter((k) => !env[k]),
    ...['CONTACT_FIRST_NAME', 'CONTACT_LAST_NAME', 'CONTACT_PHONE', 'CONTACT_EMAIL'].filter((k) => !env[k]),
  ];
  if (missing.length) {
    console.log(`review     skipped: ${missing.join(', ')} not in the env file (see the header of this script)`);
    return null;
  }
  notes = notes.replaceAll('<BASE_URL>', env.REVIEW_BASE_URL).replaceAll('<API_KEY>', env.REVIEW_API_KEY);
  const left = notes.match(/<[A-Z_ ]+>/g);
  if (left) fail(`placeholders left in the notes: ${left.join(', ')}`);
  if (notes.length > 4000) fail(`the notes are ${notes.length} characters; Apple's limit is 4000`);
  return { ...contact, demoAccountRequired: false, notes };
}

function version() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const xcconfig = fs.readFileSync(path.join(root, 'safari', 'Config', 'Shared.xcconfig'), 'utf8');
  const marketing = /^USERMODS_MARKETING_VERSION = (\S+)$/m.exec(xcconfig)?.[1];
  const build = /^USERMODS_BUILD_NUMBER = (\S+)$/m.exec(xcconfig)?.[1];
  if (marketing !== pkg) fail(`package.json says ${pkg} but Shared.xcconfig says ${marketing}`);
  return { string: pkg, build };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

async function app() {
  const j = await must('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=name,bundleId,sku,primaryLocale,contentRightsDeclaration`);
  if (!j.data.length) fail(`no app record for ${BUNDLE_ID}`);
  return j.data[0];
}

async function iosVersion(appId) {
  const j = await must('GET', `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=10`);
  // The editable one: whatever is not yet live or rejected for good.
  const editable = j.data.filter((v) => !/READY_FOR_SALE|REPLACED_WITH_NEW_VERSION|REMOVED_FROM_SALE/.test(v.attributes.appStoreState ?? ''));
  if (!editable.length) fail('no editable iOS version on the record');
  return editable[0];
}

async function builds(appId, v) {
  const j = await must('GET', `/v1/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${v.string}&sort=-uploadedDate&limit=20&fields[builds]=version,processingState,uploadedDate,usesNonExemptEncryption,expired`);
  return j.data;
}

async function localization(versionId) {
  const j = await must('GET', `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`);
  const loc = j.data.find((l) => l.attributes.locale === 'en-US') ?? j.data[0];
  if (!loc) fail('the version has no localization');
  return loc;
}

async function screenshotSets(locId) {
  const j = await must('GET', `/v1/appStoreVersionLocalizations/${locId}/appScreenshotSets?include=appScreenshots&limit=50`);
  return j;
}

async function reviewDetail(versionId) {
  const { status, json } = await api('GET', `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`);
  return status === 200 ? json.data : null;
}

function describeBuild(b) {
  const a = b.attributes;
  return `build ${a.version}  ${a.processingState}  uploaded ${a.uploadedDate}  exempt encryption: ${a.usesNonExemptEncryption === null ? 'unanswered' : !a.usesNonExemptEncryption}${a.expired ? '  EXPIRED' : ''}`;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function status() {
  const a = await app();
  const v = version();
  console.log(`app        ${a.attributes.name}  ${a.id}  sku ${a.attributes.sku}  content rights: ${a.attributes.contentRightsDeclaration ?? 'unanswered'}`);
  const ver = await iosVersion(a.id);
  console.log(`iOS        ${ver.attributes.versionString}  ${ver.attributes.appStoreState}  release: ${ver.attributes.releaseType ?? 'unset'}  (the checkout is ${v.string} (${v.build}))`);
  const bs = await builds(a.id, v);
  if (!bs.length) console.log(`builds     none for ${v.string} yet (processing takes a few minutes after an upload)`);
  for (const b of bs) console.log(`           ${describeBuild(b)}`);
  const attached = await api('GET', `/v1/appStoreVersions/${ver.id}/build`);
  console.log(`attached   ${attached.json.data ? `build ${attached.json.data.attributes?.version ?? attached.json.data.id}` : 'no build selected'}`);
  const loc = await localization(ver.id);
  const la = loc.attributes;
  console.log(`copy       ${la.locale}: description ${la.description ? la.description.length : 0} chars, keywords ${la.keywords ? la.keywords.length : 0}, promo ${la.promotionalText ? la.promotionalText.length : 0}, what's new ${la.whatsNew ? la.whatsNew.length : 0}, support ${la.supportUrl ?? 'unset'}, marketing ${la.marketingUrl ?? 'unset'}`);
  const sets = await screenshotSets(loc.id);
  if (!sets.data.length) console.log('shots      no screenshot sets');
  for (const s of sets.data) {
    const n = (s.relationships?.appScreenshots?.data ?? []).length;
    console.log(`shots      ${s.attributes.screenshotDisplayType}: ${n} image${n === 1 ? '' : 's'}`);
  }
  const rd = await reviewDetail(ver.id);
  console.log(`review     ${rd ? `contact ${rd.attributes.contactFirstName ?? '?'} ${rd.attributes.contactLastName ?? '?'}, ${rd.attributes.contactEmail ?? 'no email'}, notes ${rd.attributes.notes ? `${rd.attributes.notes.length} chars` : 'empty'}` : 'no review information yet'}`);
  const subs = await api('GET', `/v1/reviewSubmissions?filter[app]=${a.id}&filter[platform]=IOS&limit=5`);
  for (const s of subs.json.data ?? []) console.log(`submission ${s.id}  ${s.attributes.state}  ${s.attributes.submittedDate ?? ''}`);
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

async function uploadScreenshot(setId, file) {
  const bytes = fs.readFileSync(file);
  const created = await must('POST', '/v1/appScreenshots', {
    data: {
      type: 'appScreenshots',
      attributes: { fileName: path.basename(file), fileSize: bytes.length },
      relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
    },
  });
  const shot = created.data;
  for (const op of shot.attributes.uploadOperations) {
    const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
    const res = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
    if (!res.ok) fail(`uploading ${path.basename(file)} part at ${op.offset} answered ${res.status}`);
  }
  await must('PATCH', `/v1/appScreenshots/${shot.id}`, {
    data: { type: 'appScreenshots', id: shot.id, attributes: { uploaded: true, sourceFileChecksum: crypto.createHash('md5').update(bytes).digest('hex') } },
  });
  // Wait for Apple to accept the asset, so a wrong size fails here and not at Submit.
  for (let i = 0; i < 60; i++) {
    const { json } = await api('GET', `/v1/appScreenshots/${shot.id}`);
    const state = json.data?.attributes?.assetDeliveryState;
    if (state?.state === 'COMPLETE') return shot.id;
    if (state?.state === 'FAILED') fail(`${path.basename(file)} was rejected: ${JSON.stringify(state.errors)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`${path.basename(file)} did not finish processing`);
}

async function prepare() {
  const a = await app();
  const v = version();
  const copy = listing();
  const review = reviewNotes();
  const files = fs.readdirSync(screenshotDir).filter((f) => f.endsWith('.png')).sort();
  for (const set of SETS) {
    if (!files.some((f) => f.startsWith(set.prefix))) fail(`no ${set.prefix}*.png in ${path.relative(root, screenshotDir)}`);
  }

  // 1. The version string, the release type, the copyright.
  const ver = await iosVersion(a.id);
  if (!/PREPARE_FOR_SUBMISSION|DEVELOPER_REJECTED|REJECTED|METADATA_REJECTED|INVALID_BINARY/.test(ver.attributes.appStoreState ?? '')) {
    fail(`the iOS version is ${ver.attributes.appStoreState}; it cannot be edited`);
  }
  await must('PATCH', `/v1/appStoreVersions/${ver.id}`, {
    data: { type: 'appStoreVersions', id: ver.id, attributes: { versionString: v.string, releaseType: 'MANUAL', copyright: copy.copyright } },
  });
  console.log(`version    ${ver.attributes.versionString} -> ${v.string}, manual release, copyright set`);

  // 2. The build: the processed one that matches the checkout.
  const bs = await builds(a.id, v);
  const build = bs.find((b) => b.attributes.version === v.build && !b.attributes.expired);
  if (!build) fail(`no build ${v.string} (${v.build}) on App Store Connect`, 'Upload it: node scripts/safari-xcode.mjs archive --team <id> --upload, then wait for processing.');
  if (build.attributes.processingState !== 'VALID') {
    fail(`build ${v.build} is ${build.attributes.processingState}`, build.attributes.processingState === 'PROCESSING' ? 'Wait a few minutes and run prepare again.' : 'Look at the build in App Store Connect; it was refused.');
  }
  if (build.attributes.usesNonExemptEncryption === null) {
    await must('PATCH', `/v1/builds/${build.id}`, { data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } } });
    console.log('build      marked as using only exempt encryption');
  }
  await must('PATCH', `/v1/appStoreVersions/${ver.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
  console.log(`build      ${v.string} (${v.build}) selected`);

  // 3. The copy.
  const loc = await localization(ver.id);
  const attributes = {
    description: copy.description,
    keywords: copy.keywords,
    promotionalText: copy.promotionalText,
    whatsNew: copy.whatsNew,
    supportUrl: copy.supportUrl,
    marketingUrl: copy.marketingUrl,
  };
  const patchCopy = () => api('PATCH', `/v1/appStoreVersionLocalizations/${loc.id}`, { data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes } });
  let copied = await patchCopy();
  // An app's first version has no What's New field: Apple answers 409 for the attribute rather
  // than ignoring it. Drop it and say so; the block in listing.md is for the second version.
  if (copied.status === 409 && JSON.stringify(copied.json).includes("'whatsNew'")) {
    delete attributes.whatsNew;
    copied = await patchCopy();
    console.log("copy       what's new left out: this is the app's first version and the field does not exist yet");
  }
  if (copied.status < 200 || copied.status >= 300) fail(`PATCH the localization answered ${copied.status}`, JSON.stringify(copied.json).slice(0, 600));
  console.log(`copy       ${loc.attributes.locale}: description ${copy.description.length}, keywords ${copy.keywords.length}, promo ${copy.promotionalText.length}${attributes.whatsNew ? `, what's new ${copy.whatsNew.length}` : ''}`);

  // 4. The screenshots.
  const existing = await screenshotSets(loc.id);
  for (const set of SETS) {
    let found = existing.data.find((s) => s.attributes.screenshotDisplayType === set.type);
    const held = found ? (found.relationships?.appScreenshots?.data ?? []) : [];
    const wanted = files.filter((f) => f.startsWith(set.prefix));
    if (found && held.length && !has('replace-screenshots')) {
      console.log(`shots      ${set.label}: ${held.length} already there (--replace-screenshots to redo)`);
      continue;
    }
    if (found && held.length) {
      for (const s of held) await must('DELETE', `/v1/appScreenshots/${s.id}`);
    }
    if (!found) {
      const made = await must('POST', '/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: set.type },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: loc.id } } },
        },
      });
      found = made.data;
    }
    const ids = [];
    for (const f of wanted) {
      ids.push(await uploadScreenshot(found.id, path.join(screenshotDir, f)));
      console.log(`shots      ${set.label}: ${f}`);
    }
    await must('PATCH', `/v1/appScreenshotSets/${found.id}/relationships/appScreenshots`, { data: ids.map((id) => ({ type: 'appScreenshots', id })) });
  }

  // 5. The review information.
  if (review) {
    const rd = await reviewDetail(ver.id);
    if (rd) {
      await must('PATCH', `/v1/appStoreReviewDetails/${rd.id}`, { data: { type: 'appStoreReviewDetails', id: rd.id, attributes: review } });
    } else {
      await must('POST', '/v1/appStoreReviewDetails', {
        data: { type: 'appStoreReviewDetails', attributes: review, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: ver.id } } } },
      });
    }
    console.log(`review     contact ${review.contactFirstName} ${review.contactLastName}, notes ${review.notes.length} chars, sign-in required: no`);
  }

  // 6. Content rights, which Submit asks for if it was never answered.
  if (!a.attributes.contentRightsDeclaration) {
    await must('PATCH', `/v1/apps/${a.id}`, { data: { type: 'apps', id: a.id, attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' } } });
    console.log('rights     declared: no third-party content');
  }

  console.log('');
  if (review) {
    console.log('prepared. Look at the record, then: node scripts/appstore-connect.mjs submit');
  } else {
    console.log('prepared except the review information. Fill the env file and run prepare again; it changes nothing twice.');
  }
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

async function submit() {
  const a = await app();
  const ver = await iosVersion(a.id);
  const attached = await api('GET', `/v1/appStoreVersions/${ver.id}/build`);
  if (!attached.json.data) fail('no build is selected for the version', 'Run prepare first.');
  // App Store Connect creates an empty review detail with the version, so the resource existing
  // proves nothing; the contact and the notes have to be in it or Apple answers 409 at Submit.
  const rd = await reviewDetail(ver.id);
  if (!rd?.attributes?.contactEmail || !rd?.attributes?.notes) {
    fail('the review information is empty (no contact or no notes)', 'Run prepare with REVIEW_* and CONTACT_* set; see the header of this script.');
  }

  const open = await api('GET', `/v1/reviewSubmissions?filter[app]=${a.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=5`);
  let submission = (open.json.data ?? []).find((s) => s.attributes.state === 'READY_FOR_REVIEW');
  if ((open.json.data ?? []).some((s) => /WAITING_FOR_REVIEW|IN_REVIEW/.test(s.attributes.state))) {
    fail('a submission is already waiting for or in review');
  }
  if (!submission) {
    const made = await must('POST', '/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: a.id } } } },
    });
    submission = made.data;
  }
  const items = await api('GET', `/v1/reviewSubmissions/${submission.id}/items`);
  const hasVersion = (items.json.data ?? []).some((i) => i.relationships?.appStoreVersion?.data?.id === ver.id);
  if (!hasVersion) {
    await must('POST', '/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: ver.id } },
        },
      },
    });
  }
  const done = await must('PATCH', `/v1/reviewSubmissions/${submission.id}`, {
    data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
  });
  console.log(`submitted  usermods ${ver.attributes.versionString} for iOS: submission ${done.data.id} is ${done.data.attributes.state}`);
  console.log('           App Review writes to the developer mailbox; a rejection is a message, not a dashboard alert.');
}

switch (command) {
  case 'status': await status(); break;
  case 'prepare': await prepare(); break;
  case 'submit': await submit(); break;
  default: fail(`unknown command "${command}"`, 'Try: status, prepare, submit');
}
