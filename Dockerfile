FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    procps \
    python3 \
    tar \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

ARG INCLUDE_SANDBOX_DEVICES=false

RUN mkdir -p bin /opt/poligo/rootfs/dev /opt/poligo/rootfs/proc /opt/poligo/rootfs/run /opt/poligo/rootfs/home /opt/poligo/rootfs/root /opt/poligo/rootfs/tmp /opt/poligo/rootfs/var/tmp /opt/poligo/rootfs/var/cache /opt/poligo/rootfs/var/lib /opt/poligo/rootfs/var/log /opt/poligo/rootfs/var/run /opt/poligo/rootfs/workspace \
    && cp -a /usr /etc /bin /sbin /lib /lib64 /opt/poligo/rootfs/ \
    && mkdir -p /opt/poligo/rootfs/dev/pts /opt/poligo/rootfs/dev/shm \
    && rm -f /opt/poligo/rootfs/etc/hosts /opt/poligo/rootfs/etc/hostname /opt/poligo/rootfs/etc/resolv.conf \
    && printf '127.0.0.1 localhost\\n::1 localhost\\n' > /opt/poligo/rootfs/etc/hosts \
    && printf 'poligo-terminal\\n' > /opt/poligo/rootfs/etc/hostname \
    && if [ "$INCLUDE_SANDBOX_DEVICES" = "true" ]; then \
        chmod 755 /opt/poligo/rootfs/dev && \
        mknod -m 666 /opt/poligo/rootfs/dev/null c 1 3 && \
        mknod -m 666 /opt/poligo/rootfs/dev/zero c 1 5 && \
        mknod -m 666 /opt/poligo/rootfs/dev/full c 1 7 && \
        mknod -m 666 /opt/poligo/rootfs/dev/random c 1 8 && \
        mknod -m 666 /opt/poligo/rootfs/dev/urandom c 1 9 && \
        mknod -m 666 /opt/poligo/rootfs/dev/tty c 5 0; \
    fi \
    && ln -sf /proc/self/fd /opt/poligo/rootfs/dev/fd \
    && ln -sf /proc/self/fd/0 /opt/poligo/rootfs/dev/stdin \
    && ln -sf /proc/self/fd/1 /opt/poligo/rootfs/dev/stdout \
    && ln -sf /proc/self/fd/2 /opt/poligo/rootfs/dev/stderr \
    && cc -O2 -Wall -Wextra -Werror src/chroot-launcher.c -o bin/poligo-chroot-launcher \
    && chmod -R a-s /opt/poligo/rootfs \
    && chmod -R a-w /opt/poligo/rootfs \
    && chmod 1777 /opt/poligo/rootfs/tmp /opt/poligo/rootfs/var/tmp \
    && if [ "$INCLUDE_SANDBOX_DEVICES" = "true" ]; then \
        chmod 666 /opt/poligo/rootfs/dev/null /opt/poligo/rootfs/dev/zero /opt/poligo/rootfs/dev/full /opt/poligo/rootfs/dev/random /opt/poligo/rootfs/dev/urandom /opt/poligo/rootfs/dev/tty; \
    fi \
    && mkdir -p /opt/poligo/sandbox-slots/slot1 /opt/poligo/sandbox-slots/slot2 \
    && cp -a /opt/poligo/rootfs/. /opt/poligo/sandbox-slots/slot1/ \
    && cp -a /opt/poligo/rootfs/. /opt/poligo/sandbox-slots/slot2/ \
    && chmod -R a-s /opt/poligo/sandbox-slots \
    && chmod -R a-w /opt/poligo/sandbox-slots \
    && chmod 755 /opt/poligo/sandbox-slots/slot1/etc /opt/poligo/sandbox-slots/slot2/etc \
    && chmod 644 /opt/poligo/sandbox-slots/slot1/etc/passwd /opt/poligo/sandbox-slots/slot1/etc/group /opt/poligo/sandbox-slots/slot2/etc/passwd /opt/poligo/sandbox-slots/slot2/etc/group \
    && printf 'poligo20001:x:20001:20001:Poligo Terminal:/workspace:/usr/bin/bash\\n' >> /opt/poligo/sandbox-slots/slot1/etc/passwd \
    && printf 'poligo20001:x:20001:\\n' >> /opt/poligo/sandbox-slots/slot1/etc/group \
    && printf 'poligo20002:x:20002:20002:Poligo Terminal:/workspace:/usr/bin/bash\\n' >> /opt/poligo/sandbox-slots/slot2/etc/passwd \
    && printf 'poligo20002:x:20002:\\n' >> /opt/poligo/sandbox-slots/slot2/etc/group \
    && chmod 444 /opt/poligo/sandbox-slots/slot1/etc/passwd /opt/poligo/sandbox-slots/slot1/etc/group /opt/poligo/sandbox-slots/slot2/etc/passwd /opt/poligo/sandbox-slots/slot2/etc/group \
    && chown -R 20001:20001 /opt/poligo/sandbox-slots/slot1/workspace \
    && chown -R 20002:20002 /opt/poligo/sandbox-slots/slot2/workspace \
    && chmod 700 /opt/poligo/sandbox-slots/slot1/workspace /opt/poligo/sandbox-slots/slot2/workspace \
    && chmod 1777 /opt/poligo/sandbox-slots/slot1/tmp /opt/poligo/sandbox-slots/slot1/var/tmp /opt/poligo/sandbox-slots/slot2/tmp /opt/poligo/sandbox-slots/slot2/var/tmp \
    && chmod 666 /opt/poligo/sandbox-slots/slot1/dev/null /opt/poligo/sandbox-slots/slot1/dev/zero /opt/poligo/sandbox-slots/slot1/dev/full /opt/poligo/sandbox-slots/slot1/dev/random /opt/poligo/sandbox-slots/slot1/dev/urandom /opt/poligo/sandbox-slots/slot1/dev/tty \
    && chmod 666 /opt/poligo/sandbox-slots/slot2/dev/null /opt/poligo/sandbox-slots/slot2/dev/zero /opt/poligo/sandbox-slots/slot2/dev/full /opt/poligo/sandbox-slots/slot2/dev/random /opt/poligo/sandbox-slots/slot2/dev/urandom /opt/poligo/sandbox-slots/slot2/dev/tty

ENV NODE_ENV=production
ENV PORT=10000

CMD ["node", "src/server.js"]
