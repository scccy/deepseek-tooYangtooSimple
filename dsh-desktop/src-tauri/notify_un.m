// Native macOS notification delivery via UNUserNotificationCenter.
//
// The desktop shell compiles this with `cc` (see build.rs) and Rust links the
// static archive, calling dsh_notify_setup / dsh_notify_send.
//
// Why: tauri-plugin-notification -> mac-notification-sys uses the deprecated
// NSUserNotificationCenter, which never requests authorization on modern
// macOS and silently suppresses banners while the app is foreground. This
// delegate presents banners in the foreground and requests authorization once.

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

static void dsh_log_cstr(const char *msg);

@interface DSHNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation DSHNotificationDelegate

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
        willPresentNotification:(UNNotification *)notification
          withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler
{
  dsh_log_cstr("delegate: willPresentNotification fired (foreground)");
  // Show a banner + sound even while the app is the active foreground app.
  completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
         didPresentNotification:(UNNotification *)notification
    withCompletionHandler:(void (^)(BOOL))completionHandler
{
  dsh_log_cstr("delegate: didPresentNotification");
  completionHandler(YES);
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       didDeliverNotification:(UNNotification *)notification
{
  dsh_log_cstr("delegate: didDeliverNotification");
}

@end

// Diagnostics to stderr (captured when the app runs from a terminal), so the
// authorization + delivery path can be observed while iterating.
static void dsh_log_cstr(const char *msg) {
  fprintf(stderr, "[notify_un] %s\n", msg);
}

// UNUserNotificationCenter requires a real .app bundle (bundleProxyForCurrentProcess);
// the bare debug binary crashes on access. Only initialize when running bundled.
static BOOL dsg_is_bundled_app(void) {
  NSBundle *mainBundle = [NSBundle mainBundle];
  return mainBundle != nil && [mainBundle.bundlePath hasSuffix:@".app"];
}

void dsh_notify_setup(void) {
  static DSHNotificationDelegate *delegate = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    if (!dsg_is_bundled_app()) {
      dsh_log_cstr("setup: skip (not a bundled app)");
      return;
    }
    dsh_log_cstr("setup: registering UNUserNotificationCenter delegate");
    delegate = [[DSHNotificationDelegate alloc] init];
    [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
    dispatch_async(dispatch_get_main_queue(), ^{
      UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
      [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        char line[256];
        snprintf(line, sizeof line, "auth status before request: %ld",
                 (long)settings.authorizationStatus);
        dsh_log_cstr(line);
        if (settings.authorizationStatus != UNAuthorizationStatusNotDetermined) {
          dsh_log_cstr("requestAuthorization skipped (already decided)");
          return;
        }
        dsh_log_cstr("requestAuthorization: prompting…");
        UNAuthorizationOptions options =
            UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge;
        [center requestAuthorizationWithOptions:options
                              completionHandler:^(BOOL granted, NSError *error) {
                                char line[256];
                                snprintf(line, sizeof line,
                                         "requestAuthorization result granted=%d error=%s",
                                         granted,
                                         error ? error.localizedDescription.UTF8String : "nil");
                                dsh_log_cstr(line);
                              }];
      }];
    });
  });
}

void dsh_notify_send(const char *title, const char *body) {
  if (!dsg_is_bundled_app()) {
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    @autoreleasepool {
      UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
      if (title != NULL) {
        content.title = [NSString stringWithUTF8String:title];
      }
      if (body != NULL) {
        content.body = [NSString stringWithUTF8String:body];
      }
      content.sound = [UNNotificationSound defaultSound];
      // macOS treats a nil (deliver-now) trigger unreliably — the request is
      // accepted but never presented. A tiny time-interval trigger is the
      // reliable way to fire immediately.
      UNTimeIntervalNotificationTrigger *trigger =
          [UNTimeIntervalNotificationTrigger triggerWithTimeInterval:1 repeats:NO];
      UNNotificationRequest *request =
          [UNNotificationRequest requestWithIdentifier:[NSUUID UUID].UUIDString
                                                content:content
                                                trigger:trigger];
      [center addNotificationRequest:request
               withCompletionHandler:^(NSError *error) {
                 if (error != nil) {
                   char line[512];
                   snprintf(line, sizeof line, "send: addNotificationRequest error=%s",
                            error.localizedDescription.UTF8String);
                   dsh_log_cstr(line);
                 }
               }];
    }
  });
}