import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SCHEMA_ID = 'org.gnome.shell.extensions.monitor-brightness-presets';

export function loadSettings() {
    const appDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const schemaDir = GLib.build_filenamev([appDir, '..', 'extension', 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir, Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({settings_schema: source.lookup(SCHEMA_ID, false)});
}
