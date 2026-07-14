export const agentRoles = ["author", "explorer", "reviewer"] as const;
export type AgentRole = (typeof agentRoles)[number];

export function assertCoreMayCreateAgent(parent: "core" | AgentRole): void {
  if (parent !== "core") throw new Error(`${parent} Agent cannot create a child Agent`);
}
