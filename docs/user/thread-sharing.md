# Sharing threads

Share a thread with people in your fwai organization (one colleague, one of your projects, or the
whole organization), or with anyone through an invite link. They open it in their own fwai, on the
web, desktop or mobile app, and follow it as it runs. The thread keeps running on your machine,
with your files and providers.

## Share a thread

Your machine must be signed in and linked to [fwai Connect](./remote-access.md).

1. Open the thread menu (click the title, or right-click the thread in the sidebar) and choose
   **Share**. It is also in the command palette.
2. Pick what they may do:
   - **Can view**: they read the thread.
   - **Can send messages**: their messages go straight to the agent. **Commands and file changes
     need my approval** is on by default: any command or file change their messages lead to waits
     until you approve it, and only you can approve it.
3. Search for a colleague by username, or pick one of your projects or **Everyone in** your
   organization, and choose **Share**.

## Share with an invite link

An invite link works without an organization, and reaches people outside yours. In the share
dialog, pick what they may do as above, then under **Invite link** choose:

- **One person**: the first account to accept it joins, and the link stops working for anyone else.
  That person can open it again on another device.
- **Anyone with the link**: everyone who accepts it joins, until it expires or you revoke it.

Choose how long new people can join (1, 7 or 30 days), then **Create link** and send the link. The
link is shown only once. Whoever opens it signs in to fwai and chooses **Join**; the thread then
shows under **Shared with me**. On a phone, the link opens in the browser, which offers **Open in
app**.

Everyone who joins appears in the share dialog marked **via link**, and you can revoke each person.
Revoking the link stops new people from joining; **Revoke and remove** also removes everyone who
joined through it. People who already joined keep access after the link expires.

In an organization, invite links reach only its members unless an organization owner allows
sharing outside the organization in the organization's settings. Turning that off later also ends
access for people outside the organization who already joined.

To share quickly, type `/share` and a name in the composer and pick a colleague, a project or
**Whole organization**; sending shares the thread as **Can send messages** with your approval on,
and nothing goes to the agent.

## Your team

When your account is in an organization, the logo reads **fw ai TEAM** and the chat header has a
**Team** button (also in the command palette). It opens the Team panel: your organization's
projects with their members, and members in no project. **Share** next to a person or project
shares the current thread the same way as `/share`; a shared one shows **Revoke**. Organization
owners see every project; members see the projects they are in.

People are shown by username only. Organization owners can share with any project. A member's
share with the whole organization waits until an organization owner approves it; until then it
shows **Waiting for an organization owner**, and nobody gets access. Organization owners approve or
reject these requests in **Settings → Sharing → Organization share requests**. While the app is
open, a new request pops up a notice with **Review**, and the Settings button shows how many wait.

An agent can propose a share but never grant one. A proposal shows **Proposed by an agent** and
grants nothing until you approve it in the share dialog or **Settings → Sharing**. The thread
shows **Request** in the sidebar and **Share proposed** in its header while one waits.

## Who sees it

People you shared with directly find the thread under **Shared with me** in the sidebar. Project
and organization shares show under **Team**. Opening one connects to your machine; when it is
offline they see **owner offline** and cannot use the thread until it is back.

They see the thread's messages, the agent's work and its diffs, with each message labelled by who
sent it. They cannot open a terminal, browse or change files, use git, change the thread's settings,
rename, settle or archive it, or answer the agent's approvals and questions.

## Stop sharing

Revoke a share or an invite link from the share dialog, or see every thread you shared in
**Settings → Sharing → Shared by me**. Settling or archiving a thread ends all its shares, and shared threads are never
settled automatically. Unsettling does not bring shares back; share it again.

On mobile you can open and follow threads shared with you, join through invite links, and see who
sent each message. Sharing a thread, creating invite links, the Team panel, `/share`, **Shared by me** and deciding organization share requests are on
the web and desktop apps only; mobile shows organization owners how many requests wait.
