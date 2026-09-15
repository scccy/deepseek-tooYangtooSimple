// Native macOS notifications via UNUserNotificationCenter.
//
// Rust facade over the tiny ObjC bridge compiled from notify_un.m (see
// build.rs). The C functions dispatch onto the main thread, request
// authorization once at setup, and deliver banners that present even while
// the app is the foreground app (which the deprecated NSUserNotificationCenter
// path never did).

#[cfg(target_os = "macos")]
use std::ffi::CString;

#[cfg(target_os = "macos")]
#[link(name = "notify_un", kind = "static")]
extern "C" {
    fn dsh_notify_setup();
    fn dsh_notify_send(title: *const std::os::raw::c_char, body: *const std::os::raw::c_char);
}

#[cfg(target_os = "macos")]
pub fn setup() {
    unsafe { dsh_notify_setup() }
}

#[cfg(target_os = "macos")]
pub fn send(title: &str, body: &str) {
    let title_c = CString::new(title).unwrap_or_default();
    let body_c = CString::new(body).unwrap_or_default();
    unsafe { dsh_notify_send(title_c.as_ptr(), body_c.as_ptr()) }
}

#[cfg(not(target_os = "macos"))]
pub fn setup() {}

#[cfg(not(target_os = "macos"))]
pub fn send(_title: &str, _body: &str) {}