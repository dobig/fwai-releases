# Linked threads

Link threads so their agents can hand work to each other. Give each thread a one-line purpose, such
as "owns the llm_gateway repo, follows its AGENTS.md". An agent can then assign a task to a linked
thread, and the reply comes back to it automatically, like a delegated task. The threads can belong
to different projects, run on your other machines, or be colleagues' threads shared with you.

## Link threads

1. Open the thread menu or the command palette and choose **Link with…**.
2. Pick the threads to link, and say what each one owns, including the current one. Each starts
   with its project and title; replace that with what the thread is responsible for, because agents
   decide where work goes from it. To add threads to a group this thread is already in, choose the
   group at the top, or use **Add threads…** in the group's menu in the thread details panel.
   Picking a thread in another group also offers its group, so this thread can join it.
3. The thread header shows **Linked** with the members. The thread details panel lists them too,
   where you can change a purpose, remove a member, pause the group, or dissolve it.

To link one thread quickly, type `/link` in the composer and pick it. Nothing goes to the agent.

```
/link [Math] does all the calculations own: measures rooms and areas group: Renovation
```

- The text after the thread is its purpose; `own:` is this thread's purpose; `group:` names the
  group. All three are optional, and the purposes replace those of threads already in the group.
- With `group:`, the threads meet in that group if either is in it; otherwise it is a new group by
  that name.
- Without it, the threads meet in the one group either is in, whichever side you link from. If they
  are in several, you choose one or a new group. If neither is in a group, they form a new one.

Only you create, change or dissolve links; agents only use them. Archiving or deleting a thread
removes it from its groups. Settling does not.

## Across machines and colleagues

**Link with…** also lists threads on your other machines signed in to your account, and threads
colleagues shared with you as a collaborator, with their owner and whether they are online. Linking a
colleague's thread shares yours back with them, and you choose whether their tasks wait for your
approval; `/link` on a colleague's thread opens **Link with…** for you to confirm that. A thread that is offline can still be linked; it joins when it is back.

A remote thread shares no files with yours, so tasks carry what they need instead of paths. Its owner
approves its commands when their share asks for it. If a share ends, for example because the owner
settles the thread, it leaves the group. A group created on another machine or by a colleague does
not show in this thread's header; its agent still sees its peers.

## What the agents do

An agent is told about its linked threads: what each owns, where it runs, whether it is working, and
a line on each of its recent runs. When you ask for something that belongs to a peer, the agent
assigns it to that thread instead of doing it, and says so. It hears about its peers again only when
something changed, so linking adds little to a conversation's cost.

When a run in a linked thread ends, the group records who asked, the first sentence of the final
reply, and whether it completed, failed or was stopped. These lines stay inside the group, including
for colleagues' threads in it, and no extra model call writes them.

A task waits in the receiving thread's queue if it is busy. The receiving agent is told which thread
and project sent it and that its final reply goes back. When its turn ends, that reply returns to the
sending thread and wakes it.

The timeline shows a card for each task, sent or received, with its status. **View chain** shows who
assigned what to whom.

## Limits

- A chain of tasks crosses at most three threads.
- An agent cannot assign work to a thread that is already waiting on the same chain.
- A group takes at most 20 tasks in 10 minutes.
- A task never runs in a broader permission mode than the thread that sent it.

## Stop a task

Choose **Stop** on a task card, on a node in the chain view, or press stop in a thread while its turn
works on a linked task. This stops that task and every task it handed on, and nothing else: other
work queued on those threads continues. The sending thread receives "Stopped by the user", and its
agent cannot send the same work elsewhere. To start again, send it a new message.

**Pause** a group to refuse new tasks while running ones finish. **Dissolve** removes the group.

The mobile app shows sent tasks like delegated work and
received ones like messages from another thread, but cannot create, change or stop links yet.
