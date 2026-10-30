# brother_ql-raster för Linux/Raspberry Pi, eller valfri nätverksväg.
# Används inte för USB på Windows — där ligger Brothers drivrutin kvar åt Chrome.

import sys

from win_print import PrinterError, resolve_backend

RASTER_WIDTH = 696
RASTER_HEIGHT = 271


def raster_image(image):
    return image.convert('RGB').resize((RASTER_WIDTH, RASTER_HEIGHT))


def to_instructions(image, model='QL-810W', label='62x29'):
    from brother_ql.conversion import convert
    from brother_ql.raster import BrotherQLRaster

    qlr = BrotherQLRaster(model)
    return convert(
        qlr=qlr,
        images=[raster_image(image)],
        label=label,
        rotate='0',
        threshold=70.0,
        dither=False,
        compress=False,
        red=False,
        dpi_600=False,
        hq=True,
        cut=True,
    )


def send_instructions(instructions, printer, backend_identifier, platform=None):
    system = platform or sys.platform
    if system == 'win32' and backend_identifier in {'pyusb', 'linux_kernel'}:
        raise PrinterError(
            'USB-raster via brother_ql används inte på Windows. '
            'Använd backend "windows" så Chrome-utskriften fortsätter att fungera.'
        )
    from brother_ql.backends.helpers import send
    send(instructions=instructions, printer_identifier=printer, backend_identifier=backend_identifier, blocking=True)


def print_image(image, config, platform=None):
    backend = resolve_backend(config.get('backend'), platform)
    if backend == 'windows':
        raise PrinterError('Windows-kön skrivs inte via brother_ql.')
    if backend == 'network':
        printer = (config.get('printer') or '').strip()
        if not printer.startswith('tcp://'):
            raise PrinterError('Nätverksbackend kräver printer på formen tcp://<ip>:9100.')
        send_instructions(to_instructions(image), printer, 'network')
        return
    if (platform or sys.platform) == 'win32':
        raise PrinterError('Linux-backend kan inte användas på Windows.')
    printer = (config.get('printer') or 'file:///dev/usb/lp0').strip()
    send_instructions(to_instructions(image), printer, 'linux_kernel')
