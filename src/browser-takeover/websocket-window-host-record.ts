const MAX_HOST_RECORD_BYTES = 8 * 1024 * 1024;

export interface WebSocketWindowJpegFrame {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Parses the bounded local-host record protocol shared by Linux and macOS WSS exact-window
 * surfaces. Record type 2 carries either one editable-focus byte or width/height + JPEG bytes.
 * Frame content remains ephemeral and is never converted into diagnostics or control-plane state.
 */
export class WebSocketWindowHostRecordParser {
  #pending = Buffer.alloc(0);

  constructor(
    private readonly onFrame: (frame: WebSocketWindowJpegFrame) => void,
    private readonly onEditableFocus: (editable: boolean) => void = () => undefined
  ) {}

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.#pending = this.#pending.byteLength === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.#pending, chunk]);
    if (this.#pending.byteLength > MAX_HOST_RECORD_BYTES + 5) {
      throw new Error("WSS exact-window host record buffer exceeded bounds");
    }
    for (;;) {
      if (this.#pending.byteLength < 5) return;
      const type = this.#pending[0];
      const length = this.#pending.readUInt32BE(1);
      if (type !== 2 || length < 1 || length > MAX_HOST_RECORD_BYTES) {
        throw new Error("WSS exact-window host emitted an invalid record");
      }
      if (this.#pending.byteLength < 5 + length) return;
      const payload = this.#pending.subarray(5, 5 + length);
      this.#pending = this.#pending.subarray(5 + length);
      if (length === 1) {
        if (payload[0] !== 0 && payload[0] !== 1) {
          throw new Error("WSS exact-window host emitted an invalid editable-focus record");
        }
        this.onEditableFocus(payload[0] === 1);
        continue;
      }
      if (length < 8) throw new Error("WSS exact-window host emitted an invalid record");
      const width = payload.readUInt16BE(0);
      const height = payload.readUInt16BE(2);
      const data = payload.subarray(4);
      if (
        width < 1
        || height < 1
        || data.byteLength < 4
        || data[0] !== 0xff
        || data[1] !== 0xd8
        || data[data.byteLength - 2] !== 0xff
        || data[data.byteLength - 1] !== 0xd9
      ) {
        throw new Error("WSS exact-window host emitted an invalid JPEG frame");
      }
      this.onFrame({ data: Buffer.from(data), width, height });
    }
  }
}
