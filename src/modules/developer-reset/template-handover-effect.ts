/** Publicly importable preparation boundary. Execution stays closed until a future
 * exact-target authority issuer connects verified protection and every blocker.
 * A GRANT, environment variable or caller Boolean cannot activate this adapter. */
import { prepareResetTemplateHandoverProtocol } from './template-handover-protocol.js';
export { RESET_TEMPLATE_HANDOVER_STEP } from './template-handover-protocol.js';
export function prepareResetTemplateHandover(...input: Parameters<typeof prepareResetTemplateHandoverProtocol>) {
  const prepared = prepareResetTemplateHandoverProtocol(...input);
  return Object.freeze({ summary: prepared.summary,
    async execute(_input: unknown) {
      return { status: 'ACTIVATION_REQUIRED' as const, executionEnabled: false as const,
        operationalAuthorityEnabled: false as const, liveDatabaseVerified: false as const,
        completeResetCoverage: false as const, retryExecutionAllowed: false as const };
    },
    dispose: prepared.dispose,
  });
}
