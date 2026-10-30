# Utskrift till den redan installerade Windows-kön för Brother QL-810Wc.
# DEVMODE gäller bara det här jobbet. Skrivaren standard (den Chrome använder)
# ändras inte, och WinUSB/Zadig används inte.

import sys

LABEL_WIDTH_MM = 62
LABEL_HEIGHT_MM = 29
QL_TOKEN = 'QL-810W'

# Windows DEVMODE, tiondels millimeter.
DM_ORIENTATION = 0x1
DM_PAPERSIZE = 0x2
DM_PAPERLENGTH = 0x4
DM_PAPERWIDTH = 0x8
DM_SCALE = 0x10
DMPAPER_USER = 256
DMORIENT_PORTRAIT = 1
LOGPIXELSX = 88
LOGPIXELSY = 90
PRINTER_ENUM_LOCAL = 2
PRINTER_ENUM_CONNECTIONS = 4

PRINTER_STATUS_ERROR = 0x2
PRINTER_STATUS_PAPER_JAM = 0x8
PRINTER_STATUS_PAPER_OUT = 0x10
PRINTER_STATUS_OFFLINE = 0x80
PRINTER_STATUS_DOOR_OPEN = 0x400000

USB_BACKENDS = {'usb', 'pyusb', 'libusb', 'zadig', 'winusb'}


class PrinterError(Exception):
    pass


def destination_px(dpi_x, dpi_y, width_mm=LABEL_WIDTH_MM, height_mm=LABEL_HEIGHT_MM):
    return (
        int(round(width_mm / 25.4 * dpi_x)),
        int(round(height_mm / 25.4 * dpi_y)),
    )


def apply_label_devmode(devmode):
    """Sätter 62×29 mm och skala 100 % på ett jobb-DEVMODE. Anropa inte SetPrinter."""
    devmode.PaperSize = DMPAPER_USER
    devmode.PaperWidth = int(round(LABEL_WIDTH_MM * 10))
    devmode.PaperLength = int(round(LABEL_HEIGHT_MM * 10))
    devmode.Scale = 100
    devmode.Orientation = DMORIENT_PORTRAIT
    devmode.Fields = (getattr(devmode, 'Fields', 0) or 0) | DM_ORIENTATION | DM_PAPERSIZE | DM_PAPERLENGTH | DM_PAPERWIDTH | DM_SCALE
    return devmode


def choose_printer(names, configured_name):
    cleaned = [n for n in (names or []) if n]
    wanted = (configured_name or '').strip()
    if wanted:
        for name in cleaned:
            if name.lower() == wanted.lower():
                return name
        for name in cleaned:
            if wanted.lower() in name.lower():
                return name
        available = ', '.join(cleaned) or 'inga'
        raise PrinterError('Skrivaren "%s" finns inte i Windows. Tillgängliga: %s' % (wanted, available))
    matches = [name for name in cleaned if QL_TOKEN.lower() in name.lower()]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise PrinterError(
            'Flera skrivare matchar QL-810W (%s). Sätt printer_name i config.json.' % ', '.join(matches)
        )
    available = ', '.join(cleaned) or 'inga'
    raise PrinterError(
        'Hittade ingen skrivare vars namn innehåller QL-810W. '
        'Kontrollera att Brothers drivrutin är installerad. Tillgängliga: %s' % available
    )


def resolve_backend(configured, platform=None):
    system = platform or sys.platform
    raw = (configured or '').strip().lower()
    if not raw:
        raw = 'windows' if system == 'win32' else 'linux'
    if system == 'win32' and raw in USB_BACKENDS:
        raise PrinterError(
            'USB via pyusb/libusb används inte på Windows. '
            'Det skulle byta ut Brother-drivrutinen och slå sönder utskrift från Chrome. '
            'Använd backend "windows", som skriver till den befintliga skrivarkön.'
        )
    if system == 'win32' and raw in {'linux', 'brother_ql', 'file'}:
        raise PrinterError(
            'På Windows ska backend vara "windows" så Brother-drivrutinen och Chrome-utskrift lämnas orörda.'
        )
    if raw == 'windows':
        return 'windows'
    if raw == 'network':
        return 'network'
    if raw in {'linux', 'brother_ql', 'file'}:
        return 'linux'
    raise PrinterError('Okänd backend: ' + raw)


def status_from_flags(flags):
    flags = flags or 0
    if flags & PRINTER_STATUS_OFFLINE:
        return 'offline', 'Skrivaren är offline'
    if flags & PRINTER_STATUS_PAPER_OUT:
        return 'paper_out', 'Etiketter saknas'
    if flags & PRINTER_STATUS_PAPER_JAM:
        return 'paper_jam', 'Pappersstopp'
    if flags & PRINTER_STATUS_DOOR_OPEN:
        return 'cover_open', 'Locket är öppet'
    if flags & PRINTER_STATUS_ERROR:
        return 'error', 'Skrivarfelsignal'
    return 'ok', ''


def list_printer_names(win32print):
    rows = win32print.EnumPrinters(PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS)
    return [row[2] for row in rows]


def print_image(image, printer_name='', api=None):
    """Skickar bilden i 100 % utan egna marginaler. api injiceras i tester."""
    if api is None:
        api = Win32Api()
    chosen = choose_printer(api.list_printers(), printer_name)
    devmode = api.open_devmode(chosen)
    apply_label_devmode(devmode)
    dpi_x, dpi_y = api.dpi(chosen, devmode)
    dest = destination_px(dpi_x, dpi_y)
    api.start_job(chosen, devmode, image, dest)
    return chosen


class Win32Api:
    """Riktig Windows-kö. SetPrinter anropas inte."""

    def list_printers(self):
        import win32print
        return list_printer_names(win32print)

    def open_devmode(self, printer_name):
        import win32print
        handle = win32print.OpenPrinter(printer_name)
        try:
            return win32print.GetPrinter(handle, 2)['pDevMode']
        finally:
            win32print.ClosePrinter(handle)

    def dpi(self, printer_name, devmode):
        import win32con
        import win32gui
        import win32ui
        handle = win32gui.CreateDC('WINSPOOL', printer_name, None, devmode)
        dc = win32ui.CreateDCFromHandle(handle)
        try:
            return dc.GetDeviceCaps(win32con.LOGPIXELSX), dc.GetDeviceCaps(win32con.LOGPIXELSY)
        finally:
            dc.DeleteDC()

    def start_job(self, printer_name, devmode, image, dest):
        import win32gui
        import win32ui
        from PIL import ImageWin
        handle = win32gui.CreateDC('WINSPOOL', printer_name, None, devmode)
        dc = win32ui.CreateDCFromHandle(handle)
        try:
            dc.StartDoc('Scanny etikett')
            dc.StartPage()
            dib = ImageWin.Dib(image.convert('RGB'))
            width, height = dest
            dib.draw(dc.GetHandleOutput(), (0, 0, width, height))
            dc.EndPage()
            dc.EndDoc()
        finally:
            dc.DeleteDC()


def probe(printer_name=''):
    try:
        import win32print
    except ImportError:
        return {'printerStatus': 'error', 'detail': 'pywin32 saknas', 'printerName': printer_name or ''}
    try:
        chosen = choose_printer(list_printer_names(win32print), printer_name)
        handle = win32print.OpenPrinter(chosen)
        try:
            info = win32print.GetPrinter(handle, 2)
            status, detail = status_from_flags(info.get('Status') or 0)
        finally:
            win32print.ClosePrinter(handle)
        return {'printerStatus': status, 'detail': detail, 'printerName': chosen}
    except Exception as err:
        return {'printerStatus': 'error', 'detail': str(err)[:200], 'printerName': printer_name or ''}
