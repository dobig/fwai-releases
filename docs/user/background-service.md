# Running fwai in the background

On Linux and macOS, fwai can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Install the `fwai` CLI first ([Install fwai](./install.md#command-line)), then
run these commands on the machine that will host fwai:

| Task                            | Command                  |
| ------------------------------- | ------------------------ |
| Install and start               | `fwai service install`   |
| Inspect status and log location | `fwai service status`    |
| Move to a newer release         | `fwai update`            |
| Restart                         | `fwai service restart`   |
| Stop and remove from startup    | `fwai service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.
Running `fwai service install` again repairs a service that `fwai service status`
reports as broken.

`fwai update` downloads the newest release on your channel and switches `fwai`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `fwai service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating fwai](./updating.md).

Pass an exact version (`fwai update 1.0.0`) to pin one, or `--allow-downgrade`
to move backwards. Preview builds are for maintainers' testing: they can be
broken and are never offered as updates, so the installer and `fwai update` ask
for confirmation before installing one.

`fwai uninstall` removes the background service, the `fwai` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.fwai/userdata` are kept, along with `service.env`
under fwai home. Pass `--yes` from a script.

## Local network access

The service listens on your local network and Tailscale addresses, so the
desktop and mobile apps on the same network connect directly instead of through
fwai Connect. The hosted web app at chat.fwaii.com stays on fwai Connect, because
browsers block plain HTTP from an HTTPS page. The service does not answer on
public addresses, and every device still needs to pair or sign in. To keep the service reachable from this machine only, set
`T3CODE_HOST=127.0.0.1` in `service.env` (below). Any `T3CODE_HOST` value
replaces this default.

## Configure the service environment

Put custom environment variables in `service.env` under the service's fwai home
directory, normally `~/.fwai/service.env`. This file survives service installation
and updates. For example:

```dotenv
T3CODE_PORT=3773
T3CODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `T3CODE_HOME`,
`T3_BOOT_SERVICE_UNIT`, and `T3_SERVICE_LAUNCHER_CONTEXT` (including case variants).

Run `fwai service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `fwai service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default fwai home, `chmod 600 ~/.fwai/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so fwai starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

fwai Connect can offer service installation during setup, but the two are managed
separately. Signing out of fwai Connect does not stop or uninstall the service.

## Troubleshooting

Start with `fwai service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running fwai as root creates a separate installation and Connect
identity. Without administrator access, run `fwai serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status fwai.service`, then use the repair command printed by fwai.                          |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `fwai service restart`.                          |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `fwai` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.fwaii.code.service.plist`.

For failures after signing in to fwai Connect, see
[connection troubleshooting](./fwai-connect-troubleshooting.md).

## Reclaim database space

fwai removes superseded internal history on its own while it runs; your
conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Storage (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

Run `fwai doctor` on the machine that hosts the environment. It reports the
database size and the space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use. Use `--base-dir` for a
different data directory.

The repair can take several minutes on a large database. It rebuilds the
database through a temporary copy, so it needs free space of about the
database's size twice over: once in the system temporary directory (`TMPDIR`
or `/tmp` on Linux and macOS) and once next to the database for its
write-ahead log.
