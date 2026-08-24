export const stubTrunk = `#!/usr/bin/env bash
set -u

event_log="\${QG_FIXTURE_EVENT_LOG:?}"
label="\${QG_FIXTURE_LABEL:-gate}"
pid_file="\${QG_FIXTURE_PID_FILE:-}"
start_barrier="\${QG_FIXTURE_START_BARRIER:-}"
delay_ms="\${QG_FIXTURE_DEFAULT_DELAY_MS:-250}"
trunk_argv="$*"

case " $* " in
  *" fixture-full.txt "*) delay_ms="\${QG_FIXTURE_FULL_DELAY_MS:-4000}" ;;
  *" fixture-short-a.txt "*|*" fixture-short-b.txt "*)
    delay_ms="\${QG_FIXTURE_SHORT_DELAY_MS:-500}"
    ;;
esac

record_event() {
  node -e '
    const fs = require("node:fs");
    const [file, event, label, shellPid, argv, cwd, descendantPid] = process.argv.slice(1);
    fs.appendFileSync(file, JSON.stringify({
      event,
      label,
      timestampMs: Date.now(),
      shellPid: Number(shellPid),
      argv,
      cwd,
      descendantPid: descendantPid ? Number(descendantPid) : undefined,
    }) + "\\n");
  ' "$event_log" "$1" "$label" "$$" "$trunk_argv" "$PWD" "\${2:-}"
}

record_event start
if [[ -n "$start_barrier" ]]; then
  while [[ ! -e "\${start_barrier}.release" ]]; do
    sleep 0.05
  done
fi
case " $* " in
  *" fixture-crash.txt "*)
    /bin/bash -c 'trap "" HUP INT TERM; while :; do sleep 1; done' qg-fixture-survivor &
    descendant_pid=$!
    if [[ -n "$pid_file" ]]; then
      printf '%s %s\n' "$$" "$descendant_pid" > "$pid_file"
    fi
    record_event descendant "$descendant_pid"
    wait "$descendant_pid"
    rc=$?
    record_event end
    exit "$rc"
    ;;
esac

node -e 'setTimeout(() => {}, Number(process.argv[1]))' "$delay_ms"
rc=$?
record_event end
exit "$rc"
`;
