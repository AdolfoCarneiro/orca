#!/usr/bin/env python3
"""GTK3 target for the cua-vs-Orca background bench. Writes state.json every 30 ms; obeys cmd."""
import json
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

state_dir = sys.argv[1]
STATE = os.path.join(state_dir, "state.json")
CMD = os.path.join(state_dir, "cmd")
s = {"count": 0, "returns": 0, "menuHits": 0, "last": None}


def named(widget, name):
    widget.get_accessible().set_name(name)
    return widget


win = Gtk.Window(title="BenchTarget")
win.set_default_size(760, 560)
win.move(60, 60)
win.connect("destroy", Gtk.main_quit)
accel = Gtk.AccelGroup()
win.add_accel_group(accel)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
win.add(box)

menubar = Gtk.MenuBar()
edit = Gtk.MenuItem(label="Edit")
sub = Gtk.Menu()
sub.set_accel_group(accel)
bump = Gtk.MenuItem(label="Bump")
bump.add_accelerator("activate", accel, ord("b"), Gdk.ModifierType.CONTROL_MASK, Gtk.AccelFlags.VISIBLE)
bump.connect("activate", lambda _w: s.__setitem__("menuHits", s["menuHits"] + 1))
sub.append(bump)
edit.set_submenu(sub)
menubar.append(edit)
box.pack_start(menubar, False, False, 0)

button = Gtk.Button(label="Increment")
button.connect("clicked", lambda _b: s.__setitem__("count", s["count"] + 1))
check = Gtk.CheckButton(label="Check me")
field = named(Gtk.Entry(), "field")
field.connect("activate", lambda _e: s.__setitem__("returns", s["returns"] + 1))
combo = named(Gtk.ComboBoxText(), "Color")
for item in ("Red", "Green", "Blue"):
    combo.append_text(item)
combo.set_active(0)
scroll = named(Gtk.ScrolledWindow(), "list")
scroll.set_size_request(300, 250)
rows = Gtk.ListBox()
for i in range(1, 301):
    rows.add(Gtk.Label(label=f"Row {i}"))
scroll.add(rows)
for widget in (button, check, field, combo):
    box.pack_start(widget, False, False, 0)
box.pack_start(scroll, True, True, 0)


def command(c):
    if c == "reset":
        s["count"] = s["returns"] = s["menuHits"] = 0
        check.set_active(False)
        sub.popdown()
        combo.set_active(0)
        scroll.get_vadjustment().set_value(0)
        win.set_focus(field)
        field.set_text("")
    elif c == "setHello":
        win.set_focus(field)
        field.set_text("hello")
        field.set_position(5)
        s["returns"] = 0


def tick():
    try:
        with open(CMD) as f:
            c = f.read().strip()
        if c:
            open(CMD, "w").close()
            command(c)
    except OSError:
        pass
    bounds = field.get_selection_bounds()
    sel = list(bounds) if bounds else [field.get_position(), field.get_position()]
    state = {
        "count": s["count"], "check": check.get_active(), "text": field.get_text(), "returns": s["returns"],
        "selStart": sel[0], "selLen": sel[1] - sel[0], "combo": combo.get_active_text(),
        "top": scroll.get_vadjustment().get_value(), "menuHits": s["menuHits"], "dropOpen": sub.get_visible(),
        "activeForm": win.is_active(), "fieldFocused": win.get_focus() is field, "pid": os.getpid(),
    }
    data = json.dumps(state)
    if data != s["last"]:
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            f.write(data)
        os.replace(tmp, STATE)
        s["last"] = data
    return True


win.show_all()
win.set_focus(field)
GLib.timeout_add(30, tick)
Gtk.main()
