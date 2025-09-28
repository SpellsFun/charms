# syntax=docker/dockerfile:1.6

###############################
# 构建阶段：编译 charms server
###############################
FROM rust:1.80-bullseye AS builder

# 安装编译 prover 特性所需的工具链（Go 用于 sp1-recursion-gnark-ffi）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        clang \
        pkg-config \
        libssl-dev \
        golang \
        protobuf-compiler && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# 复制清单文件以利用构建缓存
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY charms-app-runner/Cargo.toml charms-app-runner/
COPY charms-client/Cargo.toml charms-client/
COPY charms-data/Cargo.toml charms-data/
COPY charms-lib/Cargo.toml charms-lib/
COPY charms-proof-wrapper/Cargo.toml charms-proof-wrapper/
COPY charms-sdk/Cargo.toml charms-sdk/

# 预先拉取依赖，避免频繁重编译
RUN cargo fetch

# 复制全部源码并进行发布构建
COPY . .
RUN cargo build --release --features prover --bin charms

###############################
# 运行阶段：提供轻量运行环境
###############################
FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        && rm -rf /var/lib/apt/lists/*

ENV RUST_LOG=info
WORKDIR /app

COPY --from=builder /workspace/target/release/charms /usr/local/bin/charms

EXPOSE 8802

# 默认启动 server，监听全网并启用 prover 特性
CMD ["charms", "server", "--ip", "0.0.0.0", "--port", "8802"]
