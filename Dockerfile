# syntax=docker/dockerfile:1.6

ARG CUDA_VERSION=12.5.1
ARG RUST_VERSION=1.88.0

###############################
# 构建阶段：编译 charms server
###############################
FROM nvidia/cuda:${CUDA_VERSION}-devel-ubuntu20.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH="/usr/local/cargo/bin:/usr/local/go/bin:${PATH}" \
    CC=clang \
    CXX=clang++ \
    AR=llvm-ar

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        clang \
        curl \
        git \
        llvm \
        llvm-dev \
        libclang-dev \
        libffi-dev \
        libgmp-dev \
        libmpc-dev \
        libmpfr-dev \
        libssl-dev \
        pkg-config \
        protobuf-compiler \
        python3 \
        python3-pip \
        wget \
        zlib1g-dev \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# 安装 Go（sp1-recursion-gnark-ffi 需 1.22.x）
ARG GO_VERSION=1.22.6
RUN wget "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" && \
    tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz && \
    rm go${GO_VERSION}.linux-amd64.tar.gz

# 安装指定版本的 Rust
ARG RUST_VERSION
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain ${RUST_VERSION}

# 安装 Succinct SP1 工具链
RUN curl -L https://sp1.succinct.xyz | bash
ENV PATH="/root/.sp1/bin:${PATH}"
RUN sp1up || true

WORKDIR /workspace
COPY . .

RUN cargo build --release --features prover --bin charms && \
    cp target/release/charms /usr/local/bin/charms && \
    rm -rf target

# 预下载 Groth16 电路
ENV SP1_PROVER=cuda \
    APP_SP1_PROVER=cuda \
    SPELL_SP1_PROVER=app \
    SP1_GPU_SERVICE_URL=http://localhost:3000/twirp/ \
    RUST_LOG=info
RUN mkdir -p /root/.sp1 && \
    charms utils install-circuit-files

###############################
# 运行阶段：提供轻量运行环境
###############################
FROM nvidia/cuda:${CUDA_VERSION}-runtime-ubuntu20.04 AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        libssl1.1 && \
    rm -rf /var/lib/apt/lists/*

ENV RUST_LOG=info
WORKDIR /app

COPY --from=builder /usr/local/bin/charms /usr/local/bin/charms
COPY --from=builder /root/.sp1 /root/.sp1

EXPOSE 17784

# 默认启动 server，监听全网并启用 prover 特性
CMD ["charms", "server", "--ip", "0.0.0.0", "--port", "17784"]
