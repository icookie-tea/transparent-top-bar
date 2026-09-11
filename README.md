# Transparent Top Bar (Auto Foreground)

A GNOME Shell extension that makes the top bar transparent with an adjustable
opacity, and automatically switches the bar's foreground between dark and light
text to stay readable on any wallpaper.

This is a fork of [Transparent Top Bar](https://github.com/zhanghai/gnome-shell-extension-transparent-top-bar)
by zhanghai and lamarios, with:

- a rebuilt preferences window,
- per-state background sampling (desktop, overview, lock screen),
- automatic foreground color based on the sampled background luminance.

## Features

- **Opacity** – 0–100% black behind the panel, animated.
- **Opaque on full screen** – the bar becomes opaque while a window touches it
  (with a real fade in both directions).
- **Automatic foreground color** – the background below the bar is sampled in
  several places and the median luminance picks dark or light text. The
  overview and lock screen backgrounds are sampled separately, so extensions
  that change the overview backdrop (e.g. Blur my Shell) are handled too.
- **Separate black and white text shadows** – the black shadow of the default
  light foreground and the white shadow of the dark foreground can be turned
  off independently.
- **Debug logging** – optional sampling diagnostics in the system log.

## Install

```sh
./install.sh          # copy the extension into your user extensions dir
./install.sh --dev    # symlink the repository instead (development)
./install.sh --uninstall
```

Then log out and back in, and enable *Transparent Top Bar* in the Extensions
app. Requires GNOME Shell 47–50.

## Development

- [`docs/analysis.md`](docs/analysis.md) (Chinese) – analysis of the three
  timing bugs that were fixed (wrong foreground color when entering the
  overview, missing fade when a window leaves the bar, instant snap after an
  overview round trip with a fullscreen window) and the remaining design notes.
- [`tests/README.md`](tests/README.md) – behavioural tests that run a nested
  GNOME Shell (`gnome-shell --devkit`) inside a toolbox container.

## Credits

Based on Transparent Top Bar by zhanghai and lamarios.
