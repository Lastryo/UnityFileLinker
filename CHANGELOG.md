# Change Log

All notable changes to the `UnityFileLinker` extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - 2026-11-10

### Added

- Added `.csproj` updates when folders containing scripts are renamed, moved, copied, or deleted.
- Added `.asmref` support, with references by assembly name or GUID.
- Added `Assembly-CSharp-firstpass` and `Assembly-CSharp-Editor-firstpass` as default targets for `Assets/Plugins`, `Assets/Standard Assets`, and `Assets/Pro Standard Assets`.
- Added Player project support: scripts are kept in `*.Player.csproj` alongside their main project.
- Added the `UnityFileLinker: Resync Project Files` command.
- Added support for embedded packages in the `Packages` folder.
- Added the `UnityFileLinker` output channel and the `unityFileLinker.showInfoNotifications` setting.

### Changed

- The extension now activates only in Unity workspaces.
- Notifications now use complete localized messages.
- File changes are now processed in batches: a branch switch or asset import reads and writes each `.csproj` once and shows one notification.
- Routine updates now appear in the status bar and output channel instead of pop-ups. Warnings and errors still pop up.
- Scripts stay where they are, with a single warning, when their `.asmdef` is invalid. They no longer fall back to `Assembly-CSharp`.

### Fixed

- Fixed removal of one script deleting neighbouring entries when a multi-line `<Compile>` element followed them.
- Fixed scripts being dropped from every project when the target `.csproj` had not been generated yet.
- Fixed all scripts being treated as editor scripts when the project lived under a folder named `Editor`.
- Fixed files outside the root `Assets` folder being added to projects.
- Fixed scripts in folders Unity ignores, such as `Samples~`, being added during resync.
- Fixed `.asmdef` files with a BOM being reported as invalid.
- Fixed scripts being inserted after references in the compile item group.

### Removed

- Removed the template command and the unused `xml2js` dependency.

## [0.1.1] - 2026-04-30

### Fixed

- New `<Compile>` entries are now inserted after existing ones.

## [0.1.0] - 2026-04-30

### Added

- Added automatic `.asmdef` watching for create, change, delete, rename, and move operations.
- Added `.asmdef` scope resync that scans affected C# scripts and updates their target `.csproj` files.
- Added support for removing stale script references from old `.csproj` files when scripts are reassigned to another assembly.
- Added duplicate detection for `<Compile Include="...">` entries.
- Added batched `.asmdef` resync to reduce repeated `.csproj` reads and writes in larger Unity projects.
- Added summary notifications for `.asmdef` resync operations.

### Changed

- Improved `.csproj` update logic to preserve existing project file formatting instead of rebuilding XML.
- Improved script path matching by normalizing path separators and casing.
- Improved rename handling for scripts and `.asmdef` files inside the Unity `Assets` folder.
- Improved `.csproj` removal logic to search all project files for the exact script path.
- Improved handling of Unity default projects, including `Assembly-CSharp.csproj` and `Assembly-CSharp-Editor.csproj`.
- Improved README content for GitHub and Visual Studio Marketplace usage.

### Fixed

- Fixed stale `.csproj` references after moving scripts between folders with different `.asmdef` files.
- Fixed possible duplicate script entries after repeated create, move, or resync operations.
- Fixed invalid or incomplete `.asmdef` files causing update failures.
- Fixed race conditions by serializing `.csproj` update operations.
- Fixed accidental watcher handling outside the Unity `Assets` folder.
- Fixed safer handling of deleted folders and missing paths.

## [0.0.5]

### Added

- Initial Marketplace release of UnityFileLinker.
- Basic `.cs` file synchronization for Unity-generated `.csproj` files.
- Basic support for Unity `Editor` folders and assembly definition files.
