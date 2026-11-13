import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {collectPresets} from './presets.js';

export function buildPresetsEditor(settings, _) {
    const group = new Adw.PreferencesGroup({
        title: _('Presets'),
        description: _('Each preset sets every monitor to the same brightness. Presets without a name, or with the name of a preset above them, are not saved.'),
    });

    const rows = [];
    let activeRow;
    let written = settings.get_string('active-preset');
    const save = () => {
        for (const row of rows) {
            row.name = row.entry.text.trim();
            row.percent = row.spin.get_value_as_int();
        }
        const {presets, duplicates, active} = collectPresets(rows, activeRow);
        for (const row of rows) {
            if (duplicates.has(row))
                row.entry.add_css_class('error');
            else
                row.entry.remove_css_class('error');
        }
        settings.set_value('presets', new GLib.Variant('a(si)', presets));
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

    const addRow = (name, percent) => {
        const entry = new Adw.EntryRow({title: _('Name'), text: name});
        const spin = Gtk.SpinButton.new_with_range(0, 100, 5);
        spin.value = percent;
        spin.valign = Gtk.Align.CENTER;
        const remove = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: _('Remove preset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        entry.add_suffix(spin);
        entry.add_suffix(new Gtk.Label({label: '%'}));
        entry.add_suffix(remove);

        const row = {entry, spin, name, percent};
        rows.push(row);
        group.add(entry);

        entry.connect('changed', save);
        spin.connect('value-changed', save);
        remove.connect('clicked', () => {
            rows.splice(rows.indexOf(row), 1);
            group.remove(entry);
            save();
        });
        return entry;
    };

    const add = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: _('Add preset'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    add.connect('clicked', () => addRow('', 50).grab_focus());
    group.set_header_suffix(add);

    for (const [name, percent] of settings.get_value('presets').deepUnpack())
        addRow(name, percent);
    activeRow = rows.find(row => row.name === written);
    const picks = settings.connect('changed::active-preset', followPicks);

    return {group, destroy: () => settings.disconnect(picks)};
}
