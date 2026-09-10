import Meta from 'gi://Meta';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const AUTO_FOREGROUND_COLOR = 'auto-foreground-color';
const DARK_TEXT_CLASS = 'transparent-top-bar-dark-text';
const LIGHT_TEXT_CLASS = 'transparent-top-bar-light-text';

// Wallpaper sampling for the auto foreground color
const SAMPLE_COUNT = 12;
const SAMPLE_OFFSET = 4;                // logical pixels below the panel
const SAMPLE_MARGIN_RATIO = 0.02;       // keep away from the screen edges
const WALLPAPER_SAMPLE_DELAY = 1500;    // ms, wait for the wallpaper cross-fade
const DARK_TEXT_LUMINANCE_THRESHOLD = 0.5;
const LUMINANCE_HYSTERESIS = 0.05;

// The shell already promisifies this, calling it again is a no-op
Gio._promisify(Shell.Screenshot.prototype, 'pick_color');

export default class TransparentTopBarWithCustomTransparencyExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._actorSignalIds = null;
        this._windowSignalIds = null;
        this._delayedTimeoutId = null;
        this.transparencyChangeDebounce = null;
        this.darkFullScreenChangeDebounce = null;
        this.textShadowChangeDebounce = null;
        this._backgroundSettings = null;
        this._backgroundSettingsIds = null;
        this._interfaceSettings = null;
        this._interfaceSettingsId = null;
        this._monitorsChangedId = null;
        this._wallpaperSampleTimeoutId = null;
        this._wallpaperLuminance = null;
        this._darkText = null;
        this._autoColorGeneration = 0;
        this._screenshot = null;
        this._wallpaperSampleDeferred = false;
        this._settingsChangedId = null;
    }

    enable() {

        this._settings = this.getSettings('com.ftpix.transparentbar');
        this._currentTransparency = this._settings.get_int('transparency');
        this._darkFullScreen = this._settings.get_boolean('dark-full-screen');
        this._disableTextShadow = this._settings.get_boolean('disable-text-shadow');
        this._autoForegroundColor = this._settings.get_boolean(AUTO_FOREGROUND_COLOR);

        this._actorSignalIds = new Map();
        this._windowSignalIds = new Map();
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => this.transparencyChanged(settings, key));
        this._actorSignalIds.set(Main.overview, [
            Main.overview.connect('showing', this._updateTransparent.bind(this)),
            Main.overview.connect('hiding', this._updateTransparent.bind(this)),
            Main.overview.connect('shown', this._applyAutoColorClass.bind(this)),
            Main.overview.connect('hidden', this._onOverviewHidden.bind(this))
        ]);

        this._actorSignalIds.set(Main.sessionMode, [
            Main.sessionMode.connect('updated', this._onSessionModeUpdated.bind(this))
        ]);

        for (const metaWindowActor of global.get_window_actors()) {
            this._onWindowActorAdded(metaWindowActor.get_parent(), metaWindowActor);
        }

        this._actorSignalIds.set(global.window_group, [
            global.window_group.connect('child-added', this._onWindowActorAdded.bind(this)),
            global.window_group.connect('child-removed', this._onWindowActorRemoved.bind(this))
        ]);

        //Use a delayed version of _updateTransparent to let the shell catch up
        this._actorSignalIds.set(global.window_manager, [
            global.window_manager.connect('switch-workspace', this._updateTransparentDelayed.bind(this))
        ]);

        // Re-sample the wallpaper when the background or the dark style preference changes
        this._backgroundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._backgroundSettingsIds = [
            this._backgroundSettings.connect('changed::picture-uri', () => this._scheduleWallpaperSampling()),
            this._backgroundSettings.connect('changed::picture-uri-dark', () => this._scheduleWallpaperSampling())
        ];

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceSettingsId = this._interfaceSettings.connect('changed::color-scheme', () => this._scheduleWallpaperSampling());

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => this._scheduleWallpaperSampling());

        this._updateTransparent();
        this._scheduleWallpaperSampling(1000);
    }

    transparencyChanged(settings, key) {

        if (key === 'transparency') {
            GLib.source_remove(this.transparencyChangeDebounce);
            this.transparencyChangeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                const oldTransparency = this._currentTransparency;
                this._currentTransparency = this._settings.get_int('transparency');
                Main.panel.remove_style_class_name('transparent-top-bar-' + oldTransparency);
                this._updateTransparent();
            });
            return;
        }

        if (key === 'dark-full-screen') {
            this._darkFullScreen = this._settings.get_boolean('dark-full-screen');
            GLib.source_remove(this.darkFullScreenChangeDebounce);
            this.darkFullScreenChangeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                Main.panel.remove_style_class_name('transparent-top-bar-' + this._currentTransparency);
                this._updateTransparent();
            });
            return;
        }

        if (key === 'disable-text-shadow') {
            this._disableTextShadow = this._settings.get_boolean('disable-text-shadow');
            GLib.source_remove(this.textShadowChangeDebounce);
            this.textShadowChangeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._updateTextShadow();
            });
            return;
        }

        if (key === AUTO_FOREGROUND_COLOR) {
            this._autoForegroundColor = this._settings.get_boolean(AUTO_FOREGROUND_COLOR);
            this._autoColorGeneration++;

            if (this._autoForegroundColor) {
                this._scheduleWallpaperSampling(250);
            } else {
                this._wallpaperLuminance = null;
                this._darkText = null;
                this._applyAutoColorClass();
            }
            return;
        }
    }

    disable() {
        GLib.source_remove(this.transparencyChangeDebounce);
        GLib.source_remove(this.darkFullScreenChangeDebounce);
        GLib.source_remove(this.textShadowChangeDebounce);

        for (const actorSignalIds of [this._actorSignalIds, this._windowSignalIds]) {
            for (const [actor, signalIds] of actorSignalIds) {
                for (const signalId of signalIds) {
                    actor.disconnect(signalId);
                }
            }
        }
        this._actorSignalIds = null;
        this._windowSignalIds = null;

        if (this._settingsChangedId !== null) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._delayedTimeoutId != null) {
            GLib.Source.remove(this._delayedTimeoutId);
        }
        this._delayedTimeoutId = null;

        if (this._wallpaperSampleTimeoutId !== null) {
            GLib.source_remove(this._wallpaperSampleTimeoutId);
            this._wallpaperSampleTimeoutId = null;
        }

        this._autoColorGeneration++;
        for (const signalId of this._backgroundSettingsIds ?? []) {
            this._backgroundSettings.disconnect(signalId);
        }
        this._backgroundSettings = null;
        this._backgroundSettingsIds = null;

        if (this._interfaceSettingsId !== null) {
            this._interfaceSettings.disconnect(this._interfaceSettingsId);
            this._interfaceSettingsId = null;
        }
        this._interfaceSettings = null;

        if (this._monitorsChangedId !== null) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        this._screenshot = null;
        this._wallpaperLuminance = null;
        this._darkText = null;

        this._setTransparent(false);
        Main.panel.remove_style_class_name('no-text-shadow');
        this._settings = null;
    }

    _onWindowActorAdded(container, metaWindowActor) {
        this._windowSignalIds.set(metaWindowActor, [
            metaWindowActor.connect('notify::allocation', this._updateTransparent.bind(this)),
            metaWindowActor.connect('notify::visible', this._updateTransparent.bind(this))
        ]);
    }

    _onWindowActorRemoved(container, metaWindowActor) {
        for (const signalId of this._windowSignalIds.get(metaWindowActor)) {
            metaWindowActor.disconnect(signalId);
        }
        this._windowSignalIds.delete(metaWindowActor);
        this._updateTransparent();
    }

    _updateTransparentDelayed() {
        this._delayedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._updateTransparent();
            this._delayedTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateTextShadow() {
        if (this._disableTextShadow) {
            Main.panel.add_style_class_name('no-text-shadow');
        } else {
            Main.panel.remove_style_class_name('no-text-shadow');
        }
    }

    _updateTransparent() {
        if (!this._darkFullScreen) {
            this._setTransparent(true);
            return
        }

        if (Main.panel.has_style_pseudo_class('overview') || !Main.sessionMode.hasWindows) {
            this._setTransparent(true);
            return;
        }

        if (!Main.layoutManager.primaryMonitor) {
            return;
        }

        // Get all the windows in the active workspace that are in the primary monitor and visible.
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();
        const windows = activeWorkspace.list_windows().filter(metaWindow => {
            return metaWindow.is_on_primary_monitor()
                && metaWindow.showing_on_its_workspace()
                && !metaWindow.is_hidden()
                && metaWindow.get_window_type() !== Meta.WindowType.DESKTOP
                && !metaWindow.skip_taskbar;
        });

        // Check if at least one window is near enough to the panel.
        const panelTop = Main.panel.get_transformed_position()[1];
        const panelBottom = panelTop + Main.panel.get_height();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const isNearEnough = windows.some(metaWindow => {
            const verticalPosition = metaWindow.get_frame_rect().y;
            return verticalPosition < panelBottom + 5 * scale;
        });

        this._setTransparent(!isNearEnough);
    }

    _setTransparent(transparent) {
        const transparency = this._settings.get_int("transparency");
        if (transparent) {
            Main.panel.add_style_class_name('transparent-top-bar');
            Main.panel.add_style_class_name('transparent-top-bar-' + transparency);
        } else {
            Main.panel.remove_style_class_name('transparent-top-bar');
            Main.panel.remove_style_class_name('transparent-top-bar-' + transparency);
        }

        this._applyAutoColorClass();
        this._updateTextShadow();
    }

    _onOverviewHidden() {
        if (this._wallpaperSampleDeferred) {
            this._wallpaperSampleDeferred = false;
            this._scheduleWallpaperSampling(500);
            return;
        }

        this._applyAutoColorClass();
    }

    _onSessionModeUpdated() {
        this._updateTransparent();

        if (this._wallpaperSampleDeferred && Main.sessionMode.hasWindows && !Main.overview.visible) {
            this._wallpaperSampleDeferred = false;
            this._scheduleWallpaperSampling(500);
        }
    }

    _scheduleWallpaperSampling(delay = WALLPAPER_SAMPLE_DELAY) {
        if (this._wallpaperSampleTimeoutId !== null) {
            GLib.source_remove(this._wallpaperSampleTimeoutId);
            this._wallpaperSampleTimeoutId = null;
        }

        if (!this._autoForegroundColor) {
            return;
        }

        this._wallpaperSampleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._wallpaperSampleTimeoutId = null;
            this._refreshWallpaperLuminance();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshWallpaperLuminance() {
        const generation = ++this._autoColorGeneration;

        // The overview and the lock screen dim the background, so sampling now
        // would cache a dark value that then gets applied to the real wallpaper
        if (Main.overview.visible || !Main.sessionMode.hasWindows) {
            this._wallpaperSampleDeferred = true;
            return;
        }

        this._wallpaperSampleDeferred = false;
        const luminance = await this._sampleWallpaperLuminance();

        if (generation !== this._autoColorGeneration || !this._autoForegroundColor) {
            return;
        }

        this._wallpaperLuminance = luminance;
        this._applyAutoColorClass();
    }

    async _sampleWallpaperLuminance() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor === null) {
            return null;
        }

        const [, panelY] = Main.panel.get_transformed_position();
        const y = Math.round(panelY + Main.panel.get_height() + SAMPLE_OFFSET);

        if (y < monitor.y || y >= monitor.y + monitor.height) {
            return null;
        }

        if (this._screenshot === null) {
            this._screenshot = new Shell.Screenshot();
        }

        const margin = Math.max(8, Math.round(monitor.width * SAMPLE_MARGIN_RATIO));
        const usableWidth = Math.max(1, monitor.width - 2 * margin);
        const luminances = [];
        const startUs = GLib.get_monotonic_time();

        for (let i = 0; i < SAMPLE_COUNT; i++) {
            const x = Math.round(monitor.x + margin + (i + 0.5) * usableWidth / SAMPLE_COUNT);

            try {
                const [color] = await this._screenshot.pick_color(x, y);
                if (color === null) {
                    continue;
                }

                // Cogl.Color channels are 0-255; 0.3/0.59/0.11 is what elementary OS uses
                luminances.push((0.3 * color.red + 0.59 * color.green + 0.11 * color.blue) / 255);
            } catch (e) {
                log(`Transparent Top Bar: failed to sample wallpaper at ${x}, ${y}: ${e.message}`);
            }
        }

        if (luminances.length === 0) {
            return null;
        }

        const elapsedMs = (GLib.get_monotonic_time() - startUs) / 1000;
        const sorted = [...luminances].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const mean = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;

        log('Transparent Top Bar: wallpaper luminance ' +
            `median=${median.toFixed(3)} mean=${mean.toFixed(3)} ` +
            `(${luminances.length}/${SAMPLE_COUNT} samples in ${elapsedMs.toFixed(1)} ms)`);

        return median;
    }

    _applyAutoColorClass() {
        Main.panel.remove_style_class_name(DARK_TEXT_CLASS);
        Main.panel.remove_style_class_name(LIGHT_TEXT_CLASS);

        if (!this._autoForegroundColor || this._wallpaperLuminance === null) {
            return;
        }

        if (!Main.panel.has_style_class_name('transparent-top-bar')) {
            return;
        }

        const transparency = this._settings.get_int('transparency');
        if (transparency >= 100) {
            return;
        }

        // The overview and the lock/login screens always draw a dark background,
        // keep the shell's default light foreground there
        if (Main.overview.visible || Main.panel.has_style_pseudo_class('overview') ||
            !Main.sessionMode.hasWindows) {
            return;
        }

        // the bar itself is rgba(0, 0, 0, transparency%), so it darkens the wallpaper behind it
        const effective = this._wallpaperLuminance * (1 - transparency / 100);
        const threshold = DARK_TEXT_LUMINANCE_THRESHOLD;

        let darkText;
        if (this._darkText !== null && Math.abs(effective - threshold) < LUMINANCE_HYSTERESIS) {
            darkText = this._darkText;
        } else {
            darkText = effective > threshold;
        }

        this._darkText = darkText;
        Main.panel.add_style_class_name(darkText ? DARK_TEXT_CLASS : LIGHT_TEXT_CLASS);
    }

};
