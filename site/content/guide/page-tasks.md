# One-off browser tasks and questions about the page

Besides writing mods, usermods can answer a question about the page you are on, or carry out a one-off task on it, such as "scroll to the bottom and list every image URL". Neither creates a mod unless you ask for one.

## Ask about the page

Ask something like "what are the cancellation terms on this page?" or "summarise the reviews". The model reads the page's text and answers in the chat. Long pages are read in parts.

## Run a one-off task

When you explicitly ask for a task, the model operates the page with scripts: it can click, type, scroll, wait for content to load, and collect data, then reports the result. Examples:

- "Scroll to the bottom, open every carousel, and give me download links for all the photos."
- "List every link in this table with its title."
- "Expand all the collapsed comments."

The model never submits, buys, sends or deletes anything you did not explicitly ask for. If you want the task to happen on every visit, ask for a mod and it will write one.

## How usermods decides

Every request is read as one of three things:

| You ask for | usermods does |
|---|---|
| A change that should stick ("hide the sidebar") | Writes, tests and proposes a mod |
| An answer about the page | Reads the page and answers, no mod |
| A one-off task, explicitly | Operates the page and reports, no mod |

If it cannot tell, it asks one short question.

## What gets sent

Answering and acting both need the model to see the page, so the page's address, title and the content the model reads go to the provider you picked for that chat. See [Privacy](/guide/privacy).
