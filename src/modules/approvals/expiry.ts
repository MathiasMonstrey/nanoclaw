/**
 * Approval expiry — the backstop that guarantees a requesting agent is never
 * parked forever on a card nobody answers.
 *
 * Every module approval is written with an `expires_at` (see APPROVAL_TTL_MS in
 * primitive.ts). Each host-sweep tick, rows past their deadline are edited to
 * "Expired" on the platform (best effort), finalized as a plain reject so the
 * agent gets an actionable answer, and dropped.
 *
 * Rows created before the TTL existed carry a null `expires_at` and would never
 * be picked up, so each sweep first backfills them with a deadline derived from
 * their own `created_at`.
 *
 * Deliberately excludes:
 *   - `awaiting_reason` rows — owned by reason-capture.ts's own sweep.
 *   - OneCLI credential rows — owned by onecli-approvals.ts (in-memory timer
 *     plus its own startup sweep), and resolved through a Promise rather than
 *     the module handler path finalizeReject assumes.
 */
import { getDeliveryAdapter } from '../../delivery.js';
import {
  deletePendingApproval,
  getExpiredPendingApprovals,
  getPendingApprovalsMissingExpiry,
  getSession,
  setPendingApprovalExpiry,
} from '../../db/sessions.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';
import { finalizeReject } from './finalize.js';
import { ONECLI_ACTION } from './onecli-approvals.js';
import { APPROVAL_TTL_MS } from './primitive.js';

/**
 * Give any legacy null-`expires_at` pending row a deadline, derived from the
 * row's own `created_at` so a row that has already been stuck for days expires
 * on this tick instead of getting a fresh 24h reprieve.
 *
 * Runs at the top of every sweep rather than once at import: touching the DB at
 * module-load time breaks any consumer that imports this module before the
 * database is opened, and steady-state the query matches nothing.
 */
function backfillLegacyApprovalExpiry(): void {
  const rows = getPendingApprovalsMissingExpiry();
  if (rows.length === 0) return;
  for (const row of rows) {
    const createdMs = Date.parse(row.created_at);
    const base = Number.isNaN(createdMs) ? Date.now() : createdMs;
    setPendingApprovalExpiry(row.approval_id, new Date(base + APPROVAL_TTL_MS).toISOString());
  }
  log.info('Backfilled expiry on legacy pending approvals', { count: rows.length });
}

/** Best-effort card edit so the admin's chat doesn't keep a dead button. */
async function editCardExpired(row: PendingApproval): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  try {
    await adapter.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: '⌛ Expired (no response)',
      }),
    );
  } catch (err) {
    log.warn('Failed to edit expired approval card', { approvalId: row.approval_id, err });
  }
}

/**
 * Finalize every pending approval whose TTL has elapsed. Called once per
 * host-sweep tick.
 */
export async function sweepExpiredApprovals(): Promise<void> {
  backfillLegacyApprovalExpiry();

  const rows = getExpiredPendingApprovals(new Date().toISOString());
  for (const approval of rows) {
    if (approval.action === ONECLI_ACTION) continue;

    await editCardExpired(approval);

    const session = approval.session_id ? getSession(approval.session_id) : null;
    if (!session) {
      deletePendingApproval(approval.approval_id);
      log.info('Expired approval dropped (no session)', {
        approvalId: approval.approval_id,
        action: approval.action,
      });
      continue;
    }

    // Reject, not silent-drop: the agent asked a question and deserves an
    // answer it can branch on. finalizeReject also wakes the container.
    await finalizeReject(approval, session, '');
    log.info('Approval expired without a response — finalized as reject', {
      approvalId: approval.approval_id,
      action: approval.action,
      createdAt: approval.created_at,
    });
  }
}
