import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MonitorBrightnessPresetsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Presets'),
            description: _('Each preset sets every monitor to the same brightness. Presets without a name are not saved.'),
        });
        page.add(group);
        window.add(page);

        const rows = [];
        const save = () => {
            const presets = rows
                .map(({entry, spin}) => [entry.text.trim(), spin.get_value_as_int()])
                .filter(([name]) => name);
            settings.set_value('presets', new GLib.Variant('a(si)', presets));
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

            const row = {entry, spin};
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
