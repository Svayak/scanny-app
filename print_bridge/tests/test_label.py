import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import label_render
from label_render import label_size, render_label


class LabelRenderTest(unittest.TestCase):
    def test_size_is_62x29_mm_at_300_dpi(self):
        self.assertEqual(label_size(300), (732, 343))
        image = render_label('Borrbit 8mm', '12345', '7312345678901')
        self.assertEqual(image.size, (732, 343))
        self.assertEqual(image.mode, 'RGB')

    def test_barcode_changes_the_pixels_and_the_label_is_not_blank(self):
        first = render_label('Samma namn', '1', '111111')
        second = render_label('Samma namn', '1', '222222')
        self.assertNotEqual(first.tobytes(), second.tobytes())
        colors = first.getcolors(maxcolors=500000)
        self.assertTrue(any(count > 20 and color != (255, 255, 255) for count, color in colors))

    def test_article_number_is_part_of_the_layout(self):
        with_art = render_label('Bricka', 'ART-9', '555555')
        without = render_label('Bricka', '', '555555')
        self.assertNotEqual(with_art.tobytes(), without.tobytes())

    def test_long_name_still_fits_the_die_cut(self):
        image = render_label('Extra lång produktbenämning som inte får sticka utanför etiketten', '9988', 'ABC123')
        self.assertEqual(image.size, (732, 343))


if __name__ == '__main__':
    unittest.main()
