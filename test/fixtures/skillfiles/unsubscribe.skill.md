---
usermods-skill: 1
name: Unsubscribe from the weekly digest
description: Turns off the weekly digest in your email preferences and saves.
namespace: ada
version: 1.0.2
match:
  - "*://*.news.example.com/*"
start: https://news.example.com/account/settings
inputs: {}
outputs:
  confirmation: { label: confirmation }
license: MIT
x-reviewed-by: nobody
x-tags: [email, settings]
---

# Unsubscribe

Turns the digest off, and nothing else.

```steps
- go: /account/settings
- click: link "Email preferences"
  at: { css: "a[href=\"/account/email\"]", in: nav "Account" }
- wait: { selector: "input#weekly", state: visible }
- check: checkbox "Weekly digest"
  at: { css: "input#weekly", in: 'form "Email preferences"' }
  checked: false
  why: turn off the digest
- click: button "Save preferences"
  at: { css: "button[type=submit]", in: 'form "Email preferences"' }
- wait: { text: Preferences saved }
- read: confirmation
  from: div.flash
  take: text
```

Written by hand, then checked on the site.
