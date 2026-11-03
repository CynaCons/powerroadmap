/**
 * Types for the hand-rolled WebSocket frame codec.
 *
 * The codec itself is plain JS, because the bridge server has no build step and
 * is launched straight from `.mcp.json`. These declarations exist so the tests —
 * which are TypeScript, and which drive the server as a real process with a
 * hand-rolled page client — can import it without `any`.
 */

/**
 * Opcodes, typed as plain numbers rather than literals: a caller passes one
 * where an opcode is wanted, and narrowing them to a union makes a helper that
 * defaults to `OPCODE.text` refuse every other member.
 */
export declare const OPCODE: {
  continuation: number;
  text: number;
  binary: number;
  close: number;
  ping: number;
  pong: number;
};

export declare function decodeFrame(buf: Buffer): {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  total: number;
} | null;

/**
 * `mask` must be true for a frame sent as a CLIENT and false as a server
 * (RFC 6455 §5.1); a conforming peer closes the connection either way round.
 */
export declare function encodeFrame(
  text: string | Buffer,
  opcode?: number,
  options?: { mask?: boolean },
): Buffer;

/** What `FrameReader.push` asks the caller to do with each whole message. */
export type FrameAction =
  | { type: 'text'; text: string }
  | { type: 'close' }
  | { type: 'pong'; payload: Buffer };

export declare class FrameReader {
  push(chunk: Buffer): FrameAction[];
}
