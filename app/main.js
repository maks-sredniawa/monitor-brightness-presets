import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import 'gi://Gtk?version=4.0';
import System from 'system';

import {loadSettings} from './settings.js';
import {BrightnessWindow} from './window.js';

const APP_ID = 'com.maksforge.MonitorBrightnessPresets';

const BrightnessApp = GObject.registerClass(
class BrightnessApp extends Adw.Application {
    constructor() {
        super({application_id: APP_ID, flags: Gio.ApplicationFlags.DEFAULT_FLAGS});
        const quit = new Gio.SimpleAction({name: 'quit'});
        quit.connect('activate', () => this.quit());
        this.add_action(quit);

        this.set_accels_for_action('app.quit', ['<Control>q']);
        this.set_accels_for_action('win.refresh', ['<Control>r', 'F5']);
        this.set_accels_for_action('win.edit-presets', ['<Control>comma']);
        this.set_accels_for_action('win.edit-schedule', ['<Control>t']);
        this.set_accels_for_action('win.shortcuts', ['<Control>question']);
        for (let position = 1; position <= 9; position++)
            this.set_accels_for_action(`win.apply-preset(${position})`, [`<Control>${position}`]);
    }

    vfunc_activate() {
        (this.active_window ?? new BrightnessWindow(this, loadSettings())).present();
    }
});

new BrightnessApp().run([System.programInvocationName, ...ARGV]);
