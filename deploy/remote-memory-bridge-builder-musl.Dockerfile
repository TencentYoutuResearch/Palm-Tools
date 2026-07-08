# musl static builder for glibc-free Rust binaries.
# Works on any Linux kernel 2.6.32+, no glibc dependency.
#
# Usage:
#   docker build --platform linux/amd64 \
#     -f deploy/remote-memory-bridge-builder-musl.Dockerfile \
#     -t kode-builder-musl deploy/
#
# Then build:
#   docker run --rm -v "$PWD:/work" -w /work kode-builder-musl \
#     cargo build --release --target x86_64-unknown-linux-musl \
#       -p kode-bridge -p kode-memory --bin kode-memory-mcp
ARG BASE_IMAGE=rust:1.89-alpine
FROM ${BASE_IMAGE}

RUN apk add --no-cache \
      musl-dev \
      build-base \
      curl \
      file \
      git \
      pkgconfig \
      ca-certificates \
      openssl-dev \
      openssl-libs-static

RUN rustup target add x86_64-unknown-linux-musl
