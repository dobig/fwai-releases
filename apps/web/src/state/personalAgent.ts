import { createPersonalAgentAtoms } from "@t3tools/client-runtime/state/personal-agent";

import { connectionAtomRuntime } from "../connection/runtime";

/** The personal agent inbox and sent requests (#22), read from the relay. */
export const personalAgent: ReturnType<typeof createPersonalAgentAtoms> =
  createPersonalAgentAtoms(connectionAtomRuntime);
