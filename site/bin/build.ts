// node site/bin/build.ts [--content site/content] [--checks site/data/checks.json] [--out site/dist]
//                        [--guide-dates site/data/guide-dates.json] [--assets site/assets]
// node site/bin/build.ts --stamp-guide-dates   (stamps guide source dates from git, then exits)

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_ORIGIN, build, stampGuideDates } from '../src/build/build.ts';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    content: { type: 'string', default: resolve(siteDir, 'content') },
    checks: { type: 'string', default: resolve(siteDir, 'data/checks.json') },
    out: { type: 'string', default: resolve(siteDir, 'dist') },
    'guide-dates': { type: 'string', default: resolve(siteDir, 'data/guide-dates.json') },
    assets: { type: 'string', default: resolve(siteDir, 'assets') },
    'stamp-guide-dates': { type: 'boolean', default: false },
  },
});

if (values['stamp-guide-dates']) {
  const dates = stampGuideDates(values.content, values['guide-dates'], resolve(siteDir, '..'));
  for (const [slug, at] of Object.entries(dates)) console.log(`${slug} ${at}`);
} else {
  const { manifest, warnings } = build({
    content: values.content,
    checks: values.checks,
    out: values.out,
    guideDates: values['guide-dates'],
    assets: values.assets,
    origin: process.env.SITE_ORIGIN || DEFAULT_ORIGIN,
    commit: process.env.GIT_REVISION || 'dev',
  });
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(`built ${values.out}: ${manifest.counts.pages} indexable pages, ${manifest.counts.sites} sites, ` +
    `${Object.keys(manifest.pages).length} page routes, ${Object.keys(manifest.files).length} files`);
}
