# Editing a mod you already have

Click **Edit in chat** on any installed mod in usermods, describe the change, and press **Update mod**. The change is written back over the same mod: same id, same on/off state, same stored values, no second copy.

![A chat editing an installed mod, with Update mod and Save as a new mod instead](/assets/guide/11-editing.png)

## It works on any mod

Not only mods written in chat: scripts installed from a URL, imported from a file, or brought across from Tampermonkey can all be edited this way, enabled or disabled. An imported script's `==UserScript==` header is kept and put back when you save, so its `@require`, `@grant`, `@connect`, `@run-at` and `@version` lines survive. Only the name, description and `@match` lines are rewritten.

## Three ways in

- **From the mod.** Every row in the Mods tab and the dashboard has **Edit in chat**. If a chat already edits that mod, it opens that chat, so you continue the conversation that built it.
- **From the chat.** A new chat lists the mods that run on the current page as one-click **Edit** entries named after each mod. **Edit a mod...** beside the chat switcher opens a picker of all your mods, page matches first.
- **From the model.** Each turn tells the model which mods already run on the current address. Ask for something that belongs with one of them ("also hide the footer") and it opens that mod and proposes the updated script instead of writing a second mod. If it cannot tell, it asks.

If the chat you are in has an unsaved draft, picking a mod opens a new chat for it and says so.

## Keeping both

**Save as a new mod instead** breaks the link: the next save creates a separate mod and leaves the original installed. If you save a mod whose name and match patterns equal one you already have, usermods asks whether to update it or keep both.

You can also edit the source directly in the [dashboard](/guide/dashboard): select a mod and its code opens in an editor beside the list.
