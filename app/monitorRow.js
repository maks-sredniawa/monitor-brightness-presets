import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

const SPINNER_DELAY_MS = 300;

export const MonitorRow = GObject.registerClass(
class MonitorRow extends Adw.PreferencesRow {
    constructor(bus, onChange) {
        super({activatable: false});
        this.bus = bus;
        this.request = 0;
        this._spinnerDelay = 0;
        this._lastPercent = null;

        this._name = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END});
        this._spinner = new Adw.Spinner({visible: false, width_request: 16, height_request: 16});
        this._value = new Gtk.Label({css_classes: ['numeric', 'dim-label'], width_chars: 4, xalign: 1});
        const top = new Gtk.Box({spacing: 8});
        top.append(this._name);
        top.append(this._spinner);
        top.append(this._value);

        this._scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 10}),
            draw_value: false,
            round_digits: 0,
            hexpand: true,
        });
        this._changed = this._scale.connect('value-changed', () => {
            const percent = Math.round(this._scale.get_value());
            this._value.label = `${percent}%`;
            if (percent === this._lastPercent)
                return;
            this._lastPercent = percent;
            onChange(percent);
        });
        // Scrolling the page with the pointer over a slider must not change a monitor.
        const wheel = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        wheel.connect('scroll', () => Gdk.EVENT_STOP);
        this._scale.add_controller(wheel);

        this._note = new Gtk.Label({css_classes: ['caption', 'dim-label'], wrap: true, xalign: 0, visible: false});

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8,
        });
        box.append(top);
        box.append(this._scale);
        box.append(this._note);
        this.child = box;
        this.connect('unrealize', () => this._stopSpinnerDelay());
    }

    set name(name) {
        this.title = name;
        this._name.label = name;
        this._scale.update_property([Gtk.AccessibleProperty.LABEL], [name]);
    }

    get percent() {
        return this._lastPercent;
    }

    set percent(percent) {
        this._lastPercent = percent;
        GObject.signal_handler_block(this._scale, this._changed);
        this._scale.set_value(percent);
        GObject.signal_handler_unblock(this._scale, this._changed);
        this._value.label = `${percent}%`;
    }

    get note() {
        return this._note.visible ? this._note.label : null;
    }

    set note(text) {
        this._note.label = text ?? '';
        this._note.visible = Boolean(text);
    }

    set working(working) {
        this._stopSpinnerDelay();
        if (!working) {
            this._spinner.visible = false;
            return;
        }
        this._spinnerDelay = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPINNER_DELAY_MS, () => {
            this._spinnerDelay = 0;
            this._spinner.visible = true;
            return GLib.SOURCE_REMOVE;
        });
    }

    set refreshing(refreshing) {
        this._scale.sensitive = !refreshing;
        this.working = refreshing;
    }

    _stopSpinnerDelay() {
        if (this._spinnerDelay) {
            GLib.source_remove(this._spinnerDelay);
            this._spinnerDelay = 0;
        }
    }
});
