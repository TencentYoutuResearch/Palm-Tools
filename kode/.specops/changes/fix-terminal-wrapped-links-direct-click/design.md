---
schema_version: 2
id: fix-terminal-wrapped-links-direct-click
document_class: design
status: proposed
---

# Design

## Logical line reconstruction

xterm marks a buffer line with `isWrapped=true` when it is the continuation of the
previous physical line. For a requested physical row:

1. Walk upward while the current line is wrapped to find the logical start.
2. Walk downward while the next line is wrapped to find the logical end.
3. Concatenate visible cells from all rows without inserting implicit newlines.
4. Record every character's physical buffer row, start x, and exclusive end x.
5. Trim only the logical line's trailing padding cells.

The resulting logical text is the input to the existing URL and path parsers.

## Multi-row link ranges

`TerminalLinkTarget.start` and `.end` remain character offsets in logical text.
A position map converts them to xterm `IBufferRange`:

```text
logical character offset
  -> { physical row, start x, end x }
```

When a target spans rows, its range start and end use different `y` values. xterm
already supports links whose range spans rows; the link provider must return the
same target when called for any physical row that intersects the range.

Adjacent path-component ranges stay non-overlapping after mapping. A directory
component may itself span rows.

## Click hit-testing

The current click hit-test reads only the physical row under the pointer. It will
instead reconstruct the logical line containing that row and find the character
whose physical cell range contains the pointer. The normal target scan then
activates the complete URL or path component.

This also prevents line wrapping from changing whether a click is considered a
link.

## Direct click on every desktop platform

The activation predicate becomes platform-independent:

```text
activate link = primary click event exists
```

Windows, macOS, and Linux use the same ordinary single click. The modifier keys
are no longer required, though existing temporary modifier state does not break
activation.

Kode's Codex/TCodex mouse ownership adapter must ignore mousedown when it starts
on a recognized link on every platform, allowing xterm to route the click to the
link provider. The adapter still owns drag selection after movement crosses the
drag threshold.

## Verification strategy

- Pure `isWrapped` reconstruction tests cover two-row and three-row URLs, paths,
  hard newlines, CJK wide cells, and trailing padding.
- Mapping tests assert range start/end rows and columns.
- Hit-test tests click the first, middle, and final wrapped segments.
- Activation tests cover direct click on Windows, macOS, and Linux.
- Mouse tests prove a click on a link bypasses deferred CLI click ownership while
  drag selection still works.
- Real GUI tests use a narrow terminal to force wrapping, then click URL/path
  fragments on Windows and macOS.

## Risks

- Reconstructing the wrong logical range could merge hard newlines. Tests must
  ensure only `isWrapped=true` rows are joined.
- Wide characters and combining characters can shift cell coordinates. The
  position map must store physical x positions rather than deriving columns from
  string length.
- Repeatedly rebuilding long logical lines on mouse move may be costly. Cache the
  last reconstructed line and target list by physical range and buffer version.

## Rollback

Restore physical-line parsing and the prior platform modifier predicate. No data
or persistence migration is involved.
