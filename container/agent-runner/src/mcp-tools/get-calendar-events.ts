/**
 * Home Assistant calendar MCP tool: get_calendar_events.
 *
 * Ported from the v1 fork (container/agent-runner/src/ipc-mcp-stdio.ts).
 * Fetches events from a Home Assistant instance's REST API for a date
 * range, grouped by calendar. HA_URL/HA_TOKEN are passed into the
 * container by the host-side `home-assistant` provider container config
 * (src/providers/home-assistant.ts) and arrive here via process.env.
 *
 * HA is reached directly (not through the OneCLI gateway), so the token
 * is read from the environment rather than the vault.
 */
import http from 'http';
import https from 'https';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;

const DEFAULT_CALENDARS = [
  'calendar.gezin',
  'calendar.mathias_monstrey_gmail_com',
  'calendar.liza',
  'calendar.mathias_en_liza',
  'calendar.kuisagenda',
  'calendar.verjaardagen',
  'calendar.wat_eten_we',
];

function haFetch(urlStr: string, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      urlStr,
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export const getCalendarEvents: McpToolDefinition = {
  tool: {
    name: 'get_calendar_events',
    description:
      'Fetch calendar events from Home Assistant for a given date range. Returns events grouped by calendar.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        start: {
          type: 'string',
          description: 'Start of the range as ISO 8601 timestamp (e.g. "2026-03-16T00:00:00Z")',
        },
        end: {
          type: 'string',
          description: 'End of the range as ISO 8601 timestamp (e.g. "2026-03-17T00:00:00Z")',
        },
        calendars: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of calendar entity IDs (e.g. ["calendar.gezin"]). Defaults to all configured calendars.',
        },
      },
      required: ['start', 'end'],
    },
  },
  async handler(args) {
    if (!HA_URL || !HA_TOKEN) {
      return {
        content: [
          { type: 'text' as const, text: 'Home Assistant not configured. HA_URL and HA_TOKEN must be set.' },
        ],
        isError: true,
      };
    }

    const start = args.start as string;
    const end = args.end as string;
    const requested = args.calendars as string[] | undefined;
    const calendars = requested && requested.length > 0 ? requested : DEFAULT_CALENDARS;
    const result: Record<string, unknown> = {};

    await Promise.all(
      calendars.map(async (calId) => {
        try {
          const url = `${HA_URL}/api/calendars/${encodeURIComponent(calId)}?start=${encodeURIComponent(
            start,
          )}&end=${encodeURIComponent(end)}`;
          const body = await haFetch(url, HA_TOKEN!);
          result[calId] = JSON.parse(body);
        } catch (e) {
          result[calId] = { error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
};

registerTools([getCalendarEvents]);
