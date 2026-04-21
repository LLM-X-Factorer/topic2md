---
name: Bug report
about: Report something that is wrong, broken, or behaving unexpectedly
title: '[bug] '
labels: bug
assignees: ''
---

## What happened

<!-- What did you observe? Keep it short and specific. -->

## What you expected

<!-- One or two sentences. -->

## Reproducer

<!-- Smallest steps that reliably trigger the bug. Include topic / CLI args / config. -->

```
pnpm topic2md "<your topic>" --model <id>
```

## Environment

- topic2md commit or tag:
- Node version: `node --version`
- pnpm version: `pnpm --version`
- OS + arch:
- Running mode: [ ] CLI [ ] Web UI [ ] Docker
- Models involved (OpenRouter id):

## Relevant logs / stack

<!--
Paste `pnpm topic2md "..." --verbose` output if possible.
Redact API keys.
Don't pipe long logs through tail/head — the full stderr helps.
-->

```
(paste here)
```

## Extra context

<!-- Screenshots, SQL from data.db, links to failing CI runs, whatever helps. -->
