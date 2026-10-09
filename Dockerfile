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

RUN mkdir -p bin /opt/poligo/rootfs/dev /opt/poligo/rootfs/proc /opt/poligo/rootfs/run /opt/poligo/rootfs/home /opt/poligo/rootfs/root /opt/poligo/rootfs/tmp /opt/poligo/rootfs/var/tmp /opt/poligo/rootfs/var/cache /opt/poligo/rootfs/var/lib /opt/poligo/rootfs/var/log /opt/poligo/rootfs/var/run /opt/poligo/rootfs/workspace \
    && cp -a /usr /etc /bin /sbin /lib /lib64 /opt/poligo/rootfs/ \
    && mkdir -p /opt/poligo/rootfs/dev/pts /opt/poligo/rootfs/dev/shm \
    && rm -f /opt/poligo/rootfs/etc/hosts /opt/poligo/rootfs/etc/hostname /opt/poligo/rootfs/etc/resolv.conf \
    && printf '127.0.0.1 localhost\\n::1 localhost\\n' > /opt/poligo/rootfs/etc/hosts \
    && printf 'poligo-terminal\\n' > /opt/poligo/rootfs/etc/hostname \
    && mknod -m 666 /opt/poligo/rootfs/dev/null c 1 3 \
    && mknod -m 666 /opt/poligo/rootfs/dev/zero c 1 5 \
    && mknod -m 666 /opt/poligo/rootfs/dev/full c 1 7 \
    && mknod -m 666 /opt/poligo/rootfs/dev/random c 1 8 \
    && mknod -m 666 /opt/poligo/rootfs/dev/urandom c 1 9 \
    && mknod -m 666 /opt/poligo/rootfs/dev/tty c 5 0 \
    && ln -sf /proc/self/fd /opt/poligo/rootfs/dev/fd \
    && ln -sf /proc/self/fd/0 /opt/poligo/rootfs/dev/stdin \
    && ln -sf /proc/self/fd/1 /opt/poligo/rootfs/dev/stdout \
    && ln -sf /proc/self/fd/2 /opt/poligo/rootfs/dev/stderr \
    && cc -O2 -Wall -Wextra -Werror src/chroot-launcher.c -o bin/poligo-chroot-launcher \
    && chmod -R a-w /opt/poligo/rootfs \
    && chmod 1777 /opt/poligo/rootfs/tmp /opt/poligo/rootfs/var/tmp \
    && chmod 666 /opt/poligo/rootfs/dev/null /opt/poligo/rootfs/dev/zero /opt/poligo/rootfs/dev/full /opt/poligo/rootfs/dev/random /opt/poligo/rootfs/dev/urandom /opt/poligo/rootfs/dev/tty

ENV NODE_ENV=production
ENV PORT=10000

CMD ["node", "src/server.js"]
