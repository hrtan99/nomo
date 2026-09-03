# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG UBUNTU_IMAGE="ubuntu:26.04@sha256:61b65dc6bddff5e68c552f22126fe77496395f956ff2e983e05d8a52efd63e55"
FROM ${UBUNTU_IMAGE}

ARG DEBIAN_FRONTEND=noninteractive
ARG NOMO_UID=10001
ARG NOMO_GID=10001

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        cargo \
        clang \
        cmake \
        curl \
        file \
        git \
        jq \
        less \
        libssl-dev \
        pkg-config \
        procps \
        python3 \
        ripgrep \
        rustc \
        tini \
        xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${NOMO_GID}" nomo \
    && useradd \
        --create-home \
        --gid "${NOMO_GID}" \
        --shell /bin/bash \
        --uid "${NOMO_UID}" \
        nomo \
    && install -d -o nomo -g nomo \
        /home/nomo/.cache \
        /home/nomo/.cargo \
        /workspace

ENV CARGO_HOME=/home/nomo/.cargo \
    HOME=/home/nomo \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/home/nomo/.cargo/bin:${PATH}

WORKDIR /workspace
USER nomo:nomo

CMD ["/bin/bash", "-l"]
