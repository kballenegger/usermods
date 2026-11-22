# Migrating from Tampermonkey

To move your Tampermonkey scripts to usermods, export a backup from Tampermonkey's Utilities tab and pick that file under **Migrate from Tampermonkey** in usermods' Mods tab. Each script comes across with its on/off state, its stored values and its update URL.

## Steps

1. Open the Tampermonkey dashboard: its toolbar icon, then **Dashboard**.
2. Go to the **Utilities** tab.
3. Under **File**, click **Export** to save the backup (`.zip` or `.json`).
4. In usermods, open the **Mods** tab, expand **Migrate from Tampermonkey**, and pick that file.

Chrome extensions cannot read each other's storage, which is why the migration goes through Tampermonkey's export file.

![The Migrate from Tampermonkey card with the four export steps](/assets/guide/06-migrate.png)

## What comes across

- Both export formats: the JSON document and the ZIP (one `.user.js` per script with its options and storage files, or the older JSON-in-`.txt` entries).
- Each script's enabled or disabled state.
- Its `GM_setValue` store.
- Its update URL, so [update checks](/guide/updates) keep working.

## Scripts you already have

A script already in usermods is matched by its `@downloadURL`, or by `@namespace` and `@name` when it has none. A newer version updates the existing mod in place, keeping its id and stored values, with the backup's values merged over the top. The import reports how many scripts came in, how many were updated, and what it could not read.

## After migrating

Most scripts run unchanged. A few Tampermonkey features are stubs or missing in usermods (menu commands, desktop notifications, `GM_download`, `GM_cookie`, `GM_webRequest`). [GM API support](/guide/gm-api) has the full table. Once you have checked your scripts, turn them off in Tampermonkey so the two do not both run on the same pages.
