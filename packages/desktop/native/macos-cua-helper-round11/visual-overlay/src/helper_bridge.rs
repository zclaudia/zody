//! Private Round 11 C ABI for the native CUA Helper.
//!
//! The ABI is narrow: one operation owner, one trusted native admission
//! callback and one PNG result. It adds no frame owner, approval state or
//! general SDK/JSON entry. The existing public `request_window_capture` stays
//! closed with `HostNotApproved`.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use crate::capture::CaptureHooks;
use crate::error::VisualError;
use crate::geometry::{CaptureRequest, WindowBounds, WindowIdentity};
use crate::session::{AdmissionCheck, CaptureCancelHandle, Checkpoint};
use crate::CapturedFrame;

pub const CUA_R11_VISUAL_OK: i32 = 0;
pub const CUA_R11_VISUAL_DENIED: i32 = 1;
pub const CUA_R11_VISUAL_CANCELED: i32 = 2;
pub const CUA_R11_VISUAL_INVALID_ARGUMENT: i32 = 3;
pub const CUA_R11_VISUAL_NATIVE_FAILURE: i32 = 4;
pub const CUA_R11_VISUAL_CAPACITY_EXHAUSTED: i32 = 5;
pub const CUA_R11_VISUAL_NOT_READY: i32 = 6;
pub const CUA_R11_VISUAL_ALREADY_CONSUMED: i32 = 7;
pub const CUA_R11_VISUAL_DESTROY_PENDING: i32 = 8;

pub const CUA_R11_VISUAL_CHECK_START: u32 = 0;
pub const CUA_R11_VISUAL_CHECK_SWIFT_ADMISSION: u32 = 1;
pub const CUA_R11_VISUAL_CHECK_FINAL_DELIVERY: u32 = 2;

pub type CuaR11AdmitFn = unsafe extern "C" fn(
    context: *mut c_void,
    operation_id: u64,
    checkpoint: u32,
    window_id: u32,
    pid: i32,
    layer: i32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> i32;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CuaR11Request {
    pub window_id: u32,
    pub pid: i32,
    pub layer: i32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
pub struct CuaR11Operation {
    _private: [u8; 0],
}

/// Tracks whether native code may still hold the caller's callback context.
pub(crate) struct CallbackGate {
    native_started: AtomicBool,
    released: AtomicBool,
}

impl CallbackGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            native_started: AtomicBool::new(false),
            released: AtomicBool::new(false),
        })
    }

    pub(crate) fn begin_native(&self) {
        self.native_started.store(true, Ordering::SeqCst);
    }

    pub(crate) fn native_start_failed(&self) {
        self.native_started.store(false, Ordering::SeqCst);
        self.released.store(true, Ordering::SeqCst);
    }

    pub(crate) fn mark_released(&self) {
        self.released.store(true, Ordering::SeqCst);
    }

    pub(crate) fn native_started(&self) -> bool {
        self.native_started.load(Ordering::SeqCst)
    }

    pub(crate) fn released(&self) -> bool {
        self.released.load(Ordering::SeqCst)
    }
}

struct CancelState {
    handle: Option<CaptureCancelHandle>,
    canceled: bool,
}

/// Monotonic close path attached before Swift starts.
pub(crate) struct CancelSlot {
    state: Mutex<CancelState>,
}

impl CancelSlot {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(CancelState {
                handle: None,
                canceled: false,
            }),
        })
    }

    pub(crate) fn cancel(&self) {
        let mut state = lock(&self.state);
        state.canceled = true;
        if let Some(handle) = &state.handle {
            handle.cancel();
        }
    }

    pub(crate) fn attach(&self, handle: CaptureCancelHandle) {
        let mut state = lock(&self.state);
        if state.handle.is_some() {
            return;
        }
        if state.canceled {
            handle.cancel();
        }
        state.handle = Some(handle);
    }

    pub(crate) fn is_canceled(&self) -> bool {
        lock(&self.state).canceled
    }
}

struct NativeAdmission {
    callback: CuaR11AdmitFn,
    context: usize,
}

// SAFETY: the native Helper owns callback/context lifetime and keeps it alive
// until `cua_r11_visual_callback_resources_released` returns 1.
unsafe impl Send for NativeAdmission {}
unsafe impl Sync for NativeAdmission {}

impl NativeAdmission {
    fn check(&self, operation_id: u64, checkpoint: u32, identity: &WindowIdentity) -> bool {
        let decision = unsafe {
            (self.callback)(
                self.context as *mut c_void,
                operation_id,
                checkpoint,
                identity.window_id,
                identity.pid,
                identity.layer,
                identity.bounds.x,
                identity.bounds.y,
                identity.bounds.width,
                identity.bounds.height,
            )
        };
        decision == 0
    }
}

struct OperationState {
    terminal: Option<Result<CapturedFrame, VisualError>>,
    canceled: bool,
    png_taken: bool,
}

struct Operation {
    id: u64,
    gate: Arc<CallbackGate>,
    cancel: Arc<CancelSlot>,
    state: Mutex<OperationState>,
    changed: Condvar,
}

impl Operation {
    fn new(id: u64, gate: Arc<CallbackGate>, cancel: Arc<CancelSlot>) -> Arc<Self> {
        Arc::new(Self {
            id,
            gate,
            cancel,
            state: Mutex::new(OperationState {
                terminal: None,
                canceled: false,
                png_taken: false,
            }),
            changed: Condvar::new(),
        })
    }

    fn complete(&self, result: Result<CapturedFrame, VisualError>) {
        let mut state = lock(&self.state);
        if state.terminal.is_none() {
            state.terminal = Some(result);
            self.changed.notify_all();
        }
    }

    fn cancel(&self) {
        self.cancel.cancel();
        let mut state = lock(&self.state);
        state.canceled = true;
        self.changed.notify_all();
    }

    fn wait_status(&self) -> i32 {
        let mut state = lock(&self.state);
        loop {
            if state.canceled {
                return CUA_R11_VISUAL_CANCELED;
            }
            if state.terminal.is_some() {
                break;
            }
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        status_of(state.terminal.as_ref().expect("terminal present"))
    }

    fn take_png(
        &self,
        out_png: *mut *mut u8,
        out_len: *mut usize,
        out_width: *mut u32,
        out_height: *mut u32,
    ) -> i32 {
        if out_png.is_null() || out_len.is_null() || out_width.is_null() || out_height.is_null() {
            return CUA_R11_VISUAL_INVALID_ARGUMENT;
        }
        let mut state = lock(&self.state);
        if state.canceled {
            return CUA_R11_VISUAL_CANCELED;
        }
        let Some(result) = state.terminal.as_ref() else {
            return CUA_R11_VISUAL_NOT_READY;
        };
        let frame = match result {
            Ok(frame) => frame,
            Err(error) => return status_of_error(error),
        };
        if state.png_taken {
            return CUA_R11_VISUAL_ALREADY_CONSUMED;
        }
        let width = frame.width();
        let height = frame.height();
        let bytes = frame.png().to_vec().into_boxed_slice();
        state.png_taken = true;
        let len = bytes.len();
        let pointer = Box::into_raw(bytes) as *mut u8;
        unsafe {
            *out_png = pointer;
            *out_len = len;
            *out_width = width;
            *out_height = height;
        }
        CUA_R11_VISUAL_OK
    }

    fn destroy_state(&self) -> i32 {
        if lock(&self.state).terminal.is_none() {
            return CUA_R11_VISUAL_NOT_READY;
        }
        if self.gate.native_started() && !self.gate.released() {
            return CUA_R11_VISUAL_DESTROY_PENDING;
        }
        CUA_R11_VISUAL_OK
    }

    /// Callback resources are released only when Swift reported its payload
    /// hand-back and this worker finished every Rust-side callback. The final
    /// delivery callback can run after Swift's payloadReleased, so the gate
    /// alone is not enough to free the native context.
    fn callback_resources_released(&self) -> bool {
        self.gate.released() && lock(&self.state).terminal.is_some()
    }
}

struct OperationHandle {
    operation: Arc<Operation>,
}

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

fn next_operation_id() -> Option<u64> {
    let mut current = NEXT_OPERATION_ID.load(Ordering::Relaxed);
    loop {
        if current == 0 {
            return None;
        }
        match NEXT_OPERATION_ID.compare_exchange_weak(
            current,
            current.checked_add(1).unwrap_or(0),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Some(current),
            Err(actual) => current = actual,
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn cua_r11_visual_start(
    request: *const CuaR11Request,
    admit: Option<CuaR11AdmitFn>,
    context: *mut c_void,
) -> *mut CuaR11Operation {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(admit) = admit else {
            return ptr::null_mut();
        };
        if request.is_null() {
            return ptr::null_mut();
        }
        let request = *request;
        let capture_request = CaptureRequest::new(
            request.window_id,
            request.pid,
            request.layer,
            WindowBounds::new(request.x, request.y, request.width, request.height),
        );
        if capture_request.validate().is_err() {
            return ptr::null_mut();
        }
        let Some(operation_id) = next_operation_id() else {
            return ptr::null_mut();
        };
        let native = Arc::new(NativeAdmission {
            callback: admit,
            context: context as usize,
        });
        if !native.check(
            operation_id,
            CUA_R11_VISUAL_CHECK_START,
            &capture_request.expected_identity(),
        ) {
            return ptr::null_mut();
        }

        let gate = CallbackGate::new();
        let cancel = CancelSlot::new();
        let operation = Operation::new(operation_id, Arc::clone(&gate), Arc::clone(&cancel));
        let admission: AdmissionCheck = {
            let native = Arc::clone(&native);
            Arc::new(move |_session_id, checkpoint, identity| {
                native.check(operation_id, checkpoint_value(checkpoint), identity)
            })
        };
        let hooks = CaptureHooks {
            operation_id,
            admission,
            cancel: Arc::clone(&cancel),
            gate: Arc::clone(&gate),
        };
        let worker_operation = Arc::clone(&operation);
        let worker = std::thread::Builder::new()
            .name(format!("cua-r11-visual-{operation_id}"))
            .spawn(move || {
                let result = run_capture(&capture_request, &hooks);
                if !hooks.gate.native_started() {
                    hooks.gate.mark_released();
                }
                worker_operation.complete(result);
            });
        if worker.is_err() {
            gate.mark_released();
            return ptr::null_mut();
        }
        Box::into_raw(Box::new(OperationHandle { operation })) as *mut CuaR11Operation
    }))
    .unwrap_or(ptr::null_mut())
}

#[no_mangle]
pub unsafe extern "C" fn cua_r11_visual_wait(operation: *mut CuaR11Operation) -> i32 {
    catch_unwind(AssertUnwindSafe(|| match handle_ref(operation) {
        Some(handle) => handle.operation.wait_status(),
        None => CUA_R11_VISUAL_INVALID_ARGUMENT,
    }))
    .unwrap_or(CUA_R11_VISUAL_NATIVE_FAILURE)
}

#[no_mangle]
pub unsafe extern "C" fn cua_r11_visual_take_png(
    operation: *mut CuaR11Operation,
    out_png: *mut *mut u8,
    out_len: *mut usize,
    out_width: *mut u32,
    out_height: *mut u32,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| match handle_ref(operation) {
        Some(handle) => handle
            .operation
            .take_png(out_png, out_len, out_width, out_height),
        None => CUA_R11_VISUAL_INVALID_ARGUMENT,
    }))
    .unwrap_or(CUA_R11_VISUAL_NATIVE_FAILURE)
}

#[no_mangle]
pub unsafe extern "C" fn cua_r11_visual_free_png(png: *mut u8, len: usize) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if png.is_null() {
            return;
        }
        let slice = ptr::slice_from_raw_parts_mut(png, len);
        drop(Box::from_raw(slice));
    }));
}

#[no_mangle]
pub unsafe extern "C" fn cua_r11_visual_cancel(operation: *mut CuaR11Operation) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if let Some(handle) = handle_ref(operation) {
            handle.operation.cancel();
        }
    }));
}

#[no_mangle]
pub unsafe extern "C" fn cua_r11_visual_callback_resources_released(
    operation: *mut CuaR11Operation,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| match handle_ref(operation) {
        Some(handle) if handle.operation.callback_resources_released() => 1,
        _ => 0,
    }))
    .unwrap_or(0)
}

#[no_mangle]
pub unsafe extern "C" fn cua_r11_visual_destroy(operation: *mut CuaR11Operation) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(handle) = handle_ref(operation) else {
            return CUA_R11_VISUAL_INVALID_ARGUMENT;
        };
        let state = handle.operation.destroy_state();
        if state != CUA_R11_VISUAL_OK {
            return state;
        }
        drop(Box::from_raw(operation as *mut OperationHandle));
        CUA_R11_VISUAL_OK
    }))
    .unwrap_or(CUA_R11_VISUAL_NATIVE_FAILURE)
}

fn run_capture(
    request: &CaptureRequest,
    hooks: &CaptureHooks,
) -> Result<CapturedFrame, VisualError> {
    if hooks.cancel.is_canceled() {
        return Err(VisualError::CaptureCanceled);
    }
    crate::capture::capture_window_png_with_hooks(request, Some(hooks))
}

fn checkpoint_value(checkpoint: Checkpoint) -> u32 {
    match checkpoint {
        Checkpoint::SwiftAdmission => CUA_R11_VISUAL_CHECK_SWIFT_ADMISSION,
        Checkpoint::FinalDelivery => CUA_R11_VISUAL_CHECK_FINAL_DELIVERY,
    }
}

fn status_of(result: &Result<CapturedFrame, VisualError>) -> i32 {
    match result {
        Ok(_) => CUA_R11_VISUAL_OK,
        Err(error) => status_of_error(error),
    }
}

fn status_of_error(error: &VisualError) -> i32 {
    match error {
        VisualError::HostNotApproved => CUA_R11_VISUAL_DENIED,
        VisualError::CaptureCanceled => CUA_R11_VISUAL_CANCELED,
        VisualError::CaptureAlreadyConsumed => CUA_R11_VISUAL_ALREADY_CONSUMED,
        VisualError::CaptureCapacityExhausted { .. } => CUA_R11_VISUAL_CAPACITY_EXHAUSTED,
        VisualError::NativeCapture(_) => CUA_R11_VISUAL_NATIVE_FAILURE,
        _ => CUA_R11_VISUAL_INVALID_ARGUMENT,
    }
}

unsafe fn handle_ref<'a>(operation: *mut CuaR11Operation) -> Option<&'a OperationHandle> {
    if operation.is_null() {
        None
    } else {
        Some(&*(operation as *const OperationHandle))
    }
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::slice;
    use std::thread;
    use std::time::Duration;

    unsafe extern "C" fn deny(
        _context: *mut c_void,
        _id: u64,
        _checkpoint: u32,
        _window_id: u32,
        _pid: i32,
        _layer: i32,
        _x: f64,
        _y: f64,
        _width: f64,
        _height: f64,
    ) -> i32 {
        1
    }

    fn valid_request() -> CuaR11Request {
        CuaR11Request {
            window_id: 77,
            pid: 4242,
            layer: 0,
            x: 10.0,
            y: 20.0,
            width: 300.0,
            height: 200.0,
        }
    }

    #[test]
    fn start_requires_a_callback_and_a_valid_request() {
        let request = valid_request();
        let missing = unsafe { cua_r11_visual_start(&request, None, ptr::null_mut()) };
        assert!(missing.is_null());
        let invalid = CuaR11Request {
            window_id: 0,
            ..request
        };
        let rejected = unsafe { cua_r11_visual_start(&invalid, Some(deny), ptr::null_mut()) };
        assert!(rejected.is_null());
    }

    #[test]
    fn start_callback_denial_returns_null() {
        let request = valid_request();
        let operation = unsafe { cua_r11_visual_start(&request, Some(deny), ptr::null_mut()) };
        assert!(operation.is_null());
    }

    #[test]
    fn destroy_waits_for_callback_release() {
        let gate = CallbackGate::new();
        gate.begin_native();
        let operation = Operation::new(9, Arc::clone(&gate), CancelSlot::new());
        operation.complete(Err(VisualError::CaptureCanceled));
        let handle = Box::into_raw(Box::new(OperationHandle { operation })) as *mut CuaR11Operation;
        assert_eq!(unsafe { cua_r11_visual_destroy(handle) }, CUA_R11_VISUAL_DESTROY_PENDING);
        assert_eq!(unsafe { cua_r11_visual_callback_resources_released(handle) }, 0);
        assert_eq!(unsafe { cua_r11_visual_wait(handle) }, CUA_R11_VISUAL_CANCELED);
        gate.mark_released();
        assert_eq!(unsafe { cua_r11_visual_callback_resources_released(handle) }, 1);
        assert_eq!(unsafe { cua_r11_visual_destroy(handle) }, CUA_R11_VISUAL_OK);
    }

    #[test]
    fn take_png_is_one_shot_and_not_ready_before_terminal() {
        let operation = Operation::new(10, CallbackGate::new(), CancelSlot::new());
        let handle = Box::into_raw(Box::new(OperationHandle {
            operation: Arc::clone(&operation),
        })) as *mut CuaR11Operation;
        let mut png: *mut u8 = ptr::null_mut();
        let mut len = 0_usize;
        let mut width = 0_u32;
        let mut height = 0_u32;
        assert_eq!(
            unsafe { cua_r11_visual_take_png(handle, &mut png, &mut len, &mut width, &mut height) },
            CUA_R11_VISUAL_NOT_READY
        );
        operation.complete(Err(VisualError::CaptureCanceled));
        assert_eq!(
            unsafe { cua_r11_visual_take_png(handle, &mut png, &mut len, &mut width, &mut height) },
            CUA_R11_VISUAL_CANCELED
        );
        assert_eq!(unsafe { cua_r11_visual_destroy(handle) }, CUA_R11_VISUAL_OK);
    }

    #[test]
    fn cancel_after_a_completed_png_rejects_take_and_wait() {
        let operation = Operation::new(12, CallbackGate::new(), CancelSlot::new());
        let frame = CapturedFrame::new(
            77,
            crate::PixelDimensions {
                width: 1,
                height: 1,
            },
            vec![0x89, b'P', b'N', b'G'],
        )
        .expect("frame");
        operation.complete(Ok(frame));
        let handle = Box::into_raw(Box::new(OperationHandle {
            operation: Arc::clone(&operation),
        })) as *mut CuaR11Operation;
        unsafe { cua_r11_visual_cancel(handle) };
        assert_eq!(unsafe { cua_r11_visual_wait(handle) }, CUA_R11_VISUAL_CANCELED);
        let mut png: *mut u8 = ptr::null_mut();
        let mut len = 0_usize;
        let mut width = 0_u32;
        let mut height = 0_u32;
        assert_eq!(
            unsafe { cua_r11_visual_take_png(handle, &mut png, &mut len, &mut width, &mut height) },
            CUA_R11_VISUAL_CANCELED
        );
        assert_eq!(unsafe { cua_r11_visual_destroy(handle) }, CUA_R11_VISUAL_OK);
    }

    #[test]
    fn callback_release_waits_for_worker_terminal_after_swift_release() {
        let gate = CallbackGate::new();
        gate.begin_native();
        let operation = Operation::new(13, Arc::clone(&gate), CancelSlot::new());
        let handle = Box::into_raw(Box::new(OperationHandle {
            operation: Arc::clone(&operation),
        })) as *mut CuaR11Operation;
        gate.mark_released();
        assert_eq!(unsafe { cua_r11_visual_callback_resources_released(handle) }, 0);
        operation.complete(Err(VisualError::CaptureCanceled));
        assert_eq!(unsafe { cua_r11_visual_callback_resources_released(handle) }, 1);
        assert_eq!(unsafe { cua_r11_visual_destroy(handle) }, CUA_R11_VISUAL_OK);
    }

    #[test]
    fn cancel_wakes_a_wait_blocked_before_terminal() {
        let operation = Operation::new(14, CallbackGate::new(), CancelSlot::new());
        let waiter_operation = Arc::clone(&operation);
        let waiter = thread::spawn(move || waiter_operation.wait_status());
        thread::sleep(Duration::from_millis(50));
        operation.cancel();
        assert_eq!(waiter.join().expect("waiter"), CUA_R11_VISUAL_CANCELED);
        assert!(lock(&operation.state).terminal.is_none());
    }

    #[test]
    fn png_buffer_round_trips_through_the_c_allocator_pair() {
        let operation = Operation::new(11, CallbackGate::new(), CancelSlot::new());
        let frame = CapturedFrame::new(
            77,
            crate::PixelDimensions {
                width: 1,
                height: 1,
            },
            vec![0x89, b'P', b'N', b'G'],
        )
        .expect("frame");
        operation.complete(Ok(frame));
        let handle = Box::into_raw(Box::new(OperationHandle { operation })) as *mut CuaR11Operation;
        let mut png: *mut u8 = ptr::null_mut();
        let mut len = 0_usize;
        let mut width = 0_u32;
        let mut height = 0_u32;
        assert_eq!(
            unsafe { cua_r11_visual_take_png(handle, &mut png, &mut len, &mut width, &mut height) },
            CUA_R11_VISUAL_OK
        );
        assert_eq!(width, 1);
        assert_eq!(height, 1);
        assert_eq!(unsafe { slice::from_raw_parts(png, len) }, [0x89, b'P', b'N', b'G']);
        unsafe { cua_r11_visual_free_png(png, len) };
        assert_eq!(
            unsafe { cua_r11_visual_take_png(handle, &mut png, &mut len, &mut width, &mut height) },
            CUA_R11_VISUAL_ALREADY_CONSUMED
        );
        assert_eq!(unsafe { cua_r11_visual_destroy(handle) }, CUA_R11_VISUAL_OK);
    }

    #[test]
    fn public_capture_entry_stays_closed() {
        let request = CaptureRequest::new(
            77,
            4242,
            0,
            WindowBounds::new(10.0, 20.0, 300.0, 200.0),
        );
        assert_eq!(
            crate::request_window_capture(&request),
            Err(VisualError::HostNotApproved)
        );
    }
}
