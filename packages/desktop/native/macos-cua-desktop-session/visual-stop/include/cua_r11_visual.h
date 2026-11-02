#pragma once

// Private Round 11 visual bridge for the macOS CUA Helper, derived for the
// stop-worker. This is not a public SDK. Production builds do not reference the
// diagnostic gate; only the explicit stop-diagnostic feature compiles it.

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CUA_R11_VISUAL_ABI_VERSION 1u

typedef enum cua_r11_visual_status {
  CUA_R11_VISUAL_OK = 0,
  CUA_R11_VISUAL_DENIED = 1,
  CUA_R11_VISUAL_CANCELED = 2,
  CUA_R11_VISUAL_INVALID_ARGUMENT = 3,
  CUA_R11_VISUAL_NATIVE_FAILURE = 4,
  CUA_R11_VISUAL_CAPACITY_EXHAUSTED = 5,
  CUA_R11_VISUAL_NOT_READY = 6,
  CUA_R11_VISUAL_ALREADY_CONSUMED = 7,
  CUA_R11_VISUAL_DESTROY_PENDING = 8
} cua_r11_visual_status;

typedef enum cua_r11_visual_checkpoint {
  CUA_R11_VISUAL_CHECK_START = 0,
  CUA_R11_VISUAL_CHECK_SWIFT_ADMISSION = 1,
  CUA_R11_VISUAL_CHECK_FINAL_DELIVERY = 2,
  // Notification-only checkpoint emitted after the real captureImage call
  // returns. It never re-enters the session coordinator admission path.
  CUA_R11_VISUAL_CHECK_SUBMIT_RETURNED = 3
} cua_r11_visual_checkpoint;

// Return 0 to proceed, any other value to deny. `context` stays owned by the
// native Helper and must outlive callback resource release. The operation id is
// the Rust helper operation id, not the session coordinator observation id.
typedef int32_t (*cua_r11_visual_admit_fn)(
    void *context,
    uint64_t operation_id,
    uint32_t checkpoint,
    uint32_t window_id,
    int32_t pid,
    int32_t layer,
    double x,
    double y,
    double width,
    double height);

typedef struct cua_r11_visual_request {
  uint32_t window_id;
  int32_t pid;
  int32_t layer;
  double x;
  double y;
  double width;
  double height;
} cua_r11_visual_request;

typedef struct cua_r11_visual_operation cua_r11_visual_operation;

// Returns NULL for a missing callback, invalid request or start denial.
cua_r11_visual_operation *cua_r11_visual_start(
    const cua_r11_visual_request *request,
    cua_r11_visual_admit_fn admit,
    void *context);

// Blocks until terminal. Cancellation wakes this wait, but a canceled wait is
// not evidence that native callback resources were released.
int32_t cua_r11_visual_wait(cua_r11_visual_operation *operation);

// One-shot PNG transfer. Free the returned buffer with
// cua_r11_visual_free_png.
int32_t cua_r11_visual_take_png(cua_r11_visual_operation *operation,
                              uint8_t **out_png, size_t *out_len,
                              uint32_t *out_width, uint32_t *out_height);
void cua_r11_visual_free_png(uint8_t *png, size_t len);

// Closes result reception only. Never frees callback context or native memory.
void cua_r11_visual_cancel(cua_r11_visual_operation *operation);

// Returns 1 only after the Swift bridge reported payload/callback hand-back.
int32_t cua_r11_visual_callback_resources_released(
    cua_r11_visual_operation *operation);

// Returns CUA_R11_VISUAL_DESTROY_PENDING while the native callback may still
// hold context. The Helper must keep that context alive and retry after
// callback_resources_released returns 1.
int32_t cua_r11_visual_destroy(cua_r11_visual_operation *operation);

#ifdef CUA_R11_STOP_DIAGNOSTIC
typedef enum cua_r11_visual_diagnostic_gate_result {
  CUA_R11_VISUAL_GATE_STOPPED = 1,
  CUA_R11_VISUAL_GATE_TIMEOUT = 2,
  CUA_R11_VISUAL_GATE_MISSING_OPERATION = 3
} cua_r11_visual_diagnostic_gate_result;

// Diagnostic-only scheduling gate. `request_id` is the session coordinator
// observation id. The function waits on that existing observation's cancel
// condition; it does not authorize, synthesize completion or release resources.
int32_t cua_r11_visual_wait_diagnostic_gate(uint64_t request_id, int32_t timeout_ms);
#endif

#ifdef __cplusplus
}
#endif
