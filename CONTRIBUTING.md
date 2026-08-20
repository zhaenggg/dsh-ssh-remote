# Contributing

## Build

```sh
pnpm install --ignore-scripts
pnpm -r --filter './packages/*/*' run build
```

## Publish

Packages are published under the [`@zhaeng`](https://www.npmjs.com/~zhaeng) scope (npm). Dependencies on official `@deepseek-ai/*` packages use published ranges (`dsh-* ^0.1.0-rc.x`, `cordis ^4.0.1`); inter-package references are pinned to matching versions.

Publishing is automated by one script (install → build → publish in dependency order). Accounts with two-factor authentication need an Automation-classic token in `~/.npmrc`; granular tokens and web-login tokens are rejected by the registry for publish.

```sh
./scripts/publish.sh
```

