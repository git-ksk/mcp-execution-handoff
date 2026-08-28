#include <X11/X.h>
#include <X11/Xlib.h>
#include <X11/extensions/XI2.h>
#include <X11/extensions/XRes.h>
#include <X11/extensions/record.h>

#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>

#define WAIT_TIMEOUT_MS 1500
#define MAX_WINDOW_ANCESTRY 32
#define MAX_PROCESS_ANCESTRY 64
#define MAX_PROC_STAT_BYTES 4096
#define X_EVENT_BYTES 32

#define WIRE_EVENT_TYPE_OFFSET 0
#define WIRE_CORE_DETAIL_OFFSET 1
#define WIRE_CORE_EVENT_WINDOW_OFFSET 12
#define WIRE_XI2_EXTENSION_OFFSET 1
#define WIRE_XI2_EVTYPE_OFFSET 8
#define WIRE_XI2_DETAIL_OFFSET 16
#define WIRE_XI2_EVENT_WINDOW_OFFSET 24

typedef struct {
  Display *control;
  Display *data;
  XRecordContext context;
  Window expected_window;
  unsigned int expected_keycode;
  int xinput_opcode;
  bool delivered;
  bool saw_event;
  bool saw_key_mismatch;
  bool saw_window_mismatch;
} ProbeState;

static int x_error_seen = 0;

static int on_x_error(Display *display, XErrorEvent *event) {
  (void)display;
  (void)event;
  x_error_seen = 1;
  return 0;
}

static int64_t monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return ((int64_t)now.tv_sec * 1000) + ((int64_t)now.tv_nsec / 1000000);
}

static uint32_t read_u32(const unsigned char *data, size_t offset) {
  uint32_t value = 0;
  (void)memcpy(&value, data + offset, sizeof(value));
  return value;
}

static uint16_t read_u16(const unsigned char *data, size_t offset) {
  uint16_t value = 0;
  (void)memcpy(&value, data + offset, sizeof(value));
  return value;
}

static bool parse_positive_long(const char *value, long *parsed_return) {
  char *end = NULL;
  long parsed;
  if (value == NULL || *value == '\0') return false;
  errno = 0;
  parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed <= 0) return false;
  *parsed_return = parsed;
  return true;
}

static bool parent_pid_of(pid_t pid, pid_t *parent_pid_return) {
  char path[64];
  char buffer[MAX_PROC_STAT_BYTES];
  FILE *file;
  char *close;
  char state = '\0';
  long parsed_parent = 0;

  if (pid <= 0 || snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid) < 0) return false;
  file = fopen(path, "r");
  if (file == NULL) return false;
  const bool read_ok = fgets(buffer, sizeof(buffer), file) != NULL;
  const bool complete = read_ok && strchr(buffer, '\n') != NULL;
  (void)fclose(file);
  if (!complete) return false;
  close = strrchr(buffer, ')');
  if (close == NULL || close[1] != ' ') return false;
  if (sscanf(close + 2, "%c %ld", &state, &parsed_parent) != 2 || state == '\0') return false;
  if (parsed_parent <= 0 || parsed_parent > INT_MAX) return false;
  *parent_pid_return = (pid_t)parsed_parent;
  return true;
}

static bool process_is_target_or_descendant(pid_t pid, pid_t target_pid) {
  pid_t current = pid;
  int depth;
  if (pid <= 0 || target_pid <= 0) return false;
  for (depth = 0; depth < MAX_PROCESS_ANCESTRY; depth += 1) {
    pid_t parent = 0;
    if (current == target_pid) return true;
    if (current <= 1 || !parent_pid_of(current, &parent) || parent == current) return false;
    current = parent;
  }
  return false;
}

static bool window_descends_from(Display *display, Window ancestor, Window candidate) {
  int depth;
  if (ancestor == None || candidate == None) return false;
  for (depth = 0; depth < MAX_WINDOW_ANCESTRY; depth += 1) {
    Window root = None;
    Window parent = None;
    Window *children = NULL;
    unsigned int child_count = 0;
    Status status;
    if (candidate == ancestor) return true;
    x_error_seen = 0;
    status = XQueryTree(display, candidate, &root, &parent, &children, &child_count);
    (void)root;
    (void)child_count;
    if (children != NULL) XFree(children);
    if (status == 0 || x_error_seen != 0 || parent == None || parent == candidate) return false;
    candidate = parent;
  }
  return false;
}

static bool collect_target_clients(
    Display *display,
    pid_t target_pid,
    XRecordClientSpec **clients_return,
    int *count_return) {
  XResClientIdSpec spec;
  XResClientIdValue *ids = NULL;
  XRecordClientSpec *clients = NULL;
  long id_count = 0;
  long index;
  int client_count = 0;
  int major = 0;
  int minor = 0;

  *clients_return = NULL;
  *count_return = 0;
  if (!XResQueryVersion(display, &major, &minor)) return false;
  if (major < 1 || (major == 1 && minor < 2)) return false;

  spec.client = None;
  spec.mask = XRES_CLIENT_ID_PID_MASK;
  if (XResQueryClientIds(display, 1, &spec, &id_count, &ids) != Success || id_count <= 0 || ids == NULL) {
    if (ids != NULL) XResClientIdsDestroy(id_count, ids);
    return false;
  }
  if (id_count > INT_MAX) {
    XResClientIdsDestroy(id_count, ids);
    return false;
  }
  clients = calloc((size_t)id_count, sizeof(*clients));
  if (clients == NULL) {
    XResClientIdsDestroy(id_count, ids);
    return false;
  }

  for (index = 0; index < id_count; index += 1) {
    int existing;
    const pid_t pid = XResGetClientPid(&ids[index]);
    const XRecordClientSpec client = (XRecordClientSpec)ids[index].spec.client;
    bool duplicate = false;
    if (!process_is_target_or_descendant(pid, target_pid) || client == (XRecordClientSpec)None) continue;
    for (existing = 0; existing < client_count; existing += 1) {
      if (clients[existing] == client) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) clients[client_count++] = client;
  }
  XResClientIdsDestroy(id_count, ids);
  if (client_count == 0) {
    free(clients);
    return false;
  }
  *clients_return = clients;
  *count_return = client_count;
  return true;
}

static void record_callback(XPointer closure, XRecordInterceptData *recorded) {
  ProbeState *state = (ProbeState *)closure;
  if (recorded == NULL) return;
  if (!state->delivered
      && recorded->category == XRecordFromServer
      && !recorded->client_swapped
      && recorded->data != NULL
      && recorded->data_len >= (X_EVENT_BYTES / 4UL)) {
    const unsigned char *event = recorded->data;
    const unsigned char type = (unsigned char)(event[WIRE_EVENT_TYPE_OFFSET] & 0x7fU);
    state->saw_event = true;
    if (type == KeyPress) {
      const unsigned int detail = event[WIRE_CORE_DETAIL_OFFSET];
      const Window event_window = (Window)read_u32(event, WIRE_CORE_EVENT_WINDOW_OFFSET);
      if (detail != state->expected_keycode) {
        state->saw_key_mismatch = true;
      } else if (!window_descends_from(state->control, state->expected_window, event_window)) {
        state->saw_window_mismatch = true;
      } else {
        state->delivered = true;
      }
    } else if (type == GenericEvent && (int)event[WIRE_XI2_EXTENSION_OFFSET] == state->xinput_opcode) {
      const uint16_t evtype = read_u16(event, WIRE_XI2_EVTYPE_OFFSET);
      const uint32_t detail = read_u32(event, WIRE_XI2_DETAIL_OFFSET);
      const Window event_window = (Window)read_u32(event, WIRE_XI2_EVENT_WINDOW_OFFSET);
      if (evtype == XI_KeyPress) {
        if (detail != state->expected_keycode) {
          state->saw_key_mismatch = true;
        } else if (!window_descends_from(state->control, state->expected_window, event_window)) {
          state->saw_window_mismatch = true;
        } else {
          state->delivered = true;
        }
      }
    }
  }
  XRecordFreeData(recorded);
}

static void cleanup(ProbeState *state) {
  if (state->context != 0 && state->control != NULL && state->data != NULL) {
    x_error_seen = 0;
    (void)XRecordDisableContext(state->control, state->context);
    XSync(state->control, False);
    XRecordProcessReplies(state->data);
    (void)XRecordFreeContext(state->control, state->context);
    XSync(state->control, False);
    state->context = 0;
  }
}

static bool arm(ProbeState *state, pid_t target_pid) {
  XRecordClientSpec *clients = NULL;
  XRecordRange *ranges[2] = {NULL, NULL};
  int client_count = 0;
  int major = 0;
  int minor = 0;

  if (!XRecordQueryVersion(state->control, &major, &minor)) return false;
  (void)major;
  (void)minor;
  if (!collect_target_clients(state->control, target_pid, &clients, &client_count)) return false;

  ranges[0] = XRecordAllocRange();
  ranges[1] = XRecordAllocRange();
  if (ranges[0] == NULL || ranges[1] == NULL) {
    if (ranges[0] != NULL) XFree(ranges[0]);
    if (ranges[1] != NULL) XFree(ranges[1]);
    free(clients);
    return false;
  }
  ranges[0]->delivered_events.first = KeyPress;
  ranges[0]->delivered_events.last = KeyPress;
  ranges[1]->delivered_events.first = GenericEvent;
  ranges[1]->delivered_events.last = GenericEvent;

  x_error_seen = 0;
  state->context = XRecordCreateContext(state->control, 0, clients, client_count, ranges, 2);
  XFree(ranges[0]);
  XFree(ranges[1]);
  free(clients);
  if (state->context == 0) return false;
  XSync(state->control, False);
  if (x_error_seen != 0) {
    state->context = 0;
    return false;
  }
  x_error_seen = 0;
  if (!XRecordEnableContextAsync(state->data, state->context, record_callback, (XPointer)state)) {
    cleanup(state);
    return false;
  }
  if (x_error_seen != 0) {
    cleanup(state);
    return false;
  }
  return true;
}

static const char *wait_for_delivery(ProbeState *state) {
  const int fd = ConnectionNumber(state->data);
  const int64_t start = monotonic_ms();
  if (fd < 0 || start < 0 || state->context == 0) return "IO";

  x_error_seen = 0;
  XSync(state->control, False);
  if (x_error_seen != 0) return "IO";
  XRecordProcessReplies(state->data);
  if (state->delivered) return NULL;

  for (;;) {
    struct pollfd descriptor;
    const int64_t now = monotonic_ms();
    int remaining;
    int result;
    if (now < 0) return "IO";
    XRecordProcessReplies(state->data);
    if (state->delivered) return NULL;
    if (now - start >= WAIT_TIMEOUT_MS) {
      if (state->saw_window_mismatch) return "WINDOW_MISMATCH";
      if (state->saw_key_mismatch) return "KEY_MISMATCH";
      if (state->saw_event) return "EVENT_MISMATCH";
      return "NO_DELIVERY";
    }
    remaining = (int)(WAIT_TIMEOUT_MS - (now - start));
    descriptor.fd = fd;
    descriptor.events = POLLIN;
    descriptor.revents = 0;
    do {
      result = poll(&descriptor, 1, remaining);
    } while (result < 0 && errno == EINTR);
    if (result <= 0) return result == 0 ? "NO_DELIVERY" : "IO";
    if ((descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) return "IO";
  }
}

int main(int argc, char **argv) {
  ProbeState state = {0};
  long target_pid_long;
  long window_long;
  long keycode_long;
  char command[32];
  const char *failure;
  int event_base = 0;
  int error_base = 0;
  int result = 3;

  if (argc != 7
      || strcmp(argv[1], "--pid") != 0
      || strcmp(argv[3], "--window") != 0
      || strcmp(argv[5], "--keycode") != 0
      || !parse_positive_long(argv[2], &target_pid_long)
      || !parse_positive_long(argv[4], &window_long)
      || !parse_positive_long(argv[6], &keycode_long)
      || target_pid_long > INT_MAX
      || (unsigned long)window_long > UINT32_MAX
      || keycode_long < 8
      || keycode_long > 255) {
    return 2;
  }

  (void)setvbuf(stdout, NULL, _IOLBF, 0);
  XSetErrorHandler(on_x_error);
  state.expected_window = (Window)(unsigned long)window_long;
  state.expected_keycode = (unsigned int)keycode_long;
  state.control = XOpenDisplay(NULL);
  state.data = XOpenDisplay(NULL);
  if (state.control == NULL || state.data == NULL) goto done;
  if (!XQueryExtension(state.control, "XInputExtension", &state.xinput_opcode, &event_base, &error_base)
      || state.xinput_opcode <= 0 || state.xinput_opcode > UINT8_MAX) {
    goto done;
  }
  if (!arm(&state, (pid_t)target_pid_long)) goto done;

  (void)fprintf(stdout, "READY\n");
  if (fgets(command, sizeof(command), stdin) == NULL || strcmp(command, "WAIT\n") != 0) {
    result = 2;
    goto done;
  }
  failure = wait_for_delivery(&state);
  if (failure == NULL) {
    (void)fprintf(stdout, "OK KEY\n");
    result = 0;
  } else {
    (void)fprintf(stdout, "ERR %s\n", failure);
    result = 3;
  }

done:
  cleanup(&state);
  if (state.data != NULL) XCloseDisplay(state.data);
  if (state.control != NULL) XCloseDisplay(state.control);
  return result;
}
