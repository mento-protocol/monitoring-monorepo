The family partition works for normal focused runs, but its safety guard misses supported lockless gate runs. Those runs can incorrectly accept a partial self-test as the full quality-gate result.

Review comment:

- [P2] Refuse focused tests in lockless gate runs — /private/tmp/fx-1995/scripts/agent-quality-gate.test.sh:600-603
  When a developer uses the documented `--no-lock` or `AGENT_QUALITY_GATE_LOCK=0` escape hatch while `GATE_TEST_FOCUS` is exported, lock acquisition returns without setting `AGENT_QUALITY_GATE_LOCK_HELD`, so this guard does not fire. The gate's mapped self-test can then run only the selected family and report success without the full suite, contrary to the contract in `docs/notes/agent-quality-gate-mechanics.md:1139-1146`. Detect gate execution independently of lock ownership, or clear the focus before mapped commands.
