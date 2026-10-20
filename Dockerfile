# HomeLan Docker Image — Multi-Stage Build
# Stage 1: Build React Frontend
FROM node:22-alpine AS frontend-build

WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit
COPY frontend/ ./
RUN npm run build

# Stage 2: Python Build Environment (Builder)
FROM python:3.12-slim AS python-build

# Install compiler tools for compiling raw extensions if wheels are missing
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o APT::Update::Error-Mode=any update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Create virtual environment to isolate dependencies cleanly
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY backend/requirements.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt && \
    /opt/venv/bin/pip uninstall -y pip setuptools wheel

# Stage 3: Clean Python Runtime
FROM python:3.12-slim AS runtime

# Upgrade base system packages to patch OS-level CVEs, install runtime-only dependencies,
# and remove pip/ensurepip from runtime to eliminate package-manager attack surface and vendored CVEs
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o APT::Update::Error-Mode=any update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    nmap \
    libcap2-bin \
    iputils-ping \
    avahi-utils \
    iproute2 \
    dnsutils \
    && rm -rf /var/lib/apt/lists/* \
    && pip uninstall -y pip setuptools wheel \
    && rm -rf /usr/local/lib/python3.12/ensurepip

# Grant nmap capabilities so we don't need to run as root
RUN setcap cap_net_raw,cap_net_admin,cap_net_bind_service+eip /usr/bin/nmap

# Copy virtual environment from python-build stage
COPY --from=python-build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Copy version file, agent script and backend code
COPY VERSION .
COPY agent ./agent
COPY backend/ .

# Copy frontend build to static directory
COPY --from=frontend-build /build/frontend/dist ./static

# Create data directory and user
RUN mkdir -p /app/data && \
    useradd -m -s /bin/bash gravitylan && \
    chown -R gravitylan:gravitylan /app

# Define Volume
VOLUME ["/app/data"]

# Environment
ENV GRAVITYLAN_DATA_DIR=/app/data
ENV GRAVITYLAN_DEBUG=false

# Expose port
EXPOSE 8000

# Run as non-root user
USER gravitylan

# Healthcheck (utilizes Python natively to completely avoid curl dependency and CVEs)
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python3 -c "import urllib.request, os, sys; port = os.environ.get('GRAVITYLAN_PORT', '8000'); urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=5)"

# Start server
# Using 1 worker for stability and predictability in homelab environments.
# For larger deployments, increase workers or use a task queue for heavy jobs.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${GRAVITYLAN_PORT:-8000} --workers 1"]
