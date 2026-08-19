# Cursor pool-worker MicroVM image.
#
# Build time: install git + cursor-agent, start the tiny /run hook, snapshot.
# Run time: /run receives pool/repo/key and starts entrypoint.sh.
ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

RUN dnf install -y --setopt=install_weak_deps=0 \
      bash unzip tar gzip git ca-certificates findutils \
      nodejs python3 shadow-utils \
      $(command -v curl >/dev/null 2>&1 || echo curl) && \
    dnf clean all && \
    git --version

RUN curl -fsSL https://cursor.com/install | bash && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent && \
    (command -v agent || command -v cursor-agent)

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
ENV HOOK_PORT=9000
WORKDIR /opt/cursor

COPY hook.mjs /opt/cursor/hook.mjs
COPY entrypoint.sh /opt/cursor/entrypoint.sh
RUN chmod +x /opt/cursor/entrypoint.sh /opt/cursor/hook.mjs && \
    mkdir -p /opt/cursor/workspaces

ENTRYPOINT ["node", "/opt/cursor/hook.mjs"]
