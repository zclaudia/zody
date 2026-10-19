#!/usr/bin/env bash

set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-zcode-desktop-e2e-demo}"
DOCKERFILE="${DOCKERFILE:-Dockerfile.desktop-e2e}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
PNPM_VERSION="${PNPM_VERSION:-10.33.2}"
DEFAULT_E2E_SPEC="./test/e2e/container-boot.test.ts,./test/e2e/smoke.test.ts,./test/e2e/e2ecase-regression.test.ts,./test/e2e/upstream-provider.test.ts,./test/e2e/task-list-archive-confirmation.test.ts"
# 修复原因：formal/local replay 通过不等于 Docker admission；Assistant Preview Cards 的容器尝试
# 停在镜像解析阶段，CDD01 则在 WDIO 内失败；两者都没有 replay-isolated 绿色证据。
CONVERSATION_SESSION_VERIFIED_E2E_SPEC=""
# 只有通过人工 review、formal promotion 和单 spec Docker admission 的插件用例才能写入。
PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC=""
E2E_SPEC_PRESET="${E2E_SPEC_PRESET:-}"
# F0.3 断网验收：--block-official（或 BLOCK_OFFICIAL=1）把官方域名 --add-host 到
# 容器内 sink 地址（127.0.0.1），在容器内先启动 scripts/official-request-sink.mjs
# 记录被拦请求，跑完后用 scripts/assert-official-requests.mjs 断言。
BLOCK_OFFICIAL="${BLOCK_OFFICIAL:-0}"
preset_arg=""
preset_count=0
for script_arg in "$@"; do
  case "$script_arg" in
    --block-official)
      BLOCK_OFFICIAL=1
      ;;
    *)
      preset_arg="$script_arg"
      preset_count=$((preset_count + 1))
      ;;
  esac
done
if [ "$preset_count" -gt 1 ]; then
  printf '[desktop-e2e-container] expected at most one preset argument\n' >&2
  exit 1
fi
if [ "$preset_count" -eq 1 ]; then
  if [ -n "$E2E_SPEC_PRESET" ] && [ "$E2E_SPEC_PRESET" != "$preset_arg" ]; then
    printf '[desktop-e2e-container] preset argument conflicts with E2E_SPEC_PRESET: %s != %s\n' "$preset_arg" "$E2E_SPEC_PRESET" >&2
    exit 1
  fi
  E2E_SPEC_PRESET="$preset_arg"
fi

case "$E2E_SPEC_PRESET" in
  "" | default)
    PRESET_E2E_SPEC="$DEFAULT_E2E_SPEC"
    ;;
  conversation-session-verified)
    if [ -z "$CONVERSATION_SESSION_VERIFIED_E2E_SPEC" ]; then
      printf '[desktop-e2e-container] No V4 conversation-session spec has Docker replay-isolated admission evidence; run a formal spec with E2E_SPEC first, then use e2e:docker:admit after it passes.\n' >&2
      exit 2
    fi
    PRESET_E2E_SPEC="$CONVERSATION_SESSION_VERIFIED_E2E_SPEC"
    ;;
  plugins-verified)
    if [ -z "$PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC" ]; then
      printf '[desktop-e2e-container] No plugin-management spec has completed human review and Docker admission; run a promoted formal spec with E2E_SPEC first, then use e2e:docker:admit:plugins.\n' >&2
      exit 2
    fi
    PRESET_E2E_SPEC="$PLUGIN_MANAGEMENT_VERIFIED_E2E_SPEC"
    ;;
  *)
    printf '[desktop-e2e-container] unsupported E2E_SPEC_PRESET: %s\n' "$E2E_SPEC_PRESET" >&2
    printf '[desktop-e2e-container] expected one of: default, conversation-session-verified, plugins-verified\n' >&2
    exit 1
    ;;
esac
E2E_SPEC="${E2E_SPEC:-$PRESET_E2E_SPEC}"
E2E_NETWORK_MODE="${E2E_NETWORK_MODE:-replay-isolated}"
SHM_SIZE="${SHM_SIZE:-2g}"
DEFAULT_DRIVER_CACHE_VOLUME="zcode-desktop-e2e-driver-cache-${DOCKER_PLATFORM//\//-}"
DRIVER_CACHE_VOLUME="${DRIVER_CACHE_VOLUME:-$DEFAULT_DRIVER_CACHE_VOLUME}"
DRIVER_CACHE_DIR="${DRIVER_CACHE_DIR:-/workspace/.cache/wdio-browser-drivers}"
DRIVER_PREFETCH_TIMEOUT="${DRIVER_PREFETCH_TIMEOUT:-300}"
E2E_RUN_ID="${ZCODE_E2E_RUN_ID:-desktop-e2e-$(date -u +%Y%m%d-%H%M%S)-$$}"
E2E_ARTIFACT_ROOT="${E2E_ARTIFACT_ROOT:-$PWD/packages/desktop/.e2e-artifacts}"
HOST_ARTIFACT_DIR="${E2E_ARTIFACT_DIR:-$E2E_ARTIFACT_ROOT/$E2E_RUN_ID}"
CONTAINER_ARTIFACT_DIR="/workspace/packages/desktop/.e2e-artifacts/$E2E_RUN_ID"
CONTAINER_NETWORK_CAPTURE_DIR="$CONTAINER_ARTIFACT_DIR/network-capture"
CONTAINER_NAME="${CONTAINER_NAME:-zcode-desktop-e2e-${E2E_RUN_ID}}"
PERF_SAMPLE_INTERVAL_SECONDS="${PERF_SAMPLE_INTERVAL_SECONDS:-3}"
CONTAINER_STATS_PATH="$HOST_ARTIFACT_DIR/perf/container-samples.ndjson"

log() {
  printf '[desktop-e2e-container] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[desktop-e2e-container] missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

require_command docker

if ! docker info >/dev/null 2>&1; then
  printf '[desktop-e2e-container] Docker daemon is not reachable; please start Docker and retry.\n' >&2
  exit 1
fi

if [ ! -f "$DOCKERFILE" ]; then
  printf '[desktop-e2e-container] Dockerfile not found: %s\n' "$DOCKERFILE" >&2
  exit 1
fi

case "$E2E_NETWORK_MODE" in
  replay-isolated | bridge | capture)
    ;;
  *)
    printf '[desktop-e2e-container] unsupported E2E_NETWORK_MODE: %s\n' "$E2E_NETWORK_MODE" >&2
    printf '[desktop-e2e-container] expected one of: replay-isolated, bridge, capture\n' >&2
    exit 1
    ;;
esac

if [ "$E2E_NETWORK_MODE" = "replay-isolated" ] && [ "${E2E_PROVIDER_HTTP_MODE:-replay}" = "capture" ]; then
  printf '[desktop-e2e-container] replay-isolated cannot be used with E2E_PROVIDER_HTTP_MODE=capture\n' >&2
  exit 1
fi

if [ "$E2E_NETWORK_MODE" = "capture" ]; then
  if [ -z "${E2E_PROVIDER_API_KEY:-}" ] || [ "${E2E_PROVIDER_API_KEY:-}" = "xxx" ]; then
    printf '[desktop-e2e-container] E2E_NETWORK_MODE=capture requires a real E2E_PROVIDER_API_KEY\n' >&2
    exit 1
  fi
  if [ "${E2E_PROVIDER_PRESET:-env}" = "env" ] && [ -z "${E2E_PROVIDER_BASE_URL:-}" ]; then
    printf '[desktop-e2e-container] E2E_NETWORK_MODE=capture requires E2E_PROVIDER_BASE_URL\n' >&2
    exit 1
  fi
fi

mkdir -p "$HOST_ARTIFACT_DIR/perf" "$HOST_ARTIFACT_DIR/network-capture"

if [ "${SKIP_IMAGE_BUILD:-0}" = "1" ]; then
  if ! docker image inspect "${IMAGE_NAME}:latest" >/dev/null 2>&1; then
    printf '[desktop-e2e-container] SKIP_IMAGE_BUILD=1 but image not found: %s:latest\n' "$IMAGE_NAME" >&2
    exit 1
  fi
  log "skipping image build for ${IMAGE_NAME}:latest"
else
  log "building ${IMAGE_NAME}:latest with ${DOCKERFILE} for ${DOCKER_PLATFORM}"
  DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}" docker build \
    --platform "$DOCKER_PLATFORM" \
    -f "$DOCKERFILE" \
    --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
    -t "${IMAGE_NAME}:latest" \
    .
fi

if [ "${SKIP_DRIVER_PREFETCH:-0}" != "1" ]; then
  log "prefetching Chromedriver into volume ${DRIVER_CACHE_VOLUME}"
  docker run \
    --rm \
    --platform "$DOCKER_PLATFORM" \
    -e "DRIVER_PREFETCH_TIMEOUT=${DRIVER_PREFETCH_TIMEOUT}" \
    -e "WDIO_BROWSER_DRIVER_CACHE_DIR=${DRIVER_CACHE_DIR}" \
    -v "${DRIVER_CACHE_VOLUME}:${DRIVER_CACHE_DIR}" \
    "${IMAGE_NAME}:latest" \
    bash -lc '
      set -euo pipefail
      version="${CHROMEDRIVER_VERSION:-$(node -e "const { electronToChromium } = require(\"electron-to-chromium\"); const pkg = require(\"./packages/desktop/package.json\"); console.log(electronToChromium(pkg.devDependencies.electron));")}"
      echo "Chromedriver version: ${version}"
      timeout "${DRIVER_PREFETCH_TIMEOUT}s" pnpm exec browsers install "chromedriver@${version}" --path "${WDIO_BROWSER_DRIVER_CACHE_DIR}" --format "{{browser}}@{{buildId}} {{path}}"
    '
fi

docker_run_args=(
  --name "$CONTAINER_NAME"
  --platform "$DOCKER_PLATFORM"
  --shm-size "$SHM_SIZE"
  -e CI=1
  -e ZCODE_E2E_CONTAINER=1
  -e "ZCODE_E2E_RUN_ID=${E2E_RUN_ID}"
  -e "ZCODE_E2E_ARTIFACT_DIR=${CONTAINER_ARTIFACT_DIR}"
  -e "ZCODE_E2E_NETWORK_CAPTURE_DIR=${CONTAINER_NETWORK_CAPTURE_DIR}"
  -e "ZCODE_E2E_SPEC=${E2E_SPEC}"
  -v "${DRIVER_CACHE_VOLUME}:${DRIVER_CACHE_DIR}"
  -v "${HOST_ARTIFACT_DIR}:${CONTAINER_ARTIFACT_DIR}"
)

case "$E2E_NETWORK_MODE" in
  replay-isolated)
    docker_run_args+=(--network none)
    docker_run_args+=(-e "E2E_PROVIDER_HTTP_MODE=replay")
    ;;
  bridge)
    docker_run_args+=(-e "E2E_PROVIDER_HTTP_MODE=${E2E_PROVIDER_HTTP_MODE:-replay}")
    ;;
  capture)
    docker_run_args+=(-e "E2E_PROVIDER_HTTP_MODE=capture")
    ;;
esac

if [ -n "${EXTRA_WDIO_ARGS:-}" ]; then
  docker_run_args+=(-e "EXTRA_WDIO_ARGS=${EXTRA_WDIO_ARGS}")
fi

if [ -n "${E2E_PROVIDER_API_KEY:-}" ]; then
  docker_run_args+=(-e "E2E_PROVIDER_API_KEY=${E2E_PROVIDER_API_KEY}")
fi

# 修复：E2E 上游供应商由环境变量配置后，容器只转发了 API key，抓包模式拿不到上游地址与模型必然失败。
for provider_env_name in E2E_PROVIDER_BASE_URL E2E_PROVIDER_MODEL E2E_PROVIDER_SECONDARY_MODEL \
  E2E_PROVIDER_PRESET E2E_PROVIDER_THOUGHT_LEVEL E2E_PROVIDER_SECONDARY_THOUGHT_LEVEL; do
  if [ -n "${!provider_env_name:-}" ]; then
    docker_run_args+=(-e "${provider_env_name}=${!provider_env_name}")
  fi
done

# F2.11：本机/CI 在模拟环境（如 arm64 宿主机跑 amd64 容器）里 Electron renderer 冷启动
# 可能超过 wdio.conf.ts 的默认 WebDriver 请求超时（会话创建 POST 30s 即超时）。转发
# wdio.conf.ts 已支持的请求限流旋钮，让慢环境显式调大而不是改默认值。
for webdriver_limit_env_name in ZCODE_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS ZCODE_E2E_WEBDRIVER_REQUEST_RETRY_COUNT; do
  if [ -n "${!webdriver_limit_env_name:-}" ]; then
    docker_run_args+=(-e "${webdriver_limit_env_name}=${!webdriver_limit_env_name}")
  fi
done

# F0.3：--block-official 时从官方域名词表（scripts/lib/official-domains.mjs）生成
# --add-host 清单，把官方域名解析到容器内 sink 地址。sink 与 E2E 同容器、监听容器内
# 80/443，因此 --network none（replay-isolated 默认）下同样生效。生成失败直接中止：
# 不允许「以为在断网验收、实际屏蔽清单为空」地跑容器。
OFFICIAL_REQUEST_SINK_ADDRESS="${OFFICIAL_REQUEST_SINK_ADDRESS:-127.0.0.1}"
if [ "$BLOCK_OFFICIAL" = "1" ]; then
  OFFICIAL_HOST_BLOCKLIST="$(node scripts/generate-official-blocklist.mjs \
    --format add-host --sink-address "$OFFICIAL_REQUEST_SINK_ADDRESS")"
  official_host_count="$(printf '%s\n' "$OFFICIAL_HOST_BLOCKLIST" | wc -l | tr -d ' ')"
  log "blocking ${official_host_count} official host(s) -> ${OFFICIAL_REQUEST_SINK_ADDRESS} (in-container official-request-sink)"
  while IFS= read -r host_map; do
    [ -n "$host_map" ] || continue
    docker_run_args+=(--add-host "$host_map")
  done <<EOF
$OFFICIAL_HOST_BLOCKLIST
EOF
fi

sample_container_stats() {
  while true; do
    if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
      stats_json="$(docker stats --no-stream --format '{{json .}}' "$CONTAINER_NAME" 2>/dev/null || true)"
      if [ -n "$stats_json" ]; then
        printf '{"capturedAt":"%s","stats":%s}\n' \
          "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          "$stats_json" >> "$CONTAINER_STATS_PATH"
      fi
    fi
    sleep "$PERF_SAMPLE_INTERVAL_SECONDS"
  done
}

cleanup_container() {
  if [ -n "${stats_sampler_pid:-}" ]; then
    kill "$stats_sampler_pid" >/dev/null 2>&1 || true
    wait "$stats_sampler_pid" >/dev/null 2>&1 || true
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

trap cleanup_container EXIT
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

if [ "$BLOCK_OFFICIAL" = "1" ]; then
  SINK_LOG_IN_CONTAINER="${CONTAINER_ARTIFACT_DIR}/official-requests.jsonl"
  # 覆盖镜像 CMD：先启动 sink（写进挂载的 artifact 目录，宿主机在
  # $HOST_ARTIFACT_DIR/official-requests.jsonl 读取），就绪检查失败立即退出；
  # E2E 结束向 sink 发 SIGINT 冲刷文件，容器退出码取 E2E 的。
  # 容器侧变量（\$SINK_PID 等）由容器 shell 求值；路径在此处展开，不含引号字符。
  container_command="node /workspace/scripts/official-request-sink.mjs --output '${SINK_LOG_IN_CONTAINER}' & SINK_PID=\$!; sleep 1; kill -0 \$SINK_PID 2>/dev/null || { echo '[official-request-sink] sink exited at startup (port conflict or script missing in image?)' >&2; exit 90; }; E2E_STATUS=0; dbus-run-session -- pnpm --filter @zcode/desktop test:e2e \${EXTRA_WDIO_ARGS:-} || E2E_STATUS=\$?; kill -INT \$SINK_PID 2>/dev/null || true; wait \$SINK_PID 2>/dev/null || true; exit \$E2E_STATUS"
  log "running ${E2E_SPEC}; network=${E2E_NETWORK_MODE}; official-request sink ON; artifacts: ${HOST_ARTIFACT_DIR}"
  sample_container_stats &
  stats_sampler_pid=$!
  container_status=0
  docker run "${docker_run_args[@]}" "${IMAGE_NAME}:latest" bash -lc "$container_command" || container_status=$?
else
  log "running ${E2E_SPEC}; network=${E2E_NETWORK_MODE}; artifacts: ${HOST_ARTIFACT_DIR}"
  sample_container_stats &
  stats_sampler_pid=$!
  container_status=0
  docker run "${docker_run_args[@]}" "${IMAGE_NAME}:latest" || container_status=$?
fi

if [ "$BLOCK_OFFICIAL" = "1" ]; then
  # 断言 sink 记录：默认 report 只观察；阶段验收用
  # OFFICIAL_REQUESTS_ASSERT_MODE=empty（必须无官方请求）
  # 或 OFFICIAL_REQUESTS_ASSERT_MODE=whitelist + OFFICIAL_REQUESTS_ALLOW=<逗号分隔主机名>
  # （仅白名单，如放行 BYOK 直连的公开 API 主机，见 scripts/lib/official-domains.mjs）。
  OFFICIAL_REQUESTS_ASSERT_MODE="${OFFICIAL_REQUESTS_ASSERT_MODE:-report}"
  assert_args=("${HOST_ARTIFACT_DIR}/official-requests.jsonl" --mode "$OFFICIAL_REQUESTS_ASSERT_MODE")
  if [ -n "${OFFICIAL_REQUESTS_ALLOW:-}" ]; then
    assert_args+=(--allow "$OFFICIAL_REQUESTS_ALLOW")
  fi
  assert_status=0
  if ! node scripts/assert-official-requests.mjs "${assert_args[@]}"; then
    assert_status=1
  fi
  if [ "$container_status" -ne 0 ]; then
    exit "$container_status"
  fi
  exit "$assert_status"
fi

# 非 --block-official 路径：docker run 的退出码经 container_status 显式透传
# （`|| container_status=$?` 赋值本身恒为 0，不能靠隐式状态退出）。
exit "$container_status"
