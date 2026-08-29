/**
 * OS-neutral diagnostic projection consumed by managed Window transport composition.
 *
 * Concrete surfaces may expose richer platform-local diagnostics, but the managed runtime depends
 * only on this bounded content-free shape. Fields that a platform cannot observe remain `none`.
 */
export type ManagedWindowWebSocketSurfaceFailure = "none" | "frame_timeout" | "helper_closed" | "helper_error" | "frame_protocol" | "diagnostics_bounds" | "input_failure" | "input_timeout" | "input_revalidation_failure" | "revalidation_failure" | "capture_x11" | "capture_encoder" | "capture_option" | "capture_other";
export type ManagedWindowWebSocketInputStage = "none" | "focus_ready" | "pointer_move_ready" | "pointer_authority_ready" | "pointer_down_sent" | "pointer_post_authority_ready" | "tap_sent" | "key_down_sent" | "key_authority_ready" | "key_up_sent" | "applied";
export type ManagedWindowWebSocketInputFailureDetail = "none" | "xtest_unavailable" | "xtest_busy" | "xtest_invalid" | "xtest_ack_timeout" | "xtest_write_failure" | "xtest_output_bounds" | "xtest_protocol_mismatch" | "xtest_unexpected_response" | "xtest_state_rejected" | "xtest_xtest_rejected" | "xtest_protocol_rejected" | "xtest_process_error" | "xtest_process_closed";
export type ManagedWindowWebSocketInputBoundaryStage = "none" | "requested" | "helper_ready" | "revalidation_ready" | "command_sent" | "acknowledged";
export type ManagedWindowWebSocketHelperStopReason = "none" | "capture_failure" | "input_failure" | "stdin_end" | "signal_term" | "signal_int" | "expiry" | "input_buffer_bounds" | "explicit_stop";
export type ManagedWindowWebSocketHelperCrashReason = "none" | "uncaught_exception" | "main_rejection";
export type ManagedWindowWebSocketHelperExitKind = "none" | "clean" | "nonzero" | "signal";
export type ManagedWindowWebSocketHelperCrashClass = "none" | "pipe_epipe" | "stream_write_after_end" | "stream_destroyed" | "jpeg_parser" | "frame_writer" | "input_callback" | "xtest_callback" | "accessibility_callback" | "capture_callback" | "stream_internal" | "event_dispatch" | "child_process_internal" | "special_key" | "exact_window_revalidate" | "active_target_check" | "focus_target_check" | "scroll_input" | "text_input" | "host_input_apply" | "host_input_chain" | "host_module" | "unknown";
export type ManagedWindowWebSocketHelperCrashOrigin = "none" | "uncaught_exception" | "unhandled_rejection" | "unknown";
export type ManagedWindowWebSocketHelperCrashErrorKind = "none" | "error" | "type_error" | "range_error" | "other";
export type ManagedWindowWebSocketHelperCrashMessageClass = "none" | "focus_not_owned" | "window_not_active" | "target_process_unavailable" | "window_not_visible" | "window_owner_changed" | "window_geometry_unavailable" | "special_key_geometry_changed" | "xtest_helper_unavailable" | "xtest_helper_busy" | "xtest_helper_ack_timeout" | "xtest_helper_rejected" | "atspi_unavailable" | "atspi_busy" | "atspi_timeout" | "atspi_readiness_timeout" | "atspi_response_failed" | "atspi_response_invalid" | "atspi_response_large" | "atspi_regions_many" | "atspi_region_invalid" | "atspi_region_bounds" | "atspi_write_failure" | "atspi_output_bounds" | "atspi_protocol_mismatch" | "atspi_unexpected_response" | "atspi_process_failed" | "atspi_process_closed" | "atspi_failed" | "helper_command_timeout" | "helper_command_failed" | "other";
export interface ManagedWindowWebSocketSurfaceDiagnostics {
    lastFailure: ManagedWindowWebSocketSurfaceFailure;
    framesObserved: number;
    lastInputStage: ManagedWindowWebSocketInputStage;
    lastInputBoundaryStage: ManagedWindowWebSocketInputBoundaryStage;
    inputAttempts: number;
    failure: ManagedWindowWebSocketSurfaceFailure;
    failureInputStage: ManagedWindowWebSocketInputStage;
    failureInputBoundaryStage: ManagedWindowWebSocketInputBoundaryStage;
    lastInputFailureDetail: ManagedWindowWebSocketInputFailureDetail;
    failureInputFailureDetail: ManagedWindowWebSocketInputFailureDetail;
    lastHelperStopReason: ManagedWindowWebSocketHelperStopReason;
    failureHelperStopReason: ManagedWindowWebSocketHelperStopReason;
    lastHelperCrashReason: ManagedWindowWebSocketHelperCrashReason;
    failureHelperCrashReason: ManagedWindowWebSocketHelperCrashReason;
    lastHelperExitKind: ManagedWindowWebSocketHelperExitKind;
    failureHelperExitKind: ManagedWindowWebSocketHelperExitKind;
    lastHelperCrashClass: ManagedWindowWebSocketHelperCrashClass;
    failureHelperCrashClass: ManagedWindowWebSocketHelperCrashClass;
    lastHelperCrashOrigin: ManagedWindowWebSocketHelperCrashOrigin;
    failureHelperCrashOrigin: ManagedWindowWebSocketHelperCrashOrigin;
    lastHelperCrashErrorKind: ManagedWindowWebSocketHelperCrashErrorKind;
    failureHelperCrashErrorKind: ManagedWindowWebSocketHelperCrashErrorKind;
    lastHelperCrashMessageClass: ManagedWindowWebSocketHelperCrashMessageClass;
    failureHelperCrashMessageClass: ManagedWindowWebSocketHelperCrashMessageClass;
    authorityBoundary: "valid" | "lost";
}
//# sourceMappingURL=websocket-window-surface-diagnostics.d.ts.map