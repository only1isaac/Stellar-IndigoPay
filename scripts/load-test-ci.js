import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ── Custom metrics ─────────────────────────────────────────────────────────

const donationLatency = new Trend("donation_latency", true);
const donationErrors = new Counter("donation_errors");
const donationSuccessRate = new Rate("donation_success_rate");

// ── CI smoke test configuration ────────────────────────────────────────────
//
// This script is a trimmed-down variant of scripts/load-test.js intended
// exclusively for CI.  Goals:
//
//   • Catch p95 latency regressions early (target: p95 < 2 s)
//   • Finish in ≤ 45 s so it doesn't noticeably extend pipeline runtime
//   • Run with far fewer VUs (10) to avoid stressing ephemeral CI runners
//
// The threshold is intentionally generous (2 s, vs the production SLO of
// 500 ms) because:
//   - The CI backend runs on a single container without a real DB
//   - We want to catch obvious regressions, not measure production latency
//
// Full-scale testing is still done manually:
//   k6 run scripts/load-test.js

export const options = {
  scenarios: {
    smoke: {
      executor: "constant-vus",
      vus: 10,
      duration: "30s",
    },
  },
  thresholds: {
    // Regression gate: p95 must stay below 2 s
    donation_latency: ["p(95)<2000"],
    // At least 95 % of requests must succeed (allows for a small number of
    // transient failures on the ephemeral CI backend)
    donation_success_rate: ["rate>0.95"],
    // Overall HTTP error rate must stay below 5 %
    http_req_failed: ["rate<0.05"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";

// A small pool of valid-format Stellar testnet public keys used as donor
// addresses.  These never touch the real network during CI.
const SAMPLE_ADDRESSES = [
  "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3A73ZFMZE",
  "GBVNNPOFVILBYQZLTDAL2QXAHVDYCSQXFMOUQ73XU3NKLHZB6KPRSEV",
  "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGBQH9L3BKQBFHV7HJZQZD",
  "GDNSSYSCSSRY3VWUQGGZXFPXDPWKJTMV6GCRXFCTQHK63CG4K5UEFSV",
  "GDQJUTQYK2MQX2CNYPCAETIQZRDZYOUC5RLAOBOVPPFBQ6TMHKCMB4PT",
];

// Generate a unique-ish 64-char hex transaction hash per VU + iteration so
// the idempotency check in recordDonation doesn't collapse all requests.
function fakeTxHash(vuId, iter) {
  const base = `${vuId.toString(16).padStart(8, "0")}${iter.toString(16).padStart(8, "0")}`;
  return (base + "0".repeat(64)).slice(0, 64);
}

// ── Default scenario: donation recording smoke test ─────────────────────────

export default function () {
  const donor = SAMPLE_ADDRESSES[__VU % SAMPLE_ADDRESSES.length];
  const txHash = fakeTxHash(__VU, __ITER);
  const amountXLM = (Math.random() * 9 + 1).toFixed(7);

  const payload = JSON.stringify({
    projectId: `project-${((__VU + __ITER) % 10) + 1}`,
    amountXLM,
    donorAddress: donor,
    transactionHash: txHash,
    memo: "ci-smoke-test",
  });

  const params = {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: "POST /api/donations" },
  };

  const res = http.post(`${BASE_URL}/api/donations`, payload, params);

  donationLatency.add(res.timings.duration);

  const ok = check(res, {
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
    "response has donationId or success": (r) => {
      try {
        const body = JSON.parse(r.body);
        return !!(body.donationId ?? body.data?.id ?? body.success);
      } catch {
        return false;
      }
    },
  });

  donationSuccessRate.add(ok ? 1 : 0);
  if (!ok) donationErrors.add(1);

  // Short think-time to avoid hammering the CI backend.  Keeps the effective
  // request rate at roughly 5-10 req/s across 10 VUs.
  sleep(1 + Math.random() * 0.5);
}
