import { describe, expect, it } from "vitest";
import { passesBlockerRule, sortCandidates } from "./tracker.js";
import type { Issue, ServiceConfig } from "./types.js";

describe("tracker helpers", () => {
  it("sorts by priority, oldest creation time, then identifier", () => {
    expect(
      sortCandidates([
        issue("B", 2, "2024-01-01"),
        issue("C", 1, "2025-01-01"),
        issue("A", 1, "2024-01-01")
      ]).map((item) => item.identifier)
    ).toEqual(["A", "C", "B"]);
  });

  it("blocks Todo issues with non-terminal blockers", () => {
    const config = { tracker: { terminal_states: ["Done"] } } as ServiceConfig;
    const blocked = issue("A", 1, "2024-01-01");
    blocked.blocked_by = [{ id: "2", identifier: "B", state: "Todo" }];
    expect(passesBlockerRule(blocked, config)).toBe(false);
    blocked.blocked_by = [{ id: "2", identifier: "B", state: "Done" }];
    expect(passesBlockerRule(blocked, config)).toBe(true);
  });
});

function issue(identifier: string, priority: number | null, created_at: string): Issue {
  return {
    id: identifier,
    identifier,
    title: identifier,
    description: null,
    priority,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at,
    updated_at: null
  };
}
