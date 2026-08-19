# Lambda function image: published cursor-agent CLI + spawn.mjs.
# Build: ./scripts/build-controller.sh  (linux/arm64)
FROM public.ecr.aws/lambda/nodejs:22

RUN (command -v microdnf >/dev/null && microdnf install -y tar gzip findutils gzip unzip) || \
    (command -v dnf >/dev/null && dnf install -y tar gzip findutils unzip) || true

RUN curl -fsSL https://cursor.com/install | bash && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent && \
    ln -sf /root/.local/bin/agent ${LAMBDA_TASK_ROOT}/agent && \
    (command -v agent || test -x /root/.local/bin/agent)

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
ENV CURSOR_AGENT_BIN=/root/.local/bin/agent
ENV SPAWN_SCRIPT=/var/task/spawn.mjs

COPY dist/index.js ${LAMBDA_TASK_ROOT}/index.js
COPY dist/spawn.mjs ${LAMBDA_TASK_ROOT}/spawn.mjs

CMD ["index.handler"]
