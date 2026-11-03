FROM node:24.14.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /workspace
RUN chown node:node /workspace
COPY --chown=node:node . .
USER node

RUN pnpm install --frozen-lockfile --filter @zody/browser-use-plugin...
RUN pnpm --dir apps/zody-cli --filter @zody/browser-use-plugin... build

ENV DISPLAY=""
ENV ZCODE_HEADLESS_BROWSER_E2E_EXECUTABLE=/usr/bin/chromium
ENV ZCODE_HEADLESS_BROWSER_E2E_REQUIRED=1

CMD ["pnpm", "--dir", "apps/zody-cli", "--filter", "@zody/browser-use-plugin", "exec", "vitest", "run", "test/headless-browser.e2e.test.ts"]
