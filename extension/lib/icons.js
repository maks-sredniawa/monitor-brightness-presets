import Gio from 'gi://Gio';

export function contrastIcon() {
    const lib = Gio.File.new_for_uri(import.meta.url).get_parent();
    return new Gio.FileIcon({file: lib.get_parent().resolve_relative_path('icons/contrast-symbolic.svg')});
}
