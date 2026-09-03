# 0001 - Desktop shell and IPC boundary

## Status

Accepted.

## Context

Slice 1 needs a local desktop shell for the reader-first layout. The core is
responsible for local file access, byte-range reads, indexing, and bounded
paginated projection data for the WebView.

## Decision

Use Tauri 2 as the desktop shell, with a Rust binary as the native core and a
Vite + vanilla TypeScript frontend for the three-column shell.

IPC boundaries:

- Local files remain owned by Rust; JavaScript never reads them directly.
- IPC passes only small, bounded projections and windows.
- Responses must fit the documented 1 MiB contract or return cursors for more.
- Large text is chunked and capped below 256 KiB per chunk.
- The WebView is limited to same-origin assets and does not load remote content.
- Rust command handlers validate paths and bounds before reading.

## Consequences

The app depends on Tauri's lifecycle and security model. The empty shell keeps
file access disabled until the Rust core and command contracts are implemented.
