# Using Kimi Swarm in Claude

Kimi Swarm gives Claude a team of AI workers that run in your own private workspace. Claude
hands them larger jobs (web research, working through documents or data, building files, coding),
the workers split the job and work on it in parallel, and Claude brings the result back into your
chat.

## Get started (once)

1. In Claude, open **Settings → Connectors** and click **Connect** next to **Kimi Swarm**. (If you
   don't see it, ask your Kimi Swarm admin to add you.)
2. Sign in with your work account when asked.
3. Only if you use your own Claude Pro or Max account (not a company Team/Enterprise plan): open
   **Settings → Capabilities → Allow network egress**, choose **Package managers only**, and add
   the domain your admin gave you under *Additional allowed domains*. This lets Claude hand your
   attachments to Kimi. On company plans your admin has already done this.

That's it. Nothing else is required.

**Optional: have Claude suggest Kimi on its own.** Install the Kimi Swarm skill once: download
`kimi-swarm.zip` (your admin shares it, or get it from the project's GitHub release page) and upload it under
**Customize → Skills** in Claude. With it, Claude offers to hand big, independent parts of your
requests to Kimi ("Should I hand the 20-vendor comparison to Kimi Swarm so it runs while I write
the summary?") even when you don't mention Kimi. In Claude Code, put the `kimi-swarm` folder in
`~/.claude/skills/` instead.

## Ask for work

Say "Kimi Swarm" in your request and Claude hands the job over. Copy one of these to try it:

- "Use Kimi Swarm to research the 10 biggest competitors of Acme and give me a comparison table
  with sources."
- "Have Kimi Swarm read these three PDFs and write a one-page summary of the differences." (attach
  the files)
- "Ask Kimi Swarm to turn this spreadsheet into a report with charts, as a PDF."
- "Use Kimi Swarm to compare pricing and limits for these 20 tools and flag anything missing."

Kimi decides how many workers a job needs. Larger jobs take a few minutes and run in the
background: Claude checks on them for you, so you can keep chatting or come back later and ask
"is the Kimi Swarm task done?".

## Files

- **Giving files to Kimi:** attach them to your message. Claude passes them to your workspace.
- **Getting results:** reports, spreadsheets, PDFs and other files Kimi makes appear in the chat
  as downloads.
- Your workspace is private to you and kept between conversations, so you can say "update last
  week's report" and Kimi still has it.

## Settings you can change by asking Claude

| Ask Claude | What it does |
|---|---|
| "Show my Kimi Swarm agent limit" / "lower my Kimi agent limit to 8" | The most workers Kimi may use on one task. It is a ceiling: Kimi uses fewer when a task doesn't need them. |
| "Which models can Kimi Swarm use?" | Lists the available AI models with their prices. |
| "Switch Kimi Swarm to GLM-5.3" / "use a cheaper model for the Kimi workers" | Changes the model for your future tasks. |
| "Always hand suitable parts to Kimi" / "stop suggesting Kimi" | Claude sometimes offers to give an independent part of your request to Kimi so both parts run at the same time. By default it asks first; you can have it do this automatically or never. |

Your admin sets the upper limits.

## Good to know

- **Cost:** every task uses paid AI capacity. More workers and bigger jobs cost more; Claude shows
  the token usage and estimated cost when a task finishes. A 30-item research brief usually costs
  $1–3.
- **If a task fails,** Claude tells you why (for example "the AI account is out of credits"). Pass
  that message to your admin if it's not something you can fix.
- **Privacy:** your files and results stay in your own workspace; other employees cannot see them.
  Kimi reads the web for research; the contents of your files are sent only to the AI model that
  does the work.
