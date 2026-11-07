---
name: unreal-engine
description: Unreal Engine 5 projects (C++ gameplay code, Blueprints, modules, plugins, the build tools). Use for gameplay, editor tooling or build work in a folder with a .uproject file.
license: MIT
---

# Unreal Engine

## Orient first
- Read the `.uproject` (engine association, modules, enabled plugins) and the `*.Build.cs` / `*.Target.cs` files before you add code. Use the APIs of that engine version.
- Learn the project's layout: game module(s) under `Source/`, plugins under `Plugins/`, content under `Content/`. Find its base classes (a custom `ACharacter`, `UGameInstance`, subsystems) and reuse them.
- Never edit `Binaries/`, `Intermediate/`, `Saved/`, `DerivedDataCache/` or `.uasset`/`.umap` files as text. Assets change in the editor, not on disk.

## C++ that fits the engine
- Every reflected type needs `UCLASS()`/`USTRUCT()`/`UENUM()` plus `GENERATED_BODY()`, and the `.generated.h` include last. Class prefixes matter: `A` actors, `U` objects and components, `F` structs, `E` enums, `I` interfaces.
- Expose to the editor and Blueprints on purpose: `UPROPERTY(EditAnywhere, BlueprintReadOnly, Category="...")`, `UFUNCTION(BlueprintCallable)`. Keep members `private`/`protected`, with `meta=(AllowPrivateAccess="true")` where Blueprints need them.
- Pointers to `UObject`s must be `UPROPERTY()` (or `TObjectPtr<>`) so the garbage collector sees them; use `TWeakObjectPtr` for references you do not own and check `IsValid()` before use.
- Create components in the constructor with `CreateDefaultSubobject`; spawn actors with `GetWorld()->SpawnActor`. Do gameplay setup in `BeginPlay`, not in the constructor.
- Turn off `PrimaryActorTick.bCanEverTick` unless the actor really needs it; prefer timers (`FTimerManager`) and delegates to polling in `Tick`.
- Replication: mark properties `Replicated`/`ReplicatedUsing` and register them in `GetLifetimeReplicatedProps`; change game state on the server (`HasAuthority()`), with `Server`/`Client`/`NetMulticast` RPCs only where needed.
- New dependencies go in the module's `Build.cs` (`PublicDependencyModuleNames` / `PrivateDependencyModuleNames`).

## Blueprints and C++ together
- Put systems and heavy logic in C++, expose a small API, and leave tuning and content wiring to Blueprint subclasses. Say which Blueprint the user must reparent or update after a C++ change, because you cannot edit `.uasset` files.

## Build and check
- Build with the project's own route (the IDE solution, or `Build.bat`/`RunUAT` from the engine install) and read the compiler output; a Live Coding success is not a full build.
- After header changes, ask the user to close the editor and do a full build: hot reload breaks easily.
- Report what still has to be done in the editor (assets, Blueprint graphs, project settings).
