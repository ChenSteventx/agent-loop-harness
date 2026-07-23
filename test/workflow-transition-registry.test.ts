import { describe, expect, it } from "vitest";
import { operationInputHash } from "../src/bindings.js";
import {
  decideNextTransition,
  type ProofGapSnapshot,
  workflowActionForEdge,
} from "../src/loop.js";
import {
  evaluateWorkflowTransitionProof,
  workflowActionForTransitionReceipt,
  workflowTransitionRegistry,
} from "../src/workflow-transition-registry.js";
import {
  compileWorkflowTopology,
  type WorkflowEdge,
} from "../src/workflow-topology.js";

const base: ProofGapSnapshot = {
  risk: "low",
  template: "solo",
  exploration: "not-required",
  writer: "missing",
  acceptance: "not-required",
  verification: "missing",
  review: "not-required",
  repairsUsed: 0,
  maximumRepairs: 1,
  repeatedFailure: false,
};

describe("workflow transition registry", () => {
  it("is the unique source for every compiled edge", () => {
    const ids = workflowTransitionRegistry.map((rule) => rule.edge.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const template of ["solo", "assisted", "reviewed"] as const) {
      const manifest = compileWorkflowTopology(template);
      const projected = workflowTransitionRegistry
        .filter((rule) => rule.templates.includes(template))
        .map((rule) => rule.edge);
      expect(manifest.edges).toEqual(projected);
      for (const edge of manifest.edges) {
        expect(workflowTransitionRegistry.filter((rule) => rule.edge.id === edge.id)).toHaveLength(1);
      }
    }
  });

  it("preserves the frozen V2 manifest hashes", () => {
    expect(operationInputHash(compileWorkflowTopology("solo"))).toBe(
      "deb5f18a1689e3f6f1985bfba94fbdaa06ca47c05d87b324786f5f6d423bdf28",
    );
    expect(operationInputHash(compileWorkflowTopology("assisted"))).toBe(
      "397977236ca77066340e6d1d9c2439f8b88f05f72da39787586ebe2b480ba942",
    );
    expect(operationInputHash(compileWorkflowTopology("reviewed"))).toBe(
      "58f4c797874732b1ed140dfdfe94c9eae08446b880b91fa29bd59c56f75ce117",
    );
  });

  it("deep-freezes the executable registry so consumers cannot change future manifests", () => {
    const first = workflowTransitionRegistry[0]!;
    expect(Object.isFrozen(workflowTransitionRegistry)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.templates)).toBe(true);
    expect(Object.isFrozen(first.edge)).toBe(true);
    expect(Object.isFrozen(first.edge.requiredEvidenceKinds)).toBe(true);
    expect(() => Object.assign(first.edge, { guard: "writer-required" })).toThrow(TypeError);
    expect(operationInputHash(compileWorkflowTopology("solo"))).toBe(
      "deb5f18a1689e3f6f1985bfba94fbdaa06ca47c05d87b324786f5f6d423bdf28",
    );
  });

  it("materializes pending actions from the same receipt factory", () => {
    for (const rule of workflowTransitionRegistry) {
      if (rule.edge.budgetId === null) {
        expect(workflowActionForEdge(rule.edge.id, null)).toEqual(
          workflowActionForTransitionReceipt(rule.edge.id, null),
        );
        expect(workflowActionForEdge(rule.edge.id, 1)).toBeNull();
      } else {
        expect(workflowActionForEdge(rule.edge.id, null)).toBeNull();
        for (const ordinal of [1, 2, 3, 4, 5]) {
          expect(workflowActionForEdge(rule.edge.id, ordinal)).toEqual({
            kind: "repair",
            attempt: ordinal,
          });
        }
      }
    }
    expect(workflowActionForEdge("unknown.edge", null)).toBeNull();
  });

  it("fails closed when the frozen manifest does not admit the selected edge", () => {
    const manifest = compileWorkflowTopology("solo");
    const withoutAuthor = {
      ...manifest,
      edges: manifest.edges.filter((edge) => edge.id !== "entry.author"),
    };
    expect(decideNextTransition(base, withoutAuthor)).toEqual({
      edgeId: null,
      guard: null,
      action: {
        kind: "block",
        reason: "Required transition entry.author is not allowed by the frozen topology",
      },
    });
  });

  it("fails closed across template boundaries", () => {
    const crossTemplate = decideNextTransition(
      { ...base, exploration: "missing" },
      compileWorkflowTopology("solo"),
    );
    expect(crossTemplate.edgeId).toBeNull();
    expect(crossTemplate.action.kind).toBe("block");

    expect(decideNextTransition(base, compileWorkflowTopology("assisted"))).toEqual({
      edgeId: null,
      guard: null,
      action: {
        kind: "block",
        reason: "Frozen workflow template assisted does not match proof template solo",
      },
    });
  });

  it("fails closed for unknown requirements and frozen metadata drift", () => {
    const registered = compileWorkflowTopology("solo").edges.find(
      (edge) => edge.id === "entry.author",
    )!;
    const unknownRequirement = {
      ...registered,
      requiredEvidenceKinds: ["unknown-proof"],
    } as unknown as WorkflowEdge;
    expect(evaluateWorkflowTransitionProof(unknownRequirement, base)).toMatchObject({
      registered: false,
      requirementsSatisfied: false,
      satisfied: false,
      unknownRequirements: ["unknown-proof"],
    });

    const driftedGuard = {
      ...registered,
      guard: "risk-unknown" as const,
    };
    expect(evaluateWorkflowTransitionProof(driftedGuard, base)).toMatchObject({
      registered: false,
      satisfied: false,
    });
  });

  it("never selects an edge outside the snapshot template across the proof-state space", () => {
    const risks: readonly ProofGapSnapshot["risk"][] = ["unknown", "low", "normal", "high"];
    const templates: readonly ProofGapSnapshot["template"][] = ["solo", "assisted", "reviewed"];
    const explorations: readonly ProofGapSnapshot["exploration"][] = [
      "not-required", "missing", "satisfied", "failed",
    ];
    const writers: readonly ProofGapSnapshot["writer"][] = [
      "missing", "running", "patch-ready", "failed", "committed",
    ];
    const acceptances: readonly ProofGapSnapshot["acceptance"][] = [
      "not-required", "missing", "satisfied",
    ];
    const verifications: readonly ProofGapSnapshot["verification"][] = ["missing", "passed", "failed"];
    const reviews: readonly ProofGapSnapshot["review"][] = [
      "not-required", "missing", "passed", "blocking", "unavailable",
    ];

    for (const template of templates) {
      const manifest = compileWorkflowTopology(template);
      const allowed = new Set(manifest.edges.map((edge) => edge.id));
      for (const risk of risks)
        for (const exploration of explorations)
          for (const writer of writers)
            for (const acceptance of acceptances)
              for (const verification of verifications)
                for (const review of reviews)
                  for (const repairsUsed of [0, 1] as const)
                    for (const repeatedFailure of [false, true] as const) {
                      const snapshot: ProofGapSnapshot = {
                        risk,
                        template,
                        exploration,
                        writer,
                        acceptance,
                        verification,
                        review,
                        repairsUsed,
                        maximumRepairs: 1,
                        repeatedFailure,
                      };
                      const decision = decideNextTransition(snapshot);
                      expect(decideNextTransition(snapshot, manifest)).toEqual(decision);
                      if (decision.edgeId !== null) expect(allowed.has(decision.edgeId)).toBe(true);
                    }
    }
  });
});
