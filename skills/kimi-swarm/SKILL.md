---
name: kimi-swarm
description: Hand independent, substantial parts of a request to Kimi Swarm (the Kimi Swarm connector) so they run in the background while you work on the rest. Use when a request, even one that never mentions Kimi, contains a part that would take you several minutes and does not depend on the rest, such as researching or comparing many items (products, vendors, companies, sources), reading or summarizing a batch of documents, building a report, spreadsheet or other file, or a long coding task. Also use when the user asks for Kimi or Kimi Swarm directly.
---

# Kimi Swarm

Kimi Swarm is a team of AI workers that runs in the user's own private workspace, reached through the Kimi Swarm connector. It works in the background while you keep going, so handing it an independent part of a request lets both parts finish at the same time.

Kimi has about 2 minutes of fixed start-up time and cannot see this conversation, so it only pays off for parts that are substantial and self-contained.

## When to offer

Offer Kimi for a part of the request when all of these hold:

- It would take you several minutes: many items to research or compare, many documents to read, a report or file to build, a long coding task.
- It does not depend on the rest of the request, and the rest does not need to wait for it.
- It can be described in a self-contained brief.

Do not offer for quick questions, tightly coupled work, or when the user clearly wants you to do all of it yourself.

If the whole request is one big independent job, offer to hand the whole thing over.

## Check the user's preference

The first time in a conversation, call the Kimi Swarm connector's `kimi_swarm_settings` tool with no arguments and read `offerKimi`:

- `ask` (default): offer, then wait for a yes.
- `auto`: hand the part over without asking and tell the user you did.
- `off`: do not offer; use Kimi only if the user asks for it.

If the user says to always do this, or to stop asking, save it: call `kimi_swarm_settings` with `offerKimi` set to `auto` or `off`.

If the Kimi tools are not loaded yet, search your available tools for `kimi_delegate_task`. If there is no Kimi Swarm connector, do the work yourself and do not mention Kimi.

## How to offer

One or two sentences: which part, and why it helps. For example:

> The pricing comparison for the 20 tools doesn't depend on the summary. Should I hand it to Kimi Swarm so it runs in the background while I write the summary?

Then stop and wait for the answer.

## When the user says yes (or offerKimi is auto)

1. **Start Kimi first.** Call `kimi_delegate_task` with `cwd: /workspace` and a self-contained brief:
   - what to produce, the exact fields, format and scope;
   - any context from this conversation that Kimi needs (it cannot see the chat);
   - if the user wants a file, ask Kimi to save it in `/workspace/outputs`.
   `kimi_delegate_task` returns immediately with a `sessionId`; Kimi keeps working.
2. **Do your own part** while Kimi works.
3. **Collect Kimi's result.** Call `kimi_wait_until_idle` with the `sessionId`, and call it again while it returns a timeout (the job is still running). Then call `kimi_get_handoff`.
4. **Combine both parts** into one answer. Say which part came from Kimi. If Kimi made files, bring them into the conversation with `kimi_create_download_links`.

If the user attached files that Kimi needs, follow the Kimi Swarm connector's file instructions (`kimi_create_upload_links`) before delegating.
