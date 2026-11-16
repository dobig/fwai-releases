# fwai

Downloads for the fwai desktop app and the `fwai` CLI: [latest release](https://github.com/dobig/fwai-releases/releases/latest).

| Platform                       | Desktop app | CLI                                       |
| ------------------------------ | ----------- | ----------------------------------------- |
| macOS, Apple silicon           | `arm64.dmg` | `darwin-arm64.tar.gz`                     |
| macOS, Intel                   | `x64.dmg`   | —                                         |
| Linux x64 / arm64              | `.AppImage` | `linux-x64.tar.gz` / `linux-arm64.tar.gz` |
| Windows x64 / arm64 (unsigned) | `.exe`      | `win32-x64.zip` / `win32-arm64.zip`       |

Install the CLI on a server:

```sh
curl -fsSL https://raw.githubusercontent.com/dobig/fwai-releases/prod/scripts/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/dobig/fwai-releases/prod/scripts/install.ps1 | iex
```

Linux hosts need glibc and `libatomic1`. See [docs/user](docs/user/install.md) for more.

This repository holds the source the releases are built from. It is published from our private repository on every release, so pull requests here are not merged; open an issue instead. Branches: `prod` is the latest release, `staging` the latest staging build (pre-releases named `*-preview.*`, for testing against our staging services), `main` the latest development snapshot.
