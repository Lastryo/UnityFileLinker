# Change Log

All notable changes to the `UnityFileLinker` extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
