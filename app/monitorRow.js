import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

import {format} from '../extension/lib/format.js';
import {contrastIcon} from '../extension/lib/icons.js';

const _ = text => text;

const SPINNER_DELAY_MS = 300;
const NOTES = {
    brightness: _('Did not change its brightness. Its own menu may be locking it, for example an ECO mode or picture preset.'),
    contrast: _('Did not change its contrast. Its own menu may be locking it, for example an ECO mode or picture preset.'),
    both: _('Did not change its brightness or contrast. Its own menu may be locking them, for example an ECO mode or picture preset.'),
};

class SliderLine {
    constructor(icon, step, onChange) {
        this.lastPercent = null;
        this.icon = icon;
        this.value = new Gtk.Label({css_classes: ['numeric', 'dim-label'], width_chars: 4, xalign: 1});
        this.scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: step, page_increment: 10}),
            draw_value: false,
            round_digits: 0,
            hexpand: true,
        });
        this._changed = this.scale.connect('value-changed', () => {
            const percent = Math.round(this.scale.get_value());
            this._showValue(percent);
            if (percent === this.lastPercent)
                return;
            this.lastPercent = percent;
            onChange(percent);
        });
        // Scrolling the page with the pointer over a slider must not change a monitor.
        const wheel = new Gtk.EventControllerScroll({
            flags: Gtk.EventControllerScrollFlags.BOTH_AXES,
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        wheel.connect('scroll', () => Gdk.EVENT_STOP);
        this.scale.add_controller(wheel);

        this.box = new Gtk.Box({spacing: 8});
        this.box.append(icon);
        this.box.append(this.scale);
        this.box.append(this.value);
    }

    set percent(percent) {
        this.lastPercent = percent;
        GObject.signal_handler_block(this.scale, this._changed);
        this.scale.set_value(percent);
        GObject.signal_handler_unblock(this.scale, this._changed);
        this._showValue(percent);
    }

    _showValue(percent) {
        this.value.label = `${percent}%`;
        this.scale.update_property([Gtk.AccessibleProperty.VALUE_TEXT], [`${percent}%`]);
    }
}

export const MonitorRow = GObject.registerClass(
class MonitorRow extends Adw.PreferencesRow {
    constructor(bus, onBrightness, onContrast) {
        super({activatable: false});
        this.bus = bus;
        this.requests = {brightness: 0, contrast: 0};
        this._busy = new Set();
        this._rejected = {brightness: false, contrast: false};
        this._spinnerDelay = 0;

        this._name = new Gtk.Label({xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END});
        this._spinner = new Adw.Spinner({visible: false, width_request: 16, height_request: 16});
        const top = new Gtk.Box({spacing: 8});
        top.append(this._name);
        top.append(this._spinner);

        this._brightness = new SliderLine(new Gtk.Image({
            icon_name: 'display-brightness-symbolic',
            css_classes: ['dim-label'],
            tooltip_text: _('Brightness'),
            accessible_role: Gtk.AccessibleRole.PRESENTATION,
        }), 5, onBrightness);
        this._contrast = new SliderLine(new Gtk.Image({
            gicon: contrastIcon(),
            css_classes: ['dim-label'],
            tooltip_text: _('Contrast'),
            accessible_role: Gtk.AccessibleRole.PRESENTATION,
        }), 1, onContrast);
        this._noContrast = new Gtk.Label({
            label: _('Contrast cannot be set over DDC/CI.'),
            css_classes: ['caption', 'dim-label'],
            xalign: 0,
            margin_top: 2,
            wrap: true,
            visible: false,
        });

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
        box.append(this._brightness.box);
        box.append(this._contrast.box);
        box.append(this._noContrast);
        box.append(this._note);
        this.child = box;
        this.connect('unrealize', () => this._stopSpinnerDelay());
    }

    set name(name) {
        this.title = name;
        this._name.label = name;
        this._brightness.scale.update_property([Gtk.AccessibleProperty.LABEL], [format(_('%s brightness'), name)]);
        this._contrast.scale.update_property([Gtk.AccessibleProperty.LABEL], [format(_('%s contrast'), name)]);
    }

    get percent() {
        return this._brightness.lastPercent;
    }

    set percent(percent) {
        this._brightness.percent = percent;
    }

    get hasContrast() {
        return this._contrast.box.visible;
    }

    set hasContrast(hasContrast) {
        this._contrast.box.visible = hasContrast;
        this._noContrast.visible = !hasContrast;
    }

    get contrast() {
        return this.hasContrast ? this._contrast.lastPercent : null;
    }

    set contrast(percent) {
        this._contrast.percent = percent;
    }

    get rejected() {
        return {...this._rejected};
    }

    setRejected(feature, rejected) {
        this._rejected[feature] = rejected;
        const {brightness, contrast} = this._rejected;
        const text = brightness && contrast ? NOTES.both : NOTES[brightness ? 'brightness' : 'contrast'];
        this._note.label = brightness || contrast ? text : '';
        this._note.visible = brightness || contrast;
    }

    clearRejected() {
        this.setRejected('brightness', false);
        this.setRejected('contrast', false);
    }

    get note() {
        return this._note.visible ? this._note.label : null;
    }

    claim(feature, working) {
        const request = ++this.requests[feature];
        this._setBusy(feature, working);
        return request;
    }

    isLatest(feature, request) {
        return this.requests[feature] === request;
    }

    release(feature, request) {
        if (this.isLatest(feature, request))
            this._setBusy(feature, false);
    }

    set refreshing(refreshing) {
        this._brightness.scale.sensitive = !refreshing;
        this._contrast.scale.sensitive = !refreshing;
        this._setBusy('refresh', refreshing);
    }

    _setBusy(job, busy) {
        if (busy)
            this._busy.add(job);
        else
            this._busy.delete(job);
        if (this._busy.size === 0) {
            this._stopSpinnerDelay();
            this._spinner.visible = false;
        } else if (!this._spinner.visible && !this._spinnerDelay) {
            this._spinnerDelay = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SPINNER_DELAY_MS, () => {
                this._spinnerDelay = 0;
                this._spinner.visible = true;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _stopSpinnerDelay() {
        if (this._spinnerDelay) {
            GLib.source_remove(this._spinnerDelay);
            this._spinnerDelay = 0;
        }
    }
});
