import type { TakeoverHostTarget } from "../browser-takeover/broker.js";
import type { ExperimentalWebSocketWindowCaptureFailureDisposition, ExperimentalWebSocketWindowSurface } from "./websocket-window-handoff.js";
import type { WebSocketTakeoverFrame } from "./websocket-takeover.js";
export type LinuxWebSocketSurfaceFailure = "none" | "frame_timeout" | "helper_closed" | "helper_error" | "frame_protocol" | "diagnostics_bounds" | "input_failure" | "input_timeout" | "input_revalidation_failure" | "revalidation_failure" | "capture_x11" | "capture_encoder" | "capture_option" | "capture_other";
export type LinuxWebSocketInputStage = "none" | "focus_ready" | "pointer_move_ready" | "pointer_authority_ready" | "pointer_down_sent" | "pointer_post_authority_ready" | "tap_sent" | "key_down_sent" | "key_authority_ready" | "key_up_sent" | "applied";
export type LinuxWebSocketInputBoundaryStage = "none" | "requested" | "helper_ready" | "revalidation_ready" | "command_sent" | "acknowledged";
export type LinuxWebSocketInputFailureDetail = "none" | "xtest_unavailable" | "xtest_busy" | "xtest_invalid" | "xtest_ack_timeout" | "xtest_write_failure" | "xtest_output_bounds" | "xtest_protocol_mismatch" | "xtest_unexpected_response" | "xtest_state_rejected" | "xtest_xtest_rejected" | "xtest_protocol_rejected" | "xtest_process_error" | "xtest_process_closed";
export type LinuxWebSocketHelperStopReason = "none" | "capture_failure" | "input_failure" | "stdin_end" | "signal_term" | "signal_int" | "expiry" | "input_buffer_bounds" | "explicit_stop";
export type LinuxWebSocketHelperCrashReason = "none" | "uncaught_exception" | "main_rejection";
export type LinuxWebSocketHelperExitKind = "none" | "clean" | "nonzero" | "signal";
export type LinuxWebSocketHelperCrashClass = "none" | "pipe_epipe" | "stream_write_after_end" | "stream_destroyed" | "jpeg_parser" | "frame_writer" | "input_callback" | "xtest_callback" | "accessibility_callback" | "capture_callback" | "stream_internal" | "event_dispatch" | "child_process_internal" | "special_key" | "exact_window_revalidate" | "active_target_check" | "focus_target_check" | "scroll_input" | "text_input" | "host_input_apply" | "host_input_chain" | "host_module" | "unknown";
export type LinuxWebSocketHelperCrashOrigin = "none" | "uncaught_exception" | "unhandled_rejection" | "unknown";
export type LinuxWebSocketHelperCrashErrorKind = "none" | "error" | "type_error" | "range_error" | "other";
export type LinuxWebSocketHelperCrashMessageClass = "none" | "focus_not_owned" | "window_not_active" | "target_process_unavailable" | "window_not_visible" | "window_owner_changed" | "window_geometry_unavailable" | "special_key_geometry_changed" | "xtest_helper_unavailable" | "xtest_helper_busy" | "xtest_helper_ack_timeout" | "xtest_helper_rejected" | "atspi_unavailable" | "atspi_busy" | "atspi_timeout" | "atspi_readiness_timeout" | "atspi_response_failed" | "atspi_response_invalid" | "atspi_response_large" | "atspi_regions_many" | "atspi_region_invalid" | "atspi_region_bounds" | "atspi_write_failure" | "atspi_output_bounds" | "atspi_protocol_mismatch" | "atspi_unexpected_response" | "atspi_process_failed" | "atspi_process_closed" | "atspi_failed" | "helper_command_timeout" | "helper_command_failed" | "other";
export interface ExperimentalLinuxWebSocketWindowSurfaceConfig {
    hostScript: string;
    displayName: string;
    xdotoolExecutable?: string;
    helperTtlMs?: number;
}
export interface LinuxWebSocketJpegFrame {
    data: Buffer;
    width: number;
    height: number;
}
/** Parses private JPEG records while accepting the helper's bounded editable-focus control record. */
export declare class LinuxWebSocketHostRecordParser {
    #private;
    private readonly onFrame;
    constructor(onFrame: (frame: LinuxWebSocketJpegFrame) => void);
    push(chunk: Buffer): void;
}
/**
 * Private Linux physical-Acceptance surface for the #40 WSS experiment.
 *
 * It deliberately reuses the existing normal-browser exact-window helper. The helper still owns
 * X11 target resolution, capture and Human input. This adapter selects its JPEG-only stdout mode,
 * keeps the process/window tuple server-side, revalidates that exact tuple before every returned
 * frame/input, and never exposes helper transport details to Browser/Window consumers.
 */
export declare class ExperimentalLinuxWebSocketWindowSurface implements ExperimentalWebSocketWindowSurface {
    #private;
    constructor(config: ExperimentalLinuxWebSocketWindowSurfaceConfig);
    diagnosticsSnapshot(): {
        lastFailure: LinuxWebSocketSurfaceFailure;
        framesObserved: number;
        lastInputStage: LinuxWebSocketInputStage;
        lastInputBoundaryStage: LinuxWebSocketInputBoundaryStage;
        inputAttempts: number;
        failure: LinuxWebSocketSurfaceFailure;
        failureInputStage: LinuxWebSocketInputStage;
        failureInputBoundaryStage: LinuxWebSocketInputBoundaryStage;
        lastInputFailureDetail: LinuxWebSocketInputFailureDetail;
        failureInputFailureDetail: LinuxWebSocketInputFailureDetail;
        lastHelperStopReason: LinuxWebSocketHelperStopReason;
        failureHelperStopReason: LinuxWebSocketHelperStopReason;
        lastHelperCrashReason: LinuxWebSocketHelperCrashReason;
        failureHelperCrashReason: LinuxWebSocketHelperCrashReason;
        lastHelperExitKind: LinuxWebSocketHelperExitKind;
        failureHelperExitKind: LinuxWebSocketHelperExitKind;
        lastHelperCrashClass: LinuxWebSocketHelperCrashClass;
        failureHelperCrashClass: LinuxWebSocketHelperCrashClass;
        lastHelperCrashOrigin: LinuxWebSocketHelperCrashOrigin;
        failureHelperCrashOrigin: LinuxWebSocketHelperCrashOrigin;
        lastHelperCrashErrorKind: LinuxWebSocketHelperCrashErrorKind;
        failureHelperCrashErrorKind: LinuxWebSocketHelperCrashErrorKind;
        lastHelperCrashMessageClass: LinuxWebSocketHelperCrashMessageClass;
        failureHelperCrashMessageClass: LinuxWebSocketHelperCrashMessageClass;
    };
    captureFailureDisposition(error: unknown): ExperimentalWebSocketWindowCaptureFailureDisposition;
    captureExactWindow(target: Readonly<TakeoverHostTarget>): Promise<WebSocketTakeoverFrame>;
    tapExactWindow(target: Readonly<TakeoverHostTarget>, x: number, y: number): Promise<void>;
    scrollExactWindow(target: Readonly<TakeoverHostTarget>, deltaY: number): Promise<void>;
    insertExactWindowText(target: Readonly<TakeoverHostTarget>, text: string): Promise<void>;
    pressExactWindowKey(target: Readonly<TakeoverHostTarget>, key: string): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=linux-websocket-window-surface.d.ts.map