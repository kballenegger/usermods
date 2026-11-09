---
usermods-skill: 1
name: File an expense
description: Fills the new-expense form from your inputs and stops before Submit so you press it.
version: 1.0.0
match:
  - "*://expenses.example.com/*"
start: https://expenses.example.com/expenses/new
inputs:
  merchant: { label: Merchant }
  amount: { label: Amount }
  note: { label: Note, optional: true }
outputs: {}
---

# File an expense

Fills the new-expense form from your inputs and stops before Submit so you press it.
Made with usermods on 2026-11-02 from a run on expenses.example.com.

```steps
- go: /expenses/new
  why: start where the recording started
- fill: $merchant
  into: textbox "Merchant"
  at: { css: "#merchant", in: 'form "New expense"' }
  why: enter the merchant name
- fill: $amount
  into: textbox "Amount"
  at: { css: "#amount", in: 'form "New expense"' }
  why: enter the amount
- fill: $note
  into: textbox "Note"
  at: { css: "#note", in: 'form "New expense"' }
  why: enter the note, if any
  when: $note
- wait: { selector: "button[type=submit]", state: visible }
- ask: Check the form and press Submit.
  until: { text: Expense filed }
```
