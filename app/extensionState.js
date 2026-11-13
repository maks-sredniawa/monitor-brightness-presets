import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const UUID = 'monitor-brightness-presets@maksforge.com';
const BUS_NAME = 'org.gnome.Shell.Extensions';
const OBJECT_PATH = '/org/gnome/Shell/Extensions';
const ACTIVE = 1;

const isActive = info => info.state?.unpack() === ACTIVE;

export function watchExtension(onChange) {
    const bus = Gio.DBus.session;
    const cancellable = new Gio.Cancellable();
    const recheck = () => {
        bus.call(BUS_NAME, OBJECT_PATH, BUS_NAME, 'GetExtensionInfo', new GLib.Variant('(s)', [UUID]),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NO_AUTO_START, -1, cancellable, (_bus, result) => {
                try {
                    const [info] = bus.call_finish(result).deepUnpack();
                    onChange(isActive(info));
                } catch (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        onChange(null);
                }
            });
    };
    const subscription = bus.signal_subscribe(BUS_NAME, BUS_NAME, 'ExtensionStateChanged', OBJECT_PATH, UUID,
        Gio.DBusSignalFlags.NONE, (_connection, _sender, _path, _iface, _signal, parameters) => {
            const [, info] = parameters.deepUnpack();
            onChange(isActive(info));
        });
    recheck();
    return {
        recheck,
        destroy: () => {
            cancellable.cancel();
            bus.signal_unsubscribe(subscription);
        },
    };
}
