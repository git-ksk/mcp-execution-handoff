#include <X11/Xlib.h>

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#define MAX_POINTER_DEPTH 16

int main(int argc, char **argv) {
  Display *display;
  Window current;
  Window root_return = None;
  Window child_return = None;
  int root_x = 0;
  int root_y = 0;
  int win_x = 0;
  int win_y = 0;
  unsigned int mask = 0;
  int depth = 0;

  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    (void)puts("mcp-handoff-linux-x11-pointer-query 1");
    return 0;
  }
  if (argc != 1) return 2;

  display = XOpenDisplay(NULL);
  if (display == NULL) return 3;
  current = RootWindow(display, DefaultScreen(display));

  (void)printf("CHAIN=%lu", (unsigned long)current);
  for (depth = 0; depth < MAX_POINTER_DEPTH; depth += 1) {
    if (!XQueryPointer(
          display,
          current,
          &root_return,
          &child_return,
          &root_x,
          &root_y,
          &win_x,
          &win_y,
          &mask)) {
      XCloseDisplay(display);
      return 3;
    }
    if (child_return == None || child_return == current) break;
    current = child_return;
    (void)printf(",%lu", (unsigned long)current);
  }
  (void)printf(" ROOT_X=%d ROOT_Y=%d MASK=%u\n", root_x, root_y, mask);
  (void)fflush(stdout);
  XCloseDisplay(display);
  return 0;
}
