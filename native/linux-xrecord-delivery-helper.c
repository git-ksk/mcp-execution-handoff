#include <X11/X.h>
#include <X11/Xlib.h>
#include <X11/extensions/record.h>

#include <errno.h>
#include <poll.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define PROTOCOL_VERSION 1
#define MAX_LINE_BYTES 192
#define MAX_TOKENS 5
#define DELIVERY_WAIT_TIMEOUT_MS 1000
#define X_EVENT_BYTES 32

#define WIRE_EVENT_TYPE_OFFSET 0
#define WIRE_DETAIL_OFFSET 1
#define WIRE_ROOT_X_OFFSET 20
#define WIRE_ROOT_Y_OFFSET 22

typedef struct {
  Display *control;
  Display *data;
  XRecordContext context;
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

static int16_t read_i16(const unsigned char *data, size_t offset) {
  int16_t value = 0;
  (void)memcpy(&value, data + offset, sizeof(value));
  return value;
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
    const int root_x = (int)read_i16(event, WIRE_ROOT_X_OFFSET);
    const int root_y = (int)read_i16(event, WIRE_ROOT_Y_OFFSET);
    // XRecordClientSpec is the exact target XID resource, so this context already scopes
    // delivered events to the client that created that resource. The event field itself may name
    // a descendant/input child; do not incorrectly require it to equal the top-level exact XID.
    if (type == ButtonPress && detail == 1U
        && root_x == state->expected_x && root_y == state->expected_y) {
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
  state->delivered = false;
}

static bool arm_delivery(DeliveryState *state, Window window, int x, int y) {
  XRecordClientSpec client;
  XRecordRange *range;
  XRecordRange *ranges[1];
  int major = 0;
  int minor = 0;

  disable_context(state);
  if (!XRecordQueryVersion(state->control, &major, &minor)) return false;
  (void)major;
  (void)minor;

  range = XRecordAllocRange();
  if (range == NULL) return false;
  range->delivered_events.first = ButtonPress;
  range->delivered_events.last = ButtonPress;
  ranges[0] = range;
  client = (XRecordClientSpec)window;

  x_error_seen = 0;
  state->context = XRecordCreateContext(state->control, 0, &client, 1, ranges, 1);
  XFree(range);
  if (state->context == 0) return false;
  XSync(state->control, False);
  if (x_error_seen != 0) {
    state->context = 0;
    return false;
  }

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
      if (count != 4 || !parse_long_token(tokens[1], &window) || !parse_long_token(tokens[2], &x)
          || !parse_long_token(tokens[3], &y) || window <= 0 || (unsigned long)window > UINT32_MAX
          || x < INT16_MIN || x > INT16_MAX || y < INT16_MIN || y > INT16_MAX) {
        reply("ERR", "PROTOCOL");
        return 2;
      }
      if (!arm_delivery(state, (Window)(unsigned long)window, (int)x, (int)y)) {
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
