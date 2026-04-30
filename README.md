# UnityFileLinker

UnityFileLinker is a Visual Studio Code extension for Unity projects that keeps Unity-generated `.csproj` files in sync when C# scripts or assembly definitions change.

It helps reduce manual project regeneration and keeps VS Code aware of newly created, moved, renamed, or deleted Unity C# files.

## Why use UnityFileLinker?

When working with Unity projects in VS Code, `.csproj` files can sometimes get out of sync after moving scripts, creating new files, deleting files, or changing `.asmdef` structure.

UnityFileLinker watches your Unity `Assets` folder and updates the related `.csproj` files automatically, so your C# project references stay closer to the actual Unity project structure.

## Installation

UnityFileLinker is available on the Visual Studio Marketplace:

https://marketplace.visualstudio.com/items?itemName=lastryo.unityfilelinker

You can also install it from inside Visual Studio Code:

1. Open the Extensions view.
2. Search for `UnityFileLinker`.
3. Click Install.

## Features

- Automatically adds new `.cs` files under `Assets` to the correct `.csproj`.
- Removes deleted `.cs` files from project files.
- Updates `.csproj` entries when `.cs` files are renamed or moved.
- Supports Unity `.asmdef` files.
- Resolves scripts to the matching assembly project when an `.asmdef` is present.
- Falls back to Unity default projects when no valid `.asmdef` is found.
- Handles `Editor` scripts through Unity editor project conventions.
- Resyncs affected scripts when `.asmdef` files are created, changed, deleted, renamed, or moved.
- Removes stale script references from old `.csproj` files during `.asmdef` resync.
- Avoids duplicate `<Compile Include="...">` entries.
- Preserves existing `.csproj` formatting as much as possible.
- Uses batched `.asmdef` resync to reduce unnecessary file reads and writes.

## How it works

UnityFileLinker watches files inside the Unity `Assets` folder:

```text
**/Assets/**/*.cs
**/Assets/**/*.asmdef
```

When a C# script is created, deleted, renamed, or moved, the extension finds the correct `.csproj` file and updates its `<Compile Include="...">` entries.

When an `.asmdef` file changes, UnityFileLinker scans the affected folder, resolves the correct target project for each script, removes stale references from other project files, and writes only the `.csproj` files that actually changed.

## Assembly Definition support

If a script is located inside a folder with a Unity `.asmdef` file, UnityFileLinker uses the assembly name from that `.asmdef` to determine the target `.csproj`.

Example project structure:

```text
Assets/Gameplay/Gameplay.asmdef
Assets/Gameplay/Player.cs
```

Example `.asmdef` content:

```json
{
  "name": "Gameplay"
}
```

In this case, `Player.cs` will be linked to:

```text
Gameplay.csproj
```

If no valid `.asmdef` is found, UnityFileLinker falls back to Unity's default project files:

```text
Assembly-CSharp.csproj
Assembly-CSharp-Editor.csproj
```

## Requirements

- Visual Studio Code `1.95.0` or newer.
- A Unity project opened as a VS Code workspace.
- Unity-generated `.csproj` files in the workspace root.

## Important notes

UnityFileLinker does not generate `.csproj` files by itself. It updates project files that already exist in the Unity project root.

If Unity has not generated a project file for a newly created or renamed `.asmdef` yet, the extension may show a warning that the corresponding `.csproj` was not found. In that case, regenerate project files from Unity and try again.

## License

MIT
