# Security Policy

usermods runs user-supplied JavaScript in the browser and holds the user's API keys. That makes a
handful of boundaries worth guarding closely, and worth reporting on carefully. Thank you for
looking.

## Reporting a vulnerability

**Report privately, through GitHub.** Go to the
[Security tab](https://github.com/kballenegger/usermods/security/advisories) of the repository and
click **Report a vulnerability**. That opens a private security advisory, visible only to you and
the maintainer, with a place to discuss a fix and to get a CVE if one is warranted.

Please do not open a public issue, a pull request or a discussion for something exploitable. A
public issue is the right place for a hardening idea that is not itself exploitable — say it plainly
and it will be treated as an ordinary bug.

A useful report says what an attacker controls, what they get, and how you know. Concretely:

- The version or commit you tested, your Chrome version, and which build (the GitHub build or the
  Chrome Web Store build — they differ, see below).
- The smallest thing that demonstrates it: a page, a userscript, an install URL, a sequence of
  clicks.
- What the attacker has to start with. "Any website the user visits" and "a script the user chose
  to install" are very different starting points.
- What is gained: the API key, storage belonging to another script, execution in a privileged
  context, a request the user did not authorize.

## Scope

In scope, roughly in order of how seriously it will be taken:

- **Script execution boundaries.** A page escaping into the extension's context; a userscript
  reaching another script's `GM_setValue` store or the user's provider settings; code reaching a
  privileged world it was not granted. Note that `@grant none` and `unsafeWindow` scripts run in the
  page's MAIN world *by design* and share globals with the page — that is what those scripts ask
  for, and it is documented. A script escaping the isolated `USER_SCRIPT` world into the extension
  is not by design.
- **The install page.** `entrypoints/install/` and `lib/installurl.ts`. Anything that makes the page
  fetch, preview or save a script other than the one whose URL it displays, or that gets a
  non-`http(s)` URL past `isInstallableUrl`, or that installs without the preview and the user's
  click.
- **The GM API host.** `lib/gm.ts` and `lib/connect.ts`. Bypassing `@connect` so
  `GM_xmlhttpRequest` reaches a host the script never declared; reading or writing values across
  script boundaries; abusing `@require`/`@resource` fetching at install time.
- **Token and key storage.** `lib/settings.ts`, `lib/oauth.ts`. Anything that sends the user's API
  key or subscription tokens somewhere other than the endpoint they configured, or exposes them to a
  page, a content script or an installed userscript.
- **The agent loop and its tools.** Page content is untrusted input to a model. A page that talks
  the model into running a script is a prompt-injection problem and is interesting to the extent it
  reaches something the user did not approve — the proposal and save steps are the guardrail, so a
  path that skips them matters much more than one that produces a bad suggestion.

Out of scope:

- **A userscript the user installed doing what userscripts do.** Installed scripts are code the user
  chose to run, previewed before saving, with their grants and `@connect` hosts shown. A malicious
  script on Greasy Fork is a reason to read scripts before installing them, not a vulnerability here.
- **Broad host permissions.** `<all_urls>` is inherent to a userscript manager; see
  [docs/store/permissions.md](docs/store/permissions.md).
- **Page content reaching the configured model endpoint.** That is the entire feature, disclosed in
  the first-run notice and in [PRIVACY.md](PRIVACY.md).
- **"Allow User Scripts" being required.** That is Chrome's toggle, not usermods'.
- Findings in Chrome itself, in your model provider, or in a script's own remote server.
- Reports with no demonstrated impact: version-number banners, missing headers on pages that are not
  served, automated-scanner output pasted without analysis.

## Supported versions

This is a young project with one maintainer. Only the **latest release, and `main`**, are supported.
Fixes go to `main` and into the next release; there are no backports to older tags.

The Chrome Web Store build (`npm run build:store`) omits subscription sign-in and tree-shakes
`lib/oauth.ts` out of the bundle entirely, so findings in the OAuth flow apply to the GitHub build
only. Please say which build you tested.

## What to expect

usermods is maintained by one person as a side project, so please calibrate accordingly. The honest
commitment is:

- **An acknowledgement within about a week.** If you have heard nothing after two weeks, a nudge on
  the advisory thread is welcome and will not annoy anyone.
- **An assessment** — whether it is in scope, and how serious it looks — once the report has been
  reproduced.
- **A fix as soon as it is practical**, prioritized by severity. Something that leaks keys or escapes
  the script sandbox gets dropped-everything treatment. Lesser things get fixed in the normal flow of
  work.
- **Credit in the advisory and the release notes**, under whatever name you prefer, unless you would
  rather not be named.

There is no bug bounty. Nobody is paid to work on this.

Please give a reasonable window to ship a fix before publishing. If you would like to disclose on a
particular date, say so in the report and it will be worked to.

## Anything already known

Two properties are deliberate, documented, and not secretly being treated as bugs:

- MAIN-world scripts (`@grant none`, `unsafeWindow`) share globals with the page, and their
  `GM_setValue` writes cannot be persisted. Mod cards and the install preview mark them.
- Installed scripts run with the grants their header declares, after the user sees them in the
  preview.

If you think either of those is worse than the README claims, that is a legitimate report — say why.
