ARG RUST_IMAGE=rust:1.89-bookworm
FROM ${RUST_IMAGE}

ARG APT_MIRROR=
ARG APT_SECURITY_MIRROR=

RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -n "$APT_SECURITY_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org/debian-security|${APT_SECURITY_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
    fi

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      curl \
      file \
      git \
      pkg-config \
      ca-certificates
