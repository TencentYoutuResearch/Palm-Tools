#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for the bundled Kode avatar sheet splitter."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

from PIL import Image


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "split_avatar_sheets.py"


def load_splitter() -> ModuleType:
    """Load the splitter as an importable module."""
    spec = importlib.util.spec_from_file_location("split_avatar_sheets", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load splitter: {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SPLITTER = load_splitter()


def frame_path(root: Path, state_path: str, frame_index: int) -> Path:
    """Return one generated frame path."""
    return root / state_path / f"frame-{frame_index + 1:02d}.png"


def unique_color(panel_index: int, frame_index: int) -> tuple[int, int, int, int]:
    """Return a stable unique color for one panel frame."""
    return (
        20 + panel_index * 20,
        30 + frame_index * 50,
        200 - panel_index * 10,
        255,
    )


def assert_center_color(
    test_case: unittest.TestCase,
    path: Path,
    expected: tuple[int, int, int, int],
) -> None:
    """Assert one generated frame's center pixel."""
    with Image.open(path) as frame:
        test_case.assertEqual(SPLITTER.DEFAULT_FRAME_SIZE, frame.size)
        test_case.assertEqual(expected, frame.convert("RGBA").getpixel((45, 47)))


class SplitAvatarSheetsTest(unittest.TestCase):
    """Validate both supported source layouts."""

    def test_quad_layout_maps_all_36_frames(self) -> None:
        """Split a deterministic 3x3 by 2x2 fixture."""
        cell_size = SPLITTER.REFERENCE_CELL_SIZE
        sheet = Image.new("RGBA", (cell_size * 3, cell_size * 3), (0, 0, 0, 255))
        for panel_index, (__, column, row) in enumerate(SPLITTER.PANEL_MAPPING):
            for frame_index in range(4):
                frame_column = frame_index % 2
                frame_row = frame_index // 2
                left = column * cell_size + frame_column * cell_size // 2
                top = row * cell_size + frame_row * cell_size // 2
                right = left + cell_size // 2
                bottom = top + cell_size // 2
                sheet.paste(unique_color(panel_index, frame_index), (left, top, right, bottom))

        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            SPLITTER.split_sheet(
                sheet,
                output_dir,
                SPLITTER.DEFAULT_FRAME_SIZE,
                SPLITTER.LAYOUT_QUAD,
                SPLITTER.REFERENCE_FRAME_X,
                SPLITTER.REFERENCE_FRAME_Y,
            )
            SPLITTER.verify_staging(output_dir, SPLITTER.DEFAULT_FRAME_SIZE)
            contact_sheet_path = output_dir.parent / "quad-contact-sheet.png"
            SPLITTER.create_contact_sheet(
                output_dir,
                contact_sheet_path,
                SPLITTER.DEFAULT_FRAME_SIZE,
            )
            with Image.open(contact_sheet_path) as contact_sheet:
                self.assertGreater(contact_sheet.width, SPLITTER.DEFAULT_FRAME_SIZE[0] * 4)
                self.assertGreater(contact_sheet.height, SPLITTER.DEFAULT_FRAME_SIZE[1] * 9)
            for panel_index, (state_path, __, ___) in enumerate(SPLITTER.PANEL_MAPPING):
                for frame_index in range(4):
                    assert_center_color(
                        self,
                        frame_path(output_dir, state_path, frame_index),
                        unique_color(panel_index, frame_index),
                    )

    def test_bottom_strip_supports_row_specific_offsets(self) -> None:
        """Split a bottom strip whose y offset differs for each row."""
        cell_size = SPLITTER.REFERENCE_CELL_SIZE
        frame_x = (20, 116, 212, 308)
        frame_y = (320, 300, 280)
        sheet = Image.new("RGBA", (cell_size * 3, cell_size * 3), (0, 0, 0, 255))
        for panel_index, (__, column, row) in enumerate(SPLITTER.PANEL_MAPPING):
            for frame_index in range(4):
                left = column * cell_size + frame_x[frame_index]
                top = row * cell_size + frame_y[row]
                right = left + SPLITTER.REFERENCE_FRAME_WIDTH
                bottom = top + SPLITTER.REFERENCE_FRAME_HEIGHT
                sheet.paste(unique_color(panel_index, frame_index), (left, top, right, bottom))

        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir)
            SPLITTER.split_sheet(
                sheet,
                output_dir,
                SPLITTER.DEFAULT_FRAME_SIZE,
                SPLITTER.LAYOUT_BOTTOM_STRIP,
                frame_x,
                frame_y,
            )
            SPLITTER.verify_staging(output_dir, SPLITTER.DEFAULT_FRAME_SIZE)
            for panel_index, (state_path, __, ___) in enumerate(SPLITTER.PANEL_MAPPING):
                for frame_index in range(4):
                    assert_center_color(
                        self,
                        frame_path(output_dir, state_path, frame_index),
                        unique_color(panel_index, frame_index),
                    )


if __name__ == "__main__":
    unittest.main()
