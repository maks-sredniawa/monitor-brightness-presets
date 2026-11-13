import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {format} from './format.js';
import {contrastIcon} from './icons.js';
import {collectPresets, readPresets} from './presets.js';
import {renameInSchedule} from './schedule.js';

const DEFAULT_CONTRAST = 50;

function buildContrastButton(contrast, sizeGroup, onChange, _) {
    const icon = new Gtk.Image({gicon: contrastIcon(), accessible_role: Gtk.AccessibleRole.PRESENTATION});
    const value = new Gtk.Label({css_classes: ['numeric']});
    const content = new Gtk.Box({spacing: 4, halign: Gtk.Align.START});
    content.append(icon);
    content.append(value);

    const toggle = new Gtk.Switch({active: contrast !== null, valign: Gtk.Align.CENTER});
    const switchRow = new Gtk.Box({spacing: 12});
    switchRow.append(new Gtk.Label({label: _('Set contrast'), xalign: 0, hexpand: true, mnemonic_widget: toggle}));
    switchRow.append(toggle);

    const spin = Gtk.SpinButton.new_with_range(0, 100, 5);
    spin.set_increments(5, 10);
    spin.value = contrast ?? DEFAULT_CONTRAST;
    spin.hexpand = true;
    spin.update_property([Gtk.AccessibleProperty.LABEL], [_('Contrast percent')]);
    const spinRow = new Gtk.Box({spacing: 6});
    spinRow.append(spin);
    spinRow.append(new Gtk.Label({label: '%'}));

    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
        margin_start: 12,
        margin_end: 12,
        margin_top: 12,
        margin_bottom: 12,
    });
    box.append(switchRow);
    box.append(spinRow);
    box.append(new Gtk.Label({
        label: _('Off leaves each monitor’s contrast as it is. The same percent looks different on each monitor.'),
        css_classes: ['caption', 'dim-label'],
        wrap: true,
        xalign: 0,
        max_width_chars: 30,
    }));
    const popover = new Gtk.Popover({child: box});
    popover.connect('show', () => toggle.grab_focus());

    const button = new Gtk.MenuButton({
        child: content,
        popover,
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Contrast'),
        css_classes: ['flat', 'image-button'],
    });
    sizeGroup.add_widget(button);

    const current = () => toggle.active ? spin.get_value_as_int() : null;
    const show = () => {
        const percent = current();
        spinRow.sensitive = percent !== null;
        value.visible = percent !== null;
        value.label = `${percent}%`;
        if (percent === null)
            icon.add_css_class('dim-label');
        else
            icon.remove_css_class('dim-label');
        button.update_property([Gtk.AccessibleProperty.LABEL],
            [percent === null ? _('Contrast, not set') : format(_('Contrast, %d%%'), percent)]);
    };
    toggle.connect('notify::active', () => {
        show();
        onChange();
    });
    spin.connect('value-changed', () => {
        show();
        if (toggle.active)
            onChange();
    });
    show();
    return {button, toggle, spin, current};
}

export function buildPresetsEditor(settings, _) {
    const group = new Adw.PreferencesGroup({
        title: _('Presets'),
        description: _('Each preset sets every monitor to the same brightness. Presets without a name, or with the name of a preset above them, are not saved.'),
    });

    // Presets, their contrasts and renamed schedule times must land in one write, and delaying the caller's own
    // settings object would also hold back its writes of the active preset.
    const writer = new Gio.Settings({settings_schema: settings.settings_schema, backend: settings.backend});
    writer.delay();

    const contrastButtons = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.HORIZONTAL});
    const duplicateNote = _('Another preset above has the same name, so this one is not saved.');
    const rows = [];
    let activeRow;
    const nameRemove = row => row.remove.update_property([Gtk.AccessibleProperty.LABEL],
        [row.name ? format(_('Remove %s'), row.name) : _('Remove preset')]);
    let written = settings.get_string('active-preset');
    const save = () => {
        for (const row of rows) {
            row.name = row.entry.text.trim();
            row.percent = row.spin.get_value_as_int();
            row.contrast = row.contrastControl.current();
        }
        const {presets, contrasts, duplicates, renames, saved, active} = collectPresets(rows, activeRow);
        for (const row of rows) {
            if (duplicates.has(row)) {
                row.entry.add_css_class('error');
                row.entry.title = _('Same name as above, not saved');
                row.entry.update_state([Gtk.AccessibleState.INVALID], [Gtk.AccessibleInvalidState.TRUE]);
                row.entry.update_property([Gtk.AccessibleProperty.DESCRIPTION], [duplicateNote]);
            } else {
                row.entry.remove_css_class('error');
                row.entry.title = _('Name');
                row.entry.reset_state(Gtk.AccessibleState.INVALID);
                row.entry.reset_property(Gtk.AccessibleProperty.DESCRIPTION);
            }
            nameRemove(row);
        }
        writer.set_value('presets', new GLib.Variant('a(si)', presets));
        writer.set_value('preset-contrast', new GLib.Variant('a{si}', contrasts));
        if (Object.keys(renames).length > 0) {
            const schedule = renameInSchedule(writer.get_value('schedule').deepUnpack(), renames);
            writer.set_value('schedule', new GLib.Variant('a(is)', schedule));
        }
        writer.apply();
        for (const row of saved)
            row.savedName = row.name;
        if (active !== settings.get_string('active-preset')) {
            written = active;
            settings.set_string('active-preset', active);
        }
    };
    const followPicks = () => {
        const active = settings.get_string('active-preset');
        if (active === written)
            return;
        written = active;
        activeRow = collectPresets(rows).saved.find(row => row.name === active);
    };

    const addRow = (name, percent, contrast) => {
        const entry = new Adw.EntryRow({title: _('Name'), text: name});
        const spin = Gtk.SpinButton.new_with_range(0, 100, 5);
        spin.value = percent;
        spin.valign = Gtk.Align.CENTER;
        spin.update_property([Gtk.AccessibleProperty.LABEL], [_('Brightness percent')]);
        const contrastControl = buildContrastButton(contrast, contrastButtons, () => save(), _);
        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Remove preset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        entry.add_suffix(spin);
        entry.add_suffix(new Gtk.Label({label: '%'}));
        entry.add_suffix(contrastControl.button);
        entry.add_suffix(remove);

        const row = {entry, spin, remove, contrastControl, name, savedName: name, percent, contrast};
        nameRemove(row);
        rows.push(row);
        group.add(entry);

        entry.connect('changed', save);
        spin.connect('value-changed', save);
        remove.connect('clicked', () => {
            const index = rows.indexOf(row);
            rows.splice(index, 1);
            const neighbour = rows[index] ?? rows[index - 1];
            contrastButtons.remove_widget(contrastControl.button);
            group.remove(entry);
            save();
            (neighbour?.entry ?? add).grab_focus();
        });
        return entry;
    };

    const add = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: _('Add preset'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    add.connect('clicked', () => addRow('', 50, null).grab_focus());
    group.set_header_suffix(add);

    for (const {name, brightness, contrast} of readPresets(settings))
        addRow(name, brightness, contrast);
    activeRow = rows.find(row => row.name === written);
    const picks = settings.connect('changed::active-preset', followPicks);

    return {group, destroy: () => settings.disconnect(picks)};
}
