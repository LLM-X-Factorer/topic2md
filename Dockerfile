# Uses the official Playwright image so Chromium + its system deps are
# already installed for @topic2md/image-screenshot.
FROM mcr.microsoft.com/playwright:v1.56.2-noble AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY cli/package.json cli/
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/source-tavily/package.json packages/source-tavily/
COPY packages/image-screenshot/package.json packages/image-screenshot/
COPY packages/publish-file/package.json packages/publish-file/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
CMD ["pnpm", "--filter", "@topic2md/web", "start"]
