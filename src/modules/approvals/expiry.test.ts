/**
 * Approval delivery metadata + expiry.
 *
 * Two guarantees are covered here, both learned from a live deadlock: a
 * `groups-restart` approval was written with null channel/platform columns and
 * a null `expires_at`, so nothing could edit its card and nothing could ever
 * reclaim it. The requesting agent stayed parked until the container was
 * restarted by hand.
 *
 *   1. `requestApproval` stamps the routing columns and a TTL, and drops the
 *      row outright when the card cannot be delivered.
 *   2. `sweepExpiredApprovals` finalizes rows past their deadline as a plain
 *      reject, so the agent always gets an answer it can branch on.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  createPendingApproval,
  createSession,
  getPendingApproval,
  getPendingApprovalsByAction,
} from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { getSession } from '../../db/sessions.js';
import { APPROVAL_TTL_MS, requestApproval } from './primitive.js';
import { sweepExpiredApprovals } from './expiry.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-expiry' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-expiry';
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let delivered: Array<{ channelType: string; platformId: string; content: string }>;
let deliverImpl: ChannelDeliveryAdapter['deliver'];

const fakeAdapter: ChannelDeliveryAdapter = {
  deliver: (channelType, platformId, threadId, kind, content) =>
    deliverImpl(channelType, platformId, threadId, kind, content),
};

/** Text of the most recent agent-facing note written via writeSessionMessage. */
function lastRelayedText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

async function request(action = 'groups_restart'): Promise<void> {
  await requestApproval({
    session: getSession('sess-1')!,
    agentName: 'Agent',
    action,
    payload: { group: 'ag-1' },
    title: `CLI: ${action}`,
    question: 'Restart the group?',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  delivered = [];
  deliverImpl = async (channelType, platformId, _threadId, _kind, content) => {
    delivered.push({ channelType, platformId, content });
    return 'pm-1';
  };

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });

  upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('requestApproval row metadata', () => {
  it('stamps the delivery route, message id and a TTL on the pending row', async () => {
    await request();

    expect(delivered).toHaveLength(1);
    const row = getPendingApproval(JSON.parse(delivered[0].content).questionId);

    expect(row).toBeDefined();
    expect(row!.channel_type).toBe(DM_CHANNEL);
    expect(row!.platform_id).toBe(DM_PLATFORM);
    expect(row!.agent_group_id).toBe('ag-1');
    expect(row!.platform_message_id).toBe('pm-1');

    // Without a deadline the sweep can never reclaim the row.
    expect(row!.expires_at).toBeTruthy();
    const ttl = new Date(row!.expires_at!).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(APPROVAL_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(APPROVAL_TTL_MS);
  });

  it('leaves no pending row behind when the card cannot be delivered', async () => {
    deliverImpl = async () => {
      throw new Error('channel unreachable');
    };

    await request();

    // A row here would be unresolvable: no card exists for anyone to click.
    expect(getExistingApprovalCount()).toBe(0);
    expect(lastRelayedText()).toMatch(/could not deliver/i);
  });

  it('does not record a row when there is no delivery adapter at all', async () => {
    setDeliveryAdapter(null as unknown as ChannelDeliveryAdapter);

    await request();

    expect(getExistingApprovalCount()).toBe(0);
    expect(lastRelayedText()).toMatch(/no delivery adapter/i);
  });
});

describe('sweepExpiredApprovals', () => {
  it('leaves an approval alone while it is still inside its TTL', async () => {
    await request();
    await sweepExpiredApprovals();

    expect(getExistingApprovalCount()).toBe(1);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it('finalizes an elapsed approval as a plain reject and edits the card', async () => {
    seedExpired('appr-old', 'groups_restart');

    await sweepExpiredApprovals();

    expect(getPendingApproval('appr-old')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your groups_restart request was rejected by admin.');

    const edit = delivered.map((d) => JSON.parse(d.content)).find((c) => c.operation === 'edit');
    expect(edit).toBeDefined();
    expect(edit.messageId).toBe('pm-1');
    expect(edit.text).toMatch(/expired/i);
  });

  it('backfills a deadline onto legacy rows written without one', async () => {
    createPendingApproval({
      approval_id: 'appr-legacy',
      session_id: 'sess-1',
      request_id: 'appr-legacy',
      action: 'groups_restart',
      payload: '{}',
      created_at: now(),
      title: 'CLI: groups_restart',
      options_json: '[]',
    });
    expect(getPendingApproval('appr-legacy')!.expires_at).toBeNull();

    await sweepExpiredApprovals();

    // Created just now, so it isn't reclaimed yet — but it now has a deadline.
    const row = getPendingApproval('appr-legacy');
    expect(row).toBeDefined();
    expect(row!.expires_at).toBeTruthy();
  });

  it('reclaims a legacy row whose deadline already passed once backfilled', async () => {
    // The deadline is derived from created_at, so a row that has been stuck
    // since before the TTL window is finalized on the very next tick rather
    // than getting a fresh 24h reprieve.
    createPendingApproval({
      approval_id: 'appr-ancient',
      session_id: 'sess-1',
      request_id: 'appr-ancient',
      action: 'groups_restart',
      payload: '{}',
      created_at: new Date(Date.now() - APPROVAL_TTL_MS - 60_000).toISOString(),
      title: 'CLI: groups_restart',
      options_json: '[]',
    });

    await sweepExpiredApprovals();

    expect(getPendingApproval('appr-ancient')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your groups_restart request was rejected by admin.');
  });

  it('ignores OneCLI credential rows, which have their own expiry owner', async () => {
    seedExpired('appr-onecli', 'onecli_credential');

    await sweepExpiredApprovals();

    expect(getPendingApproval('appr-onecli')).toBeDefined();
  });
});

function seedExpired(approvalId: string, action: string): void {
  createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action,
    payload: '{}',
    created_at: new Date(Date.now() - APPROVAL_TTL_MS - 60_000).toISOString(),
    agent_group_id: 'ag-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    platform_message_id: 'pm-1',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    title: `CLI: ${action}`,
    options_json: '[]',
  });
}

function getExistingApprovalCount(action = 'groups_restart'): number {
  return getPendingApprovalsByAction(action).length;
}
