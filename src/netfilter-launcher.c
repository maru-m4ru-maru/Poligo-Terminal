#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define POLIGO_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define POLIGO_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported architecture for terminal network filtering
#endif

static struct sock_filter instructions[128];
static size_t instruction_count;

static void emit(struct sock_filter instruction) {
  if (instruction_count >= sizeof(instructions) / sizeof(instructions[0])) {
    _exit(125);
  }

  instructions[instruction_count++] = instruction;
}

static void deny_syscall(unsigned int number) {
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)));
}

static void build_filter(void) {
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)));
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, POLIGO_AUDIT_ARCH, 1, 0));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));

#ifdef __NR_socket
  deny_syscall(__NR_socket);
#endif
#ifdef __NR_socketpair
  deny_syscall(__NR_socketpair);
#endif
#ifdef __NR_connect
  deny_syscall(__NR_connect);
#endif
#ifdef __NR_accept
  deny_syscall(__NR_accept);
#endif
#ifdef __NR_accept4
  deny_syscall(__NR_accept4);
#endif
#ifdef __NR_bind
  deny_syscall(__NR_bind);
#endif
#ifdef __NR_listen
  deny_syscall(__NR_listen);
#endif
#ifdef __NR_sendto
  deny_syscall(__NR_sendto);
#endif
#ifdef __NR_recvfrom
  deny_syscall(__NR_recvfrom);
#endif
#ifdef __NR_sendmsg
  deny_syscall(__NR_sendmsg);
#endif
#ifdef __NR_recvmsg
  deny_syscall(__NR_recvmsg);
#endif
#ifdef __NR_sendmmsg
  deny_syscall(__NR_sendmmsg);
#endif
#ifdef __NR_recvmmsg
  deny_syscall(__NR_recvmmsg);
#endif
#ifdef __NR_shutdown
  deny_syscall(__NR_shutdown);
#endif
#ifdef __NR_io_uring_setup
  deny_syscall(__NR_io_uring_setup);
#endif
#ifdef __NR_io_uring_enter
  deny_syscall(__NR_io_uring_enter);
#endif
#ifdef __NR_io_uring_register
  deny_syscall(__NR_io_uring_register);
#endif
#ifdef __NR_bpf
  deny_syscall(__NR_bpf);
#endif
#ifdef __NR_perf_event_open
  deny_syscall(__NR_perf_event_open);
#endif

  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
}

static int write_all(int descriptor, const void *data, size_t length) {
  const unsigned char *cursor = data;

  while (length > 0) {
    ssize_t written = write(descriptor, cursor, length);

    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }

      return -1;
    }

    cursor += written;
    length -= (size_t)written;
  }

  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    dprintf(STDERR_FILENO, "sandbox launcher requires the Bubblewrap executable path\n");
    return 125;
  }

  build_filter();

  int descriptors[2];

  if (pipe2(descriptors, O_CLOEXEC) != 0) {
    perror("create seccomp pipe");
    return 125;
  }

  size_t program_size = instruction_count * sizeof(instructions[0]);

  if (write_all(descriptors[1], instructions, program_size) != 0) {
    perror("write seccomp program");
    close(descriptors[0]);
    close(descriptors[1]);
    return 125;
  }

  close(descriptors[1]);

  if (descriptors[0] != 3) {
    if (dup2(descriptors[0], 3) < 0) {
      perror("prepare seccomp descriptor");
      close(descriptors[0]);
      return 125;
    }

    close(descriptors[0]);
  }

  int descriptor_flags = fcntl(3, F_GETFD);

  if (descriptor_flags < 0 || fcntl(3, F_SETFD, descriptor_flags & ~FD_CLOEXEC) < 0) {
    perror("preserve seccomp descriptor");
    return 125;
  }

  char **child_argv = calloc((size_t)argc + 2, sizeof(char *));

  if (!child_argv) {
    perror("allocate Bubblewrap arguments");
    return 125;
  }

  child_argv[0] = argv[1];
  child_argv[1] = "--seccomp";
  child_argv[2] = "3";

  for (int source = 2, destination = 3; source < argc; source++, destination++) {
    child_argv[destination] = argv[source];
  }

  execv(argv[1], child_argv);
  perror("execute Bubblewrap");
  return 125;
}
