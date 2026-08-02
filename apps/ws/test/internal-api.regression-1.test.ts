/**
 * Regression: ISSUE-005 — an agent that degraded kept silently swallowing
 * @mentions. Dispatch skipped 11 turns with only a server log while the board
 * chat showed nothing, so the sender had no idea the agent had stopped.
 * Found by /qa on 2026-08-01
 * Report: .gstack/qa-reports/qa-report-quorum-2026-08-01.md
 */
import { describe, expect, it } from "vitest";

import { degradedNotice } from "../src/internal-api";

describe("degradedNotice", () => {
  it("announces the agent by name when it first degrades", () => {
    const notice = degradedNotice("ready", "degraded", "Researcher");
    expect(notice).toContain("Researcher");
    expect(notice).toContain("degraded");
  });

  it("announces a degrade seen for the first time (no prior status in the doc)", () => {
    expect(degradedNotice(undefined, "degraded", "Researcher")).not.toBeNull();
  });

  it("stays silent while the agent is already degraded, so one outage is one message", () => {
    expect(degradedNotice("degraded", "degraded", "Researcher")).toBeNull();
  });

  it("speaks again only after the agent recovers and degrades a second time", () => {
    expect(degradedNotice("degraded", "ready", "Researcher")).toBeNull();
    expect(degradedNotice("ready", "degraded", "Researcher")).not.toBeNull();
  });

  it.each(["ready", "running"] as const)("says nothing about a healthy %s agent", (status) => {
    expect(degradedNotice("degraded", status, "Researcher")).toBeNull();
    expect(degradedNotice("ready", status, "Researcher")).toBeNull();
  });
});
