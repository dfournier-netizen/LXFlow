# LXFlow packaging

Run `npm ci`, then `npm run dist`. This bundles the current source, builds pinned
Node 22 standalone executables for Windows x64, Intel Mac and Apple Silicon Mac,
and writes five ZIPs plus SHA256SUMS.txt in dist. `npm run dist:launchers` builds
only the two Node-dependent launcher ZIPs. `npm run test:packaging` checks the
Windows executable on loopback with isolated temporary data and verifies both
Mac architecture headers; actual macOS runtime testing still needs a Mac.

The ZIP builder uses an explicit three-file allowlist and fixed ZIP timestamps
and modes. It never includes saved shows, images, configuration or nested old
packages. Existing installations and legacy Run of Show distributions are kept.
Pinned dependencies and no-bytecode packaging make builds repeatable; executable
byte identity across different build hosts is not guaranteed. macOS executable
and command files carry executable Unix permissions in their ZIP entries.

The first standalone build downloads platform Node runtimes. The build uses
the supported [pkg Node 22 targets](https://yao-pkg.github.io/pkg/guide/targets)
and [no-bytecode cross-platform packaging](https://yao-pkg.github.io/pkg/guide/bytecode).
Windows packages are unsigned and macOS packages are not notarized. The Mac
launcher applies a local ad-hoc code signature when needed (required for Apple
Silicon builds produced on Windows). Launch via Start LXFlow.command. Test downloaded
packages on the intended operating system before production deployment.

Upgrade by stopping the existing server, backing up its runtime files, and
copying runofshow-data.json, runofshow-config.json and runofshow-images from the
old app directory to the new package's app directory. Undo history is embedded
in the data file; preserve its .bak sibling as well for disk recovery.

Release 1.3.0 (2026-09-22): all five archives rebuilt; 26 source regression tests,
real-workbook round trips, and Windows executable spreadsheet/PDF smoke checks pass.
Verify the 1.3.0 browser badge after upgrading. Legacy packages are retained for data
safety and contain an older parser; do not use them to validate current imports.

Release 1.3.0 (2026-09-22) adds the tablet interface pass and retains the 1.2.0 import
fixes. All five archives rebuilt; tablet and phone viewport checks completed in-browser.
