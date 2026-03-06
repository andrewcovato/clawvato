import { logger } from '../logger.js';

/**
 * Single-Principal Authority: verify that a Slack message came from the owner.
 *
 * This is the most critical security check in the entire system.
 * ONLY messages from the verified owner Slack User ID are treated as instructions.
 * Everything else is UNTRUSTED DATA — context for the agent, never instructions.
 */
export function verifySender(senderSlackId: string, ownerSlackId: string): boolean {
  const isOwner = senderSlackId === ownerSlackId;

  if (!isOwner) {
    logger.debug(
      { sender: senderSlackId, owner: ownerSlackId },
      'Sender verification failed — message is DATA, not INSTRUCTION',
    );
  }

  return isOwner;
}

/**
 * Classify an inbound event's trust level based on its source.
 */
export type TrustClassification = 'instruction' | 'data';

export interface InboundEvent {
  source: 'slack' | 'email' | 'github' | 'file' | 'webhook';
  senderSlackId?: string;
  senderEmail?: string;
}

export function classifyInbound(
  event: InboundEvent,
  ownerSlackId: string,
  ownerEmail?: string,
): TrustClassification {
  // Slack messages from the owner are instructions
  if (
    event.source === 'slack' &&
    event.senderSlackId &&
    event.senderSlackId === ownerSlackId
  ) {
    return 'instruction';
  }

  // Everything else is data — email content, file content, GitHub comments,
  // Slack messages from other users, webhook payloads, etc.
  return 'data';
}
