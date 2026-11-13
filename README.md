# Monitor brightness presets

Tool. A GNOME Shell extension that keeps a few brightness presets for all your monitors, whatever their make, so you can switch every screen between them in a moment.

It adds a **Brightness** toggle to Quick Settings. Its menu lists the presets (Day 100%, Evening 60%, Night 25% to start with). Picking one sets every external monitor to that brightness over DDC/CI, scaled to each monitor's own range. **Edit presets** opens the preferences, where presets can be renamed, changed, added and removed.

The **Brightness Presets** app, in the app grid, does the same in its own window and adds a slider for each monitor, showing its current brightness. It shares the presets with the Quick Settings toggle, so a pick in either shows in both. Monitors it cannot control are listed with the reason. Ctrl+1 to Ctrl+9 apply the presets, Ctrl+R refreshes the monitors after replugging.

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
