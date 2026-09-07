# Dockerfile — builds the 24/7 agent worker environment (vision: ws plan get agent-system-vision-v2).
#
# Design: the image contains only the RUNTIME (node, git, gh, claude CLI, bootstrap
# entrypoint). The workspace repo itself is cloned/pulled AT RUNTIME into a volume —
# GitHub stays the single source of truth and a merged PR is picked up by a `git pull`,
# no image rebuild needed (the vision's hot-reload path).
#
# Build:  docker compose build
# Run:    docker compose up -d          (needs .env — see .env.example)
# Docs:   docs/container-runtime.md

# Base major is asserted by cli/test/runtime-version.test.js: `engines.node` must agree
# with it and `@types/node` must never resolve ahead of it (typecheck would then approve
# APIs production lacks). Moving this line means moving those together.
FROM node:26-bookworm-slim

# Base tools + GitHub CLI (gh drives the PR workflow and provides git credentials from GITHUB_TOKEN)
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates tzdata procps jq \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Scheduling is `ws scheduler` (cli/ws.js + cli/util/scheduler.js, from the cloned repo).

# AI CLI — current provider. The provider seam at runtime is cli/util/agent.js;
# swapping providers means changing this line and adding a case branch there.
RUN npm install -g @anthropic-ai/claude-code

# Bootstrap entrypoint is baked in (it must exist before the repo is cloned).
# Everything else it runs comes from the cloned workspace repo.
COPY setup-scripts/container/entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod +x /usr/local/bin/agent-entrypoint \
    # pre-create the volume mountpoint owned by node, or the named volume arrives root-owned
    && mkdir -p /home/node/sources && chown node:node /home/node/sources

USER node
WORKDIR /home/node
ENV HOME=/home/node

ENTRYPOINT ["agent-entrypoint"]
