from __future__ import annotations

import pytest

from deepfake_grid_analyzer.parser import parse_frames_line, parse_gemini_response


def test_parse_yes_response_with_ranges() -> None:
    result = parse_gemini_response("Yes - Confidence: 87%\nFrames: 1-10, 13, 16, 18-25", total_frames=25)
    assert result.is_deepfake is True
    assert result.confidence == 87
    assert result.frames_text == "1-10, 13, 16, 18-25"
    assert result.frame_indices[0] == 1
    assert result.frame_indices[-1] == 25


def test_parse_no_response_with_none() -> None:
    result = parse_gemini_response("No - Confidence: 12%\nFrames: none", total_frames=30)
    assert result.is_deepfake is False
    assert result.confidence == 12
    assert result.frame_indices == tuple()
    assert result.frames_text == "none"


def test_parse_frames_line_canonicalizes_ranges() -> None:
    indices, frames_text = parse_frames_line("Frames: 1, 2, 3, 5, 7, 8")
    assert indices == (1, 2, 3, 5, 7, 8)
    assert frames_text == "1-3, 5, 7-8"


def test_parse_frames_line_rejects_duplicates_and_overlaps() -> None:
    with pytest.raises(ValueError, match="duplicate or overlapping"):
        parse_frames_line("Frames: 1-3, 3")


def test_parse_frames_line_rejects_out_of_bounds() -> None:
    with pytest.raises(ValueError, match="out of bounds"):
        parse_frames_line("Frames: 1-31", total_frames=30)


def test_parse_response_requires_two_lines() -> None:
    with pytest.raises(ValueError, match="exactly two lines"):
        parse_gemini_response("Yes - Confidence: 87%")


def test_parse_response_rejects_no_with_frames() -> None:
    with pytest.raises(ValueError, match="must use 'Frames: none'"):
        parse_gemini_response("No - Confidence: 20%\nFrames: 2")


def test_parse_frames_line_requires_strict_separator_spacing() -> None:
    with pytest.raises(ValueError, match="Invalid frames line"):
        parse_frames_line("Frames: 1,2,3")
import pytest

from deepfake_grid_analyzer.parser import parse_frames_line, parse_gemini_response


def test_parse_yes_response_with_ranges():
    result = parse_gemini_response("Yes - Confidence: 87%\nFrames: 1-10, 13, 16, 18-25", total_frames=25)
    assert result.is_deepfake is True
    assert result.confidence == 87
    assert result.frames_text == "1-10, 13, 16, 18-25"
    assert result.frame_indices[0] == 1
    assert result.frame_indices[-1] == 25


def test_parse_no_response_with_none():
    result = parse_gemini_response("No - Confidence: 12%\nFrames: none", total_frames=30)
    assert result.is_deepfake is False
    assert result.confidence == 12
    assert result.frame_indices == tuple()
    assert result.frames_text == "none"


def test_parse_frames_line_canonicalizes_ranges():
    indices, frames_text = parse_frames_line("Frames: 1, 2, 3, 5, 7, 8")
    assert indices == (1, 2, 3, 5, 7, 8)
    assert frames_text == "1-3, 5, 7-8"


def test_parse_frames_line_rejects_duplicates_and_overlaps():
    with pytest.raises(ValueError, match="duplicate or overlapping"):
        parse_frames_line("Frames: 1-3, 3")


def test_parse_frames_line_rejects_out_of_bounds():
    with pytest.raises(ValueError, match="out of bounds"):
        parse_frames_line("Frames: 1-31", total_frames=30)


def test_parse_response_requires_two_lines():
    with pytest.raises(ValueError, match="exactly two lines"):
        parse_gemini_response("Yes - Confidence: 87%")


def test_parse_response_rejects_no_with_frames():
    with pytest.raises(ValueError, match="must use 'Frames: none'"):
        parse_gemini_response("No - Confidence: 20%\nFrames: 2")


def test_parse_frames_line_requires_strict_separator_spacing():
    with pytest.raises(ValueError, match="Invalid frames line"):
        parse_frames_line("Frames: 1,2,3")
