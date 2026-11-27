# Usage and limits

**Menu → Usage and limits** shows how much Claude Code has been used on this computer, and how close
you are to your plan's limits.

## Plan limits

- **Current session**: the 5-hour window. How much is used, and when it resets (time and how long from now).
- **This week**: the 7-day window, with the day, date and time it resets. Plans with separate weekly
  windows (for one model, or with extra usage) show those too.

Claude Code reports these with every request it makes. Handoff records them from every run it starts,
so after you use Handoff they're up to date. **Check now** asks right away: one tiny request to the
quickest model, which uses a sliver of the session window. The page says how old the numbers are.
A window whose reset time has passed shows as started again.

Sessions in Claude Desktop count toward the same limits, but Desktop doesn't share the numbers with
other programs. The limits shown are the ones Claude Code reported last.

## Tokens and cost

Added up from every Claude Code transcript on the computer: Desktop, terminal, IDE and Handoff sessions,
and their sub-agents.

- **Last 5 hours, today, last 7 days**, then a chosen range (today, 7, 30 or 90 days) with a bar per day.
- **By model, by project, heaviest chats.** Each opens the project or chat.
- **Tokens** are split into input, output, cache reads and cache writes. In long Claude Code sessions most
  tokens are cache reads, which cost much less.

The cost is an **estimate at Anthropic's API list prices** (cache writes at 1.25x the input price for 5
minutes or 2x for an hour, fast mode at twice the price). A Pro or Max plan isn't billed per token, so
read it as "what this would cost on the API". A model Handoff has no price for shows "price unknown".

The first count reads every transcript and can take half a minute, so Handoff does it in the background
shortly after it starts. After that only new lines are read. The running totals are kept in
`data/usage-cache.json`; deleting that file only means counting again from the start.
