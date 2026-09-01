The new guard can be bypassed through the gate's supported no-lock mode. This allows a real local quality-gate run to report success without executing the complete self-test.

Review comment:

- [P1] Reject focus in no-lock gate runs — /private/tmp/fx-1995/scripts/agent-quality-gate.test.sh:600-603
  When `GATE_TEST_FOCUS` is exported and the real gate uses `--no-lock` or `AGENT_QUALITY_GATE_LOCK=0`, it never exports `AGENT_QUALITY_GATE_LOCK_HELD`. The mapped `pnpm agent:quality-gate:test` therefore reaches this branch and exits successfully after only the selected families. This violates the full-suite guarantee in `docs/notes/agent-quality-gate-mechanics.md:1143-1146`. Gate-launched commands carry `AGENTQG_RUN` even without a lock, so reject focus when that marker is set too.
