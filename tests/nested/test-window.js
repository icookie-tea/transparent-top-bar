// Plain GTK4 window used as the "window near the panel" test subject.
//
// It is painted dark on purpose: a full-width window in front of the panel
// stands in for a fullscreen app (terminal, video, editor), so the strip the
// extension samples below the panel belongs to the window while the panel is
// opaque, while the test wallpaper behind it stays bright.  See test D in
// automation.js.
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';

const app = new Gtk.Application({application_id: 'org.ttbtest.Window'});

app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'TTB Test Window',
        default_width: 500,
        default_height: 300,
    });

    const provider = new Gtk.CssProvider();
    provider.load_from_string(
        'window, window > .titlebar, headerbar {' +
        '  background-color: #101010;' +
        '  background-image: none;' +
        '  color: #f0f0f0;' +
        '}');
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

    const label = new Gtk.Label({label: 'TTB test window', vexpand: true});
    window.set_child(label);
    window.present();
});

app.run([]);
