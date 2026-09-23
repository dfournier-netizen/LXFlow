# LXFlow import review — current in 1.3.0

Updated 2026-09-22. This is the current status; earlier handoff entries are historical.

## Completed

- XLSX/XLS uses displayed text, preserving clock times, dates, and durations over 24 hours. CSV/TSV retains literal text and leading zeros.
- Starting row uses physical spreadsheet row numbers, including blank rows, and applies to all sheets. The header checkbox supports headerless input. Changing either option reparses before enabling merge.
- Decimal-looking time columns produce warnings. Each column offers Preserve displayed text (default), Excel decimal days to time (24h), or Excel decimal days to duration. Conversion is explicit, rounds to seconds, leaves existing time strings unchanged, and never guesses units.
- Duplicate/blank/reserved headers receive unique safe keys. Wider data rows retain extra columns. Excel errors remain visible with warnings.
- DOCX structural parsing retains entities, paragraphs, line breaks, merged cells, and prose around tables. Merged-cell alignment is flagged for review.
- Plain-text memo detection requires structured fields as well as a weekday; preamble text is retained.
- PDF preserves filenames and screen labels, recognizes 24-hour cue anchors, warns about approximate reading order and image assignment, and retains unmatched images in separate rows. Image-only pages explain the lack of OCR. Failed image decoding is reported.
- All mapped rows can be previewed, with spreadsheet source row numbers. Duplicate destination mappings are rejected. Initial mappings do not depend on which tables were visited.
- Merge captures its destination, validates all tables before applying, and commits atomically as one shared undo step. The client waits for a server acknowledgement; errors remain reviewable. Upload temporary files are cleaned on success and failure.

## Time-decimal diagnosis

The retained legacy Run of Show distribution contains the older raw-value spreadsheet parser. It can produce Excel fractions such as 0.2708333333 instead of 6:30:00 AM. Use a freshly extracted LXFlow 1.3.0 package and verify the version badge. Existing incorrectly imported cells are not rewritten automatically: reimport the original workbook. If the source itself contains unformatted decimal days, choose the explicit per-column conversion after reviewing the preview.

The Schaeffler workbook was verified through upload, production client mapping, WebSocket merge, saved JSON, and restart. Its main sheet has 101 nonblank data rows; UPDATES has 7. The first timed cue remains 6:30:00 AM, 7:30:00 AM, and 1:00:00 in Start Time, End Time, and TRT. The browser preview and committed grid were checked independently.

## Validation

- npm test: 26 passing regression tests covering pointers, import mapping/conversion, sheet/document fixtures, shared history, and HTTP/client/WS/disk round trips.
- LXFLOW_IMPORT_WORKBOOK can point to an approved local workbook when running node --test tests/import-roundtrip.test.mjs; the Schaeffler file passed. It is not copied into fixtures or releases.
- npm run test:packaging: Windows executable launch, spreadsheet start-row/time/duration upload, bundled PDF text/image import, and both Mac binary architecture checks passed.
- Browser: real workbook preview and merge preserve time strings; Space selects cue 1 of 101 after import.
- All five release ZIPs and checksums rebuilt for 1.3.0. Mac runtime execution still needs a Mac; the Apple Silicon launcher performs ad-hoc signing there.
- node scripts/audit-imports.mjs provides additional parser characterization without changing saved shows.

## Remaining limits and follow-up work

1. PDF reading order, rotated/multicolumn layouts, and image associations remain heuristic. No OCR; complex layouts require review. Images are not shown in the mapping preview.
2. Parsing stores extracted images before merge; canceling can leave unused image assets. Introduce staged assets with commit/cleanup before claiming cancellation leaves no files.
3. Starting row/header options apply to all workbook sheets. Per-sheet options and creating separate days/shows from tables remain future work. Merge all explicitly appends into the selected show.
4. Expand the approved fixture corpus and normalized source-location metadata across formats; add more complicated nested/merged Word and positioned PDF cases. Reproducibility comparisons should exclude fresh cue/image IDs.
5. A merge acknowledgement timeout is uncertain completion, not permission to retry blindly; inspect the show first as the UI advises. Durable request deduplication would improve reconnect recovery.
