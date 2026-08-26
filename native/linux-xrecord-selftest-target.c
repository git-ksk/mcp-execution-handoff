#include <X11/Xlib.h>

#include <stdio.h>
#include <stdlib.h>

int main(void) {
  Display *display = XOpenDisplay(NULL);
  Window root;
  Window window;
  XEvent event;

  if (display == NULL) return 2;
  root = DefaultRootWindow(display);
  window = XCreateSimpleWindow(display, root, 100, 100, 400, 300, 0, 0, 0);
  if (window == None) {
    XCloseDisplay(display);
    return 3;
  }
  XSelectInput(display, window, ButtonPressMask | ButtonReleaseMask | StructureNotifyMask);
  XMapWindow(display, window);
  XSync(display, False);
  (void)printf("READY %lu\n", (unsigned long)window);
  (void)fflush(stdout);

  for (;;) {
    XNextEvent(display, &event);
    if (event.type == ButtonPress && event.xbutton.button == Button1) {
      (void)printf("PRESS\n");
      (void)fflush(stdout);
    } else if (event.type == ButtonRelease && event.xbutton.button == Button1) {
      (void)printf("RELEASE\n");
      (void)fflush(stdout);
      break;
    }
  }

  XDestroyWindow(display, window);
  XCloseDisplay(display);
  return 0;
}
