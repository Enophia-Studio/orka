---
name: godot
description: Godot 4 projects (GDScript or C#, scenes, resources, autoloads, export). Use for gameplay, UI, tools or export work in a folder with a project.godot file.
license: MIT
---

# Godot

## Orient first
- Read `project.godot`: the engine version (`config/features`), autoloads, input map, main scene and rendering method. Use Godot 4 APIs (`@export`, `@onready`, `super()`, typed signals); Godot 3 code from memory will not run.
- Note whether the project uses GDScript, C# (a `.csproj` next to `project.godot`) or both, and follow its folder layout and naming.
- Never edit `.godot/` (the import cache) or `.import` files. `.tscn` and `.tres` are text, but change them by hand only for small, clear edits: a wrong `ext_resource` id or `uid` breaks the scene. Prefer building nodes in code, or ask the user to change the scene in the editor.

## GDScript habits
- Type everything: `var speed: float = 200.0`, `func hit(amount: int) -> void`. Typed code runs faster and the editor catches mistakes.
- `@export` for values designers tune, `@onready var sprite: Sprite2D = $Sprite2D` for child nodes; avoid long `get_node()` paths into other scenes. Use `%UniqueName` for nodes a script owns.
- Communicate upward with signals (`signal died`, `died.emit()`), downward with method calls. Connect in code with `node.some_signal.connect(callable)` and disconnect when the listener goes away.
- Physics in `_physics_process(delta)`, input in `_unhandled_input(event)`, visuals in `_process(delta)`. `CharacterBody2D/3D` moves with `velocity` and `move_and_slide()`.
- Data lives in custom `Resource` classes (`class_name`, `@export` fields) saved as `.tres`, not in big dictionaries.
- Autoloads are for truly global services (saving, audio, scene switching), not a home for all state.

## Scenes
- One responsibility per scene; compose by instancing. Change scenes through `get_tree().change_scene_to_file()` or a loader autoload.
- Free nodes with `queue_free()`, never `free()` inside their own callbacks.

## Check
- Run the project or the scene, or headless (`godot --headless --path . --quit` parses every script; the project's test runner such as GUT or gdUnit4 runs tests), and read the errors.
- Say which scene or inspector changes the user still has to make in the editor.
