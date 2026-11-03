---
usermods-skill: 1
name: File an expense
description: Fills the new-expense form on expenses.example.com from your inputs and stops before Submit so you press it.
namespace: kenneth
version: 1.0.0
match:
  - "*://*.expenses.example.com/*"
start: https://expenses.example.com/expenses/new
inputs:
  merchant: { label: Merchant }
  amount: { label: Amount, example: "42.00" }
  note: { label: Note, optional: true }
outputs: {}
license: MIT
updateURL: https://gist.githubusercontent.com/kenneth/3b1fa0000000000000000000000000aa/raw/file-an-expense.skill.md
---

# File an expense

Fills the three fields of the new-expense form and leaves Submit to you.
Made with usermods 0.2 on 2026-10-08 from a run on expenses.example.com.

```steps
- go: /expenses/new
  why: open the new-expense form
- fill: $merchant
  into: textbox "Merchant"
  at: { css: "input#merchant", in: 'form "New expense"' }
  why: enter the merchant name
- fill: $amount
  into: textbox "Amount"
  at: { css: "input[name=amount]", in: 'form "New expense"' }
  why: enter the amount
- fill: $note
  into: textbox "Note"
  at: { css: "textarea#note", in: 'form "New expense"' }
  why: enter the note, if any
  when: $note
- wait: { selector: "button[type=submit]", state: visible }
- ask: Check the form and press Submit.
  until: { text: Expense filed }
```
