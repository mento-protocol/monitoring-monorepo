#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <mach/message.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <utmpx.h>

/*
 * Apple keeps this flavor and structure behind the PRIVATE SDK guard. The
 * kernel ABI is public in the XNU source and is available through libproc.
 */
#ifndef PROC_PIDUNIQIDENTIFIERINFO
#define PROC_PIDUNIQIDENTIFIERINFO 17
struct proc_uniqidentifierinfo {
  uint8_t p_uuid[16];
  uint64_t p_uniqueid;
  uint64_t p_puniqueid;
  int32_t p_idversion;
  uint32_t p_reserve2;
  uint64_t p_reserve3;
  uint64_t p_reserve4;
};
#endif

_Static_assert(sizeof(struct proc_uniqidentifierinfo) == 56,
    "unexpected proc_uniqidentifierinfo ABI size");
_Static_assert(sizeof(pid_t) == sizeof(int), "unexpected pid_t ABI size");

/*
 * XNU also keeps the coalition flavor and structure behind the PRIVATE SDK
 * guard. Coalition type 0 is resource and type 1 is jetsam in coalition.h.
 */
#ifndef PROC_PIDCOALITIONINFO
#define PROC_PIDCOALITIONINFO 20
#endif

#define AGENTQG_COALITION_NUM_TYPES 2
#define AGENTQG_RESOURCE_COALITION_INDEX 0
#define AGENTQG_JETSAM_COALITION_INDEX 1

struct agentqg_proc_pidcoalitioninfo {
  uint64_t coalition_id[AGENTQG_COALITION_NUM_TYPES];
  uint64_t reserved1;
  uint64_t reserved2;
  uint64_t reserved3;
};

_Static_assert(sizeof(struct agentqg_proc_pidcoalitioninfo) == 40,
    "unexpected proc_pidcoalitioninfo ABI size");

#define SNAPSHOT_HEADER "agentqg-darwin-process-snapshot-v3"
#define PROBE_OUTPUT "agentqg-darwin-process-identity-v3"
#define STABLE_READ_ATTEMPTS 4
#define SNAPSHOT_EPOCH_ATTEMPTS 8
#define ALLOCATOR_PROBE_ATTEMPTS 8
#define PROC_LIST_PID_PADDING 20
#define PROBE_CHILD_TIMEOUT_MS 30000

typedef int (*proc_signal_with_audittoken_function)(audit_token_t *, int);

enum exit_code {
  EXIT_USAGE = 1,
  EXIT_INFRASTRUCTURE = 2,
  EXIT_STALE_IDENTITY = 3,
  EXIT_RETRY_IDENTITY = 4,
  EXIT_RETRY_CONTENTION = 5,
};

enum read_result {
  READ_OK = 0,
  READ_GONE,
  READ_INFRASTRUCTURE,
  READ_UNSTABLE,
};

enum probe_wait_result {
  PROBE_WAIT_ERROR = -1,
  PROBE_WAIT_TIMEOUT = 0,
  PROBE_WAIT_BYTE = 1,
  PROBE_WAIT_CLOSED = 2,
};

enum epoch_result {
  EPOCH_OK = 0,
  EPOCH_RETRY,
  EPOCH_INFRASTRUCTURE,
};

enum snapshot_retry_reason {
  SNAPSHOT_RETRY_NONE = 0,
  SNAPSHOT_RETRY_FENCE,
  SNAPSHOT_RETRY_COUNT,
  SNAPSHOT_RETRY_PID_VECTOR,
  SNAPSHOT_RETRY_ROW_UNSTABLE,
  SNAPSHOT_RETRY_ROW_AFTER_FENCE,
  SNAPSHOT_RETRY_FENCE_GAP,
};

struct process_row {
  uint32_t pid;
  uint32_t ppid;
  uint32_t pgid;
  uint32_t status;
  uint32_t uid;
  uint32_t ruid;
  uint32_t svuid;
  uint64_t unique_id;
  uint64_t parent_unique_id;
  uint64_t resource_coalition_id;
  uint64_t jetsam_coalition_id;
  uint32_t pid_version;
};

struct process_snapshot {
  struct process_row *rows;
  size_t row_count;
  uint64_t lower_unique_id;
  uint64_t upper_unique_id;
  int estimated_count;
  int listed_count;
  int capacity;
  int zero_pid_count;
  enum snapshot_retry_reason retry_reason;
};

#define FENCE_FRAME_MAGIC UINT32_C(0x41514746)

struct fence_frame {
  uint32_t magic;
  uint32_t pid;
  uint32_t ppid;
  uint32_t pid_version;
  uint64_t unique_id;
  uint64_t parent_unique_id;
};

static void usage(const char *program) {
  fprintf(stderr,
      "usage: %s snapshot\n"
      "       %s identity PID\n"
      "       %s signal PID UNIQUE_ID SIGNAL\n"
      "       %s probe\n"
      "       %s boot-id\n",
      program, program, program, program, program);
}

static int parse_u64(const char *text, uint64_t maximum, uint64_t *value) {
  char *end = NULL;
  unsigned long long parsed;

  if (text == NULL || text[0] == '\0' || text[0] == '+' || text[0] == '-') {
    return -1;
  }
  for (const char *cursor = text; *cursor != '\0'; cursor += 1) {
    if (*cursor < '0' || *cursor > '9') {
      return -1;
    }
  }

  errno = 0;
  parsed = strtoull(text, &end, 10);
  if (errno == ERANGE || end == text || *end != '\0' || parsed > maximum) {
    return -1;
  }

  *value = (uint64_t)parsed;
  return 0;
}

#define AGENTQG_DARWIN_PROCESS_IDENTITY_RUNTIME_INCLUDE 1
#include "darwin-process-identity-runtime.inc.c"
#undef AGENTQG_DARWIN_PROCESS_IDENTITY_RUNTIME_INCLUDE
static proc_signal_with_audittoken_function load_audit_signal_function(void) {
  void *symbol;
  const char *loader_error;

  (void)dlerror();
  symbol = dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  loader_error = dlerror();
  if (symbol == NULL || loader_error != NULL) {
    fprintf(stderr, "proc_signal_with_audittoken is unavailable");
    if (loader_error != NULL) {
      fprintf(stderr, ": %s", loader_error);
    }
    fputc('\n', stderr);
    return NULL;
  }
  return (proc_signal_with_audittoken_function)symbol;
}

static int invoke_audit_signal(proc_signal_with_audittoken_function function,
    pid_t pid, uint32_t pid_version, int signal_number, int *error_code) {
  audit_token_t audit_token = INVALID_AUDIT_TOKEN_VALUE;
  int result;

  audit_token.val[5] = (uint32_t)pid;
  audit_token.val[7] = pid_version;
  errno = 0;
  result = function(&audit_token, signal_number);
  *error_code = result > 0 ? result : errno;
  return result;
}

static int boot_id_command(void) {
  struct proc_uniqidentifierinfo before;
  struct proc_uniqidentifierinfo after;
  struct utmpx query;
  struct utmpx *entry;
  time_t boot_seconds;
  suseconds_t boot_microseconds;
  enum read_result result;

  for (int attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    result = read_unique_info(1, &before);
    if (result != READ_OK) {
      fprintf(stderr, "cannot read the PID 1 unique identity\n");
      return EXIT_INFRASTRUCTURE;
    }

    memset(&query, 0, sizeof(query));
    query.ut_type = BOOT_TIME;
    errno = 0;
    setutxent();
    entry = getutxid(&query);
    if (entry == NULL) {
      int saved_errno = errno;
      endutxent();
      fprintf(stderr, "cannot read the PID 1 boot entry: %s\n",
          strerror(saved_errno));
      return EXIT_INFRASTRUCTURE;
    }
    boot_seconds = entry->ut_tv.tv_sec;
    boot_microseconds = entry->ut_tv.tv_usec;
    if (entry->ut_pid != 1 || entry->ut_type != BOOT_TIME) {
      endutxent();
      fprintf(stderr, "the boot entry is not owned by PID 1\n");
      return EXIT_INFRASTRUCTURE;
    }
    endutxent();

    result = read_unique_info(1, &after);
    if (result != READ_OK) {
      fprintf(stderr, "cannot confirm the PID 1 unique identity\n");
      return EXIT_INFRASTRUCTURE;
    }
    if (!unique_info_equal(&before, &after)) {
      continue;
    }
    if (boot_seconds <= 0 || boot_microseconds < 0 ||
        boot_microseconds >= 1000000 ||
        after.p_uniqueid == 0) {
      fprintf(stderr, "PID 1 returned an invalid boot identity\n");
      return EXIT_INFRASTRUCTURE;
    }
    if (printf("pid1-%" PRIu64 "-%" PRIu64 "-%" PRIu64 "\n",
            (uint64_t)boot_seconds, (uint64_t)boot_microseconds,
            after.p_uniqueid) < 0 ||
        fflush(stdout) != 0) {
      fprintf(stderr, "cannot write the PID 1 boot identity\n");
      return EXIT_INFRASTRUCTURE;
    }
    return 0;
  }

  fprintf(stderr, "PID 1 changed during the boot identity read\n");
  return EXIT_INFRASTRUCTURE;
}

static int identity_command(pid_t pid) {
  struct process_row row;
  enum read_result result = read_stable_row(pid, &row);

  if (result == READ_GONE) {
    return EXIT_STALE_IDENTITY;
  }
  if (result != READ_OK) {
    fprintf(stderr, "cannot capture stable identity for pid %d\n", pid);
    return EXIT_INFRASTRUCTURE;
  }
  if (print_row(&row) != 0 || fflush(stdout) != 0) {
    fprintf(stderr, "cannot write process identity\n");
    return EXIT_INFRASTRUCTURE;
  }
  return 0;
}

static int classify_atomic_identity_miss(
    pid_t pid, uint64_t expected_unique_id) {
  struct process_row current;
  enum read_result result = read_stable_row(pid, &current);

  if (result == READ_GONE) {
    return EXIT_STALE_IDENTITY;
  }
  if (result != READ_OK) {
    fprintf(stderr, "cannot recheck identity for pid %d after ESRCH\n", pid);
    return EXIT_INFRASTRUCTURE;
  }
  if (current.unique_id != expected_unique_id) {
    return EXIT_STALE_IDENTITY;
  }
  return EXIT_RETRY_IDENTITY;
}

static int probe_ack_fd = -1;

static void probe_signal_handler(int signal_number) {
  const char acknowledgement = 's';
  int original_errno = errno;

  (void)signal_number;
  if (probe_ack_fd >= 0) {
    (void)write(probe_ack_fd, &acknowledgement, sizeof(acknowledgement));
  }
  errno = original_errno;
}

static void run_probe_child(
    int ready_fd, int acknowledgement_fd, int control_fd) {
  struct sigaction action;
  struct pollfd control_poll;
  const char ready = 'r';
  int poll_result;

  memset(&action, 0, sizeof(action));
  action.sa_handler = probe_signal_handler;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGUSR1, &action, NULL) != 0) {
    _exit(101);
  }
  probe_ack_fd = acknowledgement_fd;
  if (write(ready_fd, &ready, sizeof(ready)) != sizeof(ready)) {
    _exit(102);
  }
  close(ready_fd);

  control_poll.fd = control_fd;
  control_poll.events = POLLIN | POLLHUP;
  control_poll.revents = 0;
  do {
    poll_result = poll(&control_poll, 1, PROBE_CHILD_TIMEOUT_MS);
  } while (poll_result < 0 && errno == EINTR);
  _exit(0);
}

static enum probe_wait_result wait_for_probe_byte(int fd, int timeout_ms) {
  struct pollfd descriptor;
  char value;
  int poll_result;
  ssize_t read_result;

  descriptor.fd = fd;
  descriptor.events = POLLIN;
  descriptor.revents = 0;
  do {
    poll_result = poll(&descriptor, 1, timeout_ms);
  } while (poll_result < 0 && errno == EINTR);
  if (poll_result == 0) {
    return PROBE_WAIT_TIMEOUT;
  }
  if (poll_result < 0) {
    return PROBE_WAIT_ERROR;
  }
  if ((descriptor.revents & POLLIN) == 0) {
    if ((descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      return PROBE_WAIT_CLOSED;
    }
    return PROBE_WAIT_ERROR;
  }

  do {
    read_result = read(fd, &value, sizeof(value));
  } while (read_result < 0 && errno == EINTR);
  if (read_result == sizeof(value)) {
    return PROBE_WAIT_BYTE;
  }
  return read_result == 0 ? PROBE_WAIT_CLOSED : PROBE_WAIT_ERROR;
}

static int reap_probe_child(pid_t child_pid) {
  return reap_exact_child(child_pid);
}

static void run_allocator_control_child(int command_fd, int result_fd) {
  uint8_t command;
  uint64_t middle_unique_id;

  if (read_full(command_fd, &command, sizeof(command)) != 0 ||
      command != (uint8_t)'f') {
    _exit(111);
  }
  close(command_fd);
  if (capture_fence_unique_id(&middle_unique_id) != EPOCH_OK) {
    _exit(112);
  }
  if (write_full(result_fd, &middle_unique_id, sizeof(middle_unique_id)) != 0) {
    _exit(113);
  }
  close(result_fd);
  _exit(0);
}

static enum epoch_result allocator_scope_probe_attempt(void) {
  int command_pipe[2] = {-1, -1};
  int result_pipe[2] = {-1, -1};
  pid_t control_pid = -1;
  uint8_t command = (uint8_t)'f';
  uint64_t lower_unique_id;
  uint64_t middle_unique_id;
  uint64_t upper_unique_id;
  enum epoch_result result = EPOCH_INFRASTRUCTURE;
  int control_reaped = 0;

  if (pipe(command_pipe) != 0 || pipe(result_pipe) != 0) {
    fprintf(stderr, "cannot create allocator-scope probe pipes: %s\n",
        strerror(errno));
    goto cleanup;
  }
  control_pid = fork();
  if (control_pid < 0) {
    if (errno == EAGAIN) {
      result = EPOCH_RETRY;
    } else {
      fprintf(stderr, "cannot fork allocator-scope probe controller: %s\n",
          strerror(errno));
    }
    goto cleanup;
  }
  if (control_pid == 0) {
    close(command_pipe[1]);
    close(result_pipe[0]);
    run_allocator_control_child(command_pipe[0], result_pipe[1]);
  }

  close(command_pipe[0]);
  command_pipe[0] = -1;
  close(result_pipe[1]);
  result_pipe[1] = -1;
  result = capture_fence_unique_id(&lower_unique_id);
  if (result != EPOCH_OK) {
    goto cleanup;
  }
  if (write_full(command_pipe[1], &command, sizeof(command)) != 0) {
    fprintf(stderr, "cannot start allocator-scope probe child fork\n");
    result = EPOCH_INFRASTRUCTURE;
    goto cleanup;
  }
  close(command_pipe[1]);
  command_pipe[1] = -1;
  if (read_full(result_pipe[0], &middle_unique_id,
          sizeof(middle_unique_id)) != 0 ||
      read_eof(result_pipe[0]) != 0) {
    fprintf(stderr, "allocator-scope probe returned an invalid frame\n");
    result = EPOCH_INFRASTRUCTURE;
    goto cleanup;
  }
  close(result_pipe[0]);
  result_pipe[0] = -1;
  result = capture_fence_unique_id(&upper_unique_id);
  if (result != EPOCH_OK) {
    goto cleanup;
  }
  if (reap_exact_child(control_pid) != 0) {
    fprintf(stderr, "cannot reap allocator-scope probe controller\n");
    result = EPOCH_INFRASTRUCTURE;
    goto cleanup;
  }
  control_reaped = 1;
  if (lower_unique_id > UINT64_MAX - 2 ||
      middle_unique_id != lower_unique_id + 1 ||
      upper_unique_id != middle_unique_id + 1) {
    result = EPOCH_RETRY;
    goto cleanup;
  }
  result = EPOCH_OK;

cleanup:
  for (size_t index = 0; index < 2; index += 1) {
    if (command_pipe[index] >= 0) {
      close(command_pipe[index]);
    }
    if (result_pipe[index] >= 0) {
      close(result_pipe[index]);
    }
  }
  if (control_pid > 0 && control_reaped == 0 &&
      reap_exact_child(control_pid) != 0) {
    fprintf(stderr, "cannot reap allocator-scope probe controller\n");
    return EPOCH_INFRASTRUCTURE;
  }
  return result;
}

static enum epoch_result probe_global_unique_id_allocator(void) {
  for (int attempt = 0; attempt < ALLOCATOR_PROBE_ATTEMPTS; attempt += 1) {
    enum epoch_result result = allocator_scope_probe_attempt();
    if (result == EPOCH_OK) {
      return EPOCH_OK;
    }
    if (result == EPOCH_INFRASTRUCTURE) {
      return EPOCH_INFRASTRUCTURE;
    }
    if (attempt + 1 < ALLOCATOR_PROBE_ATTEMPTS) {
      wait_retry_jitter(attempt, UINT32_C(0x414c4c4f));
    }
  }
  fprintf(stderr,
      "private-ABI probe could not prove the global unique-ID allocator\n");
  return EPOCH_RETRY;
}

static int probe_command(void) {
  proc_signal_with_audittoken_function signal_function;
  int ready_pipe[2] = {-1, -1};
  int acknowledgement_pipe[2] = {-1, -1};
  int control_pipe[2] = {-1, -1};
  pid_t child_pid = -1;
  struct sigaction default_child_action;
  struct sigaction original_child_action;
  struct process_row parent_row;
  struct process_row child_row;
  enum read_result read_result;
  enum epoch_result allocator_probe_result;
  enum probe_wait_result acknowledgement_result;
  uint32_t stale_pid_version;
  int signal_result;
  int signal_error;
  int probe_result = EXIT_INFRASTRUCTURE;
  int child_reap_result = 0;
  int child_action_installed = 0;
  int child_action_restore_result = 0;

  signal_function = load_audit_signal_function();
  if (signal_function == NULL) {
    return EXIT_INFRASTRUCTURE;
  }
  memset(&default_child_action, 0, sizeof(default_child_action));
  default_child_action.sa_handler = SIG_DFL;
  sigemptyset(&default_child_action.sa_mask);
  if (sigaction(SIGCHLD, &default_child_action, &original_child_action) != 0) {
    fprintf(stderr, "cannot prepare private-ABI probe child reaping: %s\n",
        strerror(errno));
    goto cleanup;
  }
  child_action_installed = 1;
  allocator_probe_result = probe_global_unique_id_allocator();
  if (allocator_probe_result == EPOCH_RETRY) {
    probe_result = EXIT_RETRY_CONTENTION;
    goto cleanup;
  }
  if (allocator_probe_result != EPOCH_OK) {
    goto cleanup;
  }
  if (pipe(ready_pipe) != 0 || pipe(acknowledgement_pipe) != 0 ||
      pipe(control_pipe) != 0) {
    fprintf(stderr, "cannot create private-ABI probe pipes: %s\n",
        strerror(errno));
    goto cleanup;
  }

  child_pid = fork();
  if (child_pid < 0) {
    fprintf(stderr, "cannot fork the private-ABI probe child: %s\n",
        strerror(errno));
    goto cleanup;
  }
  if (child_pid == 0) {
    close(ready_pipe[0]);
    close(acknowledgement_pipe[0]);
    close(control_pipe[1]);
    run_probe_child(
        ready_pipe[1], acknowledgement_pipe[1], control_pipe[0]);
  }

  close(ready_pipe[1]);
  ready_pipe[1] = -1;
  close(acknowledgement_pipe[1]);
  acknowledgement_pipe[1] = -1;
  close(control_pipe[0]);
  control_pipe[0] = -1;

  if (wait_for_probe_byte(ready_pipe[0], 1000) != PROBE_WAIT_BYTE) {
    fprintf(stderr, "private-ABI probe child did not become ready\n");
    goto cleanup;
  }
  close(ready_pipe[0]);
  ready_pipe[0] = -1;

  read_result = read_stable_row(getpid(), &parent_row);
  if (read_result != READ_OK) {
    fprintf(stderr, "private-ABI probe cannot read its own unique identity\n");
    goto cleanup;
  }
  read_result = read_stable_row(child_pid, &child_row);
  if (read_result != READ_OK || child_row.pid != (uint32_t)child_pid ||
      child_row.ppid != (uint32_t)getpid() || child_row.unique_id == 0 ||
      child_row.unique_id <= parent_row.unique_id ||
      child_row.parent_unique_id != parent_row.unique_id ||
      parent_row.resource_coalition_id == 0 ||
      parent_row.jetsam_coalition_id == 0 ||
      child_row.resource_coalition_id != parent_row.resource_coalition_id ||
      child_row.jetsam_coalition_id != parent_row.jetsam_coalition_id ||
      !row_matches_uid(&child_row, geteuid())) {
    fprintf(stderr,
        "private-ABI probe returned inconsistent unique or coalition IDs\n");
    goto cleanup;
  }

  stale_pid_version = child_row.pid_version ^ 1U;
  signal_result = invoke_audit_signal(signal_function, child_pid,
      stale_pid_version, SIGUSR1, &signal_error);
  if (signal_result == 0 ||
      (signal_error != ESRCH && signal_error != ENOENT)) {
    fprintf(stderr, "private-ABI probe accepted a stale PID version\n");
    goto cleanup;
  }
  acknowledgement_result = wait_for_probe_byte(acknowledgement_pipe[0], 100);
  if (acknowledgement_result == PROBE_WAIT_BYTE) {
    fprintf(stderr, "private-ABI probe delivered a stale-identity signal\n");
    goto cleanup;
  }
  if (acknowledgement_result == PROBE_WAIT_CLOSED) {
    fprintf(stderr,
        "private-ABI probe acknowledgement channel closed before stale-identity proof\n");
    goto cleanup;
  }
  if (acknowledgement_result == PROBE_WAIT_ERROR) {
    fprintf(stderr,
        "cannot read private-ABI probe stale-identity acknowledgement\n");
    goto cleanup;
  }
  if (classify_atomic_identity_miss(child_pid, child_row.unique_id) !=
      EXIT_RETRY_IDENTITY) {
    fprintf(stderr, "private-ABI probe misclassified a live exec race\n");
    goto cleanup;
  }

  signal_result = invoke_audit_signal(signal_function, child_pid,
      child_row.pid_version, SIGUSR1, &signal_error);
  if (signal_result != 0) {
    fprintf(stderr, "private-ABI probe rejected an exact identity: %s\n",
        strerror(signal_error));
    goto cleanup;
  }
  acknowledgement_result =
      wait_for_probe_byte(acknowledgement_pipe[0], 1000);
  if (acknowledgement_result != PROBE_WAIT_BYTE) {
    fprintf(stderr, "private-ABI probe did not deliver the exact signal\n");
    goto cleanup;
  }
  probe_result = 0;

cleanup:
  for (size_t index = 0; index < 2; index += 1) {
    if (ready_pipe[index] >= 0) {
      close(ready_pipe[index]);
    }
    if (acknowledgement_pipe[index] >= 0) {
      close(acknowledgement_pipe[index]);
    }
    if (control_pipe[index] >= 0) {
      close(control_pipe[index]);
    }
  }
  if (child_pid > 0) {
    child_reap_result = reap_probe_child(child_pid);
  }
  if (child_action_installed != 0) {
    child_action_restore_result =
        sigaction(SIGCHLD, &original_child_action, NULL);
  }
  if (child_reap_result != 0) {
    fprintf(stderr, "cannot reap the private-ABI probe child\n");
    return EXIT_INFRASTRUCTURE;
  }
  if (child_action_restore_result != 0) {
    fprintf(stderr, "cannot restore private-ABI probe child reaping: %s\n",
        strerror(errno));
    return EXIT_INFRASTRUCTURE;
  }
  if (probe_result == 0 &&
      (printf("%s\n", PROBE_OUTPUT) < 0 || fflush(stdout) != 0)) {
    fprintf(stderr, "cannot write private-ABI probe result\n");
    return EXIT_INFRASTRUCTURE;
  }
  return probe_result;
}

static int signal_command(
    pid_t pid, uint64_t expected_unique_id, int signal_number) {
  proc_signal_with_audittoken_function signal_function;
  struct process_row row;
  enum read_result result;
  uid_t caller_uid = geteuid();
  int signal_result;
  int signal_error;

  signal_function = load_audit_signal_function();
  if (signal_function == NULL) {
    return EXIT_INFRASTRUCTURE;
  }
  result = read_stable_row(pid, &row);

  if (result == READ_GONE) {
    return EXIT_STALE_IDENTITY;
  }
  if (result != READ_OK) {
    fprintf(stderr, "cannot verify stable identity for pid %d\n", pid);
    return EXIT_INFRASTRUCTURE;
  }
  if (row.unique_id != expected_unique_id) {
    return EXIT_STALE_IDENTITY;
  }
  if (!row_matches_uid(&row, caller_uid)) {
    fprintf(stderr, "target pid %d does not match the caller uid\n", pid);
    return EXIT_INFRASTRUCTURE;
  }

  /* The audit token makes the kernel validate the PID version atomically. */
  signal_result = invoke_audit_signal(signal_function, pid,
      row.pid_version, signal_number, &signal_error);
  if (signal_result == 0) {
    return 0;
  }
  if (signal_error == ESRCH || signal_error == ENOENT) {
    return classify_atomic_identity_miss(pid, expected_unique_id);
  }
  fprintf(stderr, "cannot signal verified pid %d: %s\n", pid,
      strerror(signal_error));
  return EXIT_INFRASTRUCTURE;
}

int main(int argc, char **argv) {
  uint64_t parsed_pid;
  uint64_t parsed_unique_id;
  uint64_t parsed_signal;

  if (argc == 2 && strcmp(argv[1], "snapshot") == 0) {
    return snapshot_command();
  }
  if (argc == 2 && strcmp(argv[1], "probe") == 0) {
    return probe_command();
  }
  if (argc == 2 && strcmp(argv[1], "boot-id") == 0) {
    return boot_id_command();
  }

  if (argc == 3 && strcmp(argv[1], "identity") == 0) {
    if (parse_u64(argv[2], INT_MAX, &parsed_pid) != 0 || parsed_pid == 0) {
      usage(argv[0]);
      return EXIT_USAGE;
    }
    return identity_command((pid_t)parsed_pid);
  }

  if (argc == 5 && strcmp(argv[1], "signal") == 0) {
    if (parse_u64(argv[2], INT_MAX, &parsed_pid) != 0 || parsed_pid == 0 ||
        parse_u64(argv[3], UINT64_MAX, &parsed_unique_id) != 0 ||
        parse_u64(argv[4], NSIG - 1, &parsed_signal) != 0 ||
        parsed_signal == 0) {
      usage(argv[0]);
      return EXIT_USAGE;
    }
    return signal_command(
        (pid_t)parsed_pid, parsed_unique_id, (int)parsed_signal);
  }

  usage(argv[0]);
  return EXIT_USAGE;
}
