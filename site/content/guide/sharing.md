# Sharing a mod: export, gist, Greasy Fork

Every usermods mod has an **Export** menu with four options: download the `.user.js` file, copy it to the clipboard, share it as a GitHub gist, or publish it on Greasy Fork. For gists and Greasy Fork, usermods fills in the site's form in your own signed-in tab and you press the site's button.

![A mod's Export menu: Download .user.js, Copy to clipboard, Share as Gist, Publish on Greasy Fork](/assets/guide/14-export-menu.png)

## Download or copy

- **Download .user.js** saves the file, named after the mod.
- **Copy to clipboard** copies the whole script, header included.
- The [dashboard](/guide/dashboard) can export several mods at once as a zip.

## Before anything opens: the secrets check

Before a gist or Greasy Fork page opens, usermods scans the script for things that should not be published: API keys, access tokens, hard-coded `apiKey` values, private network addresses, internal host names and `localhost` ports. If it finds any, it lists them, masked, with **Share anyway** and **Cancel**. The check runs on your device and sends nothing.

## Share as a gist

**Share as Gist** opens gist.github.com and fills in the file name, description and script. A usermods bubble points at the save button: **Create secret gist** keeps it unlisted (anyone with the link can read it), **Create public gist** also lists it on your profile.

![GitHub's new-gist form filled with a userscript and a usermods bubble pointing at the save button](/assets/guide/15-share-hint.png)

Once saved, usermods points the mod's `@updateURL` and `@downloadURL` at the gist's raw link, which always serves the newest version. That link is the install link shown on the mod's card. Anyone who opens it gets the usermods or Tampermonkey install page, and their copy updates from the gist. Later, **Update gist** bumps the version and fills the gist's edit page.

## Publish on Greasy Fork

**Publish on Greasy Fork** opens its new-script form. Greasy Fork requires a `@license`; if the mod has none, the panel asks before adding `@license MIT`. The code box is filled and the bubble points at **Post script**. After that, the menu item becomes **Post new version on Greasy Fork**. If the mod also has a gist, Greasy Fork can sync from the gist's raw link so new versions post themselves.

## What usermods does not do

usermods has no GitHub or Greasy Fork token and asks for none. It never presses the save button. Everything on Greasy Fork is public.
