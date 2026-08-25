import base64
import io
import tempfile
import unittest
from pathlib import Path

from PIL import Image

import server


class ServerTests(unittest.TestCase):
    def test_ensure_config_creates_and_merges_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.yaml"
            config = server.ensure_config(path)
            self.assertTrue(path.exists())
            self.assertEqual(config["paths"]["palette_import"], "/home/yli/Dropbox/Comics/PaintShop")
            path.write_text("paths:\n  line_art_import: /tmp/lines\n", encoding="utf-8")
            config = server.ensure_config(path)
            self.assertEqual(config["paths"]["line_art_import"], "/tmp/lines")
            self.assertEqual(config["paths"]["finished_export"], "/home/yli/Dropbox/Comics/PaintShop")

    def test_completion_is_case_insensitive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Sketch.PNG").touch()
            (root / "ignore.txt").touch()
            config = {"paths": {"palette_import": directory, "line_art_import": directory, "finished_export": directory}}
            matches = server.complete_paths(config, "line_art", "sket")
            self.assertEqual([item["name"] for item in matches], ["Sketch.PNG"])

    def test_image_data_and_png_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "line.png"
            Image.new("RGB", (37, 19), "white").save(source)
            opened = server.image_data(str(source))
            self.assertEqual((opened["width"], opened["height"]), (37, 19))
            buffer = io.BytesIO()
            Image.new("RGB", (8, 6), "red").save(buffer, "PNG")
            data_url = "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()
            config = {"paths": {"palette_import": directory, "line_art_import": directory, "finished_export": directory}}
            exported = server.save_export(config, "done", data_url)
            self.assertTrue(Path(exported["path"]).is_file())
            self.assertEqual(Path(exported["path"]).suffix, ".png")


if __name__ == "__main__":
    unittest.main()
