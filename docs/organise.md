# Organise, export and share chats

Everything here is in a chat's **⋯** menu.

## Rename, pin, tag, archive

- **Rename**: your own name for the chat. It shows everywhere in Handoff; Claude Desktop keeps its own.
  "Use Claude's title" goes back.
- **Pin**: the chat is listed under **Pinned** at the top of the home page, and first in its project.
- **Tags**: a few words (`bug`, `client-x`, `later`). In a project's list, tap a tag to see only those chats.
- **Archive**: hides the chat from its project's list. **Archived** in that list shows them; nothing is deleted.

These live in Handoff's own `data/session-meta.json`. Claude Code's transcripts are never changed.

## Export

- **Markdown file (.md)**: the chat as a document: your messages, Claude's answers, plans and questions.
- **PDF**: opens the same document as a printable page; choose **Save as PDF** in the print dialog
  (on a phone: Print → Save as PDF, or Share → Print).

Tick **Include tool calls and their output** to add the commands Claude ran and what they printed.

## Read-only share links

**Share a read-only link** makes a link anyone can open, with no sign-in, to read that one chat:

- It lasts 1 hour, 1 day, 7 days or 30 days, and can be removed early from the same sheet.
- It shows the chat as it is when opened, with the project's name but not its folder. It can't send
  anything, and nothing else in Handoff opens with it.
- Tool calls and their output are left out unless you tick them in: they can show file contents and commands.
- The link is shown once. Handoff keeps only a hash of it (`data/shares.json`), how long it lasts and
  how often it was opened. Pages behind it ask search engines not to index them.
- **Sign out all devices** with "Also revoke…" ticked removes every share link too.
