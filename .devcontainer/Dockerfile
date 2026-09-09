FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Install baseline dependencies
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
        curl \
        unzip \
        bash \
        ca-certificates \
        docker.io \
    && rm -rf /var/lib/apt/lists/*
