# Deployment Guide

How to get the `topic2md` Web UI running on a server you control. Covers
sizing, required accounts, Docker setup, TLS, and hardening.

## Is this for you?

Use this guide if you want to self-host the Web UI (`apps/web`) so yourself
or a small team can trigger article generation from a browser.

**Not covered here**: running only the CLI (just `pnpm install && pnpm topic2md`
— see the root README), or running as a managed SaaS (you'd need user auth,
quota enforcement, and a job queue; all out of scope for v0.2).

## Architecture note: this is NOT serverless-friendly

A single run takes **60-200s** (research → outline → sections with parallel
LLM calls → image discovery + CLIP gating + vision rerank → assembly).
Platforms with synchronous function-timeout limits shorter than that don't
fit, including:

- **Vercel** — 60s default / 300s on Pro (Pro plans edge into feasibility but
  Chromium for image-screenshot plugin won't run on serverless anyway)
- **Cloudflare Workers** — no filesystem, no Chromium, no long requests
- **Netlify Functions** — same story

Use a long-running host: a plain VPS, Fly.io / Railway / Render app container,
or self-hosted Kubernetes.

## Sizing

| Shape                           | vCPU | RAM    | Disk      | Fit                                                                                                                                               |
| ------------------------------- | ---- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single user / self-host**     | 1    | 2 GB   | 20 GB SSD | Personal use, 1 article at a time                                                                                                                 |
| **Small team** (2-5 concurrent) | 2-4  | 4-8 GB | 40 GB SSD | Shared dashboard for a pod                                                                                                                        |
| **Public SaaS**                 | —    | —      | —         | Not supported out of the box. Needs a queue (Redis + BullMQ), per-user API-key isolation, and rate limits. Don't expose `/api/run` synchronously. |

Disk grows with `out/` (markdown + PDFs + downloaded images) and `data.db`
(run history + CLIP embedding cache). Budget ~10 MB per article.

Memory peaks during the images step (Chromium launched by
`@topic2md/image-screenshot`): ~300-500 MB extra while it runs.

## Recommended providers

Any of these fit the single-user / small-team shape:

- **[Hetzner Cloud](https://www.hetzner.com/cloud)** CX22 — €4.59/mo, 2 vCPU
  / 4 GB / 40 GB. Best price/performance in Europe.
- **Aliyun ECS** (阿里云) t5.small — ¥50-100/mo, 2 vCPU / 2 GB. China-region
  compliance.
- **DigitalOcean** Basic Droplet 2 GB — $12/mo, 2 vCPU / 2 GB / 60 GB.
- **[Fly.io](https://fly.io)** shared-cpu-1x / 1 GB — ~$5/mo, Docker-native
  deploy via `fly launch`.

## What you need to provide

### 1. Server basics

- Linux VM (Ubuntu 22.04+ or Debian 12+ recommended; Docker-ready)
- Domain name + DNS A record pointing at the VM
- TLS certificate (Let's Encrypt via Caddy or certbot — both free)
- Reverse proxy (Caddy is 2 lines of config; nginx + certbot if you prefer)

### 2. External API keys

| Service        | Required    | Use                                      | Cost at 1 article/day                    |
| -------------- | ----------- | ---------------------------------------- | ---------------------------------------- |
| **OpenRouter** | ✅          | LLM gateway (MiniMax / Claude / GPT / …) | ~$3-10/mo with MiniMax M2.7              |
| **Tavily**     | ✅          | Web research source                      | Free tier 1000 queries/mo; $30/mo paid   |
| **Replicate**  | recommended | CLIP relevance gate (`jina-clip-v2`)     | ~$5-10/mo after embedding cache kicks in |
| **Perplexity** | optional    | Alternate research source                | ~$5/mo starter                           |
| **Langfuse**   | optional    | Observability (per-step traces)          | Free tier or self-host                   |

Accounts take 5-10 min each. Keys go into `.env`. Missing optional keys
cleanly degrade (Replicate absent → CLIP gate bypasses; Langfuse absent →
no traces).

### 3. Budget summary (single user)

- VPS: **$5-15/mo**
- API usage (1 article/day): **$10-25/mo** depending on model and whether
  Replicate is enabled

**Total: ~$15-40/mo.**

## Docker deployment (recommended)

The repo ships a `Dockerfile` and `docker-compose.yml` that Just Work.

```bash
# On your VPS, as the deploy user
git clone https://github.com/LLM-X-Factorer/topic2md.git
cd topic2md
cp .env.example .env
$EDITOR .env                     # fill in OPENROUTER_API_KEY + TAVILY_API_KEY at minimum
docker compose up -d
curl -fsS http://localhost:3000  # smoke check
```

That's it for the app side. The image is based on the official Playwright
runtime so Chromium + dependencies are baked in.

Images also auto-publish to GHCR from `main`:
`ghcr.io/llm-x-factorer/topic2md:main`. If you'd rather pull than build:

```yaml
# docker-compose.yml
services:
  topic2md:
    image: ghcr.io/llm-x-factorer/topic2md:main
    ports: ['3000:3000']
    env_file: .env
    volumes:
      - ./out:/app/out
      - ./data.db:/app/data.db
    restart: unless-stopped
```

### Persistent volumes — don't skip these

Two paths need to outlive container rebuilds:

- `./out` — generated markdown, PDFs, `_pdf_assets/` image cache
- `./data.db` (+ `.db-wal` + `.db-shm` sidecars) — run history, CLIP
  embedding cache

Mount both as volumes in `docker-compose.yml` (already set up in the repo's
default). Without `data.db` mounted, every container restart loses run
history and forces Replicate to re-embed every candidate.

## Reverse proxy + TLS

### Caddy (easiest)

Install Caddy, then:

```caddyfile
topic2md.yourdomain.com {
    reverse_proxy localhost:3000
}
```

That's it. Caddy handles Let's Encrypt automatically.

### nginx + certbot

```nginx
server {
    server_name topic2md.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Runs are long — bump proxy timeouts from the default 60s
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Then `sudo certbot --nginx -d topic2md.yourdomain.com` to get TLS.

**The `proxy_read_timeout` bump is not optional** — without it, nginx
closes the connection after 60s and the browser shows an error even though
the backend is still working.

## Hardening (read this before going public)

The Web UI has **no built-in auth**. If you reverse-proxy it to the public
internet without changes, anyone who finds the URL can trigger runs that
hit your OpenRouter / Tavily / Replicate accounts.

Pick at least one of:

1. **Don't expose it publicly.** Bind Docker to `127.0.0.1:3000` and access
   via SSH tunnel / Tailscale / WireGuard.
2. **Put it behind basic auth** at the reverse-proxy layer:
   - Caddy: `basicauth { user HASHED_PASSWORD }`
   - nginx: `auth_basic` + `htpasswd`
3. **Add real auth** as a fork. The API surface is `/api/run` — any auth
   middleware that gates it works.

Other sensible defaults:

- Run Docker as a non-root user (the Playwright base image does this already).
- `.env` mode `600`, owned by the deploy user, not in git.
- Set per-run spending alerts in your OpenRouter / Replicate dashboards —
  a buggy loop + real API keys can get expensive fast.
- Rotate API keys at least quarterly.

## Observability

`LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` turn on tracing per run (one
trace per `runTopic2md` invocation, 6 spans for the workflow steps,
`generation.*` sub-spans for LLM calls). Absent ⇒ zero overhead.

Self-hosted Langfuse also works — set `LANGFUSE_HOST` to your instance URL.

For just "is the service up?", `GET /` returns the Next.js root and is a
usable healthcheck. The Dockerfile doesn't ship a `HEALTHCHECK` directive
yet; add one in your `docker-compose.yml` if you want container-level
restarts on failure:

```yaml
healthcheck:
  test: ['CMD-SHELL', 'curl -fsS http://localhost:3000/ || exit 1']
  interval: 30s
  timeout: 5s
  retries: 3
```

## Upgrading

```bash
cd topic2md
git pull
docker compose pull         # if using GHCR image
docker compose up -d        # or `up -d --build` if building locally
```

Stage bumps go in `CHANGELOG.md`. Watch for any `## Changed` or `## Removed`
lines when upgrading — those are where user-facing breaks land.

Database migrations are idempotent `ALTER TABLE ADD COLUMN` statements in
`openDatabase` (see `packages/core/src/persistence.ts`); no manual migration
step is needed on upgrade.

## Troubleshooting

**Run hangs at "images" for minutes on first Replicate-enabled run.**
That's the CLIP container cold-starting (~80-120s). Subsequent runs within
the same hour hit a warm container and complete in seconds. The entry-point
warmup fires in parallel with research / outline, so the perceived delay is
smaller than the raw cold-start.

**Run completes but `data.db` doesn't update.**
Check the volume mount. With `better-sqlite3` the `-wal` and `-shm`
sidecars need to coexist in the same directory as `data.db`; a bind mount
on just the `.db` file doesn't work. Mount the parent directory.

**"Replicate HTTP 403" on specific URLs.**
Some image hosts (e.g. MDPI figures) block Replicate's fetch User-Agent.
That URL falls through the gate as `score=null` and is dropped — expected
behavior, not a bug.

**Image step finishes with 0 images attached, but logs show "CLIP gate kept N/M".**
Vision rerank deliberately rejected all candidates (`pickIndex=-1`) because
none were a good enough match. The "宁缺毋滥" design preserves the empty
over a confusing fallback. Rerun with a slightly different `--background`
or topic phrasing if you need the image.

## Getting help

- Bug? Open a [GitHub issue](https://github.com/LLM-X-Factorer/topic2md/issues)
  using the bug-report template.
- Security concern? See [`SECURITY.md`](../SECURITY.md).
- Want to contribute? [`CONTRIBUTING.md`](../CONTRIBUTING.md).
