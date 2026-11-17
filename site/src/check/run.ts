// Runs one page's check for one URL: a load without the script (baseline), then a load with it
// (actions, expect, intact). Each load gets a fresh logged-out context.

import type { Browser, BrowserContext, Frame, Page } from 'playwright';
import { buildInjection, ERROR_SLOT, type ScriptMeta } from './userscript.ts';
import type { CheckResult } from './records.ts';

export interface CheckSpec {
  urls: string[];
  loggedOut: true;
  waitFor?: string;
  settleMs: number;
  baseline: string;
  expect: string;
  intact: string;
  actions?: string;
}

export interface LoadReport {
  finalUrl: string;
  title: string;
  consent?: string;
  wall?: string;
  waitForFound?: boolean;
  scriptError?: string;
  values: Record<string, unknown>;
  error?: string;
}

export interface UrlOutcome {
  url: string;
  result: CheckResult;
  note?: string;
  plain: LoadReport;
  withScript?: LoadReport;
}

export interface RunOptions {
  timeoutMs: number;
  userAgent: string;
  screenshotTo?: (name: string, png: Buffer) => void;
}

export const VIEWPORT = { width: 1366, height: 900 };

export function desktopChromeUA(browserVersion: string): string {
  const major = browserVersion.split('.')[0] ?? '0';
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Consent screens (Google, YouTube and most CMPs): click "Reject all" when offered, else "Accept all".
const CONSENT_LABELS = [/^reject all$/i, /^accept all$/i, /^i agree$/i, /^accept$/i, /^agree$/i];

// Errors Playwright throws when the page navigates under a call: a frame it was reading from is
// detached, or the document it was evaluating in is replaced. Etsy's DataDome check reloads the
// page shortly after the first load, often while consent dismissal is scanning its frames.
const NAVIGATED = /Frame was detached|frame got detached|Execution context was destroyed/i;

// Runs fn; if the page navigated during it, waits for the new document and runs fn once more.
async function acrossReload<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!NAVIGATED.test((e as Error).message)) throw e;
    await page.waitForLoadState('domcontentloaded');
    return fn();
  }
}

function dismissConsent(page: Page): Promise<string | undefined> {
  return acrossReload(page, () => clickConsent(page));
}

async function clickConsent(page: Page): Promise<string | undefined> {
  for (const label of CONSENT_LABELS) {
    for (const frame of page.frames()) {
      const button = frame.getByRole('button', { name: label }).first();
      let text: string;
      try {
        if ((await button.count()) === 0 || !(await button.isVisible())) continue;
        text = (await button.innerText()).trim();
      } catch (e) {
        // A frame removed mid-scan (an ad slot, or every subframe when the top page reloads) has
        // no button to click. Let a reload finish, then go on with the frames that remain.
        if (frame === page.mainFrame() || !frame.isDetached()) throw e;
        await page.waitForLoadState('domcontentloaded');
        continue;
      }
      await button.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1500);
      return text;
    }
  }
  return undefined;
}

// Walls that make a load "blocked": captchas, bot walls, login walls.
const WALL_TEXT = /unusual traffic|are you a robot|verify you are (a )?human|blocked by network security|press (&|and) hold|checking your browser|sign in to continue|log in to continue/i;

async function detectWall(page: Page): Promise<string | undefined> {
  const url = page.url();
  if (/\/sorry\/|captcha|\/login\b|accounts\.google\.com|\/signin/i.test(url)) return `wall url ${url}`;
  const frames: Frame[] = page.frames();
  if (frames.some((f) => /recaptcha|hcaptcha|challenges\.cloudflare|captcha-delivery/i.test(f.url()))) return 'captcha frame';
  const text = await page.evaluate('(document.body && document.body.innerText || "").slice(0, 4000)') as string;
  const m = WALL_TEXT.exec(text);
  return m ? `wall text "${m[0]}"` : undefined;
}

function wallKind(wall: string): string {
  return wall.startsWith('wall url') ? 'url' : wall.startsWith('wall text') ? 'text' : wall;
}

async function evalBool(page: Page, expr: string): Promise<boolean> {
  return (await page.evaluate(`(async () => Boolean(await (${expr})))()`)) as boolean;
}

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout();
      reject(new Error(`timed out after ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function load(
  browser: Browser,
  url: string,
  spec: CheckSpec,
  opts: RunOptions,
  label: string,
  script: { source: string; meta: ScriptMeta } | undefined,
  probes: Record<string, string>,
): Promise<LoadReport> {
  const context: BrowserContext = await browser.newContext({ userAgent: opts.userAgent, viewport: VIEWPORT, locale: 'en-US' });
  const report: LoadReport = { finalUrl: url, title: '', values: {} };
  const work = async () => {
    if (script) await context.addInitScript({ content: buildInjection(script.source, script.meta) });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
      const consent = await dismissConsent(page);
      if (consent) report.consent = consent;
      if (spec.waitFor) {
        report.waitForFound = await page
          .waitForSelector(spec.waitFor, { state: 'attached', timeout: opts.timeoutMs / 2 })
          .then(() => true, () => false);
      }
      await page.waitForTimeout(spec.settleMs);
      report.finalUrl = page.url();
      report.title = await acrossReload(page, () => page.title());
      const wall = await acrossReload(page, () => detectWall(page));
      if (wall) report.wall = wall;
      if (spec.actions) await page.evaluate(`(async () => { ${spec.actions}\n })()`);
      if (script) {
        const err = (await page.evaluate(`window.${ERROR_SLOT} || ''`)) as string;
        if (err) report.scriptError = err;
      }
      for (const [name, expr] of Object.entries(probes)) {
        report.values[name] = await evalBool(page, expr).catch((e: unknown) => `error: ${(e as Error).message.split('\n')[0]}`);
      }
      opts.screenshotTo?.(label, await page.screenshot());
    } finally {
      await context.close();
    }
  };
  await withDeadline(work(), opts.timeoutMs, () => context.close().catch(() => {})).catch((e: unknown) => {
    report.error = (e as Error).message.split('\n')[0];
  });
  return report;
}

export async function checkUrl(
  browser: Browser,
  url: string,
  spec: CheckSpec,
  script: { source: string; meta: ScriptMeta },
  opts: RunOptions,
): Promise<UrlOutcome> {
  const plain = await load(browser, url, spec, opts, 'plain', undefined, { baseline: spec.baseline });
  const blocked = (note: string): UrlOutcome => ({ url, result: 'blocked', note, plain });
  if (plain.error) return blocked(`load without script: ${plain.error}`);
  if (plain.values['baseline'] !== true) {
    const why = plain.wall ?? (plain.waitForFound === false ? `waitFor ${spec.waitFor} never appeared` : `baseline was ${String(plain.values['baseline'])}`);
    return blocked(`target not present without the script (${why})`);
  }
  const withScript = await load(browser, url, spec, opts, 'script', script, { expect: spec.expect, intact: spec.intact });
  const out = (result: CheckResult, note?: string): UrlOutcome => ({ url, result, plain, withScript, ...(note ? { note } : {}) });
  if (withScript.error) return out('blocked', `load with script: ${withScript.error}`);
  if (withScript.scriptError) return out('fail', `script threw: ${withScript.scriptError.split('\n')[0]}`);
  const failed = (['expect', 'intact'] as const).filter((k) => withScript.values[k] !== true);
  if (failed.length > 0) {
    // A wall blocks only if the plain load, which passed its baseline, did not show the same kind
    // of wall. Reddit carries a reCAPTCHA iframe on every load; that must not turn a fail into blocked.
    if (withScript.wall && wallKind(withScript.wall) !== (plain.wall && wallKind(plain.wall))) {
      return out('blocked', `with script: ${withScript.wall}`);
    }
    return out('fail', failed.map((k) => `${k} was ${String(withScript.values[k])}`).join(', '));
  }
  return out('pass');
}
