# Updates and reviewed updates

usermods checks installed scripts that have an `@updateURL` or `@downloadURL` for newer versions at most once a day, but never installs an update by itself. When one exists, you review what changed, including any new permissions and a code diff, and install it or skip it.

## When checks run

Checks run when the side panel or the dashboard opens and when the browser starts, at most once a day per mod. A check fetches the script's `@updateURL` (usually a small `.meta.js` header) and downloads the full script only if that shows a newer `@version`. Older versions are never offered. A check that fails, for example offline or on a 404, leaves a quiet "could not check" note on the row.

## Reviewing an update

When a newer version exists, the mod's row says **Update available** with the version, and the Mods tab shows a count. Opening it shows the review screen:

![The Review update screen with permission changes, a safety review and the code diff](/assets/guide/17-update-review.png)

- **What changed in its powers**: sites added or removed, new permissions such as `GM_xmlhttpRequest` or `unsafeWindow`, new `@connect` hosts, new `@require` or `@resource` URLs, and `@run-at` or frame changes.
- **Code changes**: a line diff between your version and the new one.
- **Install update** installs exactly the text shown, keeping the mod's settings and stored values. **Not now** closes the screen. **Skip this version** hides that version until a newer one appears.

## Check with the agent first

**Check with the agent first** asks the model you last used to review the update for risky changes: data sent somewhere new, cookies or storage read, input recorded, remote code, wider site matches, mining, ad injection, safeguards removed. It sends only the two versions of the script and the header changes, nothing from any page and no chat. The answer is a verdict (looks safe, review carefully, do not install), a summary and findings with line numbers. It is advice; the decision is yours. The review is kept for that version.

## Turning checks off

Turn off **Check installed mods for updates** in Settings, under Preferences. There is no option to install updates automatically.
