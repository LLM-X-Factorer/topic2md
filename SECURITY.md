# Security Policy

## Supported Versions

The `main` branch is the only supported line. `topic2md` is pre-1.0; we don't
backport fixes to older tags.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Report via one of:

1. **Preferred — GitHub private security advisory**:
   https://github.com/LLM-X-Factorer/topic2md/security/advisories/new
2. Email the maintainer (see GitHub profile of the most recent committer on
   `main`).

Include:

- A description of the issue and why it's exploitable.
- Steps to reproduce, ideally a minimal POC.
- The commit or release you reproduced against.
- Your disclosure timeline preference (we default to 90 days).

Expect an acknowledgement within **3 business days** and a triage decision
within **7 days**. Fix timelines vary by severity; we aim for coordinated
disclosure.

## In Scope

This project integrates several external services and runs a long-running
background pipeline from user input. Classes of issue we consider security
vulnerabilities:

- **Credential or key exposure** in logs, error responses, or committed
  artifacts.
- **SSRF / arbitrary URL fetching** — the image pipeline fetches URLs from
  third-party pages; finding a way to use this as an internal-network probe is
  in scope.
- **Prompt injection → server-side effects** — if content discovered by a
  source plugin can cause the LLM to emit tool calls or shell-executable
  output that escalates into side effects, that's in scope.
- **Denial of service via expensive external calls** — e.g. abuse paths that
  cause unbounded Replicate / OpenRouter / Tavily spend on a self-hosted
  instance.
- **Auth/authz on the web UI** if/when auth is added (it currently isn't —
  the web UI is designed for single-user self-hosting).
- **Dependency vulnerabilities** we haven't caught that have known exploits
  in our usage path.

## Out of Scope

- Issues that require the attacker to already have write access to the host.
- Theoretical issues without a concrete exploit path.
- Findings against the upstream services themselves (OpenRouter, Tavily,
  Replicate, Langfuse) — report those to the respective vendor.
- Running `topic2md` with leaked / shared API keys you obtained elsewhere.
- Social-engineering attacks on maintainers.

## Hardening Recommendations for Operators

If you self-host the web UI:

- Treat it as single-tenant. Don't expose `/api/run` to the public internet
  without auth + rate-limiting.
- Rotate API keys periodically; scope them to the minimum needed.
- Keep `data.db` out of publicly served paths.
- If you add auth, audit it — we don't ship one by default.
