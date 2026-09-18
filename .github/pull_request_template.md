<!--
Thanks for the PR. Please fill in the two short sections below and run the four gates.
For anything with a design in it, an issue first is appreciated — see CONTRIBUTING.md.
-->

## What this changes

<!-- One or two sentences. What is different after this lands? -->

## Why

<!--
Why this way rather than the obvious alternative. If it fixes an issue, "Fixes #123" here closes
it automatically.
-->

## Gates

All four have to pass. If one cannot, say which and why below the list rather than leaving it
unticked in silence.

- [ ] `npx tsc --noEmit` is clean
- [ ] `npx wxt build` is clean
- [ ] `npm test` passes
- [ ] `npm run smoke` passes

## Tests

- [ ] **This fixes a bug, and there is a regression test that fails without the fix.** Name it:
      <!-- e.g. test/gm.test.ts, "persists writes from the page world" -->
- [ ] This adds a feature, and it is covered by tests where the logic can be reached from `test/`
- [ ] No test — this is docs, assets, or a change with no behaviour in it

<!--
A bug fix lands with a regression test. Node tests in test/ run without a browser, which is why the
pure logic lives in chrome-free modules. When a bug exists only in the wiring, extend the smoke run
in scripts/screenshots.mjs and say so here.
-->

## Checked by hand

<!--
Delete what does not apply. Which Chrome version, which provider, which pages.
-->

- Chrome version:
- Provider used:
- Tried it on:

## Anything a reviewer should know

<!--
Screenshots for UI changes. Follow-ups you deliberately left out. Parts you are unsure about —
saying so gets you a better review, not a worse one.
-->

- [ ] This touches the manifest, permissions, or what leaves the browser — if so, `PRIVACY.md`,
      `docs/store/permissions.md` and `docs/store/listing.md` have been checked for staleness
- [ ] This changes something the README describes, and the README has been updated
