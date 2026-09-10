// Plain GTK4 window used as the "window near the panel" test subject.
import Gtk from 'gi://Gtk?version=4.0';

const app = new Gtk.Application({application_id: 'org.ttbtest.Window'});

app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'TTB Test Window',
        default_width: 500,
        default_height: 300,
    });

    const label = new Gtk.Label({label: 'TTB test window', vexpand: true});
    window.set_child(label);
    window.present();
});

app.run([]);
