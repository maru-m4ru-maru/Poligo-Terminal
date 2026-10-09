#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__x86_64__)
#define POLIGO_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define POLIGO_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported architecture for terminal seccomp filtering
#endif

#define POLIGO_NEW_NAMESPACE_FLAGS (0x00020000U | 0x02000000U | 0x04000000U | 0x08000000U | 0x10000000U | 0x20000000U | 0x40000000U | 0x00000080U)

static struct sock_filter instructions[128];
static size_t instruction_count;

static void emit(struct sock_filter instruction) {
  if (instruction_count >= sizeof(instructions) / sizeof(instructions[0])) {
    _exit(125);
  }

  instructions[instruction_count++] = instruction;
}

static void deny_syscall(unsigned int number, unsigned int error_number) {
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (error_number & SECCOMP_RET_DATA)));
}

static void build_filter(void) {
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)));
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, POLIGO_AUDIT_ARCH, 1, 0));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));

#ifdef __NR_clone
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4));
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])));
  emit((struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, POLIGO_NEW_NAMESPACE_FLAGS, 0, 1));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)));
  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
  emit((struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)));
#endif

#ifdef __NR_clone3
  deny_syscall(__NR_clone3, ENOSYS);
#endif
#ifdef __NR_socket
  deny_syscall(__NR_socket, EPERM);
#endif
#ifdef __NR_socketpair
  deny_syscall(__NR_socketpair, EPERM);
#endif
#ifdef __NR_connect
  deny_syscall(__NR_connect, EPERM);
#endif
#ifdef __NR_accept
  deny_syscall(__NR_accept, EPERM);
#endif
#ifdef __NR_accept4
  deny_syscall(__NR_accept4, EPERM);
#endif
#ifdef __NR_bind
  deny_syscall(__NR_bind, EPERM);
#endif
#ifdef __NR_listen
  deny_syscall(__NR_listen, EPERM);
#endif
#ifdef __NR_sendto
  deny_syscall(__NR_sendto, EPERM);
#endif
#ifdef __NR_recvfrom
  deny_syscall(__NR_recvfrom, EPERM);
#endif
#ifdef __NR_sendmsg
  deny_syscall(__NR_sendmsg, EPERM);
#endif
#ifdef __NR_recvmsg
  deny_syscall(__NR_recvmsg, EPERM);
#endif
#ifdef __NR_sendmmsg
  deny_syscall(__NR_sendmmsg, EPERM);
#endif
#ifdef __NR_recvmmsg
  deny_syscall(__NR_recvmmsg, EPERM);
#endif
#ifdef __NR_shutdown
  deny_syscall(__NR_shutdown, EPERM);
#endif
#ifdef __NR_io_uring_setup
  deny_syscall(__NR_io_uring_setup, EPERM);
#endif
#ifdef __NR_io_uring_enter
  deny_syscall(__NR_io_uring_enter, EPERM);
#endif
#ifdef __NR_io_uring_register
  deny_syscall(__NR_io_uring_register, EPERM);
#endif
#ifdef __NR_bpf
  deny_syscall(__NR_bpf, EPERM);
#endif
#ifdef __NR_perf_event_open
  deny_syscall(__NR_perf_event_open, EPERM);
#endif
#ifdef __NR_ptrace
  deny_syscall(__NR_ptrace, EPERM);
#endif
#ifdef __NR_process_vm_readv
  deny_syscall(__NR_process_vm_readv, EPERM);
#endif
#ifdef __NR_process_vm_writev
  deny_syscall(__NR_process_vm_writev, EPERM);
#endif
#ifdef __NR_unshare
  deny_syscall(__NR_unshare, EPERM);
#endif
#ifdef __NR_setns
  deny_syscall(__NR_setns, EPERM);
#endif
#ifdef __NR_chroot
  deny_syscall(__NR_chroot, EPERM);
#endif
#ifdef __NR_setuid
  deny_syscall(__NR_setuid, EPERM);
#endif
#ifdef __NR_setreuid
  deny_syscall(__NR_setreuid, EPERM);
#endif
#ifdef __NR_setresuid
  deny_syscall(__NR_setresuid, EPERM);
#endif
#ifdef __NR_setfsuid
  deny_syscall(__NR_setfsuid, EPERM);
#endif
#ifdef __NR_setgid
  deny_syscall(__NR_setgid, EPERM);
#endif
#ifdef __NR_setregid
  deny_syscall(__NR_setregid, EPERM);
#endif
#ifdef __NR_setresgid
  deny_syscall(__NR_setresgid, EPERM);
#endif
#ifdef __NR_setfsgid
  deny_syscall(__NR_setfsgid, EPERM);
#endif
#ifdef __NR_setgroups
  deny_syscall(__NR_setgroups, EPERM);
#endif
#ifdef __NR_capset
  deny_syscall(__NR_capset, EPERM);
#endif
#ifdef __NR_seccomp
  deny_syscall(__NR_seccomp, EPERM);
#endif
#ifdef __NR_mount
  deny_syscall(__NR_mount, EPERM);
#endif
#ifdef __NR_umount2
  deny_syscall(__NR_umount2, EPERM);
#endif
#ifdef __NR_pivot_root
  deny_syscall(__NR_pivot_root, EPERM);
#endif
#ifdef __NR_open_by_handle_at
  deny_syscall(__NR_open_by_handle_at, EPERM);
#endif
#ifdef __NR_fsopen
  deny_syscall(__NR_fsopen, EPERM);
#endif
#ifdef __NR_fsconfig
  deny_syscall(__NR_fsconfig, EPERM);
#endif
#ifdef __NR_fsmount
  deny_syscall(__NR_fsmount, EPERM);
#endif
#ifdef __NR_move_mount
  deny_syscall(__NR_move_mount, EPERM);
#endif
#ifdef __NR_mount_setattr
  deny_syscall(__NR_mount_setattr, EPERM);
#endif
#ifdef __NR_keyctl
  deny_syscall(__NR_keyctl, EPERM);
#endif
#ifdef __NR_add_key
  deny_syscall(__NR_add_key, EPERM);
#endif
#ifdef __NR_request_key
  deny_syscall(__NR_request_key, EPERM);
#endif

  emit((struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
}

static int parse_id(const char *value, uid_t *result) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);

  if (errno || !value[0] || !end || *end || parsed < 20000 || parsed > 59999) {
    return -1;
  }

  *result = (uid_t)parsed;
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 6) {
    dprintf(STDERR_FILENO, "sandbox launcher requires rootfs, uid, gid, workdir and command arguments\n");
    return 125;
  }

  uid_t uid = 0;
  uid_t gid = 0;

  if (parse_id(argv[2], &uid) != 0 || parse_id(argv[3], &gid) != 0) {
    dprintf(STDERR_FILENO, "invalid sandbox uid or gid\n");
    return 125;
  }

  if (chdir(argv[1]) != 0 || chroot(".") != 0 || chdir(argv[4]) != 0) {
    perror("enter terminal chroot");
    return 125;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    perror("set no_new_privs");
    return 125;
  }

  if (setgroups(0, NULL) != 0 || setgid(gid) != 0 || setuid(uid) != 0) {
    perror("drop terminal privileges");
    return 125;
  }

  build_filter();

  struct sock_fprog program = {
    .len = (unsigned short)instruction_count,
    .filter = instructions
  };

  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) {
    perror("install terminal seccomp filter");
    return 125;
  }

  for (int descriptor = 3; descriptor < 4096; descriptor++) {
    close(descriptor);
  }

  execv(argv[5], &argv[5]);
  perror("execute terminal command");
  return 127;
}
