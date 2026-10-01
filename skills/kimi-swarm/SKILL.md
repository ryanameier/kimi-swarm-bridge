---
name: kimi-swarm
description: Use this skill BEFORE you start researching whenever a request involves comparing, researching or collecting information on many items (roughly 8 or more products, tools, vendors, companies, models or sources), reading or summarizing many documents, building a report, spreadsheet or other file, or any other part that would take you several minutes. Use it even when the user does not mention Kimi and even though you could do the work yourself with web search: it decides whether to offer the Kimi Swarm connector, which runs that part in the background in parallel while you do the rest, and how to hand it over. Also use it whenever the user mentions Kimi or Kimi Swarm.
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

1. **Check your other tools first.** Kimi can only search the web, and every search costs money. Kimi cannot use your connectors. If one of your other connected tools can supply the starting data more cheaply or more accurately, use it before delegating and give Kimi the result to verify and extend instead of discovering everything from scratch. Examples: a company or contact database (such as FullEnrich) for lists of companies matching a region, industry and size; a CRM; the user's own documents. Use tools that are free for this kind of lookup without asking; ask the user first before anything that spends their credits (for example contact enrichment). Pass small results in the brief and larger ones as an uploaded file (see the connector's file instructions).
2. **Start Kimi first.** Call `kimi_delegate_task` with `cwd: /workspace` and a self-contained brief:
   - what to produce, the exact fields, format and scope;
   - any context from this conversation that Kimi needs (it cannot see the chat), including any candidates or data you gathered with other tools and what Kimi should verify or add to them;
   - if the user wants a file, ask Kimi to save it in `/workspace/outputs`.
   Also pass `modelTier` for what the part needs: `economy` (default, about half the cost) for most research, data collection, checking a provided list against criteria, extraction or formatting; `balanced` for complex comparison or synthesis that needs nuanced judgment, or to redo a thin economy result; `premium` (deep, cross-checked, slower and costlier) for high-stakes work. Follow the user if they ask for cheaper, faster or more thorough. If the user has fixed models in `kimi_model_settings`, those apply instead.
   `kimi_delegate_task` returns immediately with a `sessionId`; Kimi keeps working.
3. **Do your own part** while Kimi works.
4. **Collect Kimi's result.** Call `kimi_wait_until_idle` with the `sessionId`, and call it again while it returns a timeout (the job is still running). Then call `kimi_get_handoff`.
5. **Combine both parts** into one answer. Say which part came from Kimi. If Kimi made files, bring them into the conversation with `kimi_create_download_links`.

If the user attached files that Kimi needs, follow the Kimi Swarm connector's file instructions (`kimi_create_upload_links`) before delegating.
