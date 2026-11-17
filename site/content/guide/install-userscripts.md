# Installing .user.js scripts and Greasy Fork links

usermods installs ordinary userscripts. Click a `.user.js` link (on Greasy Fork, OpenUserJS, a gist or GitHub raw) and usermods opens its own install page with a preview, the way Tampermonkey does. Nothing is saved until you confirm.

## Three ways to install

- **Click a `.user.js` link.** usermods redirects the navigation to its install page, which shows the script's name, version, the sites it matches, the `GM_*` permissions it asks for, the `@connect` hosts it may contact, the libraries it loads, and the full source. Only `http` and `https` addresses are accepted, and the page shows the exact URL it will fetch.
- **Install from URL.** In the **Mods** tab, paste a `.user.js` address into **Install from URL** and click **Fetch**. You get the same preview.
- **Import a file.** **Import file** in the Mods tab takes a `.user.js` file from disk, through the same preview.

![The install page previewing a Greasy Fork script with its matches, permissions and required library](/assets/guide/05-install.png)

## The install banner

Some pages offer a script without a `.user.js` link: a gist, a GitHub file page, or a script shown as plain text. On those, usermods shows a slim bar at the top of the page with an **Install** button that opens the same preview. On Greasy Fork and OpenUserJS script pages, the bar appears only when you already have that script and the page has a newer version. If the script is installed, the bar says **Installed** or offers the update. The close button hides it for that page. The banner never installs anything by itself and makes no network request.

![A raw userscript with the usermods install bar at the top](/assets/guide/16-install-banner.png)

## Libraries and resources

`@require` libraries and `@resource` files are downloaded at install time and stored with the mod. If one of those downloads fails, the install fails and names the URL.

## Already installed

A script you already have is recognised by its `@downloadURL`, or by `@name` and `@namespace` together. Installing it again updates your copy in place instead of adding a second one.

## One-click installs from this site

Every script on this site links to its `.user.js` file, so with usermods (or Tampermonkey) installed, **Install this script** opens the preview. Each script names its own address as its `@downloadURL`, so your copy gets [update checks](/guide/updates) when the script here changes.
