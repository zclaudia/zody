# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.14.0-alpine
FROM ${NODE_IMAGE}

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG MBEARS_NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG INSTALL_CA_CERTIFICATES=false
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /repo

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN if [ "${INSTALL_CA_CERTIFICATES}" = "true" ]; then \
    if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache ca-certificates; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && \
      apt-get install -y --no-install-recommends ca-certificates && \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
  fi
RUN if command -v apk >/dev/null 2>&1; then \
    apk add --no-cache python3 make g++ cmake; \
  elif command -v apt-get >/dev/null 2>&1; then \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ cmake && \
    rm -rf /var/lib/apt/lists/*; \
  else \
    echo "A supported package manager is required for native build dependencies" >&2; exit 1; \
  fi
RUN corepack enable

# 根 workspace 是唯一安装所有者；保持锁、补丁与所有 workspace manifest 同步。
COPY . .

RUN --mount=type=cache,id=zcode-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && \
  pnpm config set @mbears:registry ${MBEARS_NPM_CONFIG_REGISTRY} && \
  pnpm config set fetch-retries 5 && \
  pnpm config set fetch-retry-maxtimeout 120000 && \
  pnpm config set fetch-timeout 300000 && \
  pnpm --filter '{./apps/zody-cli/packages/*}...' --filter '{./apps/zody-cli/tools/*}...' \
    --filter zody --filter zody-cli install --frozen-lockfile

RUN pnpm --dir apps/zody-cli build

ENTRYPOINT ["node", "--import", "tsx", "apps/zody-cli/e2e/compact-microcompact/run.mjs"]
