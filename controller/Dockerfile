# Scheduled Lambda: `agent worker controller --spawn ./spawn.sh` for 5 minutes.
# EventBridge restarts it; reserved concurrency 1 prevents overlap.
# Docker Hub Lambda Python image is amd64-only. public.ecr.aws 403s when
# BuildKit attaches a private-ECR token (`[auth] aws:: ... public.ecr.aws`).
FROM --platform=linux/amd64 amazon/aws-lambda-python:3.12

ARG TARGETARCH=amd64
ARG CURSOR_AGENT_VERSION=
ARG CURSOR_AGENT_ARCH=

# Image already has curl-minimal; installing curl conflicts. Do not `|| true`.
RUN (command -v microdnf >/dev/null && microdnf install -y tar gzip unzip findutils bash) || \
    (command -v dnf >/dev/null && dnf install -y tar gzip unzip findutils bash)

RUN ARCH="$( [ "${TARGETARCH}" = "arm64" ] && echo aarch64 || echo x86_64 )" && \
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip

# Optional: pin a lab/main CLI. Empty = prod installer. Same file as the MicroVM image.
COPY microvm-image/cursor-agent-version /tmp/cursor-agent-version
RUN VERSION="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' /tmp/cursor-agent-version | sed -e '/^$/d' | head -n 1)" && \
    VERSION="${VERSION:-${CURSOR_AGENT_VERSION:-}}" && \
    ARCH="${CURSOR_AGENT_ARCH:-$( [ "${TARGETARCH}" = "arm64" ] && echo arm64 || echo x64 )}" && \
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
    chmod a+x /root && chmod -R a+rX /root/.local && \
    if [ -d /root/.cursor ]; then chmod -R a+rX /root/.cursor; fi && \
    command -v python3 >/dev/null || ln -sf "$(command -v python)" /usr/local/bin/python3 && \
    rm -f /tmp/cursor-agent-version

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
ENV HOME=/tmp
ENV NODE_COMPILE_CACHE=/tmp/cursor-compile-cache
ENV CURSOR_AGENT_BIN=/usr/local/bin/agent
ENV SPAWN_SCRIPT=/var/task/spawn.sh
ENV CONTROLLER_RUN_SECONDS=300

COPY spawn.sh ${LAMBDA_TASK_ROOT}/spawn.sh
COPY controller/handler.py ${LAMBDA_TASK_ROOT}/handler.py
RUN chmod +x ${LAMBDA_TASK_ROOT}/spawn.sh

CMD ["handler.handler"]
