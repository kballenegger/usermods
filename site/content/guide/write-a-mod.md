# Writing a mod in chat

In usermods you describe a change to the page you are on, and the model inspects the page, writes a userscript, tests it live, and proposes it with **Try** and **Save**. A saved mod runs by itself on every matching page load.

## How a request goes

1. Open the side panel on the page and type what you want: "hide the Shorts shelf", "make the article text wider", "add a copy button to every code block".
2. The model reads the page. It can read a pruned copy of the DOM, list elements by selector or text, read computed styles, and take a screenshot of the visible tab.
3. It tries the change with a script on the live page, then tests the finished mod the way the saved mod will run, on a fresh page load when that matters.
4. It proposes the mod. The proposal says how it was tested.
5. **Try** runs it on the page now. **Save** installs it.

![A chat with a proposed mod and its Try and Save buttons](/assets/guide/01-chat-proposal.png)

## Help the model find the right thing

- **Point at an element.** Click **+**, choose **Point at element**, then click something on the page. An `@reference` drops into your message, so you can say "this" and mean it.
- **Attach an image.** Paste a screenshot or mockup into the message box, drop one onto the panel, or click **+** and choose **Attach image**. PNG, JPEG, WebP and GIF are accepted. Images are scaled down and stripped of metadata in the panel before they are sent.

![The message box holding an element reference from the picker](/assets/guide/02-chat-refs.png)

## The draft and its versions

Each chat keeps one draft mod above the message box. Every proposal you accept becomes the next version of that draft, with a line diff against the one before. **Roll back** adds the old code as a new version, so a rollback can itself be undone. "Make the button blue instead" edits the draft you have rather than starting over.

Once saved, the button reads **Update mod**, and later saves rewrite the same mod instead of adding a copy.

## Where saved mods live

The **Mods** tab lists your mods, split into the ones that match the page you are on and the rest. Each can be turned on or off, run, exported, edited in chat or deleted. Mods are plain userscripts with a `==UserScript==` header, so they also work in other userscript managers.

![The Mods tab with three saved mods](/assets/guide/03-mods.png)

## Limits

A turn stops after 30 model steps. The panel says so, and sending another message continues. If the request is ambiguous, the model asks one short question.
