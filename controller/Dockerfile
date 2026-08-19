# Cursor pool workers on AWS Lambda MicroVMs.
#
# Apply cloudformation.yaml, then start an agent from cursor.com/agents
# against the pool. The scheduled Lambda runs:
#   cursor-agent worker controller --spawn ./spawn.mjs
# spawn.mjs calls RunMicrovm. The guest execs `cursor-agent worker start --pool`.

FROM public.ecr.aws/lambda/nodejs:22

RUN (command -v microdnf >/dev/null && microdnf install -y tar gzip unzip findutils) || \
    (command -v dnf >/dev/null && dnf install -y tar gzip unzip findutils) || true

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip && \
    unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip

RUN curl -fsSL https://cursor.com/install | bash && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
ENV CURSOR_AGENT_BIN=/root/.local/bin/agent

COPY handler.mjs spawn.mjs ${LAMBDA_TASK_ROOT}/

CMD ["handler.handler"]
