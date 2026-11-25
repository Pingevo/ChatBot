# Shadow Inbox ChatList missing shop name — 2026-11-25

## Root cause and scope

Shadow Inbox consumes mirrored conversations whose `shop_name` can be absent. `ChatList` builds shop filter options from those rows and calls `.trim()` on the missing value. The same component is used by Tickets and BotWorker, so the correction belongs in its conversation-to-display mapping.

## Change

For conversation rows, use the trimmed shop name when present and `shop_id` otherwise. Show the same fallback in the list row. Keep directory-backed shop options, filter keys, API queries, and pagination unchanged.

## Verification

Server-render the real `ChatList` with a mirrored row lacking `shop_name` and with a named row; verify the first shows `shop_id` and the second retains its name. Run TypeScript and diff checks. No API, database, provider, or customer sends.
