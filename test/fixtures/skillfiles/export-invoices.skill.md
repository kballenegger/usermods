---
usermods-skill: 1
name: Export this month's invoices
description: Filters the invoices page to this month, lists the invoice numbers and downloads the CSV.
namespace: kenneth
version: 1.0.0
match:
  - "*://billing.example.com/*"
start: https://billing.example.com/invoices
inputs: {}
outputs:
  invoices: { label: Invoice numbers, list: true }
---

# Export this month's invoices

Opens the invoices page, picks "This month", reads the invoice numbers and downloads the CSV.
Made with usermods 0.2 on 2026-10-08 from a run on billing.example.com.

```steps
- go: /invoices
  why: open the invoices page
- select: This month
  into: listbox "Period"
  at: { css: "select#period", in: 'form "Filters"' }
  why: show only this month's invoices
- wait: { selector: table tbody tr, state: visible }
- read: invoices
  from: table tbody tr td.number
  take: text
  each: true
  why: collect the invoice numbers shown
- click: button "Download CSV"
  at: { css: "a#download-csv", in: 'region "Invoices"' }
  why: download the filtered list
- wait: { ms: 1500 }
```
