import { describe, expect, it } from "vitest";
import {
  compileWorkflowTopology,
  workflowNodeIds,
} from "../src/workflow-topology.js";

describe("compileWorkflowTopology", () => {
  it("publishes the closed set of workflow node identifiers", () => {
    expect(workflowNodeIds).toEqual([
      "entry",
      "resolve-risk",
      "explore",
      "author",
      "checkpoint-commit",
      "bind-acceptance",
      "verify",
      "review",
      "repair",
      "ready",
    ]);
  });

  it.each([
    [
      "solo",
      ["entry", "resolve-risk", "author", "checkpoint-commit", "verify", "repair", "ready"],
      [
        "entry.resolve-risk",
        "entry.author",
        "author.checkpoint",
        "repair.checkpoint",
        "checkpoint.verify",
        "verify.repair",
        "verify.ready",
      ],
    ],
    [
      "assisted",
      ["entry", "resolve-risk", "explore", "author", "checkpoint-commit", "verify", "repair", "ready"],
      [
        "entry.resolve-risk",
        "entry.explore",
        "explore.author",
        "author.checkpoint",
        "repair.checkpoint",
        "checkpoint.verify",
        "verify.repair",
        "verify.ready",
      ],
    ],
    [
      "reviewed",
      [
        "entry",
        "resolve-risk",
        "author",
        "checkpoint-commit",
        "bind-acceptance",
        "verify",
        "review",
        "repair",
        "ready",
      ],
      [
        "entry.resolve-risk",
        "entry.author",
        "author.checkpoint",
        "repair.checkpoint",
        "checkpoint.acceptance",
        "acceptance.verify",
        "verify.repair",
        "verify.review",
        "review.repair",
        "review.ready",
      ],
    ],
  ] as const)("compiles the fixed %s manifest", (template, expectedNodes, expectedEdges) => {
    const manifest = compileWorkflowTopology(template);

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      template,
      entryNode: "entry",
      readyNode: "ready",
      failureDisposition: "blocked",
      budgets: [{ id: "repair", maximumTraversals: 1, exhaustionDisposition: "block" }],
    });
    expect(manifest.nodes.map((node) => node.id)).toEqual(expectedNodes);
    expect(manifest.edges.map((edge) => edge.id)).toEqual(expectedEdges);
  });

  it("gives only author and repair workspace-write authority", () => {
    for (const template of ["solo", "assisted", "reviewed"] as const) {
      expect(
        compileWorkflowTopology(template).nodes
          .filter((node) => node.executionMode === "workspace-write-agent")
          .map((node) => node.id),
      ).toEqual(["author", "repair"]);
    }
  });

  it("uses one shared finite repair budget for both reviewed back edges", () => {
    const manifest = compileWorkflowTopology("reviewed");
    expect(manifest.edges.filter((edge) => edge.kind === "back")).toEqual([
      expect.objectContaining({ id: "verify.repair", budgetId: "repair" }),
      expect.objectContaining({ id: "review.repair", budgetId: "repair" }),
    ]);
    expect(manifest.budgets).toEqual([
      { id: "repair", maximumTraversals: 1, exhaustionDisposition: "block" },
    ]);
  });

  it("compiles deterministically without sharing mutable arrays", () => {
    const first = compileWorkflowTopology("reviewed");
    const second = compileWorkflowTopology("reviewed");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.nodes).not.toBe(second.nodes);
    expect(first.edges).not.toBe(second.edges);
    expect(first.budgets).not.toBe(second.budgets);
    expect(first.nodes[0]).not.toBe(second.nodes[0]);
    expect(first.edges[0]).not.toBe(second.edges[0]);
    expect(first.edges[0]!.requiredEvidenceKinds).not.toBe(second.edges[0]!.requiredEvidenceKinds);
  });
});
