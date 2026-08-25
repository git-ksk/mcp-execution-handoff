#!/usr/bin/env node
export interface LinuxWindowGeometry {
    windowId: number;
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface LinuxHostInput {
    kind: "tap" | "pointer_button" | "scroll" | "text" | "key";
    button?: "primary";
    state?: "down" | "up";
    x?: number;
    y?: number;
    deltaX?: number;
    deltaY?: number;
    text?: string;
    key?: "Backspace" | "Enter";
}
export declare function parseWindowIds(value: string): number[];
export declare function parseWindowGeometry(value: string, expectedWindowId: number): LinuxWindowGeometry | undefined;
export declare function scaledVideoSize(width: number, height: number): {
    width: number;
    height: number;
};
export declare function avccFromNalUnits(units: readonly Buffer[]): Buffer;
export declare function frameRecord(avcc: Buffer, timestamp: number, keyframe: boolean, width: number, height: number): Buffer;
/** Splits Annex-B H.264 into access units using mandatory AUD NALs emitted by the Linux encoder. */
export declare class AnnexBAccessUnitParser {
    private readonly emit;
    private pending;
    private current;
    constructor(emit: (units: Buffer[], keyframe: boolean) => void);
    push(chunk: Buffer): void;
    end(): void;
    private drain;
    private acceptNal;
    private emitCurrent;
}
export declare function parseOptionalTargetWindowId(value: string | undefined): number | undefined;
export declare function linuxWebRtcHostMain(): Promise<void>;
export declare function isLinuxWebRtcHostCliEntryPoint(moduleUrl: string, argvPath: string | undefined): boolean;
//# sourceMappingURL=linux-webrtc-host-cli.d.ts.map