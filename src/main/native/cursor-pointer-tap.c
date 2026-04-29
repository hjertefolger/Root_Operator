#include <ApplicationServices/ApplicationServices.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static _Atomic bool capture_right = false;
static _Atomic bool capture_wheel = false;
static _Atomic bool swallow_next_right_up = false;
static CFMachPortRef event_tap = NULL;

static void emit_ready(void) {
    printf("{\"type\":\"ready\"}\n");
    fflush(stdout);
}

static void emit_error(const char *message) {
    printf("{\"type\":\"error\",\"message\":\"%s\"}\n", message);
    fflush(stdout);
}

static void emit_right_mouse_down(CGEventRef event) {
    CGPoint point = CGEventGetLocation(event);
    printf(
        "{\"type\":\"rightMouseDown\",\"x\":%.0f,\"y\":%.0f}\n",
        point.x,
        point.y
    );
    fflush(stdout);
}

static int64_t scaled_delta(int64_t point_delta, int64_t unit_delta) {
    if (point_delta != 0) return -point_delta;
    if (unit_delta != 0) return -unit_delta * 40;
    return 0;
}

static void emit_wheel(CGEventRef event) {
    CGPoint point = CGEventGetLocation(event);
    int64_t unit_y = CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1);
    int64_t unit_x = CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis2);
    int64_t point_y = CGEventGetIntegerValueField(event, kCGScrollWheelEventPointDeltaAxis1);
    int64_t point_x = CGEventGetIntegerValueField(event, kCGScrollWheelEventPointDeltaAxis2);
    int64_t delta_y = scaled_delta(point_y, unit_y);
    int64_t delta_x = scaled_delta(point_x, unit_x);

    if (delta_x == 0 && delta_y == 0) return;

    printf(
        "{\"type\":\"wheel\",\"x\":%.0f,\"y\":%.0f,\"deltaX\":%lld,\"deltaY\":%lld}\n",
        point.x,
        point.y,
        (long long)delta_x,
        (long long)delta_y
    );
    fflush(stdout);
}

static CGEventRef tap_callback(
    CGEventTapProxy proxy,
    CGEventType type,
    CGEventRef event,
    void *refcon
) {
    (void)proxy;
    (void)refcon;

    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (event_tap != NULL) {
            CGEventTapEnable(event_tap, true);
        }
        return event;
    }

    if (type == kCGEventRightMouseDown && atomic_load(&capture_right)) {
        atomic_store(&swallow_next_right_up, true);
        emit_right_mouse_down(event);
        return NULL;
    }

    if (type == kCGEventRightMouseUp) {
        bool should_swallow = atomic_load(&capture_right) || atomic_exchange(&swallow_next_right_up, false);
        if (should_swallow) return NULL;
    }

    if (type == kCGEventScrollWheel && atomic_load(&capture_wheel)) {
        emit_wheel(event);
        return NULL;
    }

    return event;
}

static void *stdin_thread(void *arg) {
    (void)arg;
    char line[128];

    while (fgets(line, sizeof(line), stdin) != NULL) {
        if (strstr(line, "quit") != NULL) {
            exit(0);
        }
        atomic_store(&capture_right, strstr(line, "right=1") != NULL);
        atomic_store(&capture_wheel, strstr(line, "wheel=1") != NULL);
    }

    exit(0);
    return NULL;
}

int main(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGPIPE, SIG_IGN);

    CGEventMask mask = CGEventMaskBit(kCGEventRightMouseDown)
        | CGEventMaskBit(kCGEventRightMouseUp)
        | CGEventMaskBit(kCGEventScrollWheel);

    event_tap = CGEventTapCreate(
        kCGHIDEventTap,
        kCGHeadInsertEventTap,
        kCGEventTapOptionDefault,
        mask,
        tap_callback,
        NULL
    );

    if (event_tap == NULL) {
        emit_error("CGEventTapCreate failed");
        return 2;
    }

    pthread_t thread;
    if (pthread_create(&thread, NULL, stdin_thread, NULL) == 0) {
        pthread_detach(thread);
    }

    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, event_tap, 0);
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
    CGEventTapEnable(event_tap, true);
    emit_ready();
    CFRunLoopRun();

    CFRelease(source);
    CFRelease(event_tap);
    return 0;
}
