#include <atspi/atspi.h>

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PROTOCOL_VERSION 1
#define MAX_LINE_BYTES 64
#define MAX_DESKTOP_APPS 128
#define MAX_TOP_LEVEL_CHILDREN 128
#define MAX_NODES 2048
#define MAX_DEPTH 32
#define MAX_REGIONS 32
#define WINDOW_EDGE_TOLERANCE 8
#define MAX_PROCESS_ANCESTRY_DEPTH 32
#define MAX_PROC_STAT_BYTES 4096

typedef struct {
  int x;
  int y;
  int width;
  int height;
} Bounds;

typedef struct {
  int x;
  int y;
  int width;
  int height;
} Region;

typedef struct {
  Region regions[MAX_REGIONS];
  int region_count;
  int focused_count;
  bool focus_editable;
  int visited;
  bool failed;
} Snapshot;

static void clear_error(GError **error) {
  if (error != NULL && *error != NULL) {
    g_error_free(*error);
    *error = NULL;
  }
}

static bool parse_positive_int(const char *raw, int *out) {
  char *end = NULL;
  long value;
  if (raw == NULL || *raw == '\0') return false;
  errno = 0;
  value = strtol(raw, &end, 10);
  if (errno != 0 || end == raw || *end != '\0' || value < 1 || value > INT_MAX) return false;
  *out = (int)value;
  return true;
}

static bool parse_int(const char *raw, int *out) {
  char *end = NULL;
  long value;
  if (raw == NULL || *raw == '\0') return false;
  errno = 0;
  value = strtol(raw, &end, 10);
  if (errno != 0 || end == raw || *end != '\0' || value < INT_MIN || value > INT_MAX) return false;
  *out = (int)value;
  return true;
}

static bool state_has(AtspiAccessible *accessible, AtspiStateType state) {
  GError *error = NULL;
  AtspiStateSet *set = atspi_accessible_get_state_set(accessible);
  bool result = false;
  if (set != NULL) {
    result = atspi_state_set_contains(set, state) != FALSE;
    g_object_unref(set);
  }
  clear_error(&error);
  return result;
}

static bool parent_pid_of(unsigned int pid, unsigned int *parent_pid) {
  char path[64];
  if (snprintf(path, sizeof(path), "/proc/%u/stat", pid) < 0) return false;
  FILE *file = fopen(path, "r");
  if (file == NULL) return false;
  char buffer[MAX_PROC_STAT_BYTES];
  const bool read_ok = fgets(buffer, sizeof(buffer), file) != NULL;
  const bool complete = read_ok && strchr(buffer, '\n') != NULL;
  (void)fclose(file);
  if (!complete) return false;
  char *close = strrchr(buffer, ')');
  if (close == NULL || close[1] != ' ') return false;
  char state = '\0';
  unsigned int parsed_parent = 0;
  if (sscanf(close + 2, "%c %u", &state, &parsed_parent) != 2 || state == '\0') return false;
  *parent_pid = parsed_parent;
  return true;
}

static bool process_is_target_or_descendant(unsigned int pid, int target_pid) {
  if (pid == 0 || target_pid <= 0) return false;
  const unsigned int target = (unsigned int)target_pid;
  unsigned int current = pid;
  for (int depth = 0; depth < MAX_PROCESS_ANCESTRY_DEPTH; depth++) {
    if (current == target) return true;
    if (current <= 1) return false;
    unsigned int parent = 0;
    if (!parent_pid_of(current, &parent) || parent == 0 || parent == current) return false;
    current = parent;
  }
  return false;
}

static bool process_id_is_bounded(AtspiAccessible *accessible, int target_pid) {
  GError *error = NULL;
  guint pid = atspi_accessible_get_process_id(accessible, &error);
  const bool result = error == NULL && process_is_target_or_descendant(pid, target_pid);
  clear_error(&error);
  return result;
}

static int child_count_bounded(AtspiAccessible *accessible, int limit, bool *ok) {
  GError *error = NULL;
  gint count = atspi_accessible_get_child_count(accessible, &error);
  if (error != NULL || count < 0 || count > limit) {
    clear_error(&error);
    *ok = false;
    return 0;
  }
  clear_error(&error);
  return count;
}

static AtspiAccessible *child_at(AtspiAccessible *accessible, int index, bool *ok) {
  GError *error = NULL;
  AtspiAccessible *child = atspi_accessible_get_child_at_index(accessible, index, &error);
  if (error != NULL || child == NULL) {
    clear_error(&error);
    *ok = false;
    return NULL;
  }
  clear_error(&error);
  return child;
}

static bool component_bounds(AtspiAccessible *accessible, Bounds *bounds) {
  GError *error = NULL;
  AtspiComponent *component = atspi_accessible_get_component_iface(accessible);
  if (component == NULL) return false;
  AtspiRect *rect = atspi_component_get_extents(component, ATSPI_COORD_TYPE_SCREEN, &error);
  g_object_unref(component);
  if (error != NULL || rect == NULL) {
    clear_error(&error);
    if (rect != NULL) g_free(rect);
    return false;
  }
  bounds->x = rect->x;
  bounds->y = rect->y;
  bounds->width = rect->width;
  bounds->height = rect->height;
  g_free(rect);
  clear_error(&error);
  return bounds->width > 0 && bounds->height > 0;
}

static bool close_to_target(const Bounds *candidate, const Bounds *target) {
  const int64_t candidate_right = (int64_t)candidate->x + candidate->width;
  const int64_t candidate_bottom = (int64_t)candidate->y + candidate->height;
  const int64_t target_right = (int64_t)target->x + target->width;
  const int64_t target_bottom = (int64_t)target->y + target->height;
  return llabs((long long)candidate->x - target->x) <= WINDOW_EDGE_TOLERANCE
      && llabs((long long)candidate->y - target->y) <= WINDOW_EDGE_TOLERANCE
      && llabs((long long)candidate_right - target_right) <= WINDOW_EDGE_TOLERANCE
      && llabs((long long)candidate_bottom - target_bottom) <= WINDOW_EDGE_TOLERANCE;
}

static AtspiAccessible *find_target_application(AtspiAccessible *desktop, int target_pid) {
  bool ok = true;
  const int count = child_count_bounded(desktop, MAX_DESKTOP_APPS, &ok);
  if (!ok) return NULL;
  AtspiAccessible *match = NULL;
  for (int i = 0; i < count; i++) {
    AtspiAccessible *child = child_at(desktop, i, &ok);
    if (!ok) {
      if (match != NULL) g_object_unref(match);
      return NULL;
    }
    if (process_id_is_bounded(child, target_pid)) {
      if (match != NULL) {
        g_object_unref(match);
        g_object_unref(child);
        return NULL;
      }
      match = child;
    } else {
      g_object_unref(child);
    }
  }
  return match;
}

static AtspiAccessible *find_exact_top_level(AtspiAccessible *application, int target_pid, const Bounds *target) {
  bool ok = true;
  const int count = child_count_bounded(application, MAX_TOP_LEVEL_CHILDREN, &ok);
  if (!ok) return NULL;
  AtspiAccessible *match = NULL;
  for (int i = 0; i < count; i++) {
    AtspiAccessible *child = child_at(application, i, &ok);
    if (!ok) {
      if (match != NULL) g_object_unref(match);
      return NULL;
    }
    Bounds bounds;
    const bool candidate = process_id_is_bounded(child, target_pid)
      && state_has(child, ATSPI_STATE_VISIBLE)
      && state_has(child, ATSPI_STATE_SHOWING)
      && component_bounds(child, &bounds)
      && close_to_target(&bounds, target);
    if (candidate) {
      if (match != NULL) {
        g_object_unref(match);
        g_object_unref(child);
        return NULL;
      }
      match = child;
    } else {
      g_object_unref(child);
    }
  }
  return match;
}

static AtspiRole role_of(AtspiAccessible *accessible, bool *ok) {
  GError *error = NULL;
  AtspiRole role = atspi_accessible_get_role(accessible, &error);
  if (error != NULL) {
    clear_error(&error);
    *ok = false;
    return ATSPI_ROLE_INVALID;
  }
  clear_error(&error);
  return role;
}

static void find_web_document_at_depth(
  AtspiAccessible *accessible,
  int depth,
  int wanted_depth,
  int *visited,
  AtspiAccessible **match,
  int *matches,
  bool *ok
) {
  if (!*ok || *visited >= MAX_NODES || depth > wanted_depth || *matches > 1) return;
  (*visited)++;
  if (depth == wanted_depth) {
    if (role_of(accessible, ok) == ATSPI_ROLE_DOCUMENT_WEB
        && state_has(accessible, ATSPI_STATE_VISIBLE)
        && state_has(accessible, ATSPI_STATE_SHOWING)) {
      (*matches)++;
      if (*matches == 1) *match = g_object_ref(accessible);
    }
    return;
  }
  const int count = child_count_bounded(accessible, MAX_TOP_LEVEL_CHILDREN, ok);
  if (!*ok) return;
  for (int i = 0; i < count && *ok && *matches <= 1; i++) {
    AtspiAccessible *child = child_at(accessible, i, ok);
    if (!*ok || child == NULL) return;
    find_web_document_at_depth(child, depth + 1, wanted_depth, visited, match, matches, ok);
    g_object_unref(child);
  }
}

static AtspiAccessible *find_unique_nearest_web_document(AtspiAccessible *root) {
  for (int depth = 0; depth <= MAX_DEPTH; depth++) {
    int visited = 0;
    int matches = 0;
    bool ok = true;
    AtspiAccessible *match = NULL;
    find_web_document_at_depth(root, 0, depth, &visited, &match, &matches, &ok);
    if (!ok || matches > 1) {
      if (match != NULL) g_object_unref(match);
      return NULL;
    }
    if (matches == 1) return match;
  }
  return NULL;
}

static int clamp_normalized(int64_t numerator, int denominator) {
  if (denominator <= 0) return 0;
  if (numerator <= 0) return 0;
  if (numerator >= denominator) return 10000;
  const int64_t scaled = numerator * 10000 / denominator;
  if (scaled < 0) return 0;
  if (scaled > 10000) return 10000;
  return (int)scaled;
}

static bool same_region(const Region *left, const Region *right) {
  return left->x == right->x && left->y == right->y
      && left->width == right->width && left->height == right->height;
}

static void add_region(Snapshot *snapshot, const Bounds *element, const Bounds *target) {
  const int64_t left = element->x > target->x ? element->x : target->x;
  const int64_t top = element->y > target->y ? element->y : target->y;
  const int64_t element_right = (int64_t)element->x + element->width;
  const int64_t element_bottom = (int64_t)element->y + element->height;
  const int64_t target_right = (int64_t)target->x + target->width;
  const int64_t target_bottom = (int64_t)target->y + target->height;
  const int64_t right = element_right < target_right ? element_right : target_right;
  const int64_t bottom = element_bottom < target_bottom ? element_bottom : target_bottom;
  if (right - left < 2 || bottom - top < 2 || snapshot->region_count >= MAX_REGIONS) return;

  Region region;
  region.x = clamp_normalized(left - target->x, target->width);
  region.y = clamp_normalized(top - target->y, target->height);
  const int max_x = clamp_normalized(right - target->x, target->width);
  const int max_y = clamp_normalized(bottom - target->y, target->height);
  region.width = max_x - region.x;
  region.height = max_y - region.y;
  if (region.width < 1) region.width = 1;
  if (region.height < 1) region.height = 1;
  if (region.x + region.width > 10000) region.width = 10000 - region.x;
  if (region.y + region.height > 10000) region.height = 10000 - region.y;
  if (region.width < 1 || region.height < 1) return;
  for (int i = 0; i < snapshot->region_count; i++) {
    if (same_region(&snapshot->regions[i], &region)) return;
  }
  snapshot->regions[snapshot->region_count++] = region;
}

static void walk_document(AtspiAccessible *accessible, int depth, const Bounds *target, Snapshot *snapshot) {
  if (snapshot->failed || snapshot->visited >= MAX_NODES || depth > MAX_DEPTH) return;
  snapshot->visited++;
  AtspiStateSet *states = atspi_accessible_get_state_set(accessible);
  if (states == NULL) {
    snapshot->failed = true;
    return;
  }
  const bool visible = atspi_state_set_contains(states, ATSPI_STATE_VISIBLE) != FALSE;
  const bool showing = atspi_state_set_contains(states, ATSPI_STATE_SHOWING) != FALSE;
  const bool editable = atspi_state_set_contains(states, ATSPI_STATE_EDITABLE) != FALSE;
  const bool focused = atspi_state_set_contains(states, ATSPI_STATE_FOCUSED) != FALSE;
  g_object_unref(states);

  if (focused) {
    snapshot->focused_count++;
    if (snapshot->focused_count == 1) snapshot->focus_editable = editable;
    else snapshot->failed = true;
  }
  if (visible && showing && editable && snapshot->region_count < MAX_REGIONS) {
    Bounds bounds;
    if (component_bounds(accessible, &bounds)) add_region(snapshot, &bounds, target);
  }

  if (snapshot->failed || snapshot->visited >= MAX_NODES || depth >= MAX_DEPTH) return;
  bool ok = true;
  const int count = child_count_bounded(accessible, MAX_TOP_LEVEL_CHILDREN, &ok);
  if (!ok) {
    snapshot->failed = true;
    return;
  }
  for (int i = 0; i < count && !snapshot->failed && snapshot->visited < MAX_NODES; i++) {
    AtspiAccessible *child = child_at(accessible, i, &ok);
    if (!ok || child == NULL) {
      snapshot->failed = true;
      return;
    }
    walk_document(child, depth + 1, target, snapshot);
    g_object_unref(child);
  }
}

static bool collect_snapshot(int target_pid, const Bounds *target, Snapshot *snapshot) {
  memset(snapshot, 0, sizeof(*snapshot));
  AtspiAccessible *desktop = atspi_get_desktop(0);
  if (desktop == NULL) return false;
  AtspiAccessible *application = find_target_application(desktop, target_pid);
  g_object_unref(desktop);
  if (application == NULL) return false;
  AtspiAccessible *top_level = find_exact_top_level(application, target_pid, target);
  g_object_unref(application);
  if (top_level == NULL) return false;
  AtspiAccessible *document = find_unique_nearest_web_document(top_level);
  g_object_unref(top_level);
  if (document == NULL) return false;
  walk_document(document, 0, target, snapshot);
  g_object_unref(document);
  if (snapshot->failed || snapshot->visited >= MAX_NODES) return false;
  return true;
}

static void reply_snapshot(const Snapshot *snapshot) {
  (void)fprintf(stdout, "OK focus=%d regions=", snapshot->focused_count == 1 && snapshot->focus_editable ? 1 : 0);
  for (int i = 0; i < snapshot->region_count; i++) {
    const Region *region = &snapshot->regions[i];
    if (i != 0) (void)fputc(';', stdout);
    (void)fprintf(stdout, "%d,%d,%d,%d", region->x, region->y, region->width, region->height);
  }
  (void)fputc('\n', stdout);
  (void)fflush(stdout);
}

static void usage(void) {
  (void)fprintf(stderr, "usage: mcp-handoff-linux-atspi-helper --pid PID --x X --y Y --width W --height H\n");
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    (void)printf("mcp-handoff-linux-atspi-helper %d\n", PROTOCOL_VERSION);
    return 0;
  }

  int target_pid = 0;
  Bounds target = {0};
  bool have_pid = false, have_x = false, have_y = false, have_width = false, have_height = false;
  for (int i = 1; i + 1 < argc; i += 2) {
    if (strcmp(argv[i], "--pid") == 0) have_pid = parse_positive_int(argv[i + 1], &target_pid);
    else if (strcmp(argv[i], "--x") == 0) have_x = parse_int(argv[i + 1], &target.x);
    else if (strcmp(argv[i], "--y") == 0) have_y = parse_int(argv[i + 1], &target.y);
    else if (strcmp(argv[i], "--width") == 0) have_width = parse_positive_int(argv[i + 1], &target.width);
    else if (strcmp(argv[i], "--height") == 0) have_height = parse_positive_int(argv[i + 1], &target.height);
    else { usage(); return 2; }
  }
  if (argc != 11 || !have_pid || !have_x || !have_y || !have_width || !have_height) {
    usage();
    return 2;
  }

  if (atspi_init() != 0) return 3;
  (void)printf("READY %d\n", PROTOCOL_VERSION);
  (void)fflush(stdout);

  char line[MAX_LINE_BYTES];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    if (strchr(line, '\n') == NULL && !feof(stdin)) return 4;
    if (strcmp(line, "snapshot\n") != 0 && strcmp(line, "snapshot") != 0) {
      (void)printf("ERR\n");
      (void)fflush(stdout);
      continue;
    }
    Snapshot snapshot;
    if (!collect_snapshot(target_pid, &target, &snapshot)) {
      (void)printf("NO\n");
      (void)fflush(stdout);
      continue;
    }
    reply_snapshot(&snapshot);
  }
  (void)atspi_exit();
  return 0;
}
