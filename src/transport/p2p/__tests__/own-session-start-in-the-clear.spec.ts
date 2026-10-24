import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { MAGIC_WORD } from "../codec.js";

const ACCOUNT_ID = "0000000000000000000000000000000000000000";

/**
 * An own-session camera whose gateway-info reply names `cipher_id` 0 gets no level-2 key, and sends no video
 * for the level-1 start. The current app starts and stops a T8200 unencrypted: `1700`/`1000` with the body
 * `{accountId, encryptkey, msg_id, streamtype: 1}`, and the direct `1004` with the channel as a `uint32`, both
 * at signCode 0 and frame type 0, with header bytes `[0x01, n]` where `n` rises with every command.
 */
function session(): { session: P2PSession; sent: Buffer[] } {
  const built = new P2PSession({
    stationSn: "T8000P0000000000",
    p2pDid: "XXXXXXX-000000-XXXXX",
    resolveCipherKey: async () => undefined,
  });
  const sent: Buffer[] = [];
  const internals = built as unknown as { socket: { send: (buf: Buffer) => void }; connectAddress: object };
  internals.socket = { send: vi.fn((buf: Buffer) => void sent.push(Buffer.from(buf))) };
  internals.connectAddress = { host: "<cam-lan-ip>", port: 32100 };
  return { session: built, sent };
}

/** Feed the session a gateway-info reply whose only read member is the leading `cipher_id`. */
function negotiate(target: P2PSession, cipherId: number): void {
  const payload = Buffer.alloc(64);
  payload.writeUInt16LE(cipherId, 0);
  (target as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(payload);
}

/** The command frame of a sent datagram: its header fields and body. */
function commandOf(datagram: Buffer): {
  command: number;
  counter: [number, number];
  channel: number;
  signCode: number;
  frameType: number;
  body: Buffer;
} {
  const f = datagram.subarray(datagram.indexOf(Buffer.from(MAGIC_WORD)));
  return {
    command: f.readUInt16LE(4),
    counter: [f[10], f[11]],
    channel: f[12],
    signCode: f[13],
    frameType: f[14],
    body: f.subarray(16, 16 + f.readUInt16LE(6)),
  };
}

describe("own-session start and stop on a cipher-0 session", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("starts unencrypted with the four-field body and a counted header", () => {
    const { session: s, sent } = session();
    negotiate(s, 0);
    s.startLiveMedia(0, ACCOUNT_ID, false);

    expect(sent).toHaveLength(1);
    const start = commandOf(sent[0]);
    expect(start).toMatchObject({ command: 1700, counter: [0x01, 0x01], channel: 0, signCode: 0, frameType: 0 });
    const json = JSON.parse(start.body.toString("utf-8"));
    expect(json.commandType).toBe(1000);
    expect(Object.keys(json.data)).toEqual(["accountId", "encryptkey", "msg_id", "streamtype"]);
    expect(json.data).toMatchObject({ accountId: ACCOUNT_ID, msg_id: 1, streamtype: 1 });
    expect(json.data.encryptkey).toMatch(/^[0-9a-f]{256}$/);
  });

  it("stops with the channel as an unencrypted uint32, counting on from the start", () => {
    const { session: s, sent } = session();
    negotiate(s, 0);
    s.startLiveMedia(0, ACCOUNT_ID, false);
    s.stopLiveMedia(0, ACCOUNT_ID, false);

    expect(sent).toHaveLength(2);
    const stop = commandOf(sent[1]);
    expect(stop).toMatchObject({ command: 1004, counter: [0x01, 0x02], channel: 0, signCode: 0, frameType: 0 });
    expect(stop.body).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  });

  it("gives a restart a new counter, carried as its msg_id", () => {
    const { session: s, sent } = session();
    negotiate(s, 0);
    s.startLiveMedia(0, ACCOUNT_ID, false);
    s.stopLiveMedia(0, ACCOUNT_ID, false);
    s.startLiveMedia(0, ACCOUNT_ID, false);

    const restart = commandOf(sent[2]);
    expect(restart.counter).toEqual([0x01, 0x03]);
    expect(JSON.parse(restart.body.toString("utf-8")).data.msg_id).toBe(3);
  });

  it("keeps the level-1 start for a cipher this account has no key for", () => {
    const { session: s, sent } = session();
    negotiate(s, 3);
    s.startLiveMedia(0, ACCOUNT_ID, false);

    const start = commandOf(sent[0]);
    expect(start).toMatchObject({ command: 1700, counter: [0x01, 0x00], signCode: 1, frameType: 11 });
  });

  it("re-issues a start sent before the negotiation in the clear on the next tick", () => {
    const { session: s, sent } = session();
    s.startLiveMedia(0, ACCOUNT_ID, false);
    expect(commandOf(sent[0]).signCode).toBe(1);

    negotiate(s, 0);
    s.startLiveMedia(0, ACCOUNT_ID, false);

    expect(sent).toHaveLength(2);
    expect(commandOf(sent[1])).toMatchObject({ command: 1700, counter: [0x01, 0x01], signCode: 0, frameType: 0 });
  });
});
