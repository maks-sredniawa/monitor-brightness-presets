import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {collectPresets} from './lib/presets.js';

export default class MonitorBrightnessPresetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Presets'),
            description: _('Each preset sets every monitor to the same brightness. Presets without a name, or with the name of a preset above them, are not saved.'),
        });
        page.add(group);
        window.add(page);

        const rows = [];
        const save = () => {
            for (const row of rows) {
                row.name = row.entry.text.trim();
                row.percent = row.spin.get_value_as_int();
            }
            const {presets, saved, duplicates, active} = collectPresets(rows, settings.get_string('active-preset'));
            for (const row of rows) {
                if (duplicates.has(row))
                    row.entry.add_css_class('error');
                else
                    row.entry.remove_css_class('error');
            }
            for (const row of saved)
                row.savedName = row.name;
            settings.set_value('presets', new GLib.Variant('a(si)', presets));
            if (active !== settings.get_string('active-preset'))
                settings.set_string('active-preset', active);
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

            const row = {entry, spin, savedName: name};
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
    }
}
