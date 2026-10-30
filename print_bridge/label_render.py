# Etikett 62×29 mm (DK-11209) i 300 dpi.
# Innehållet följer webbläsarens etikett: namn, art.nr och Code128.

import os

from PIL import Image, ImageDraw, ImageFont

LABEL_WIDTH_MM = 62
LABEL_HEIGHT_MM = 29
DPI = 300


def px(mm, dpi=DPI):
    return int(round(mm / 25.4 * dpi))


def label_size(dpi=DPI):
    return px(LABEL_WIDTH_MM, dpi), px(LABEL_HEIGHT_MM, dpi)


def _font_file(bold):
    names = (
        ['arialbd.ttf', 'Arialbd.ttf', 'DejaVuSans-Bold.ttf', 'LiberationSans-Bold.ttf']
        if bold else
        ['arial.ttf', 'Arial.ttf', 'DejaVuSans.ttf', 'LiberationSans-Regular.ttf']
    )
    windir = os.environ.get('WINDIR', r'C:\Windows')
    roots = [
        os.path.join(windir, 'Fonts'),
        '/usr/share/fonts/truetype/dejavu',
        '/usr/share/fonts/truetype/liberation',
        '/usr/share/fonts/truetype/freefont',
    ]
    for root in roots:
        for name in names:
            path = os.path.join(root, name)
            if os.path.isfile(path):
                return path
    return None


def load_font(size_px, bold):
    path = _font_file(bold)
    if path:
        return ImageFont.truetype(path, size_px)
    return ImageFont.load_default()


def _ellipsis(draw, text, font, max_width):
    value = str(text or '')
    if draw.textlength(value, font=font) <= max_width:
        return value
    trimmed = value
    while trimmed and draw.textlength(trimmed + '…', font=font) > max_width:
        trimmed = trimmed[:-1]
    return (trimmed + '…') if trimmed else '…'


def _barcode(code, width, height):
    from barcode import Code128
    from barcode.writer import ImageWriter
    from io import BytesIO

    buffer = BytesIO()
    writer = ImageWriter()
    Code128(str(code), writer=writer).write(buffer, options={
        'module_width': 0.2,
        'module_height': 6.0,
        'quiet_zone': 1.0,
        'font_size': 8,
        'text_distance': 1.0,
        'write_text': True,
        'dpi': DPI,
    })
    buffer.seek(0)
    image = Image.open(buffer).convert('RGB')
    return image.resize((max(1, width), max(1, height)), Image.Resampling.NEAREST)


def render_label(name, article_no='', code='', dpi=DPI):
    """Ritar etiketten som den ser ut i webbläsaren för DK-11209."""
    width, height = label_size(dpi)
    image = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(image)
    scale = dpi / float(DPI)
    pad_x = int(round(px(3) * scale))
    pad_y = int(round(px(2) * scale))
    name_font = load_font(max(8, int(round(9 / 72 * dpi))), True)
    art_font = load_font(max(8, int(round(7 / 72 * dpi))), False)
    content_w = max(1, width - pad_x * 2)

    name_text = _ellipsis(draw, name, name_font, content_w)
    art_text = ''
    if article_no:
        art_text = _ellipsis(draw, 'Art.nr: ' + str(article_no), art_font, content_w)

    name_box = draw.textbbox((0, 0), name_text or ' ', font=name_font)
    name_h = name_box[3] - name_box[1]
    art_h = 0
    if art_text:
        art_box = draw.textbbox((0, 0), art_text, font=art_font)
        art_h = art_box[3] - art_box[1]
    bc_h = int(round(px(12) * scale))
    bc_w = max(1, int(content_w * 0.95))
    barcode = _barcode(code, bc_w, bc_h) if code else None
    if barcode is None:
        bc_h = 0

    gap = int(round(2 * scale))
    stack = name_h + (gap + art_h if art_text else 0) + (gap + bc_h if barcode else 0)
    y = max(pad_y, (height - stack) // 2)

    name_w = draw.textlength(name_text, font=name_font)
    draw.text(((width - name_w) / 2, y), name_text, fill='black', font=name_font)
    y += name_h
    if art_text:
        y += gap
        art_w = draw.textlength(art_text, font=art_font)
        draw.text(((width - art_w) / 2, y), art_text, fill='black', font=art_font)
        y += art_h
    if barcode is not None:
        y += gap
        image.paste(barcode, ((width - barcode.width) // 2, min(y, height - barcode.height)))
    return image
