import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Real child processes; a generous but bounded ceiling.
    //
    // Raised from 30s by V3 slice 3, and the reason is a real cost rather than
    // a flaky test being accommodated. Every Windows command now creates its
    // target behind the launch boundary, which means one extra process and a
    // status handshake per command: measured at ~30ms on an idle machine and
    // **228ms** as the worst of three on this one under load
    // (`test:dist-owned-command` prints the number every run). A case that
    // drives a real remediation loop makes dozens of Git calls, so it pays that
    // dozens of times — and one such case sat just inside 30s before and just
    // outside it in the parallel gate afterwards.
    //
    // The trade-off is stated rather than absorbed: this is the hang detector
    // for ~3 200 tests, and a looser one detects a hang later. It stays far
    // below the CI job's own 40-minute ceiling, which is the backstop.
    testTimeout: 90_000,
  },
});
