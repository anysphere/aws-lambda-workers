# Cursor pool-worker MicroVM image.
#
# Build time: install git + cursor-agent, start the hook server, snapshot.
# Run time: /run and /resume mint worker identity and fetch secrets. Never
# bake API keys, git tokens, or unique worker IDs into this snapshot.
ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

RUN dnf install -y --setopt=install_weak_deps=0 \
      bash unzip tar gzip git ca-certificates findutils \
      nodejs npm python3 shadow-utils \
      $(command -v curl >/dev/null 2>&1 || echo curl) && \
    dnf clean all && \
    node --version && \
    git --version

# Latest cursor-agent at image build (same spirit as baking the CLI into
# the Cloudflare container). The binary is `agent`; we also alias cursor-agent.
RUN curl -fsSL https://cursor.com/install | bash && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent && \
    (command -v agent || command -v cursor-agent)

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
ENV HOOK_PORT=9000
WORKDIR /opt/cursor

COPY package.json /opt/cursor/hooks/package.json
RUN cd /opt/cursor/hooks && npm install --omit=dev

COPY hooks.mjs /opt/cursor/hooks/hooks.mjs
COPY entrypoint.sh /opt/cursor/entrypoint.sh
RUN chmod +x /opt/cursor/entrypoint.sh /opt/cursor/hooks/hooks.mjs

# Workspaces are created at /run, not at image build, so each MicroVM gets
# a unique clone + worker identity.
RUN mkdir -p /opt/cursor/workspaces /opt/cursor/cache

# Start the hook server so /ready can succeed and the snapshot captures it.
ENTRYPOINT ["node", "/opt/cursor/hooks/hooks.mjs"]
