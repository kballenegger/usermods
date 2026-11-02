---
usermods-skill: 1
name: Album download links
description: Loads the whole album and lists the download link of every photo.
namespace: kenneth
version: 1.0.0
match:
  - "*://photos.example.com/*"
start: https://photos.example.com/albums/
inputs: {}
outputs:
  links: { label: Download links, list: true }
---

# Album download links

```steps
- click: button "Load more"
  at: { css: button.load-more, in: 'main "Album"' }
  repeat: 50
  why: load every photo in the album
- wait: { idle: true, quiet_ms: 800 }
- read: links
  from: a.photo-download
  take: href
  each: true
  why: collect each photo's download link
```
