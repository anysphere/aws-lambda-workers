# Cursor pool-worker MicroVM image.
#
# ENTRYPOINT clones the workspace if needed and execs
# `cursor-agent worker start --pool`. No lifecycle-hook HTTP server.
ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

RUN dnf install -y --setopt=install_weak_deps=0 \
      bash tar gzip git ca-certificates findutils \
      awscli shadow-utils \
      $(command -v curl >/dev/null 2>&1 || echo curl) && \
    dnf clean all && \
    git --version

RUN curl -fsSL https://cursor.com/install | bash && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent && \
    (command -v agent || command -v cursor-agent)

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
WORKDIR /opt/cursor

COPY entrypoint.sh /opt/cursor/entrypoint.sh
RUN chmod +x /opt/cursor/entrypoint.sh && mkdir -p /opt/cursor/workspaces

ENTRYPOINT ["/opt/cursor/entrypoint.sh"]
