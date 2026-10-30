import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bridge
import raster_print
import win_print
from win_print import (
    PrinterError,
    apply_label_devmode,
    choose_printer,
    destination_px,
    print_image,
    resolve_backend,
    status_from_flags,
)


class FakeApi:
    def __init__(self, names):
        self.names = names
        self.calls = []
        self.devmode = SimpleNamespace(PaperSize=1, PaperWidth=0, PaperLength=0, Scale=50, Orientation=2, Fields=0)

    def list_printers(self):
        return list(self.names)

    def open_devmode(self, name):
        self.calls.append(('open', name))
        return self.devmode

    def dpi(self, name, devmode):
        self.calls.append(('dpi', name))
        return 300, 300

    def start_job(self, name, devmode, image, dest):
        self.calls.append(('print', name, devmode.PaperWidth, devmode.PaperLength, devmode.Scale, dest))

    def SetPrinter(self, *_args):
        raise AssertionError('SetPrinter får inte anropas')


class WindowsBackendTest(unittest.TestCase):
    def test_autodetect_ql810w_and_print_at_100_percent_without_touching_defaults(self):
        api = FakeApi(['Microsoft Print to PDF', 'Brother QL-810Wc'])
        image = SimpleNamespace(size=(732, 343), convert=lambda _mode: image)
        chosen = print_image(image, '', api=api)
        self.assertEqual(chosen, 'Brother QL-810Wc')
        self.assertEqual(api.devmode.PaperSize, 256)
        self.assertEqual(api.devmode.PaperWidth, 620)
        self.assertEqual(api.devmode.PaperLength, 290)
        self.assertEqual(api.devmode.Scale, 100)
        self.assertEqual(api.calls[-1][0], 'print')
        self.assertEqual(api.calls[-1][5], (732, 343))
        self.assertNotIn('SetPrinter', [name for name, *_rest in api.calls])

    def test_configured_name_wins_and_duplicates_need_an_explicit_name(self):
        self.assertEqual(choose_printer(['QL-810W', 'Annan'], 'Annan'), 'Annan')
        self.assertEqual(choose_printer(['Brother QL-810W'], ''), 'Brother QL-810W')
        with self.assertRaises(PrinterError):
            choose_printer(['QL-810W lager', 'QL-810W kassa'], '')

    def test_windows_refuses_pyusb(self):
        with self.assertRaises(PrinterError) as caught:
            resolve_backend('pyusb', 'win32')
        self.assertIn('Chrome', str(caught.exception))
        with self.assertRaises(PrinterError):
            resolve_backend('usb', 'win32')
        with self.assertRaises(PrinterError):
            resolve_backend('linux', 'win32')
        self.assertEqual(resolve_backend('', 'win32'), 'windows')
        self.assertEqual(resolve_backend('network', 'win32'), 'network')
        self.assertEqual(resolve_backend('', 'linux'), 'linux')

    def test_destination_matches_62x29_mm(self):
        self.assertEqual(destination_px(300, 300), (732, 343))
        devmode = SimpleNamespace(Fields=0)
        apply_label_devmode(devmode)
        self.assertEqual((devmode.PaperWidth, devmode.PaperLength, devmode.Scale), (620, 290, 100))

    def test_status_flags(self):
        self.assertEqual(status_from_flags(0), ('ok', ''))
        self.assertEqual(status_from_flags(0x10)[0], 'paper_out')
        self.assertEqual(status_from_flags(0x80)[0], 'offline')

    def test_log_redacts_the_bridge_key(self):
        secret = 'scb_' + 'a' * 40
        self.assertEqual(bridge.redact('nyckel ' + secret + ' slut', secret), 'nyckel *** slut')
        self.assertNotIn(secret, bridge.redact(secret, secret))

    def test_raster_canvas_is_brother_62x29_and_not_used_as_windows_usb(self):
        from PIL import Image
        image = Image.new('RGB', (732, 343), 'white')
        resized = raster_print.raster_image(image)
        self.assertEqual(resized.size, (696, 271))
        with self.assertRaises(PrinterError):
            raster_print.send_instructions(b'', 'usb://0x04f9', 'pyusb', platform='win32')

    def test_brother_ql_builds_raster_without_a_printer(self):
        try:
            import brother_ql  # noqa: F401
        except ImportError:
            self.skipTest('brother_ql hör till Linux-kraven, inte Windows-verkstaden')
        from PIL import Image
        data = raster_print.to_instructions(Image.new('RGB', (732, 343), 'white'))
        self.assertIsInstance(data, (bytes, bytearray))
        self.assertTrue(bytes(data).startswith(b'\x1b'))


if __name__ == '__main__':
    unittest.main()
