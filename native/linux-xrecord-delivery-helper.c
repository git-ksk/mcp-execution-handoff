#include <X11/X.h>
#include <X11/Xlib.h>
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

#define PROTOCOL_VERSION 1
#define MAX_LINE_BYTES 192
#define MAX_TOKENS 6
#define DELIVERY_WAIT_TIMEOUT_MS 1000
#define MAX_WINDOW_ANCESTRY 32
#define X_EVENT_BYTES 32

#define WIRE_EVENT_TYPE_OFFSET 0
#define WIRE_DETAIL_OFFSET 1
#define WIRE_EVENT_WINDOW_OFFSET 12
#define WIRE_ROOT_X_OFFSET 20
#define WIRE_ROOT_Y_OFFSET 22

typedef struct {
  Display *control;
  Display *data;
  XRecordContext context;
  Window expected_window;
  int expected_x;
  int expected_y;
  bool delivered;
} DeliveryState;

static int x_error_seen = 0;

static int on_x_error(Display *display, XErrorEvent *event) {
  (void)display;
  (void)event;
  x_error_seen = 1;
  return 0;
}

static void reply(const char *status, const char *command) {
  (void)fprintf(stdout, "%s %s\n", status, command);
  (void)fflush(stdout);
}

static bool parse_long_token(const char *token, long *value) {
  char *end = NULL;
  long parsed;
  if (token == NULL || *token == '\0') return false;
  errno = 0;
  parsed = strtol(token, &end, 10);
  if (errno != 0 || end == token || *end != '\0') return false;
  *value = parsed;
  return true;
}

static int split_tokens(char *line, char **tokens, int capacity) {
  int count = 0;
  char *save = NULL;
  char *token = strtok_r(line, " \t\r\n", &save);
  while (token != NULL) {
    if (count >= capacity) return -1;
    tokens[count++] = token;
    token = strtok_r(NULL, " \t\r\n", &save);
  }
  return count;
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

static int16_t read_i16(const unsigned char *data, size_t offset) {
  int16_t value = 0;
  (void)memcpy(&value, data + offset, sizeof(value));
  return value;
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
  if (XResQueryVersion(display, &major, &minor) != Success) return false;
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
    if (pid != target_pid || client == (XRecordClientSpec)None) continue;
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
  DeliveryState *state = (DeliveryState *)closure;
  if (recorded == NULL) return;
  if (!state->delivered
      && recorded->category == XRecordFromServer
      && !recorded->client_swapped
      && recorded->data != NULL
      && recorded->data_len >= (X_EVENT_BYTES / 4UL)) {
    const unsigned char *event = recorded->data;
    const unsigned char type = (unsigned char)(event[WIRE_EVENT_TYPE_OFFSET] & 0x7fU);
    const unsigned char detail = event[WIRE_DETAIL_OFFSET];
    const Window event_window = (Window)read_u32(event, WIRE_EVENT_WINDOW_OFFSET);
    const int root_x = (int)read_i16(event, WIRE_ROOT_X_OFFSET);
    const int root_y = (int)read_i16(event, WIRE_ROOT_Y_OFFSET);
    // The RECORD context is limited to X11 clients whose local PID equals the Node-owned target
    // process. Also require the delivered event to remain inside the exact target XID subtree and
    // at the admitted root coordinate. Openbox's synchronous passive-grab delivery is therefore
    // not sufficient; only replay/delivery to the target process can satisfy this barrier.
    if (type == ButtonPress && detail == 1U
        && root_x == state->expected_x && root_y == state->expected_y
        && window_descends_from(state->control, state->expected_window, event_window)) {
      state->delivered = true;
    }
  }
  XRecordFreeData(recorded);
}

static void disable_context(DeliveryState *state) {
  if (state->context == 0) return;
  x_error_seen = 0;
  (void)XRecordDisableContext(state->control, state->context);
  XSync(state->control, False);
  XRecordProcessReplies(state->data);
  (void)XRecordFreeContext(state->control, state->context);
  XSync(state->control, False);
  state->context = 0;
  state->expected_window = None;
  state->delivered = false;
}

static bool arm_delivery(DeliveryState *state, Window window, pid_t target_pid, int x, int y) {
  XRecordClientSpec *clients = NULL;
  XRecordRange *range;
  XRecordRange *ranges[1];
  int client_count = 0;
  int major = 0;
  int minor = 0;

  disable_context(state);
  if (!XRecordQueryVersion(state->control, &major, &minor)) return false;
  (void)major;
  (void)minor;
  if (!collect_target_clients(state->control, target_pid, &clients, &client_count)) return false;

  range = XRecordAllocRange();
  if (range == NULL) {
    free(clients);
    return false;
  }
  range->delivered_events.first = ButtonPress;
  range->delivered_events.last = ButtonPress;
  ranges[0] = range;

  x_error_seen = 0;
  state->context = XRecordCreateContext(state->control, 0, clients, client_count, ranges, 1);
  XFree(range);
  free(clients);
  if (state->context == 0) return false;
  XSync(state->control, False);
  if (x_error_seen != 0) {
    state->context = 0;
    return false;
  }

  state->expected_window = window;
  state->expected_x = x;
  state->expected_y = y;
  state->delivered = false;
  x_error_seen = 0;
  if (!XRecordEnableContextAsync(state->data, state->context, record_callback, (XPointer)state)) {
    disable_context(state);
    return false;
  }
  if (x_error_seen != 0) {
    disable_context(state);
    return false;
  }
  return true;
}

static bool wait_for_delivery(DeliveryState *state) {
  const int fd = ConnectionNumber(state->data);
  const int64_t start = monotonic_ms();
  if (fd < 0 || start < 0 || state->context == 0) return false;

  for (;;) {
    struct pollfd descriptor;
    const int64_t now = monotonic_ms();
    int remaining;
    int result;
    if (now < 0) return false;
    XRecordProcessReplies(state->data);
    if (state->delivered) {
      disable_context(state);
      return true;
    }
    if (now - start >= DELIVERY_WAIT_TIMEOUT_MS) {
      disable_context(state);
      return false;
    }
    remaining = (int)(DELIVERY_WAIT_TIMEOUT_MS - (now - start));
    descriptor.fd = fd;
    descriptor.events = POLLIN;
    descriptor.revents = 0;
    do {
      result = poll(&descriptor, 1, remaining);
    } while (result < 0 && errno == EINTR);
    if (result <= 0) {
      disable_context(state);
      return false;
    }
    if ((descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
      disable_context(state);
      return false;
    }
  }
}

static int run_protocol(DeliveryState *state) {
  char line[MAX_LINE_BYTES];
  reply("READY", "1");
  while (fgets(line, sizeof(line), stdin) != NULL) {
    char *tokens[MAX_TOKENS] = {0};
    int count;
    long window;
    long target_pid;
    long x;
    long y;

    if (strchr(line, '\n') == NULL && !feof(stdin)) {
      int ch;
      while ((ch = fgetc(stdin)) != '\n' && ch != EOF) {}
      reply("ERR", "PROTOCOL");
      return 2;
    }
    count = split_tokens(line, tokens, MAX_TOKENS);
    if (count < 1) continue;
    if (count < 0) {
      reply("ERR", "PROTOCOL");
      return 2;
    }

    if (strcmp(tokens[0], "ARM") == 0) {
      if (count != 5 || !parse_long_token(tokens[1], &window) || !parse_long_token(tokens[2], &target_pid)
          || !parse_long_token(tokens[3], &x) || !parse_long_token(tokens[4], &y)
          || window <= 0 || (unsigned long)window > UINT32_MAX || target_pid <= 0 || target_pid > INT_MAX
          || x < INT16_MIN || x > INT16_MAX || y < INT16_MIN || y > INT16_MAX) {
        reply("ERR", "PROTOCOL");
        return 2;
      }
      if (!arm_delivery(state, (Window)(unsigned long)window, (pid_t)target_pid, (int)x, (int)y)) {
        reply("ERR", "RECORD");
        return 3;
      }
      reply("OK", "ARM");
      continue;
    }

    if (strcmp(tokens[0], "WAIT") == 0) {
      if (count != 1 || state->context == 0) {
        reply("ERR", "STATE");
        return 2;
      }
      if (!wait_for_delivery(state)) {
        reply("ERR", "TIMEOUT");
        return 3;
      }
      reply("OK", "PRESS");
      continue;
    }

    if (strcmp(tokens[0], "DISARM") == 0) {
      if (count != 1) {
        reply("ERR", "PROTOCOL");
        return 2;
      }
      disable_context(state);
      reply("OK", "DISARM");
      continue;
    }

    reply("ERR", "PROTOCOL");
    return 2;
  }
  disable_context(state);
  return 0;
}

int main(int argc, char **argv) {
  DeliveryState state = {0};
  int result;
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    (void)printf("mcp-handoff-linux-xrecord-delivery-helper %d\n", PROTOCOL_VERSION);
    return 0;
  }
  if (argc != 1) return 2;
  (void)setvbuf(stdout, NULL, _IOLBF, 0);
  XSetErrorHandler(on_x_error);
  state.control = XOpenDisplay(NULL);
  state.data = XOpenDisplay(NULL);
  if (state.control == NULL || state.data == NULL) {
    if (state.data != NULL) XCloseDisplay(state.data);
    if (state.control != NULL) XCloseDisplay(state.control);
    return 3;
  }
  result = run_protocol(&state);
  disable_context(&state);
  XCloseDisplay(state.data);
  XCloseDisplay(state.control);
  return result;
}
