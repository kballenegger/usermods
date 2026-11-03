---
usermods-skill: 1
name: Export this month's invoices
description: Filters the invoices page to this month, lists the invoice numbers and downloads the CSV.
version: 1.0.0
match:
  - "*://billing.example.com/*"
start: https://billing.example.com/invoices
inputs: {}
outputs:
  invoices: { label: Invoice numbers, list: true }
---

# Export this month's invoices

Filters the invoices page to this month, lists the invoice numbers and downloads the CSV.
Made with usermods on 2026-11-02 from a run on billing.example.com.

```steps
- go: /invoices
  why: open the invoices page
- select: This month
  into: combobox "Period"
  at: { css: "#period", in: 'form "Filters"' }
  why: show only this month's invoices
- wait: { selector: "tr:nth-child(3)", state: visible }
- read: invoices
  from: table tbody tr td.number
  take: text
  each: true
- click: link "Download CSV"
  at: { css: "#download-csv", in: 'region "Invoices"', nth: 0 }
  why: download the filtered list
- wait: { ms: 500 }
```
