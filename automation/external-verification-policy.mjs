export const EXTERNAL_VERIFICATION_ENV =
  "CODEX_EXTERNAL_VERIFICATION_FALLBACK";
export const EXTERNAL_VERIFICATION_STATUS =
  "external_verification_required";

export const EXTERNAL_VERIFICATION_PROMPT = `# Executor-managed external verification fallback

This run explicitly allows the deterministic executor to run the manifest verification commands outside your managed workspace-write sandbox.

Use status "external_verification_required" only when all of these are true:

- The current task implementation is complete to the best of your inspection.
- You attempted the required verification command(s).
- Verification could not run solely because the managed sandbox denied child-process execution or made its temporary/runtime path unavailable (for example EPERM or ENOENT).
- The failed or unavailable command is recorded in commands with its real exit code (or null when no exit code exists), and not_verified explains what remains unverified.

Do not use this status for a failing assertion, type error, incomplete implementation, missing dependency, network/auth/quota failure, unresolved ambiguity, or any ordinary task blocker. Return blocked or failed for those cases. Never report completed unless the checks you actually ran passed.`;

export function parseExternalVerificationFallback(value) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (["", "0", "false"].includes(normalized)) return false;
  if (["1", "true"].includes(normalized)) return true;
  throw new Error(
    `${EXTERNAL_VERIFICATION_ENV} must be one of: 1, true, 0, false`,
  );
}

export function validateExternalVerificationDeferral(report, enabled) {
  if (report.status !== EXTERNAL_VERIFICATION_STATUS) return null;
  if (!enabled) {
    return `${EXTERNAL_VERIFICATION_ENV} is disabled`;
  }

  const hasUnavailableCommand =
    Array.isArray(report.commands) &&
    report.commands.some(
      (command) =>
        command &&
        (command.exit_code === null ||
          (Number.isInteger(command.exit_code) && command.exit_code !== 0)),
    );
  if (!hasUnavailableCommand) {
    return `${EXTERNAL_VERIFICATION_STATUS} requires a failed or unavailable command record`;
  }

  if (!Array.isArray(report.not_verified) || report.not_verified.length === 0) {
    return `${EXTERNAL_VERIFICATION_STATUS} requires at least one not_verified item`;
  }

  return null;
}
