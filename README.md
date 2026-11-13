# Monitor brightness presets

Tool. A GNOME Shell extension that keeps a few brightness presets for all your monitors, whatever their make, so you can switch every screen between them in a moment.

It adds a **Brightness** toggle to Quick Settings. Its menu lists the presets (Day 100%, Evening 60%, Night 25% to start with). Picking one sets every external monitor to that brightness over DDC/CI, scaled to each monitor's own range. A preset can also set a contrast, shown after its brightness; one without a contrast leaves each monitor's contrast as it is. **Edit presets** opens the preferences, where presets can be renamed, changed, added and removed, and given a contrast or none.

A daily **schedule** can switch presets for you: a list of times, each with a preset, applied to every monitor at that time every day, as if you had picked it from the tile. It is off until you turn on **Follow schedule**. When a time passes while the computer is off, locked or asleep, its preset is applied on login, unlock or wake. A preset you pick by hand stays until the next scheduled time. A time whose preset was removed is marked and skipped; renaming a preset takes its times along. While the schedule is on, the tile's menu shows the next change and has a switch to pause it. The schedule is edited in the preferences, under the presets, and in the app. The extension runs it, so it works while the app is closed, and only while the extension is turned on.

The **Brightness Presets** app, in the app grid, does the same in its own window and adds two sliders for each monitor, showing its current brightness and contrast; a monitor whose contrast cannot be set over DDC/CI gets only the brightness slider. It shares the presets with the Quick Settings toggle, so a pick in either shows in both. Monitors it cannot control are listed with the reason. Its Schedule group turns the schedule on and off, shows the next change, and edits the times (Ctrl+T); when the extension is not turned on, it says so, since the app does not run the schedule itself. Ctrl+1 to Ctrl+9 apply the presets, Ctrl+R refreshes the monitors after replugging.

## Status

First version, in development. Runs on GNOME Shell 50.

## Needs

- [ddcutil](https://www.ddcutil.com/) 2.x, with access to the monitors' I²C buses: `sudo apt install ddcutil`, then log out and in again so its udev rule gives your session access.
- DDC/CI turned on in each monitor's own on-screen menu.
- No other program holding a monitor's I²C bus, such as the `ddcci` kernel module; a monitor that is busy this way is left as it is and named in the notification.

The app needs GTK 4 and libadwaita 1.8 or newer (`gir1.2-adw-1`), as on Ubuntu 26.04.

## Develop

```bash
make test         # unit and subprocess tests, against a fake ddcutil
make smoke        # drives the app window under xvfb, against the fake ddcutil
make install      # compiles the settings schema and links extension/ into ~/.local/share/gnome-shell/extensions
make install-app  # adds the app to the app grid, run from this clone
make uninstall-app
make enable    # once GNOME Shell has seen the extension (on Wayland: after logging out and in)
make pack      # builds the zip for extensions.gnome.org into dist/
```

## Contributing

Pull requests are not accepted.

## Licence

All rights reserved, source available. See [LICENSE](LICENSE).
