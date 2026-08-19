ARG BASE_IMAGE=public.ecr.aws/lambda/microvms:al2023-minimal
FROM ${BASE_IMAGE}

RUN dnf install -y --setopt=install_weak_deps=0 \
      bash tar gzip git ca-certificates findutils awscli python3 \
      $(command -v curl >/dev/null 2>&1 || echo curl) && \
    dnf clean all

RUN curl -fsSL https://cursor.com/install | bash && \
    ln -sf /root/.local/bin/agent /usr/local/bin/agent && \
    ln -sf /root/.local/bin/agent /usr/local/bin/cursor-agent

ENV PATH="/root/.cursor/bin:/root/.local/bin:/usr/local/bin:${PATH}"
WORKDIR /opt/cursor
COPY entrypoint.sh hook.py /opt/cursor/
RUN chmod +x /opt/cursor/entrypoint.sh /opt/cursor/hook.py && mkdir -p /opt/cursor/workspaces
ENV HOOK_PORT=9000
ENTRYPOINT ["python3", "/opt/cursor/hook.py"]
