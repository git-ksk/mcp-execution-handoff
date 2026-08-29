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
export declare class WebSocketWindowHostRecordParser {
    #private;
    private readonly onFrame;
    private readonly onEditableFocus;
    constructor(onFrame: (frame: WebSocketWindowJpegFrame) => void, onEditableFocus?: (editable: boolean) => void);
    push(chunk: Buffer): void;
}
//# sourceMappingURL=websocket-window-host-record.d.ts.map