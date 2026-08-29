#ifndef AGENTQG_DARWIN_PROCESS_IDENTITY_RUNTIME_INCLUDE
#error "darwin-process-identity-runtime.inc.c must be included by darwin-process-identity.c"
#endif

static enum read_result read_bsd_info(
    pid_t pid, struct proc_bsdshortinfo *bsd) {
  int bytes;
  int saved_errno;

  memset(bsd, 0, sizeof(*bsd));
  errno = 0;
  bytes = proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, bsd,
      (int)sizeof(*bsd));
  saved_errno = errno;
  if (bytes == (int)sizeof(*bsd) && bsd->pbsi_pid == (uint32_t)pid) {
    return READ_OK;
  }
  if (bytes == 0 && (saved_errno == ESRCH || saved_errno == ENOENT)) {
    return READ_GONE;
  }
  return READ_INFRASTRUCTURE;
}

static enum read_result read_unique_info(
    pid_t pid, struct proc_uniqidentifierinfo *unique) {
  int bytes;
  int saved_errno;

  memset(unique, 0, sizeof(*unique));
  errno = 0;
  bytes = proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, unique,
      (int)sizeof(*unique));
  saved_errno = errno;
  if (bytes == (int)sizeof(*unique)) {
    return READ_OK;
  }
  if (bytes == 0 && (saved_errno == ESRCH || saved_errno == ENOENT)) {
    return READ_GONE;
  }
  return READ_INFRASTRUCTURE;
}

static enum read_result read_coalition_info(
    pid_t pid, struct agentqg_proc_pidcoalitioninfo *coalition) {
  int bytes;
  int saved_errno;

  memset(coalition, 0, sizeof(*coalition));
  errno = 0;
  bytes = proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, coalition,
      (int)sizeof(*coalition));
  saved_errno = errno;
  if (bytes == (int)sizeof(*coalition)) {
    return READ_OK;
  }
  if (bytes == 0 && (saved_errno == ESRCH || saved_errno == ENOENT)) {
    return READ_GONE;
  }
  return READ_INFRASTRUCTURE;
}

static int unique_info_equal(const struct proc_uniqidentifierinfo *left,
    const struct proc_uniqidentifierinfo *right) {
  return left->p_uniqueid == right->p_uniqueid &&
      left->p_puniqueid == right->p_puniqueid &&
      left->p_idversion == right->p_idversion;
}

static int coalition_info_equal(
    const struct agentqg_proc_pidcoalitioninfo *left,
    const struct agentqg_proc_pidcoalitioninfo *right) {
  return left->coalition_id[AGENTQG_RESOURCE_COALITION_INDEX] ==
          right->coalition_id[AGENTQG_RESOURCE_COALITION_INDEX] &&
      left->coalition_id[AGENTQG_JETSAM_COALITION_INDEX] ==
          right->coalition_id[AGENTQG_JETSAM_COALITION_INDEX];
}

static int bsd_info_equal(const struct proc_bsdshortinfo *left,
    const struct proc_bsdshortinfo *right) {
  return left->pbsi_pid == right->pbsi_pid &&
      left->pbsi_ppid == right->pbsi_ppid &&
      left->pbsi_pgid == right->pbsi_pgid &&
      left->pbsi_status == right->pbsi_status &&
      left->pbsi_uid == right->pbsi_uid &&
      left->pbsi_ruid == right->pbsi_ruid &&
      left->pbsi_svuid == right->pbsi_svuid;
}

static enum read_result read_stable_row(pid_t pid, struct process_row *row) {
  struct proc_uniqidentifierinfo before;
  struct proc_uniqidentifierinfo after;
  struct agentqg_proc_pidcoalitioninfo coalition_before;
  struct agentqg_proc_pidcoalitioninfo coalition_after;
  struct proc_bsdshortinfo bsd_before;
  struct proc_bsdshortinfo bsd_after;
  enum read_result result;

  for (int attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    result = read_unique_info(pid, &before);
    if (result != READ_OK) {
      return result;
    }

    result = read_coalition_info(pid, &coalition_before);
    if (result != READ_OK) {
      return result;
    }

    result = read_bsd_info(pid, &bsd_before);
    if (result != READ_OK) {
      return result;
    }

    result = read_bsd_info(pid, &bsd_after);
    if (result != READ_OK) {
      return result;
    }

    result = read_coalition_info(pid, &coalition_after);
    if (result != READ_OK) {
      return result;
    }

    result = read_unique_info(pid, &after);
    if (result != READ_OK) {
      return result;
    }

    if (!unique_info_equal(&before, &after) ||
        !bsd_info_equal(&bsd_before, &bsd_after) ||
        !coalition_info_equal(&coalition_before, &coalition_after)) {
      continue;
    }
    if (coalition_after.coalition_id[AGENTQG_RESOURCE_COALITION_INDEX] == 0 ||
        coalition_after.coalition_id[AGENTQG_JETSAM_COALITION_INDEX] == 0) {
      return READ_INFRASTRUCTURE;
    }

    row->pid = bsd_after.pbsi_pid;
    row->ppid = bsd_after.pbsi_ppid;
    row->pgid = bsd_after.pbsi_pgid;
    row->status = bsd_after.pbsi_status;
    row->uid = bsd_after.pbsi_uid;
    row->ruid = bsd_after.pbsi_ruid;
    row->svuid = bsd_after.pbsi_svuid;
    row->unique_id = after.p_uniqueid;
    row->parent_unique_id = after.p_puniqueid;
    row->resource_coalition_id =
        coalition_after.coalition_id[AGENTQG_RESOURCE_COALITION_INDEX];
    row->jetsam_coalition_id =
        coalition_after.coalition_id[AGENTQG_JETSAM_COALITION_INDEX];
    row->pid_version = (uint32_t)after.p_idversion;
    return READ_OK;
  }

  return READ_UNSTABLE;
}

static int row_matches_uid(const struct process_row *row, uid_t caller_uid) {
  return row->uid == caller_uid || row->ruid == caller_uid ||
      row->svuid == caller_uid;
}

static int bsd_matches_uid(
    const struct proc_bsdshortinfo *bsd, uid_t caller_uid) {
  return bsd->pbsi_uid == caller_uid || bsd->pbsi_ruid == caller_uid ||
      bsd->pbsi_svuid == caller_uid;
}

static int print_row(const struct process_row *row) {
  return printf("%" PRIu32 "\t%" PRIu32 "\t%" PRIu32 "\t%" PRIu32
                "\t%" PRIu32 "\t%" PRIu32 "\t%" PRIu32 "\t%" PRIu64
                "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu64 "\t%" PRIu32
                "\n",
             row->pid, row->ppid, row->pgid, row->status, row->uid, row->ruid,
             row->svuid, row->unique_id, row->parent_unique_id,
             row->resource_coalition_id, row->jetsam_coalition_id,
             row->pid_version) < 0
      ? -1
      : 0;
}

static int compare_rows(const void *left_pointer, const void *right_pointer) {
  const struct process_row *left = left_pointer;
  const struct process_row *right = right_pointer;

  if (left->pid < right->pid) {
    return -1;
  }
  if (left->pid > right->pid) {
    return 1;
  }
  if (left->unique_id < right->unique_id) {
    return -1;
  }
  if (left->unique_id > right->unique_id) {
    return 1;
  }
  return 0;
}

static void wait_retry_jitter(int attempt, uint32_t salt) {
  uint32_t mixed = ((uint32_t)getpid() * UINT32_C(2654435761)) ^
      ((uint32_t)(attempt + 1) * UINT32_C(2246822519)) ^ salt;
  int delay_ms = 3 + (int)(mixed % UINT32_C(29));
  int poll_result;

  do {
    poll_result = poll(NULL, 0, delay_ms);
  } while (poll_result < 0 && errno == EINTR);
}

static int write_full(int fd, const void *buffer, size_t length) {
  const uint8_t *cursor = buffer;
  size_t written = 0;

  while (written < length) {
    ssize_t result = write(fd, cursor + written, length - written);
    if (result < 0 && errno == EINTR) {
      continue;
    }
    if (result <= 0) {
      return -1;
    }
    written += (size_t)result;
  }
  return 0;
}

static int read_full(int fd, void *buffer, size_t length) {
  uint8_t *cursor = buffer;
  size_t consumed = 0;

  while (consumed < length) {
    ssize_t result = read(fd, cursor + consumed, length - consumed);
    if (result < 0 && errno == EINTR) {
      continue;
    }
    if (result <= 0) {
      return -1;
    }
    consumed += (size_t)result;
  }
  return 0;
}

static int read_eof(int fd) {
  uint8_t extra;
  ssize_t result;

  do {
    result = read(fd, &extra, sizeof(extra));
  } while (result < 0 && errno == EINTR);
  return result == 0 ? 0 : -1;
}

static int reap_exact_child(pid_t child_pid) {
  int child_status;
  pid_t wait_result;

  do {
    wait_result = waitpid(child_pid, &child_status, 0);
  } while (wait_result < 0 && errno == EINTR);
  if (wait_result != child_pid || !WIFEXITED(child_status) ||
      WEXITSTATUS(child_status) != 0) {
    return -1;
  }
  return 0;
}

static void run_fence_child(int frame_fd, int release_fd) {
  struct proc_uniqidentifierinfo unique;
  struct proc_bsdshortinfo bsd;
  struct fence_frame frame;
  uint8_t release;
  ssize_t release_result;

  if (read_unique_info(getpid(), &unique) != READ_OK ||
      read_bsd_info(getpid(), &bsd) != READ_OK) {
    _exit(101);
  }
  memset(&frame, 0, sizeof(frame));
  frame.magic = FENCE_FRAME_MAGIC;
  frame.pid = bsd.pbsi_pid;
  frame.ppid = bsd.pbsi_ppid;
  frame.pid_version = (uint32_t)unique.p_idversion;
  frame.unique_id = unique.p_uniqueid;
  frame.parent_unique_id = unique.p_puniqueid;
  if (write_full(frame_fd, &frame, sizeof(frame)) != 0) {
    _exit(102);
  }
  close(frame_fd);
  do {
    release_result = read(release_fd, &release, sizeof(release));
  } while (release_result < 0 && errno == EINTR);
  _exit(release_result == 0 ? 0 : 103);
}

static enum epoch_result capture_fence_unique_id(uint64_t *unique_id) {
  struct proc_uniqidentifierinfo parent_unique;
  struct fence_frame frame;
  int frame_pipe[2] = {-1, -1};
  int release_pipe[2] = {-1, -1};
  pid_t child_pid = -1;
  enum epoch_result result = EPOCH_INFRASTRUCTURE;
  int child_reap_result = -1;

  if (read_unique_info(getpid(), &parent_unique) != READ_OK ||
      parent_unique.p_uniqueid == 0) {
    fprintf(stderr, "cannot read the fence parent unique identity\n");
    goto cleanup;
  }
  if (pipe(frame_pipe) != 0 || pipe(release_pipe) != 0) {
    fprintf(stderr, "cannot create coherent-snapshot fence pipes: %s\n",
        strerror(errno));
    goto cleanup;
  }
  child_pid = fork();
  if (child_pid < 0) {
    if (errno == EAGAIN) {
      result = EPOCH_RETRY;
    } else {
      fprintf(stderr, "cannot fork coherent-snapshot fence: %s\n",
          strerror(errno));
    }
    goto cleanup;
  }
  if (child_pid == 0) {
    close(frame_pipe[0]);
    close(release_pipe[1]);
    run_fence_child(frame_pipe[1], release_pipe[0]);
  }

  close(frame_pipe[1]);
  frame_pipe[1] = -1;
  close(release_pipe[0]);
  release_pipe[0] = -1;
  if (read_full(frame_pipe[0], &frame, sizeof(frame)) != 0 ||
      read_eof(frame_pipe[0]) != 0 || frame.magic != FENCE_FRAME_MAGIC ||
      frame.pid != (uint32_t)child_pid || frame.ppid != (uint32_t)getpid() ||
      frame.pid_version == 0 || frame.unique_id == 0 ||
      frame.unique_id <= parent_unique.p_uniqueid ||
      frame.parent_unique_id != parent_unique.p_uniqueid) {
    fprintf(stderr, "coherent-snapshot fence returned an invalid frame\n");
    goto cleanup;
  }
  *unique_id = frame.unique_id;
  result = EPOCH_OK;

cleanup:
  for (size_t index = 0; index < 2; index += 1) {
    if (frame_pipe[index] >= 0) {
      close(frame_pipe[index]);
    }
    if (release_pipe[index] >= 0) {
      close(release_pipe[index]);
    }
  }
  if (child_pid > 0) {
    child_reap_result = reap_exact_child(child_pid);
    if (child_reap_result != 0) {
      fprintf(stderr, "cannot reap coherent-snapshot fence child\n");
      return EPOCH_INFRASTRUCTURE;
    }
  }
  return result;
}

static int compare_pids(const void *left_pointer, const void *right_pointer) {
  pid_t left = *(const pid_t *)left_pointer;
  pid_t right = *(const pid_t *)right_pointer;
  return left < right ? -1 : left > right ? 1 : 0;
}

static enum epoch_result capture_pid_vector(pid_t **pids,
    int *estimated_count, int *listed_count, int *capacity,
    int *zero_pid_count, enum snapshot_retry_reason *retry_reason) {
  int estimate;
  int listed;
  pid_t *buffer;

  errno = 0;
  estimate = proc_listallpids(NULL, 0);
  if (estimate <= PROC_LIST_PID_PADDING) {
    fprintf(stderr, "proc_listallpids size query returned no process count\n");
    return EPOCH_INFRASTRUCTURE;
  }
  if ((size_t)estimate > (size_t)INT_MAX / sizeof(*buffer)) {
    fprintf(stderr, "process list is too large\n");
    return EPOCH_INFRASTRUCTURE;
  }
  buffer = calloc((size_t)estimate, sizeof(*buffer));
  if (buffer == NULL) {
    fprintf(stderr, "process list allocation failed\n");
    return EPOCH_INFRASTRUCTURE;
  }

  errno = 0;
  listed = proc_listallpids(buffer, estimate * (int)sizeof(*buffer));
  if (listed <= 0) {
    fprintf(stderr, "proc_listallpids returned no process vector\n");
    free(buffer);
    return EPOCH_INFRASTRUCTURE;
  }
  for (int index = 0; index < listed; index += 1) {
    if (buffer[index] == 0) {
      *zero_pid_count += 1;
    }
  }
  if (listed >= estimate || *zero_pid_count != 1 || listed <= *zero_pid_count ||
      estimate - (listed - *zero_pid_count) < PROC_LIST_PID_PADDING) {
    *estimated_count = estimate;
    *listed_count = listed;
    *capacity = estimate;
    *retry_reason = SNAPSHOT_RETRY_COUNT;
    free(buffer);
    return EPOCH_RETRY;
  }

  qsort(buffer, (size_t)listed, sizeof(*buffer), compare_pids);
  for (int index = 0; index < listed; index += 1) {
    if (buffer[index] < 0 ||
        (buffer[index] > 0 && index > 0 &&
            buffer[index] == buffer[index - 1])) {
      *estimated_count = estimate;
      *listed_count = listed;
      *capacity = estimate;
      *retry_reason = SNAPSHOT_RETRY_PID_VECTOR;
      free(buffer);
      return EPOCH_RETRY;
    }
  }
  *pids = buffer;
  *estimated_count = estimate;
  *listed_count = listed;
  *capacity = estimate;
  return EPOCH_OK;
}

static void free_process_snapshot(struct process_snapshot *snapshot) {
  free(snapshot->rows);
  memset(snapshot, 0, sizeof(*snapshot));
}

static const char *snapshot_retry_reason_name(
    enum snapshot_retry_reason reason) {
  switch (reason) {
    case SNAPSHOT_RETRY_FENCE:
      return "fence creation";
    case SNAPSHOT_RETRY_COUNT:
      return "process counts";
    case SNAPSHOT_RETRY_PID_VECTOR:
      return "PID vector";
    case SNAPSHOT_RETRY_ROW_UNSTABLE:
      return "unstable row";
    case SNAPSHOT_RETRY_ROW_AFTER_FENCE:
      return "post-fence row";
    case SNAPSHOT_RETRY_FENCE_GAP:
      return "non-adjacent fences";
    case SNAPSHOT_RETRY_NONE:
      return "unknown invariant";
  }
  return "unknown invariant";
}

static enum epoch_result capture_snapshot_epoch(
    struct process_snapshot *snapshot) {
  pid_t *pids = NULL;
  struct process_row *rows = NULL;
  size_t row_count = 0;
  uid_t caller_uid = geteuid();
  enum epoch_result epoch_result;

  memset(snapshot, 0, sizeof(*snapshot));
  epoch_result = capture_fence_unique_id(&snapshot->lower_unique_id);
  if (epoch_result != EPOCH_OK) {
    if (epoch_result == EPOCH_RETRY) {
      snapshot->retry_reason = SNAPSHOT_RETRY_FENCE;
    }
    return epoch_result;
  }
  epoch_result = capture_pid_vector(&pids, &snapshot->estimated_count,
      &snapshot->listed_count, &snapshot->capacity,
      &snapshot->zero_pid_count, &snapshot->retry_reason);
  if (epoch_result != EPOCH_OK) {
    return epoch_result;
  }
  rows = calloc((size_t)snapshot->listed_count, sizeof(*rows));
  if (rows == NULL) {
    fprintf(stderr, "process snapshot allocation failed\n");
    free(pids);
    return EPOCH_INFRASTRUCTURE;
  }

  for (int index = 0; index < snapshot->listed_count; index += 1) {
    struct proc_bsdshortinfo eligibility;
    struct process_row row;
    enum read_result read_result;
    pid_t pid = pids[index];

    if (pid <= 0) {
      continue;
    }
    read_result = read_bsd_info(pid, &eligibility);
    if (read_result == READ_GONE) {
      continue;
    }
    if (read_result != READ_OK) {
      fprintf(stderr, "cannot read process eligibility for pid %d\n", pid);
      epoch_result = EPOCH_INFRASTRUCTURE;
      goto cleanup;
    }
    if (!bsd_matches_uid(&eligibility, caller_uid)) {
      continue;
    }

    read_result = read_stable_row(pid, &row);
    if (read_result == READ_GONE) {
      continue;
    }
    if (read_result == READ_UNSTABLE) {
      snapshot->retry_reason = SNAPSHOT_RETRY_ROW_UNSTABLE;
      epoch_result = EPOCH_RETRY;
      goto cleanup;
    }
    if (read_result != READ_OK) {
      struct proc_bsdshortinfo current;
      enum read_result current_result = read_bsd_info(pid, &current);

      if (current_result == READ_GONE) {
        continue;
      }
      if (current_result == READ_OK &&
          !bsd_matches_uid(&current, caller_uid)) {
        continue;
      }
      fprintf(stderr, "cannot capture stable identity for relevant pid %d\n",
          pid);
      epoch_result = EPOCH_INFRASTRUCTURE;
      goto cleanup;
    }
    if (!row_matches_uid(&row, caller_uid)) {
      continue;
    }
    if (row.unique_id >= snapshot->lower_unique_id) {
      snapshot->retry_reason = SNAPSHOT_RETRY_ROW_AFTER_FENCE;
      epoch_result = EPOCH_RETRY;
      goto cleanup;
    }
    rows[row_count] = row;
    row_count += 1;
  }

  epoch_result = capture_fence_unique_id(&snapshot->upper_unique_id);
  if (epoch_result != EPOCH_OK) {
    if (epoch_result == EPOCH_RETRY) {
      snapshot->retry_reason = SNAPSHOT_RETRY_FENCE;
    }
    goto cleanup;
  }
  if (snapshot->lower_unique_id == UINT64_MAX ||
      snapshot->upper_unique_id != snapshot->lower_unique_id + 1) {
    snapshot->retry_reason = SNAPSHOT_RETRY_FENCE_GAP;
    epoch_result = EPOCH_RETRY;
    goto cleanup;
  }
  qsort(rows, row_count, sizeof(*rows), compare_rows);
  snapshot->rows = rows;
  snapshot->row_count = row_count;
  rows = NULL;
  epoch_result = EPOCH_OK;

cleanup:
  free(rows);
  free(pids);
  return epoch_result;
}

static int snapshot_command(void) {
  struct sigaction default_child_action;
  struct sigaction original_child_action;
  struct process_snapshot snapshot;
  enum epoch_result epoch_result = EPOCH_RETRY;
  int child_action_installed = 0;
  int exit_status = EXIT_INFRASTRUCTURE;

  memset(&snapshot, 0, sizeof(snapshot));
  memset(&default_child_action, 0, sizeof(default_child_action));
  default_child_action.sa_handler = SIG_DFL;
  sigemptyset(&default_child_action.sa_mask);
  if (sigaction(SIGCHLD, &default_child_action, &original_child_action) != 0) {
    fprintf(stderr, "cannot prepare coherent-snapshot child reaping: %s\n",
        strerror(errno));
    return EXIT_INFRASTRUCTURE;
  }
  child_action_installed = 1;

  for (int attempt = 0; attempt < SNAPSHOT_EPOCH_ATTEMPTS; attempt += 1) {
    free_process_snapshot(&snapshot);
    epoch_result = capture_snapshot_epoch(&snapshot);
    if (epoch_result == EPOCH_OK || epoch_result == EPOCH_INFRASTRUCTURE) {
      break;
    }
    if (attempt + 1 < SNAPSHOT_EPOCH_ATTEMPTS) {
      wait_retry_jitter(attempt, UINT32_C(0x534e4150));
    }
  }
  if (child_action_installed != 0 &&
      sigaction(SIGCHLD, &original_child_action, NULL) != 0) {
    fprintf(stderr, "cannot restore coherent-snapshot child reaping: %s\n",
        strerror(errno));
    goto cleanup;
  }
  child_action_installed = 0;
  if (epoch_result == EPOCH_RETRY) {
    fprintf(stderr,
        "coherent process snapshot stayed contended across %d fence/count/row epochs: %s (lower=%" PRIu64 ", upper=%" PRIu64 ", estimate=%d, listed=%d, capacity=%d, zero-pids=%d)\n",
        SNAPSHOT_EPOCH_ATTEMPTS,
        snapshot_retry_reason_name(snapshot.retry_reason),
        snapshot.lower_unique_id, snapshot.upper_unique_id,
        snapshot.estimated_count, snapshot.listed_count, snapshot.capacity,
        snapshot.zero_pid_count);
    exit_status = EXIT_RETRY_CONTENTION;
    goto cleanup;
  }
  if (epoch_result != EPOCH_OK) {
    goto cleanup;
  }
  if (printf("%s\t%" PRIu64 "\t%" PRIu64 "\t%d\t%d\t%d\t%d\t%zu\n",
          SNAPSHOT_HEADER, snapshot.lower_unique_id, snapshot.upper_unique_id,
          snapshot.estimated_count, snapshot.listed_count, snapshot.capacity,
          snapshot.zero_pid_count, snapshot.row_count) < 0) {
    fprintf(stderr, "cannot write process snapshot header\n");
    goto cleanup;
  }
  for (size_t index = 0; index < snapshot.row_count; index += 1) {
    if (print_row(&snapshot.rows[index]) != 0) {
      fprintf(stderr, "cannot write process snapshot row\n");
      goto cleanup;
    }
  }
  if (fflush(stdout) != 0) {
    fprintf(stderr, "cannot flush process snapshot\n");
    goto cleanup;
  }
  exit_status = 0;

cleanup:
  if (child_action_installed != 0 &&
      sigaction(SIGCHLD, &original_child_action, NULL) != 0) {
    fprintf(stderr, "cannot restore coherent-snapshot child reaping: %s\n",
        strerror(errno));
    exit_status = EXIT_INFRASTRUCTURE;
  }
  free_process_snapshot(&snapshot);
  return exit_status;
}
