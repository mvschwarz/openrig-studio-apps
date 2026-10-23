# The Observatory image: the Studio SDK at a pinned public commit, plus the observatory app and its
# provider from the checkout this rig is started from (the build context is the repository root).
FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

ARG SDK_REPO=https://github.com/mvschwarz/openrig-studio.git
ARG SDK_COMMIT=e7346bbdbd01539e6003ccccb38c44763236545b

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Fetch exactly the pinned commit, and refuse to build if something else arrived.
RUN git init -q /studio/sdk \
 && git -C /studio/sdk fetch -q --depth 1 "$SDK_REPO" "$SDK_COMMIT" \
 && git -C /studio/sdk checkout -q FETCH_HEAD \
 && test "$(git -C /studio/sdk rev-parse HEAD)" = "$SDK_COMMIT"

COPY apps/observatory /studio/apps/apps/observatory
COPY providers/studio-observatory /studio/apps/providers/studio-observatory
COPY providers/shared /studio/apps/providers/shared

# The SDK's install tool installs the APP, not its provider's dependencies; provisioning does
# those separately, so this step does too. The observatory provider has no dependencies today,
# and the step says so rather than skipping silently.
RUN printf '{"apps":[],"appsRoot":"/studio/apps","port":9440}\n' > /studio/studio.json \
 && for p in $(node /studio/sdk/provision/needed-providers.mjs /studio/apps observatory); do \
      dir="/studio/apps/providers/$p"; \
      if [ -f "$dir/package-lock.json" ]; then npm ci --prefix "$dir" --omit=dev --no-audit --no-fund; \
      elif node -e "process.exit(Object.keys(require('$dir/package.json').dependencies || {}).length ? 0 : 1)"; then npm install --prefix "$dir" --omit=dev --no-audit --no-fund; \
      else echo "provider $p: no dependencies to install"; fi; \
    done \
 && cd /studio/sdk && OPENRIG_STUDIO_DIR=/studio node tools/install-app.mjs /studio/apps/apps/observatory --enable \
 && mkdir -p /data && chown -R node:node /studio /data

LABEL org.opencontainers.image.title="openrig-observatory-studio" \
      openrig.observatory.sdk-commit="$SDK_COMMIT"

ENV OPENRIG_STUDIO_DIR=/studio
USER node
WORKDIR /studio/sdk
CMD ["node", "tools/studio.mjs", "--port", "9440"]
