---
usermods-skill: 1
name: Album download links
description: Loads every photo in an album and collects the download links.
version: 1.0.0
match:
  - "*://photos.example.com/*"
start: https://photos.example.com/albums/
inputs: {}
outputs:
  links: { label: Download links, list: true }
---

# Album download links

Loads every photo in an album and collects the download links.
Made with usermods on 2026-11-02 from a run on photos.example.com.

```steps
- click: button "Load more"
  at: { css: "#load", in: 'main "Album"' }
  repeat: 50
  why: load every photo in the album
- wait: { idle: true, quiet_ms: 300 }
- read: links
  from: a.photo-download
  take: href
  each: true
```
