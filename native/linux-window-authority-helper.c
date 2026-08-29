#include <X11/Xatom.h>
#include <X11/Xlib.h>

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PROTOCOL_VERSION 1
#define MIN_WINDOW_WIDTH 160
#define MIN_WINDOW_HEIGHT 120

static int x_error_seen = 0;

static int on_x_error(Display *display, XErrorEvent *event) {
  (void)display;
  (void)event;
  x_error_seen = 1;
  return 0;
}

static bool parse_positive(const char *value, unsigned long *out) {
  char *end = NULL;
  unsigned long parsed;
  if (value == NULL || *value == '\0') return false;
  errno = 0;
  parsed = strtoul(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed == 0UL) return false;
  *out = parsed;
  return true;
}

static bool query_owner(Display *display, Window window, Atom pid_atom, unsigned long expected_pid) {
  Atom actual_type = None;
  int actual_format = 0;
  unsigned long count = 0;
  unsigned long bytes_after = 0;
  unsigned char *data = NULL;
  int status;
  x_error_seen = 0;
  status = XGetWindowProperty(
    display, window, pid_atom, 0L, 1L, False, XA_CARDINAL,
    &actual_type, &actual_format, &count, &bytes_after, &data
  );
  XSync(display, False);
  if (status != Success || x_error_seen || actual_type != XA_CARDINAL || actual_format != 32 || count != 1 || data == NULL) {
    if (data != NULL) XFree(data);
    return false;
  }
  const unsigned long observed = *((unsigned long *)data);
  XFree(data);
  return observed == expected_pid;
}

static const char *validate(Display *display, Window window, unsigned long expected_pid, Atom pid_atom) {
  XWindowAttributes attributes;
  Window child = None;
  int root_x = 0;
  int root_y = 0;
  x_error_seen = 0;
  if (!XGetWindowAttributes(display, window, &attributes)) return "VISIBILITY";
  XSync(display, False);
  if (x_error_seen || attributes.map_state != IsViewable) return "VISIBILITY";
  if (!query_owner(display, window, pid_atom, expected_pid)) return "OWNER";
  x_error_seen = 0;
  if (!XTranslateCoordinates(
        display, window, RootWindow(display, DefaultScreen(display)),
        0, 0, &root_x, &root_y, &child)) return "GEOMETRY";
  XSync(display, False);
  if (x_error_seen || attributes.width < MIN_WINDOW_WIDTH || attributes.height < MIN_WINDOW_HEIGHT) return "GEOMETRY";
  (void)root_x;
  (void)root_y;
  return NULL;
}

int main(int argc, char **argv) {
  unsigned long expected_pid = 0;
  unsigned long window_value = 0;
  Display *display;
  Atom pid_atom;
  char line[64];

  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    (void)printf("mcp-handoff-linux-window-authority-helper %d\n", PROTOCOL_VERSION);
    return 0;
  }
  if (argc != 5 || strcmp(argv[1], "--pid") != 0 || strcmp(argv[3], "--window") != 0
      || !parse_positive(argv[2], &expected_pid) || !parse_positive(argv[4], &window_value)) return 2;

  (void)setvbuf(stdout, NULL, _IOLBF, 0);
  XSetErrorHandler(on_x_error);
  display = XOpenDisplay(NULL);
  if (display == NULL) return 3;
  pid_atom = XInternAtom(display, "_NET_WM_PID", True);
  if (pid_atom == None) {
    XCloseDisplay(display);
    return 3;
  }

  (void)printf("READY %d\n", PROTOCOL_VERSION);
  while (fgets(line, sizeof(line), stdin) != NULL) {
    if (strcmp(line, "QUERY\n") == 0 || strcmp(line, "QUERY\r\n") == 0) {
      const char *failure = validate(display, (Window)window_value, expected_pid, pid_atom);
      if (failure == NULL) (void)puts("OK");
      else (void)printf("ERR %s\n", failure);
      continue;
    }
    if (strcmp(line, "CLOSE\n") == 0 || strcmp(line, "CLOSE\r\n") == 0) {
      (void)puts("OK CLOSE");
      XCloseDisplay(display);
      return 0;
    }
    (void)puts("ERR PROTOCOL");
    XCloseDisplay(display);
    return 2;
  }
  XCloseDisplay(display);
  return 0;
}
