import Meta from 'gi://Meta';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const AUTO_FOREGROUND_COLOR = 'auto-foreground-color';
const DEBUG_LOGGING = 'debug-logging';
const DARK_TEXT_CLASS = 'transparent-top-bar-dark-text';

// Background sampling for the auto foreground color
const PanelBackgroundState = {
    DESKTOP: 'desktop',
    OVERVIEW: 'overview',
    LOCK: 'lock',
};
const FOREGROUND_LUMINANCE_THRESHOLD_KEY = 'foreground-luminance-threshold';
const SAMPLE_COUNT_KEY = 'sample-count';
const SAMPLE_OFFSET = 4;                // logical pixels below the panel
const SAMPLE_MARGIN_RATIO = 0.02;       // keep away from the screen edges
const SAMPLE_DELAY_WALLPAPER = 1500;    // ms, wait for the wallpaper cross-fade
const SAMPLE_DELAY_STATE = 100;         // ms, the 'shown'/'hidden' signals already fire after the transition
const OVERVIEW_UNSTABLE_TIME = 300;     // ms, overview transition (250ms) plus margin
const SESSION_UNSTABLE_TIME = 500;      // ms, lock/unlock curtain (300ms) plus margin
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
        this._sampleTimeoutId = null;
        this._sampleGeneration = 0;
        this._screenshot = null;
        this._settingsChangedId = null;
        this._unstableUntilMs = 0;
        this._panelTransparent = null;
        this._windowUpdateId = null;
        this._wallpaperSettleTimeoutId = null;
        this._debugLogging = false;

        // BackgroundManager (shell side) -> signal id
        this._bgManagerSignalIds = new Map();

        // The overview, the lock screen and the desktop can all render a
        // different background (e.g. Blur my Shell blurs and brightens the
        // overview), so keep a separate luminance per state
        this._luminance = new Map();
        this._darkText = new Map();
    }

    enable() {

        this._settings = this.getSettings();
        this._currentTransparency = this._settings.get_int('transparency');
        this._darkFullScreen = this._settings.get_boolean('dark-full-screen');
        this._disableTextShadow = this._settings.get_boolean('disable-text-shadow');
        this._autoForegroundColor = this._settings.get_boolean(AUTO_FOREGROUND_COLOR);
        this._debugLogging = this._settings.get_boolean(DEBUG_LOGGING);

        this._actorSignalIds = new Map();
        this._windowSignalIds = new Map();
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => this.transparencyChanged(settings, key));
        this._actorSignalIds.set(Main.overview, [
            Main.overview.connect('showing', () => {
                this._markUnstable(OVERVIEW_UNSTABLE_TIME);
                this._updateTransparent();
            }),
            Main.overview.connect('hiding', () => {
                this._markUnstable(OVERVIEW_UNSTABLE_TIME);
                this._updateTransparent();
            }),
            Main.overview.connect('shown', this._onBackgroundStateChanged.bind(this)),
            Main.overview.connect('hidden', this._onBackgroundStateChanged.bind(this))
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

        // Re-sample the background when the wallpaper or the dark style preference changes
        this._backgroundSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._backgroundSettingsIds = [
            this._backgroundSettings.connect('changed::picture-uri', () => this._invalidateLuminance()),
            this._backgroundSettings.connect('changed::picture-uri-dark', () => this._invalidateLuminance())
        ];

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interfaceSettingsId = this._interfaceSettings.connect('changed::color-scheme', () => this._invalidateLuminance());

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._invalidateLuminance();

            // The layout manager recreates the background managers around this
            // signal, so re-hook them once it has settled
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._hookBackgroundManagers();
                return GLib.SOURCE_REMOVE;
            });
        });

        // A wallpaper can be replaced in place (same URI, new file contents),
        // which does not change picture-uri; the shell's BackgroundManager
        // notices it and emits 'changed'
        this._hookBackgroundManagers();

        this._updateTransparent();

        // _updateTransparent() samples quickly when the panel turns
        // transparent; confirm the result once the startup wallpaper settled
        this._scheduleWallpaperSettleSample();
    }

    transparencyChanged(settings, key) {

        if (key === 'transparency') {
            if (this.transparencyChangeDebounce !== null)
                GLib.source_remove(this.transparencyChangeDebounce);
            this.transparencyChangeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this.transparencyChangeDebounce = null;
                const oldTransparency = this._currentTransparency;
                this._currentTransparency = this._settings.get_int('transparency');
                Main.panel.remove_style_class_name('transparent-top-bar-' + oldTransparency);
                this._updateTransparent();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (key === 'dark-full-screen') {
            this._darkFullScreen = this._settings.get_boolean('dark-full-screen');
            if (this.darkFullScreenChangeDebounce !== null)
                GLib.source_remove(this.darkFullScreenChangeDebounce);
            this.darkFullScreenChangeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this.darkFullScreenChangeDebounce = null;
                Main.panel.remove_style_class_name('transparent-top-bar-' + this._currentTransparency);
                this._updateTransparent();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (key === 'disable-text-shadow') {
            this._disableTextShadow = this._settings.get_boolean('disable-text-shadow');
            if (this.textShadowChangeDebounce !== null)
                GLib.source_remove(this.textShadowChangeDebounce);
            this.textShadowChangeDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this.textShadowChangeDebounce = null;
                this._updateTextShadow();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (key === DEBUG_LOGGING) {
            this._debugLogging = this._settings.get_boolean(DEBUG_LOGGING);
            return;
        }

        if (key === AUTO_FOREGROUND_COLOR) {
            this._autoForegroundColor = this._settings.get_boolean(AUTO_FOREGROUND_COLOR);
            this._sampleGeneration++;

            if (this._autoForegroundColor) {
                this._invalidateLuminance();
            } else {
                this._luminance.clear();
                this._darkText.clear();
                this._applyAutoColorClass();
            }
            return;
        }

        if (key === FOREGROUND_LUMINANCE_THRESHOLD_KEY) {
            this._applyAutoColorClass();
            return;
        }

        if (key === SAMPLE_COUNT_KEY) {
            this._scheduleSampling(250);
            return;
        }
    }

    disable() {
        for (const id of [this.transparencyChangeDebounce,
                          this.darkFullScreenChangeDebounce,
                          this.textShadowChangeDebounce]) {
            if (id !== null)
                GLib.source_remove(id);
        }
        this.transparencyChangeDebounce = null;
        this.darkFullScreenChangeDebounce = null;
        this.textShadowChangeDebounce = null;

        if (this._windowUpdateId !== null) {
            GLib.source_remove(this._windowUpdateId);
            this._windowUpdateId = null;
        }

        if (this._wallpaperSettleTimeoutId !== null) {
            GLib.source_remove(this._wallpaperSettleTimeoutId);
            this._wallpaperSettleTimeoutId = null;
        }

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

        if (this._sampleTimeoutId !== null) {
            GLib.source_remove(this._sampleTimeoutId);
            this._sampleTimeoutId = null;
        }

        this._sampleGeneration++;
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

        for (const [manager, signalId] of this._bgManagerSignalIds) {
            manager.disconnect(signalId);
        }
        this._bgManagerSignalIds.clear();

        this._screenshot = null;
        this._luminance.clear();
        this._darkText.clear();

        // Pretend the panel is already opaque so _setTransparent() does not
        // schedule a sample that would run after the extension is gone
        this._panelTransparent = false;
        this._unstableUntilMs = 0;
        this._setTransparent(false);
        Main.panel.remove_style_class_name('no-text-shadow');
        this._settings = null;
    }

    _onWindowActorAdded(container, metaWindowActor) {
        this._windowSignalIds.set(metaWindowActor, [
            metaWindowActor.connect('notify::allocation', this._queueWindowUpdate.bind(this)),
            metaWindowActor.connect('notify::visible', this._queueWindowUpdate.bind(this))
        ]);
    }

    _onWindowActorRemoved(container, metaWindowActor) {
        const signalIds = this._windowSignalIds.get(metaWindowActor);
        if (signalIds) {
            for (const signalId of signalIds)
                metaWindowActor.disconnect(signalId);
            this._windowSignalIds.delete(metaWindowActor);
        }
        this._updateTransparent();
    }

    // Window actors emit allocation and visibility changes every frame while
    // they are moved or resized; coalesce them instead of re-evaluating the
    // panel once per signal
    _queueWindowUpdate() {
        if (this._windowUpdateId !== null)
            return;

        this._windowUpdateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            this._windowUpdateId = null;
            this._updateTransparent();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateTransparentDelayed() {
        if (this._delayedTimeoutId !== null)
            GLib.source_remove(this._delayedTimeoutId);

        this._delayedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._delayedTimeoutId = null;
            this._updateTransparent();
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

        // The sample area may just have been uncovered by a window, so the
        // cached luminance can be that of the window content; re-sample when
        // the panel becomes transparent again
        if (this._panelTransparent !== transparent) {
            this._panelTransparent = transparent;
            if (transparent)
                this._scheduleSampling(SAMPLE_DELAY_STATE);
        }

        this._applyAutoColorClass();
        this._updateTextShadow();
    }

    get _currentBackgroundState() {
        if (Main.overview.visible) {
            return PanelBackgroundState.OVERVIEW;
        }

        if (Main.sessionMode.isLocked || !Main.sessionMode.hasWindows) {
            return PanelBackgroundState.LOCK;
        }

        return PanelBackgroundState.DESKTOP;
    }

    _onSessionModeUpdated() {
        // The lock screen slides in/out over ~300ms
        this._markUnstable(SESSION_UNSTABLE_TIME);
        this._updateTransparent();
        this._onBackgroundStateChanged();
    }

    /**
     * Called when the background behind the panel may have changed as a whole
     * (overview shown/hidden, session locked/unlocked).
     */
    _onBackgroundStateChanged() {
        this._applyAutoColorClass();

        // Always re-sample: the state background (overview blur, lock screen)
        // can change without a setting we are able to watch
        this._scheduleSampling(SAMPLE_DELAY_STATE);
    }

    _invalidateLuminance(delay = SAMPLE_DELAY_WALLPAPER) {
        // The wallpaper changed as a whole; cached values for the states we
        // cannot sample right now (overview blur, lock screen) are stale
        const current = this._currentBackgroundState;
        for (const state of this._luminance.keys()) {
            if (state !== current)
                this._luminance.delete(state);
        }
        for (const state of this._darkText.keys()) {
            if (state !== current)
                this._darkText.delete(state);
        }

        this._scheduleSampling(delay);
    }

    _hookBackgroundManagers() {
        // Private API, but it is the only reliable way to notice a wallpaper
        // that changed in place (same URI, new file contents) or a slideshow
        const managers = Main.layoutManager._bgManagers ?? [];

        for (const [manager, signalId] of this._bgManagerSignalIds) {
            if (!managers.includes(manager)) {
                manager.disconnect(signalId);
                this._bgManagerSignalIds.delete(manager);
            }
        }

        for (const manager of managers) {
            if (this._bgManagerSignalIds.has(manager)) {
                continue;
            }

            const signalId = manager.connect('changed', () => this._invalidateLuminance());
            this._bgManagerSignalIds.set(manager, signalId);
        }
    }

    // The background is animated while the overview or the lock screen is
    // shown/hidden; sampling before this deadline yields a mix of both states
    _markUnstable(durationMs) {
        const nowMs = GLib.get_monotonic_time() / 1000;
        this._unstableUntilMs = Math.max(this._unstableUntilMs, nowMs + durationMs);
    }

    _scheduleWallpaperSettleSample() {
        if (this._wallpaperSettleTimeoutId !== null)
            GLib.source_remove(this._wallpaperSettleTimeoutId);

        this._wallpaperSettleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAMPLE_DELAY_WALLPAPER, () => {
            this._wallpaperSettleTimeoutId = null;
            this._invalidateLuminance(0);
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleSampling(delay = SAMPLE_DELAY_WALLPAPER) {
        if (this._sampleTimeoutId !== null) {
            GLib.source_remove(this._sampleTimeoutId);
            this._sampleTimeoutId = null;
        }

        if (!this._autoForegroundColor || this._settings === null) {
            return;
        }

        // Do not sample while the overview or the lock screen is animating
        const remaining = this._unstableUntilMs - GLib.get_monotonic_time() / 1000;
        if (remaining > 0)
            delay = Math.max(delay, Math.ceil(remaining));

        this._sampleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._sampleTimeoutId = null;
            this._refreshBackgroundLuminance();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refreshBackgroundLuminance() {
        const nowMs = GLib.get_monotonic_time() / 1000;
        if (nowMs < this._unstableUntilMs) {
            // The background is still animating; retry once it has settled
            this._scheduleSampling(Math.ceil(this._unstableUntilMs - nowMs));
            return;
        }

        const state = this._currentBackgroundState;
        const generation = ++this._sampleGeneration;
        const luminance = await this._sampleBackgroundLuminance(state);

        // The overview/lock transition changes the background over its whole
        // duration; a sample taken in the middle is a mix of both states
        if (generation !== this._sampleGeneration ||
            GLib.get_monotonic_time() / 1000 < this._unstableUntilMs ||
            state !== this._currentBackgroundState) {
            return;
        }

        if (luminance !== null) {
            this._luminance.set(state, luminance);
        }

        this._applyAutoColorClass();
    }

    async _sampleBackgroundLuminance(state) {
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
        const sampleCount = this._settings.get_int(SAMPLE_COUNT_KEY);
        const luminances = [];
        const startUs = GLib.get_monotonic_time();

        for (let i = 0; i < sampleCount; i++) {
            const x = Math.round(monitor.x + margin + (i + 0.5) * usableWidth / sampleCount);

            try {
                const [color] = await this._screenshot.pick_color(x, y);
                if (color === null) {
                    continue;
                }

                // Cogl.Color channels are 0-255; 0.3/0.59/0.11 is what elementary OS uses
                luminances.push((0.3 * color.red + 0.59 * color.green + 0.11 * color.blue) / 255);
            } catch (e) {
                log(`Transparent Top Bar: failed to sample background at ${x}, ${y}: ${e.message}`);
            }
        }

        if (luminances.length === 0) {
            return null;
        }

        const elapsedMs = (GLib.get_monotonic_time() - startUs) / 1000;
        const sorted = [...luminances].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const mean = luminances.reduce((sum, value) => sum + value, 0) / luminances.length;

        if (this._debugLogging) {
            log('Transparent Top Bar: panel background luminance ' +
                `[${state}] median=${median.toFixed(3)} mean=${mean.toFixed(3)} ` +
                `(${luminances.length}/${sampleCount} samples in ${elapsedMs.toFixed(1)} ms)`);
        }

        return median;
    }

    _applyAutoColorClass() {
        let darkText = null;

        if (this._autoForegroundColor &&
            Main.panel.has_style_class_name('transparent-top-bar')) {
            const transparency = this._settings.get_int('transparency');
            const state = this._currentBackgroundState;
            let luminance = this._luminance.get(state);

            // The first visit of a state has no value yet; the desktop
            // wallpaper is a much better guess than the theme default
            if (luminance === undefined && state !== PanelBackgroundState.DESKTOP)
                luminance = this._luminance.get(PanelBackgroundState.DESKTOP);

            if (transparency < 100 && luminance !== undefined) {
                // the bar itself is rgba(0, 0, 0, transparency%), so it darkens its background
                const effective = luminance * (1 - transparency / 100);
                const threshold = this._settings.get_double(FOREGROUND_LUMINANCE_THRESHOLD_KEY);

                const previous = this._darkText.get(state);
                if (previous !== undefined && Math.abs(effective - threshold) < LUMINANCE_HYSTERESIS) {
                    darkText = previous;
                } else {
                    darkText = effective > threshold;
                }

                this._darkText.set(state, darkText);
            }
        }

        // Only touch the style classes when the result actually changes:
        // even a no-op remove/add pair counts as a style change, and a style
        // change cancels the panel background transition St is animating.
        // The light style is the default of #panel.transparent-top-bar, so
        // the dark class alone controls the foreground color
        if (darkText === true) {
            if (!Main.panel.has_style_class_name(DARK_TEXT_CLASS))
                Main.panel.add_style_class_name(DARK_TEXT_CLASS);
        } else {
            Main.panel.remove_style_class_name(DARK_TEXT_CLASS);
        }
    }

};
