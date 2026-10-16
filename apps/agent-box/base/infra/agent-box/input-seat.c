/* Keep a headless seat's keyboard and pointer capabilities without input.
 * Short-lived Cua devices otherwise make Chromium lose wl_keyboard/wl_pointer.
 * This process owns only the protocol object; Cua remains the input actuator. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include "virtual-keyboard-client-protocol.h"
#include "virtual-pointer-client-protocol.h"

static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *manager;
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
static int seat_is_owned;
static void capabilities(void *data, struct wl_seat *value, uint32_t caps) {
    (void)data; (void)value; (void)caps;
}
static void seat_name(void *data, struct wl_seat *value, const char *name) {
    (void)data; (void)value;
    seat_is_owned = strcmp(name, "seat0") == 0;
}
static const struct wl_seat_listener seat_listener = {capabilities, seat_name};
static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
    (void)data;
    if (!seat && strcmp(interface, "wl_seat") == 0 && version >= 2) {
        seat = wl_registry_bind(registry, name, &wl_seat_interface, 2);
        wl_seat_add_listener(seat, &seat_listener, NULL);
    } else if (!manager && strcmp(interface, "zwp_virtual_keyboard_manager_v1") == 0) {
        manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
    } else if (!pointer_manager && strcmp(interface, "zwlr_virtual_pointer_manager_v1") == 0) {
        pointer_manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, 1);
    }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data; (void)registry; (void)name;
}
static const struct wl_registry_listener registry_listener = {global, removed};
static const char keymap[] =
    "xkb_keymap {\n"
    " xkb_keycodes { include \"evdev+aliases(qwerty)\" };\n"
    " xkb_types { include \"complete\" };\n"
    " xkb_compatibility { include \"complete\" };\n"
    " xkb_symbols { include \"pc+us+inet(evdev)\" };\n"
    "};\n";

int main(void) {
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) { fputs("input seat: cannot connect to owned display\n", stderr); return 1; }
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || wl_display_roundtrip(display) < 0 ||
        !seat || !seat_is_owned || !manager || !pointer_manager) {
        fputs("input seat: owned seat0 or virtual input protocols unavailable\n", stderr);
        return 1;
    }
    int fd = memfd_create("mindi-input-seat", MFD_CLOEXEC);
    if (fd < 0 || write(fd, keymap, sizeof keymap) != (ssize_t)sizeof keymap) {
        fputs("input seat: keymap allocation failed\n", stderr); return 1;
    }
    struct zwp_virtual_keyboard_v1 *keyboard =
        zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager, seat);
    zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, sizeof keymap);
    close(fd);
    zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager, seat);
    if (wl_display_roundtrip(display) < 0) return 1;
    /* No key/modifier/motion/button/axis requests. SIGTERM closes the connection and its device;
     * compositor disconnect exits nonzero so the desktop lifecycle fails closed. */
    while (wl_display_dispatch(display) >= 0) {}
    wl_display_disconnect(display);
    return 1;
}
