ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

RUN dnf install -y --setopt=install_weak_deps=0 \
      bash tar gzip git ca-certificates findutils awscli python3 \
      $(command -v curl >/dev/null 2>&1 || echo curl) && \
    dnf clean all

# Optional: pin a lab/main CLI, e.g. 2026.08.20-f582eb6. Empty = prod installer.
# create-microvm-image zips this directory and may not pass --build-arg;
# set the version in cursor-agent-version instead (ships in the zip).
COPY cursor-agent-version /tmp/cursor-agent-version
ARG CURSOR_AGENT_VERSION=
# Guest MicroVMs here are aarch64. The previous x64 default installed a node
# binary that failed at runtime with "cannot execute binary file".
ARG CURSOR_AGENT_ARCH=arm64
RUN VERSION="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' /tmp/cursor-agent-version | sed -e '/^$/d' | head -n 1)" && \
    VERSION="${VERSION:-${CURSOR_AGENT_VERSION:-}}" && \
    ARCH="${CURSOR_AGENT_ARCH:-arm64}" && \
    echo "installing cursor-agent ${VERSION:-prod} linux/${ARCH} (build uname=$(uname -m))" && \
    if [ -n "${VERSION}" ]; then \
      mkdir -p "/root/.local/share/cursor-agent/versions/${VERSION}" /root/.local/bin && \
      curl -fsSL "https://downloads.cursor.com/lab/${VERSION}/linux/${ARCH}/agent-cli-package.tar.gz" \
        | tar --strip-components=1 -xzf - -C "/root/.local/share/cursor-agent/versions/${VERSION}" && \
      ln -sf "/root/.local/share/cursor-agent/versions/${VERSION}/cursor-agent" /root/.local/bin/agent && \
      ln -sf "/root/.local/share/cursor-agent/versions/${VERSION}/cursor-agent" /root/.local/bin/cursor-agent; \
    else \
      curl -fsSL https://cursor.com/install | bash; \
    fi && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent && \
    rm -f /tmp/cursor-agent-version

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
ENV HOME=/root
ENV NODE_COMPILE_CACHE=/tmp/cursor-compile-cache
WORKDIR /opt/cursor
COPY entrypoint.sh hook.py /opt/cursor/
RUN chmod +x /opt/cursor/entrypoint.sh /opt/cursor/hook.py && mkdir -p /opt/cursor/workspaces
ENV HOOK_PORT=9000
ENTRYPOINT ["python3", "/opt/cursor/hook.py"]
