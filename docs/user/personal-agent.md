# Personal agent

Your personal agent answers colleagues for you. People in your organization ask it with `/ask`; it
reads what you allowed, drafts an answer or proposes an action, and waits for you. Nothing leaves
until you approve it.

## Turn it on

Open **Settings → Agent** in the environment the agent should run in, choose its provider and model,
and turn it on. **Settings → Agent** also lists exactly what the agent can and cannot do; the agent is
given the same list with every request. It gets its own thread in a **Personal agent** project, with a
`MEMORY.md` for notes about you. Open it from **Personal agent** at the top of the sidebar or the command
palette. The sidebar entry also counts the requests waiting for you, and its switch turns the agent on or
off. Off works from any device. On uses the agent's last provider in the current environment; set it
up in **Settings → Agent** the first time.

Write **Your instructions** in the same place to tell it who you are, what you own and what it may
say. They are added to every request it triages. They can narrow or guide it, but never give it more
access than you ticked. You can switch its provider or model at any time; the next request uses it.

The agent runs in one environment at a time. Turning it on in another environment moves it there; the
old thread stays as history and stops taking requests. Turn it off in the same place.

The agent must run on Codex or Claude. While it works on a request it can only read: the provider
blocks commands, file changes and network. Claude also reads only the folders you allowed. Codex
cannot limit which files it reads, so on Codex the agent could read any file your account can; choose
Claude if that matters. Providers that cannot block commands and writes cannot run the agent.

## Your agent window

In its own window your agent works for you with your authority: it can read and message your
threads and use every tool. Commands and edits ask for approval as in any of your threads.

## Choose what colleagues' requests may use

Each colleague's request is handled in a separate, hidden thread, so one colleague never sees
another's request. The agent does see a short list of the earlier requests the same colleague sent you
in the last 30 days, and opens one only when the new request builds on it, so a follow-up does not
start from nothing. Turn this off with **Earlier requests from the same colleague**. In **Settings → Agent**, set each capability to **Auto** (done at once), **Ask**
(waits for your approval on the card) or **Never**:

- per project: read its folder, read its threads, send a message to its threads, start a thread;
- replying to the colleague (Auto or Ask), and sharing a thread (Ask or Never).

The **All projects** row covers projects you add later; a project's own row overrides it. The agent
asks for the access a request needs; fwai checks it against these settings, so nothing written in a
request can change the outcome. Anything flagged as suspicious always waits for you, and forwarding
always does. Folders outside your projects can be added under **Other folders**.

Credentials and keys are never readable, whatever you choose: `~/.ssh`, `~/.aws`, `~/.config/gh`
and similar folders, and `.env`, `*.pem`, `*.key` and SSH key files inside your projects. Claude
enforces this; on Codex it is an instruction only.

## Ask a colleague

Type `/ask`, pick a colleague, and write your question:

```
/ask alice what does introspection return for a non-active org?
```

The message goes to Alice's agent, not to your own agent. People without a personal agent show as
unavailable. A card in your thread shows the request's status, and you can cancel it while it is
pending. When Alice approves an answer, it appears in the thread you asked from and wakes its agent. If that
thread is gone, or you asked from a new thread you never started, the answer goes to your own
personal agent, which passes it on. Without a personal agent, it opens a new thread in the same
project. Agents can ask
too, with the `fwai_code_agent_request` tool.

Requests expire after seven days without an answer, and you are told.

## Approve requests

New requests appear in your agent's thread, in notifications and on your phone. Each card shows the
request, your agent's summary, its proposed action, its draft, and exactly what the answer would
disclose. Choose **Accept** (edit the draft first if you like), **Forward** to a colleague's agent, or
**Reject** with an optional reason.

You can decide from any device, even while the agent's machine is offline; approved work runs when it
is back. When the agent proposes sending work to one of your threads, or starting a new one, the card
shows the task for that thread separately from the reply to your colleague. The thread runs the task
you approved, never the requester's own text; its result comes back to your agent, which drafts the
answer for you to approve. A new thread with no task is only opened, and your colleague gets the
reply you approved.

## Privacy

- Only people in your organization can ask your agent.
- A request is treated as information, never as instructions. If it tries to make your agent reveal
  secrets or break its rules, the card flags it as suspicious.
- Nothing is sent, run or shared without your approval.
- Block a person in **Settings → Agent** to stop taking their requests, and unblock them there.
