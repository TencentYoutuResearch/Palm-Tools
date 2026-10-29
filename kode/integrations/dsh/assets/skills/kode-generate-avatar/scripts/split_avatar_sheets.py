#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Split a Kode 3x3 character sheet into the 36-frame gallery layout."""

from __future__ import annotations

import argparse
import logging
import re
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw


LOGGER = logging.getLogger(__name__)
AVATAR_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
GRID_SIZE = 3
LAYOUT_BOTTOM_STRIP = "bottom-strip"
LAYOUT_QUAD = "quad"
LAYOUT_CHOICES = (LAYOUT_BOTTOM_STRIP, LAYOUT_QUAD)
REFERENCE_CELL_SIZE = 418
REFERENCE_FRAME_X = (20, 113, 206, 299)
REFERENCE_FRAME_Y = (280, 280, 280)
REFERENCE_FRAME_WIDTH = 91
REFERENCE_FRAME_HEIGHT = 94
QUAD_INSET = 8
DEFAULT_FRAME_SIZE = (91, 94)
CONTACT_SHEET_LABEL_WIDTH = 112
CONTACT_SHEET_GAP = 4
CONTACT_SHEET_PADDING = 8

# all.png 面板映射：面板序号、列、行 -> Kode 状态目录。
PANEL_MAPPING = (
    ("running/01", 0, 0),  # 敲代码中
    ("running/02", 1, 0),  # 吃薯片
    ("running/03", 2, 0),  # 喝可乐
    ("running/04", 0, 1),  # 看漫画
    ("running/05", 1, 1),  # 调试中
    ("running/06", 2, 1),  # 编译成功
    ("error", 0, 2),  # 编译失败
    ("idle", 1, 2),  # 摸鱼中
    ("awaiting", 2, 2),  # 思考中
)


def parse_integer_list(
    value: str,
    expected_lengths: tuple[int, ...],
    label: str,
) -> tuple[int, ...]:
    """Parse a comma-separated integer list."""
    try:
        values = tuple(int(part.strip()) for part in value.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{label} must contain integers") from error
    if len(values) not in expected_lengths:
        expected = " or ".join(str(length) for length in expected_lengths)
        raise argparse.ArgumentTypeError(f"{label} must contain {expected} comma-separated values")
    return values


def parse_frame_x(value: str) -> tuple[int, ...]:
    """Parse four bottom-strip x offsets."""
    return parse_integer_list(value, (4,), "frame-x")


def parse_frame_y(value: str) -> tuple[int, ...]:
    """Parse one shared or three row-specific bottom-strip y offsets."""
    values = parse_integer_list(value, (1, 3), "frame-y")
    if len(values) == 1:
        return values * GRID_SIZE
    return values


def parse_size(value: str) -> tuple[int, int]:
    """Parse a WIDTHxHEIGHT output size."""
    parts = value.lower().split("x")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("frame size must look like WIDTHxHEIGHT")
    try:
        width, height = (int(part) for part in parts)
    except ValueError as error:
        raise argparse.ArgumentTypeError("frame size must contain integers") from error
    if not 16 <= width <= 1024 or not 16 <= height <= 1024:
        raise argparse.ArgumentTypeError("frame dimensions must be between 16 and 1024")
    return width, height


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Split one Kode 3x3 character sheet into 36 avatar frames.",
    )
    parser.add_argument(
        "--layout",
        choices=LAYOUT_CHOICES,
        default=LAYOUT_BOTTOM_STRIP,
        help="Source layout: bottom-strip for all.png compatibility or quad for reference-free 2x2 frames",
    )
    parser.add_argument(
        "--source",
        required=True,
        type=Path,
        help="Generated 3x3 PNG sheet",
    )
    parser.add_argument(
        "--output-dir",
        required=True,
        type=Path,
        help="Target gallery directory for one avatar",
    )
    parser.add_argument(
        "--frame-size",
        type=parse_size,
        default=DEFAULT_FRAME_SIZE,
        help="Output frame size as WIDTHxHEIGHT (default: 91x94)",
    )
    parser.add_argument(
        "--frame-x",
        type=parse_frame_x,
        default=REFERENCE_FRAME_X,
        help="bottom-strip x offsets in 418-unit cell coordinates (default: 20,113,206,299)",
    )
    parser.add_argument(
        "--frame-y",
        type=parse_frame_y,
        default=REFERENCE_FRAME_Y,
        help="bottom-strip y offset: one value or three row values (default: 280)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Back up and replace an existing avatar directory",
    )
    parser.add_argument(
        "--contact-sheet",
        type=Path,
        help="Optional QA contact-sheet PNG path outside the avatar output directory",
    )
    return parser.parse_args()


def validate_bottom_strip_coordinates(
    frame_x: tuple[int, ...],
    frame_y: tuple[int, ...],
) -> None:
    """Validate bottom-strip coordinates against one reference cell."""
    if len(frame_x) != 4 or len(frame_y) != GRID_SIZE:
        raise ValueError("bottom-strip layout requires four x offsets and three row y offsets")
    for offset in frame_x:
        if offset < 0 or offset + REFERENCE_FRAME_WIDTH > REFERENCE_CELL_SIZE:
            raise ValueError(f"frame-x offset is outside the reference cell: {offset}")
    for offset in frame_y:
        if offset < 0 or offset + REFERENCE_FRAME_HEIGHT > REFERENCE_CELL_SIZE:
            raise ValueError(f"frame-y offset is outside the reference cell: {offset}")


def validate_args(args: argparse.Namespace) -> tuple[Path, Path]:
    """Validate arguments and return absolute source and output paths."""
    source = args.source.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    if not source.is_file():
        raise ValueError(f"source sheet does not exist: {source}")
    if not AVATAR_ID_PATTERN.fullmatch(output_dir.name):
        raise ValueError(
            "output directory name must be a lowercase avatar slug using letters, numbers, or hyphens"
        )
    if args.layout == LAYOUT_BOTTOM_STRIP:
        validate_bottom_strip_coordinates(args.frame_x, args.frame_y)
    if args.contact_sheet is not None:
        contact_sheet = args.contact_sheet.expanduser().resolve()
        try:
            contact_sheet.relative_to(output_dir)
        except ValueError:
            pass
        else:
            raise ValueError("contact-sheet must be outside the avatar output directory")
    return source, output_dir


def load_sheet(path: Path) -> Image.Image:
    """Load and validate one generated 3x3 source sheet."""
    try:
        with Image.open(path) as source:
            image = source.convert("RGBA")
    except (OSError, ValueError) as error:
        raise ValueError(f"cannot read source sheet {path}: {error}") from error

    if image.width < 3 * 100 or image.height < 3 * 100:
        raise ValueError(f"source sheet is too small for a 3x3 mapping: {path} ({image.size})")
    ratio = image.width / image.height
    if ratio < 0.95 or ratio > 1.05:
        raise ValueError(f"source sheet must be square: {path} ({image.size})")
    return image


def crop_bottom_strip_frame(
    sheet: Image.Image,
    column: int,
    row: int,
    frame_index: int,
    frame_x: tuple[int, ...],
    frame_y: tuple[int, ...],
) -> Image.Image:
    """Crop one frame from an all.png-style bottom strip."""
    cell_width = sheet.width / GRID_SIZE
    cell_height = sheet.height / GRID_SIZE
    reference_x = frame_x[frame_index]
    left = column * cell_width + (reference_x / REFERENCE_CELL_SIZE) * cell_width
    top = row * cell_height + (frame_y[row] / REFERENCE_CELL_SIZE) * cell_height
    right = left + (REFERENCE_FRAME_WIDTH / REFERENCE_CELL_SIZE) * cell_width
    bottom = top + (REFERENCE_FRAME_HEIGHT / REFERENCE_CELL_SIZE) * cell_height
    return sheet.crop((round(left), round(top), round(right), round(bottom)))


def crop_quad_frame(
    sheet: Image.Image,
    column: int,
    row: int,
    frame_index: int,
) -> Image.Image:
    """Crop one frame from a 2x2 subgrid inside a 3x3 state panel."""
    cell_width = sheet.width / GRID_SIZE
    cell_height = sheet.height / GRID_SIZE
    frame_column = frame_index % 2
    frame_row = frame_index // 2
    quadrant_width = cell_width / 2
    quadrant_height = cell_height / 2
    inset_x = (QUAD_INSET / REFERENCE_CELL_SIZE) * cell_width
    inset_y = (QUAD_INSET / REFERENCE_CELL_SIZE) * cell_height
    left = column * cell_width + frame_column * quadrant_width + inset_x
    top = row * cell_height + frame_row * quadrant_height + inset_y
    right = column * cell_width + (frame_column + 1) * quadrant_width - inset_x
    bottom = row * cell_height + (frame_row + 1) * quadrant_height - inset_y
    return sheet.crop((round(left), round(top), round(right), round(bottom)))


def crop_frame(
    sheet: Image.Image,
    column: int,
    row: int,
    frame_index: int,
    layout: str,
    frame_x: tuple[int, ...],
    frame_y: tuple[int, ...],
) -> Image.Image:
    """Crop one frame using the selected source layout."""
    if layout == LAYOUT_QUAD:
        return crop_quad_frame(sheet, column, row, frame_index)
    return crop_bottom_strip_frame(sheet, column, row, frame_index, frame_x, frame_y)


def split_sheet(
    sheet: Image.Image,
    staging_dir: Path,
    frame_size: tuple[int, int],
    layout: str,
    frame_x: tuple[int, ...],
    frame_y: tuple[int, ...],
) -> None:
    """Write four mapped frames for each of the nine mapped panel states."""
    for state_path, column, row in PANEL_MAPPING:
        target_dir = staging_dir / state_path
        target_dir.mkdir(parents=True, exist_ok=True)
        for frame_index in range(4):
            frame = crop_frame(sheet, column, row, frame_index, layout, frame_x, frame_y)
            frame = frame.resize(frame_size, Image.Resampling.LANCZOS)
            frame.save(
                target_dir / f"frame-{frame_index + 1:02d}.png",
                format="PNG",
                optimize=True,
            )


def verify_staging(staging_dir: Path, frame_size: tuple[int, int]) -> None:
    """Verify the exact 36-frame Kode layout before publishing."""
    frames = sorted(staging_dir.glob("*/*/frame-*.png"))
    direct_state_frames = sorted(staging_dir.glob("*/frame-*.png"))
    if len(frames) + len(direct_state_frames) != 36:
        raise ValueError(
            f"expected 36 output frames (24 running + 12 status), "
            f"found {len(frames) + len(direct_state_frames)}"
        )
    for frame_path in frames + direct_state_frames:
        with Image.open(frame_path) as frame:
            if frame.size != frame_size:
                raise ValueError(f"unexpected frame size for {frame_path}: {frame.size}")


def create_contact_sheet(
    staging_dir: Path,
    output_path: Path,
    frame_size: tuple[int, int],
) -> None:
    """Render all nine states and four frames into one QA image."""
    frame_width, frame_height = frame_size
    row_width = frame_width * 4 + CONTACT_SHEET_GAP * 3
    width = CONTACT_SHEET_PADDING * 2 + CONTACT_SHEET_LABEL_WIDTH + row_width
    height = (
        CONTACT_SHEET_PADDING * 2
        + frame_height * len(PANEL_MAPPING)
        + CONTACT_SHEET_GAP * (len(PANEL_MAPPING) - 1)
    )
    contact_sheet = Image.new("RGBA", (width, height), (24, 24, 24, 255))
    draw = ImageDraw.Draw(contact_sheet)
    for row_index, (state_path, __, ___) in enumerate(PANEL_MAPPING):
        top = CONTACT_SHEET_PADDING + row_index * (frame_height + CONTACT_SHEET_GAP)
        draw.text((CONTACT_SHEET_PADDING, top + 4), state_path, fill=(235, 235, 235, 255))
        for frame_index in range(4):
            path = staging_dir / state_path / f"frame-{frame_index + 1:02d}.png"
            with Image.open(path) as source:
                frame = source.convert("RGBA")
            left = CONTACT_SHEET_PADDING + CONTACT_SHEET_LABEL_WIDTH
            left += frame_index * (frame_width + CONTACT_SHEET_GAP)
            contact_sheet.alpha_composite(frame, (left, top))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    contact_sheet.convert("RGB").save(output_path, format="PNG", optimize=True)
    LOGGER.info("Created avatar QA contact sheet at %s", output_path)


def next_backup_path(output_dir: Path) -> Path:
    """Return an unused timestamped backup path beside the avatar directory."""
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = output_dir.with_name(f"{output_dir.name}.backup-{timestamp}")
    suffix = 1
    while candidate.exists():
        candidate = output_dir.with_name(f"{output_dir.name}.backup-{timestamp}-{suffix}")
        suffix += 1
    return candidate


def publish(staging_dir: Path, output_dir: Path, force: bool) -> Optional[Path]:
    """Atomically publish a staged avatar and preserve any replaced directory."""
    backup_dir: Optional[Path] = None
    if output_dir.exists():
        if not force:
            raise ValueError(f"output directory already exists: {output_dir}; pass --force after approval")
        backup_dir = next_backup_path(output_dir)
        output_dir.rename(backup_dir)
        LOGGER.info("Preserved existing avatar at %s", backup_dir)
    staging_dir.rename(output_dir)
    return backup_dir


def generate_avatar(args: argparse.Namespace) -> tuple[Path, Optional[Path]]:
    """Create and publish one avatar from a 3x3 source sheet."""
    source, output_dir = validate_args(args)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}-", dir=output_dir.parent))
    try:
        split_sheet(
            load_sheet(source),
            staging_dir,
            args.frame_size,
            args.layout,
            args.frame_x,
            args.frame_y,
        )
        verify_staging(staging_dir, args.frame_size)
        if args.contact_sheet is not None:
            create_contact_sheet(
                staging_dir,
                args.contact_sheet.expanduser().resolve(),
                args.frame_size,
            )
        backup_dir = publish(staging_dir, output_dir, args.force)
    except (OSError, ValueError):
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        raise
    return output_dir, backup_dir


def main() -> int:
    """Run the command-line entry point."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args = parse_args()
    try:
        output_dir, backup_dir = generate_avatar(args)
    except (OSError, ValueError) as error:
        LOGGER.error("Avatar generation failed: %s", error)
        return 1
    LOGGER.info("Created 36 avatar frames at %s using layout=%s", output_dir, args.layout)
    if backup_dir is not None:
        LOGGER.info("Previous avatar backup: %s", backup_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
