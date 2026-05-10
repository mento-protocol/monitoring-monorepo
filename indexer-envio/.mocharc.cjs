module.exports = {
  // 30s — bumped from 10s after PR #366 hit a flake pattern where 1-3
  // random tests (biPoolManager, broker, dailySnapshot, feeUpdated,
  // poolDailyFeeSnapshot) timed out per CI run on different files each
  // time. Pattern matches the pre-existing `getRpcClient fail-fast`
  // flake: CI's slower scheduling brushes against the 10s ceiling on
  // test files with multiple sequential mock-effect resolutions.
  // Locally tests resolve in 0.5-2s; the higher ceiling is purely
  // defensive against CI variance, not a license for slow tests.
  timeout: 30000,
};
