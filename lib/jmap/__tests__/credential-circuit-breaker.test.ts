// A rejected credential must stop hitting the network.
//
// The bug this pins (2026-07-29): after deleting and recreating an account the
// browser still held a dead credential. Every JMAP call 401'd, each 401 fired a
// refreshSession + retry, and the 30s keep-alive re-authenticated forever. One
// user action fanned out into dozens of auth failures, so "I signed in a few
// times" tripped Stalwart's 100-failures-per-day ban and locked Gabriel out of
// an account that was working fine.
//
// The assertion that matters is the COUNT. A correctness-only test ("login
// fails") passed happily while the client was hammering the server, because
// failing is the right outcome — doing it 100 times is not.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../client';

const SERVER = 'https://mail.example.test';

function mockFetchAlways(status: number) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ error: 'nope' }), { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('credential circuit breaker', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stops issuing requests after the server rejects the credential (401)', async () => {
    const fetchMock = mockFetchAlways(401);
    const client = new JMAPClient(SERVER, 'gone@example.test', 'stale-password');

    // Simulate the fan-out: the webmail makes many calls right after login.
    for (let i = 0; i < 25; i++) {
      await client.connect().catch(() => {});
    }

    // Without the breaker this scaled with the loop (plus a refresh+retry per
    // call). The exact ceiling matters less than that it does not grow with
    // the number of attempts.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('treats a 403 (already banned) as terminal too', async () => {
    const fetchMock = mockFetchAlways(403);
    const client = new JMAPClient(SERVER, 'blocked@example.test', 'pw');

    for (let i = 0; i < 10; i++) {
      await client.connect().catch(() => {});
    }

    // Retrying into an active ban is what keeps refreshing the ban window.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('a fresh credential re-arms the client', async () => {
    mockFetchAlways(401);
    const client = new JMAPClient(SERVER, 'user@example.test', 'stale');
    await client.connect().catch(() => {});

    const callsWhileTripped = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Signing in again supplies a new password — the client must not stay
    // permanently bricked, or a legitimate re-login after a ban would do
    // nothing until a page reload.
    client.updateBasicAuth('freshly-issued-password');
    await client.connect().catch(() => {});

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length)
      .toBeGreaterThan(callsWhileTripped);
  });
});
