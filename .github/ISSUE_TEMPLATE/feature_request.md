---
name: Feature request
about: Propose a new plugin, workflow step, config option, or UX improvement
title: '[feat] '
labels: enhancement
assignees: ''
---

## The problem

<!-- What's the user/operator pain? Frame in terms of what's currently hard or
impossible, not in terms of "we should add X". -->

## Proposed direction

<!-- How might we address it? A sketch is fine — design happens in comments. -->

## Is this a plugin or a core change?

> Reminder: `packages/core` doesn't import plugins. New sources / image
> providers / themes / publish destinations should be new `packages/<kind>-<name>/`
> packages, not core changes. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

- [ ] New plugin (`packages/<kind>-<name>/`)
- [ ] Core workflow change (justify why it can't be a plugin)
- [ ] Web / CLI UX
- [ ] Docs / tooling / CI

## Rough size

- [ ] < 1 day
- [ ] 1-3 days
- [ ] Larger — probably needs decomposition into multiple issues

## Anything we'd break

<!-- Back-compat concerns, migration path for existing users, etc. -->
