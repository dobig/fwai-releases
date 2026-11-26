# Secrets vault

Save a password, token or key once, and agents in every project on this machine can use it by
name, like `example.com login` or `GITHUB_TOKEN`, without you typing it again.

## Add a secret

Open **Settings → Secrets** (on mobile, under Connections) and choose **Add**. Only a value and a
name are required. For a password, leave the name empty and its first domain becomes the name.

A saved value can never be shown again, on any device. To change it, edit the entry and type the
new value; leaving the field empty keeps the old one. Each entry shows when it was last used, in
which thread, by whom and how.

You can also save from a request: when an agent asks for a secret, turn on **Save to vault**
before you submit. If a saved entry fits the request, the card lists it and one click answers.

## Scopes

An entry is available in **All projects** by default, or only in the projects you pick. An agent in
another project cannot use it; when one asks, the card lists the entry with **Also allow in
<project>**.

## Domains

A password's domains say which sites it may be typed into by the built-in browser. `example.com`
covers `login.example.com`, but `alice.github.io` never covers `bob.github.io`. Values are typed
only into `https` pages, or `http` on localhost. An entry with no domains is never typed into a
page; agents can still use it in commands and tools.

The value is typed by the machine running the thread. A desktop browser tab for a thread on
another machine cannot be filled.

## Shared threads

When a collaborator's message starts a run in a thread you shared, and that run asks for an entry,
you are asked first: "<account> wants to use <name> in <thread>", **Allow once** or **Deny**, on
every device and by push. Each use asks again. Allowing hands the value to their agent.

If a share lets the collaborator's agent run commands without your approval, that agent can read
your saved secrets without asking. Share with that setting only with people you trust with them.

## Sync across your machines

Entries available in **All projects** can sync between your machines through fwai Connect.
Entries limited to chosen projects never leave the machine they were saved on.

Secrets are stored only on your machines. fwai can't read or restore them: if you lose every machine
that has them, they can't be recovered.

To turn it on, tick **Share secrets with my other machines** when you sign in to the
desktop app or set up fwai Connect, or turn on the same switch in **Settings → Secrets** on a
machine linked through fwai Connect. Turning it off stops sharing on that machine; its entries stay
on it. The first machine starts syncing at once.
Every later one waits until another machine that already syncs is online, then joins on its own.

In the same section you can:

- **Revoke** another machine. It stops receiving changes, but it may still hold the values it
  already had, so change those passwords.
- **Rotate key** if the key may have been read on one of your machines, for example by an agent.
- **Turn off sync everywhere**. This deletes the synced copies in fwai Connect; every machine keeps
  its own entries.

The section also shows changes still waiting to upload and why the last sync failed, such as an
entry over 64 KB, more than 1000 entries or more than 10 MB in total.

If two machines change the same entry, the newer change wins everywhere. The machine whose change
lost keeps its value for 30 days: the entry shows "Replaced by a newer change" or "Deleted on another
machine", and **Use this version** makes that value win everywhere again. If sync says this
machine's keys are missing, choose **Rejoin** while another of your machines is online.

Anyone who can sign in to your account on a machine and join can read your synced secrets. Protect
your account as you would the secrets themselves.

## What the vault does not do

Agents run as your user on this machine, so an agent that runs commands can read what the server
can, including the vault. The vault keeps values out of chat transcripts and saves typing; it does
not hide values from a determined agent. Anything an agent prints is its own output and is not
redacted.
