#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PROTOCOL_VERSION 2
#define MAX_LINE_BYTES 256
#define MAX_TOKENS 5

typedef enum {
  HELD_KEY_NONE = 0,
  HELD_KEY_RETURN = 1,
  HELD_KEY_BACKSPACE = 2
} HeldKey;

typedef struct {
  Display *display;
  int screen;
  int width;
  int height;
  bool primary_pressed;
  bool pointer_position_known;
  int pointer_x;
  int pointer_y;
  int cleanup_x;
  int cleanup_y;
  HeldKey held_key;
  KeyCode return_keycode;
  KeyCode backspace_keycode;
} InputState;

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

static bool sync_display(InputState *state) {
  XSync(state->display, False);
  return x_error_seen == 0;
}

static bool coordinate_in_bounds(const InputState *state, long value, bool horizontal) {
  const int limit = horizontal ? state->width : state->height;
  return value >= 0 && value < limit && value <= INT_MAX;
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

static bool cleanup_pressed_button(InputState *state);
static bool cleanup_pressed_key(InputState *state);

static bool query_pointer_state(InputState *state, int *root_x, int *root_y, unsigned int *mask) {
  Window root_return = None;
  Window child_return = None;
  int window_x = 0;
  int window_y = 0;
  unsigned int observed_mask = 0;
  int observed_root_x = 0;
  int observed_root_y = 0;
  const Window root = RootWindow(state->display, state->screen);
  if (!XQueryPointer(
      state->display, root, &root_return, &child_return,
      &observed_root_x, &observed_root_y, &window_x, &window_y, &observed_mask)) {
    return false;
  }
  if (root_return != root) return false;
  *root_x = observed_root_x;
  *root_y = observed_root_y;
  *mask = observed_mask;
  return true;
}

static bool pointer_at(InputState *state, int x, int y) {
  int root_x = 0;
  int root_y = 0;
  unsigned int mask = 0;
  return query_pointer_state(state, &root_x, &root_y, &mask) && root_x == x && root_y == y;
}

static bool primary_button_state(InputState *state, bool pressed) {
  int root_x = 0;
  int root_y = 0;
  unsigned int mask = 0;
  if (!query_pointer_state(state, &root_x, &root_y, &mask)) return false;
  return ((mask & Button1Mask) != 0U) == pressed;
}

static bool key_state(InputState *state, KeyCode keycode, bool pressed) {
  char keys[32] = {0};
  const unsigned int code = (unsigned int)keycode;
  if (code == 0U || code >= 256U) return false;
  XQueryKeymap(state->display, keys);
  return ((((unsigned char)keys[code / 8U]) & (1U << (code % 8U))) != 0U) == pressed;
}

static KeyCode keycode_for(const InputState *state, HeldKey key) {
  if (key == HELD_KEY_RETURN) return state->return_keycode;
  if (key == HELD_KEY_BACKSPACE) return state->backspace_keycode;
  return 0;
}

static HeldKey parse_key_name(const char *name) {
  if (name != NULL && strcmp(name, "RETURN") == 0) return HELD_KEY_RETURN;
  if (name != NULL && strcmp(name, "BACKSPACE") == 0) return HELD_KEY_BACKSPACE;
  return HELD_KEY_NONE;
}

static bool inject_move(InputState *state, int x, int y) {
  x_error_seen = 0;
  state->pointer_position_known = false;
  if (!XTestFakeMotionEvent(state->display, state->screen, x, y, CurrentTime)) return false;
  if (!sync_display(state) || !pointer_at(state, x, y)) return false;
  state->pointer_x = x;
  state->pointer_y = y;
  state->pointer_position_known = true;
  return true;
}

static bool inject_button_down(InputState *state) {
  if (!state->pointer_position_known) return false;
  x_error_seen = 0;
  if (!XTestFakeButtonEvent(state->display, 1, True, CurrentTime)) return false;
  // Once the press request has been accepted by Xlib, cleanup must assume Button1 may be held even
  // if the following XSync reports a protocol error. This keeps EOF/error teardown conservative.
  state->primary_pressed = true;
  if (sync_display(state)
      && primary_button_state(state, true)
      && pointer_at(state, state->pointer_x, state->pointer_y)) return true;
  (void)cleanup_pressed_button(state);
  return false;
}

static bool inject_button_up(InputState *state) {
  x_error_seen = 0;
  if (!XTestFakeButtonEvent(state->display, 1, False, CurrentTime)) return false;
  if (!sync_display(state) || !primary_button_state(state, false)) return false;
  state->primary_pressed = false;
  return true;
}

static bool cleanup_pressed_button(InputState *state) {
  bool ok = true;
  if (!state->primary_pressed) return true;
  x_error_seen = 0;
  if (!XTestFakeMotionEvent(state->display, state->screen, state->cleanup_x, state->cleanup_y, CurrentTime)) ok = false;
  if (!XTestFakeButtonEvent(state->display, 1, False, CurrentTime)) ok = false;
  if (!sync_display(state)) ok = false;
  if (!primary_button_state(state, false)) ok = false;
  state->primary_pressed = false;
  return ok;
}

static bool inject_key_down(InputState *state, HeldKey key) {
  const KeyCode keycode = keycode_for(state, key);
  if (key == HELD_KEY_NONE || keycode == 0 || state->held_key != HELD_KEY_NONE) return false;
  // Never take ownership of a key already held by another local input source. In particular, do
  // not emulate xdotool --clearmodifiers or release any modifier/key state the helper did not set.
  if (!key_state(state, keycode, false)) return false;
  x_error_seen = 0;
  if (!XTestFakeKeyEvent(state->display, keycode, True, CurrentTime)) return false;
  // As with Button1, once Xlib accepts the request cleanup conservatively owns this exact key until
  // a verified release, even if the following XSync reports an error.
  state->held_key = key;
  if (sync_display(state) && key_state(state, keycode, true)) return true;
  (void)cleanup_pressed_key(state);
  return false;
}

static bool inject_key_up(InputState *state, HeldKey key) {
  const KeyCode keycode = keycode_for(state, key);
  if (key == HELD_KEY_NONE || keycode == 0 || state->held_key != key) return false;
  x_error_seen = 0;
  if (!XTestFakeKeyEvent(state->display, keycode, False, CurrentTime)) return false;
  if (!sync_display(state) || !key_state(state, keycode, false)) return false;
  state->held_key = HELD_KEY_NONE;
  return true;
}

static bool cleanup_pressed_key(InputState *state) {
  const HeldKey key = state->held_key;
  const KeyCode keycode = keycode_for(state, key);
  bool ok = true;
  if (key == HELD_KEY_NONE) return true;
  x_error_seen = 0;
  if (keycode == 0 || !XTestFakeKeyEvent(state->display, keycode, False, CurrentTime)) ok = false;
  if (!sync_display(state)) ok = false;
  if (keycode != 0 && !key_state(state, keycode, false)) ok = false;
  state->held_key = HELD_KEY_NONE;
  return ok;
}

static bool cleanup_all(InputState *state) {
  const bool key_ok = cleanup_pressed_key(state);
  const bool pointer_ok = cleanup_pressed_button(state);
  return key_ok && pointer_ok;
}

static bool validate_primary_mapping(Display *display) {
  unsigned char mapping[32];
  const int count = XGetPointerMapping(display, mapping, (int)sizeof(mapping));
  return count >= 1 && mapping[0] == 1;
}

static int run_protocol(InputState *state) {
  char line[MAX_LINE_BYTES];

  reply("READY", "2");
  while (fgets(line, sizeof(line), stdin) != NULL) {
    char *tokens[MAX_TOKENS] = {0};
    int count;
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

    if (strcmp(tokens[0], "MOVE") == 0) {
      if (count != 3 || !parse_long_token(tokens[1], &x) || !parse_long_token(tokens[2], &y)
          || !coordinate_in_bounds(state, x, true) || !coordinate_in_bounds(state, y, false)) {
        reply("ERR", "PROTOCOL");
        return 2;
      }
      if (!inject_move(state, (int)x, (int)y)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "MOVE");
      continue;
    }

    if (strcmp(tokens[0], "DOWN") == 0) {
      if (count != 4 || strcmp(tokens[1], "1") != 0 || state->primary_pressed
          || !parse_long_token(tokens[2], &x) || !parse_long_token(tokens[3], &y)
          || !coordinate_in_bounds(state, x, true) || !coordinate_in_bounds(state, y, false)) {
        reply("ERR", state->primary_pressed ? "STATE" : "PROTOCOL");
        return 2;
      }
      state->cleanup_x = (int)x;
      state->cleanup_y = (int)y;
      if (!inject_button_down(state)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "DOWN");
      continue;
    }

    if (strcmp(tokens[0], "UP") == 0) {
      if (count != 2 || strcmp(tokens[1], "1") != 0 || !state->primary_pressed) {
        reply("ERR", state->primary_pressed ? "PROTOCOL" : "STATE");
        return 2;
      }
      if (!inject_button_up(state)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "UP");
      continue;
    }

    if (strcmp(tokens[0], "CANCEL") == 0) {
      if (count != 2 || strcmp(tokens[1], "1") != 0) {
        reply("ERR", "PROTOCOL");
        return 2;
      }
      if (!cleanup_pressed_button(state)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "CANCEL");
      continue;
    }

    if (strcmp(tokens[0], "KEYDOWN") == 0) {
      const HeldKey key = count == 2 ? parse_key_name(tokens[1]) : HELD_KEY_NONE;
      if (count != 2 || key == HELD_KEY_NONE || state->held_key != HELD_KEY_NONE) {
        reply("ERR", state->held_key != HELD_KEY_NONE ? "STATE" : "PROTOCOL");
        return 2;
      }
      if (!inject_key_down(state, key)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "KEYDOWN");
      continue;
    }

    if (strcmp(tokens[0], "KEYUP") == 0) {
      const HeldKey key = count == 2 ? parse_key_name(tokens[1]) : HELD_KEY_NONE;
      if (count != 2 || key == HELD_KEY_NONE || state->held_key != key) {
        reply("ERR", state->held_key == HELD_KEY_NONE ? "STATE" : "PROTOCOL");
        return 2;
      }
      if (!inject_key_up(state, key)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "KEYUP");
      continue;
    }

    if (strcmp(tokens[0], "CANCELKEY") == 0) {
      if (count != 1) {
        reply("ERR", "PROTOCOL");
        return 2;
      }
      if (!cleanup_pressed_key(state)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "CANCELKEY");
      continue;
    }

    if (strcmp(tokens[0], "CLOSE") == 0) {
      if (count != 1) {
        reply("ERR", "PROTOCOL");
        return 2;
      }
      if (!cleanup_all(state)) {
        reply("ERR", "XTEST");
        return 3;
      }
      reply("OK", "CLOSE");
      return 0;
    }

    reply("ERR", "PROTOCOL");
    return 2;
  }

  return cleanup_all(state) ? 0 : 3;
}

int main(int argc, char **argv) {
  InputState state = {0};
  int event_base = 0;
  int error_base = 0;
  int major = 0;
  int minor = 0;
  int result;

  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    (void)printf("mcp-handoff-linux-xtest-helper %d\n", PROTOCOL_VERSION);
    return 0;
  }
  if (argc != 1) return 2;

  (void)setvbuf(stdout, NULL, _IOLBF, 0);
  XSetErrorHandler(on_x_error);
  state.display = XOpenDisplay(NULL);
  if (state.display == NULL) return 3;
  state.screen = DefaultScreen(state.display);
  state.width = DisplayWidth(state.display, state.screen);
  state.height = DisplayHeight(state.display, state.screen);
  state.return_keycode = XKeysymToKeycode(state.display, XK_Return);
  state.backspace_keycode = XKeysymToKeycode(state.display, XK_BackSpace);
  if (state.width < 2 || state.height < 2
      || state.return_keycode == 0 || state.backspace_keycode == 0
      || !XTestQueryExtension(state.display, &event_base, &error_base, &major, &minor)
      || !validate_primary_mapping(state.display)) {
    XCloseDisplay(state.display);
    return 3;
  }

  result = run_protocol(&state);
  (void)cleanup_all(&state);
  XCloseDisplay(state.display);
  return result;
}