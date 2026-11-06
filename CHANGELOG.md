# Changelog

## Unreleased

**Radar**

- **Markdown notes** (desktop): after each analysis that found or decided something new, Radar writes what is new in that run to `~/.orka/radar/notes/radar-<date>-<time>.md` and to `LATEST.md` beside it, for handing to a coding assistant: each gap with its priority, size, tools, rationale and the proposal text **Start a session** uses, one line per feature Orka has or does not want, and the new changes as summaries with links (never release-note text). The 50 newest notes are kept. `radar.writeNotes` (on by default) turns them off; they stay on your machine.
- **Open notes folder** and **Save as Markdown…** in the Radar tab and in **Settings → Control**: the second saves the whole report to a file you pick in the system's save dialog (or to the notes folder as `radar-report-<date>.md`) and says where.

**Fixes**

- Windows: **Open folder…** and the other system dialogs (choose a file, an error box) opened behind Orka's window, so the button seemed to do nothing and each click left one more hidden dialog. They now open in front and have a taskbar button, and the folder dialog opens once however often the button is clicked.
- **Accounts** showed Antigravity CLI as *Unknown* even when signed in. It now asks `agy models` (agy 1.5.0 and newer): a model list means signed in (the label shows how many models, since agy names no account), a failure means signed out, with how to sign in. Only the count is kept; agy older than 1.5.0 still gets the update hint.

## 0.7.0

Accounts and CLIs: sign in to each CLI from Orka, install Claude Code, Antigravity CLI and Codex from it, and pick the model and effort per session in the message box. See [Accounts](README.md#accounts) and [Installing CLIs](README.md#installing-clis).

**Accounts**

- **Accounts** at the bottom of the session list (desktop, with a count such as 2/3 signed in, and an icon in the closed rail), an **Add account** popup and **Settings → Accounts** (desktop and VS Code). Each installed CLI shows the account its own status command reports (`claude auth status`, `codex login status`, `cursor-agent status`); Antigravity CLI, Gemini CLI and Copilot CLI have none, so they say where to look instead, and Copilot says when a GitHub token variable stands in for its sign-in (the variable's name, never its value). The commands run when you first open the list, the popup or the tab, and on **Check**; never on a timer.
- **Sign in… / Sign out…** run the vendor's own command, shown before it runs, in a terminal you can see, in your home folder; the status is asked again when the terminal closes. Sign-out asks first. Orka never reads, stores or forwards a sign-in, a token or a vendor's credential files, and keeps what a status command printed in memory only.
- **Claude Code profiles** for separate accounts, such as work and personal: each has its own config folder (`~/.claude-<id>`, as `CLAUDE_CONFIG_DIR`) that Orka creates empty and never reads. Add one in **Settings → Accounts** or the popup (a note says separate accounts are for separate work), sign in to it there, and remove it (its folder stays). Profiles are machine settings (`accounts.claudeProfiles`, `accounts.claudeProfile`), so a repository cannot set them.
- **One profile per CLI at a time:** while a session runs Claude Code on one profile, a run on another profile is refused with a notice. Orka never switches profiles on its own, also not on a usage limit, and a fallback never runs on another profile.
- The agent CLI cards and the Claude Code card in **Settings → Providers** link to **Accounts…**; the main agent card offers **Install…** and **Accounts…** when no agent CLI is installed.

**The model menu in the message box**

- **Each session has its own model, effort and Claude Code profile**, in a menu next to the send button (both layouts, and the VS Code panel). A new session starts from the settings; a change applies from your next message and never stops a running process. **Use as default** writes the choice to the settings for sessions started later; other open sessions keep theirs. The choice is saved with the task.
- **Effort levels** as the provider takes them: Claude API low to max, Claude Code its own default to max, OpenAI and Gemini their default, low, medium, high. The effort, thinking and reasoning selects in **Settings → Providers** became **Default effort** lines; their setting keys are unchanged.
- **ACP agents** show the models and thought levels they advertise for their session (after its first message), and the choice is sent before the next prompt. An agent's own modes are never offered, so they cannot get around Orka's permission mode.
- **A context gauge** next to the menu: a small ring showing how full the context window is, from the last request's prompt and answer, against the window the provider reported (Claude Code and ACP agents that send `usage_update`). Hidden when the provider reports no window; click it for the usage panel.

**Agent CLIs**

- **Antigravity CLI** (`agent:antigravity`) joins the catalog: Orka runs Google's `agy acp` (agy 1.5.0 or newer), which Google documents for any ACP client. You sign in by running `agy` in a terminal; Orka never touches that sign-in. The agent's card (and `orka agents`) links Google's ACP page, its terms and its FAQ, which calls wrapping agy in third-party apps unsupported on consumer plans: the choice of sign-in is yours. An older agy shows its version and `agy update` on **Check**.
- **The main agent's picker (Settings → Agents) lists every agent CLI**, also those that are off or not installed, marked as such. Picking one turns it on; when it is not installed, a notice says how to install it. With no agent CLI installed, the main agent card says so. Turning off the agent CLI that is the main agent asks first, and a main agent setting that names an agent that is off is reported once instead of switching silently.
- **Install from Orka:** Claude Code, Antigravity CLI and Codex (with codex-acp) can be installed from the **Install…** button on a missing-CLI notice. A dialog shows the vendor's official install command, its source, folder and docs; only **Install** runs it, in a terminal you can see, never elevated and never on its own. Codex first checks for Node.js 16 or newer (npm installs codex-acp). When the terminal closes (or on **Check again**), Orka looks for the program, also in Antigravity's install folder, and offers to choose it if it is not on Orka's PATH yet; for Claude Code it offers to turn it on. Copilot, Cursor and Gemini CLI show their command to copy. See [Installing from Orka](docs/EXTERNAL_AGENTS.md#installing-from-orka).
- **Gemini CLI** is now labelled **legacy** (Gemini API key or Code Assist Standard/Enterprise only; personal Google accounts moved to Antigravity CLI). Its id stays `gemini`, so existing settings keep working.

**CLI-first**

- Until you pick a main provider, a ready CLI comes first: Claude Code (turned on and logged in), else an agent CLI you turned on whose check passed; API providers follow as a fallback. The provider pickers list a model API only once it has a key.
- **Radar** can run on Claude Code, and uses it by default when it is turned on and logged in: as a plain model with every built-in tool, MCP server, settings file and slash command off, and no tools from Radar. With Claude Code an analysis runs only when you click **Analyze**, never automatically, and the Radar tab no longer speaks of an API key then. Agent CLIs still never run Radar.

**Fixes**

- In VS Code, the Claude Code profile settings are declared as machine settings, so adding or choosing a profile is saved (VS Code refuses to write an undeclared setting).

**Unchanged**

- The VS Code panel keeps one session. Orka itself makes no new network requests and sends no telemetry: status commands, installs and sign-ins are the vendors' programs, started only by your click (an installer you start downloads its CLI from the vendor).

## 0.6.0

The desktop app runs several sessions at once, one per folder. See [Parallel sessions (desktop)](README.md#parallel-sessions-desktop).

**Parallel sessions (desktop app, "Sessions and panels" layout)**

- **Switch without stopping.** Clicking another open session in the list shows it as it is, with everything it did in the background; the session you leave keeps working. A new session in another folder no longer ends the one you were in. One session is open per folder, up to 8 at a time; at 8, the least recently used idle session is closed (its task stays in the list).
- **The list shows each open session's state:** a dot while it runs, a shield while it waits for your approval. An unsaved session is a draft at the top of its folder. The **…** menu of a background session offers **Stop** while it runs and **Close (keeps it in the list)** while it is idle.
- **Approvals in the background:** a badge in the sidebar's head (and in its rail) counts the other sessions waiting for you, the window title starts with the count, and an in-app notice with **Show** tells you once per burst. Nothing is written into the waiting session's conversation.
- **Each session keeps its own:** conversation, task, changes and their review, approvals, **Always allow** answers, hand-off, the `.mcp.json` servers of its folder (MCP servers from your settings are shared) and, while the window is open, the unsent text in the message box. The permission mode and per-category rules apply to every session.
- **A limit on sessions running at once** (default 3, 1 to 8): **Settings → Control → Sessions running at once** (`sessions.maxRunning`). Each running session may start an agent CLI or Claude Code process. A request over the limit is refused with a notice; nothing is queued or started.
- **One session at a time in a folder:** a request is refused while another session works in the same folder (also under another name, such as a link or other letter case) or in a folder inside it or around it. **+** in a folder whose session runs shows that session instead of starting a second one. A Freebuff hand-off holds its folder the same way. Saving in the editor waits while a session works in an overlapping folder.
- **Leaving a file with unsaved changes asks first**, also when **Show** on a notice switches sessions.
- Open sessions are not restored after a restart; their tasks are in the list and the history.

**Unchanged**

- The VS Code panel and the classic single-column window keep one session, as before: a folder change ends it and is refused while the agent runs. Revert, Revert all and Go back still keep the files you edited yourself.

**Security and privacy**

- No new network access and no telemetry: sessions, their states and drafts stay on your machine.

## 0.5.0

The desktop app gets Files: browse the open folder, edit files and send them to the agent. See [Files (desktop)](README.md#files-desktop).

**Files (desktop app)**

- **A Files tab** next to the plan and changes and Radar, also opened from the session list, its rail or **Ctrl+Shift+E**. The tree lists a folder when you open it, marks the open file, unsaved changes, the agent's changes and the files you edited, and dims dependency and build folders. `.git` is not listed.
- **An editor (CodeMirror 6)** for UTF-8 text files up to 2 MB. It opens in place of the conversation, with the message box kept below it and a **Chat | file** switch in the title bar. Syntax colours for JavaScript/TypeScript, JSON, CSS and Unity's USS, HTML, Markdown, Python, YAML (and Unity's text assets) and C# and other C-like languages; other files open as plain text. Search with Ctrl+F, save with **Ctrl+S**, **Esc** goes back to the message box. A file's line endings and UTF-8 BOM are kept as they were; a file with mixed line endings opens read-only, and binary, non-UTF-8 and larger files are not opened.
- **A save never overwrites a newer file.** When the file changed on disk since you opened it, the save is refused and a banner offers **Reload**, **Compare** (the disk against your text) or **Keep mine**, which asks before it overwrites. A file that changes on disk while you have no unsaved changes simply follows. **Open in system app** opens a document, image or media file in its own program, never a program or a script.
- **No save while an agent works** or a Freebuff hand-off is open, so a save is never taken for the agent's change. You can keep typing; save when it stops.
- **Links that leave the folder are neither listed nor opened**, and every read and write checks the real path of the file it opens.

**Send to the agent**

- **The selected lines** (Send selection, **Ctrl+L** or the **+** menu) or **the whole file** (Attach file) go along with the next message; the agent sees the file, the line numbers and the text. A secret-looking file (`.env`, keys) is added only after you confirm, and web access and MCP tools then ask for approval for the rest of the task.

**Your edits are protected**

- A file you saved yourself after the agent changed it gets a pencil mark, **Edited by you**, in Changes and in the Files tree. **Revert all** and **Go back** keep such files as you saved them and name them (Go back already in its question), and **Revert part** leaves alone a part that touches lines you edited. **Revert** on such a file offers only **Undo only the agent's part** (with Git, when your lines and the agent's are apart), and never a revert that would throw your edits away.

**Changes**

- In the desktop app, the changed parts of a file are syntax-highlighted. Keep and Revert part check that the part is still the one you saw.

**Core**

- `safeFs`: reads and writes inside the workspace that follow no link out of it and check the real path and identity of the file they open; a replace checks the file's hash under the same open file.
- `ChangeTracker` records files the user edited; `revert`, `revertAll`, `revertHunk` and `rewindTo` respect them, `revertAgentPart` undoes only the agent's part, and `rewind` returns the files it `kept`. The CLI prints them.

**Security**

- The desktop window's CSP allows its per-page nonce for style elements (the editor's), and nothing else changes. No new network access and no telemetry: files are read and written on your machine only. The VS Code extension and the CLI gain no new network access or permissions.

**Third-party**

- CodeMirror and Lezer (MIT) are in the desktop app, listed in its `THIRD_PARTY_NOTICES.txt`.

## 0.4.0

The desktop app gets Radar: it watches what other AI coding tools ship and, when you ask, proposes what Orka could add. See [Radar (desktop)](README.md#radar-desktop).

**Radar (desktop app)**

- **A tab next to the plan and changes** on the right of the window, also reachable from the session list and its rail. The classic single-column window has its switches in **Settings → Control → Radar**. The VS Code extension and the CLI have no Radar.
- **Off until you turn it on.** Before that, the tab lists every site it would contact (GitHub release feeds and the changelogs of Claude Code, Cursor, Kiro, VS Code, GitHub Copilot and ChatGPT Codex), and nothing is fetched.
- **While it is on**, it checks the public feeds 30 seconds after the start and then every hour (each feed at most every 6 to 24 hours; an unchanged feed is recognised by a fingerprint kept locally, so nothing a site handed out, such as an `ETag`, is sent back), never with a model call. The tab shows the count of new entries, when it last looked and which feeds failed. Turning it off stops the timer and any running check. The requests carry only Orka's name and version; nothing about you or your projects is sent, and there is no telemetry. With several windows open, only one runs Radar (`~/.orka/radar/lock`); the others show its report and take over when it stops.
- **Analysis only on request:** **Analyze** runs on a provider and model you pick for Radar (or the main agent's, when that is a model API with a key), never on an agent CLI or Claude Code, on your own key and tokens: at most 40 entries and 100 model calls a run, with progress, the calls used and a **Stop** button. Entries stay waiting until their changes are decided, so a stopped, failed or capped run is carried on by the next one without paying for its summaries again. `radar.autoAnalyze` (off by default) analyzes right after a check found something.
- **The report** groups similar features across tools, shows Orka's status for each change (has it, has part of it, lacks it, not for Orka) and the decision with priority (P1–P3) and size (S/M/L), links the release notes (https pages only) and lets you retry entries the model could not read (or that the provider rejected in two runs while it answered the others), which wait aside instead of holding up the rest. Summaries, comparisons and proposals are written in the UI language (English or Turkish).
- **Start a session** on a proposal opens a new session in the current folder with the proposal in the message box (after anything you had already typed), and sends nothing; the session never sees release-note text.
- **Files:** `~/.orka/radar/state.json` and `report.json` beside it (or under `ORKA_HOME`). A state file or report that fails its checks is set aside and not used; a report with a few bad rows is read without them.
- **Settings** (desktop only, from your own settings file): `radar.enabled`, `radar.provider`, `radar.model`, `radar.autoAnalyze`.

**Core**

- The radar engine behind it (`packages/core/src/radar`): a checked source list, polling with no model calls that sends back nothing a server issued, a five-stage analysis in which every model answer has no tools and is checked against a strict JSON format, and validated reports.
- Its analysis takes a `language`: the text people read comes back in that language, while JSON keys, enum values and tags stay English and the check against copied release-note text still applies.

## 0.3.0

Coding agents you installed yourself can now be Orka's main agent, and the desktop session list gets your own groups.

**Agent CLIs (agent mode)**

- **Supported agents:** Gemini CLI, Codex (through the `codex-acp` adapter), GitHub Copilot CLI (preview), Cursor CLI, or any agent that speaks the Agent Client Protocol (ACP). Each one runs as the main agent: pick it in the agent menu after turning it on in **Settings → Providers → Agent CLIs**.
- **The agent runs its own loop. Orka keeps control of the rest:**
  - it answers the agent's permission requests with your permission mode;
  - the files the agent asks Orka for stay inside the project (what the agent does with its own tools follows its own sandbox and settings);
  - it lists the files the agent changes in the project in Changes, including files it writes with its own tools (a snapshot is taken around each request), so you can review and revert them. Files git ignores, such as `.env` or `node_modules`, are not snapshotted;
  - going back starts a fresh agent session, and the Supervisor reviews the result.
- **What it asks for:** a command request Orka cannot read, or one that runs outside the project, always asks and shows what the agent sent. A file the agent writes through Orka goes straight to disk (in VS Code an open editor reloads it); a link inside the project is written through to its target, a link out of it is refused.
- **Revert and Go back** put back the exact bytes a file had when the request began, and delete a file the agent created during the request with its own tools.
- **Supervisor:** next to an agent it needs a model provider of its own; without one it sits out, and Orka says so.
- **Signing in:** Orka never reads, stores or passes on an agent's sign-in. You sign in with the agent's own login command, which Orka opens in a terminal, with the agent's program by its full path and in your home folder. Orka runs only programs you installed and never downloads one.
- **Not offered:** Antigravity (Google's terms do not allow it through third-party software on consumer plans) and the Claude ACP adapter (licence unclear). Claude stays available through the Claude API and the opt-in Claude Code provider.
- **CLI:** `orka --provider agent:gemini` and `orka agents`. More in [docs/EXTERNAL_AGENTS.md](docs/EXTERNAL_AGENTS.md).

**Desktop app**

- **Your own session groups:** create, rename and remove them, and move a session in or out through its **…** menu. Folders and groups fold away, and sessions can be hidden from the list and shown again.

**Security (everywhere)**

- **Read-only commands are read word by word.** A command only counts as read-only (no approval in Ask mode) when Orka can read every part of it. Command substitution (`$(…)`, backticks), a single `&`, `env <program>`, options that start programs (`rg --pre`, `find -exec`, `tree -o`, `git --output`), wildcards or variables that could turn into options, and redirections into files now ask. Before, some of these ran without asking.
- **A repository's git config is read the way git reads it:** also a key on its section line, in nested repositories and submodules, and with signature programs, pagers and `core.hooksPath` counted as programs git would run. Git commands then ask, and Orka's own `git log` never verifies signatures.
- **Windows: no programs from the open folder.** Orka starts git, your shell and its other helpers by their full path from `PATH`, so a `git.exe` or `powershell.exe` a repository ships never runs. In the desktop app and the CLI, nothing Orka starts (commands, background processes, MCP servers, agents, terminal windows) picks a program from its current folder by its bare name: in cmd.exe and npm scripts, use `.\name` or a full path (`.\gradlew`). An MCP server whose `command` sits in its configured `cwd` still starts.
- Task history saves run one after another, so a request that ends while you start a new task is kept in its own task.

**Other**

- The repository moved to [Enophia-Studio/orka](https://github.com/Enophia-Studio/orka). Links and the update check follow; the old address still redirects.

## 0.2.0

The desktop app gets a calm, roomy window of its own: your sessions on the left, the conversation in the middle, the plan and the changes on the right.

**Desktop app**

- New layout:
  - **Sessions on the left:** the tasks of your recent project folders, with a search box, a new session per folder, and delete. Opening a session from another folder switches to it.
  - **The conversation in the middle:** a centered column. Tool calls are quiet one-line entries that open on a click.
  - **A message box that holds its controls:** **+** (attach a file, add an image, use a skill or command), the permission mode, the model and a round send button. A new session starts with the box in the middle of the window and suggestions under it.
  - **The task's plan and changes on the right**, in their own panel.
  - **Shortcuts:** Ctrl+B and Ctrl+Alt+B show and hide the two sides (a closed session list becomes a narrow rail of icons); Ctrl+K searches the sessions; Ctrl+Alt+N starts a new session.
  - A finished reply can be copied, and a button takes you back to the newest message when you scroll up.
  - **The single-column window is still there:** **Settings → Control → Appearance → Layout**.
- **Orka's own light and dark theme**, taken from its logo. It follows the system, or you pick one at the bottom of the session list or in the settings (setting `desktop.theme`).
- **`orka-desktop.exe` starts without a console window.** When it cannot start, a message box says why, and `~/.orka/desktop/desktop.log` keeps the details.
- Edge no longer offers to translate the window.
- **Fixed:** the desktop app could quit right at start when Windows briefly held its state file open (a virus scanner or the search indexer). Saving now tries again for a moment, and remembered state that cannot be saved no longer stops the app.
- **Security:** `desktop.log` is private to your user on macOS and Linux and masks anything shaped like an API key. A failed keychain call no longer reports its command line, which on macOS held the key being saved.

**Everywhere**

- **Update notices:** once a day Orka checks whether a newer release is out and says so, with a link to its page. Nothing is downloaded or installed.
  - Turn it off with `orka.updates.check` (VS Code) or `updates.check` (desktop), `"updateCheck": false` in the CLI config, or `ORKA_NO_UPDATE_CHECK=1`.
  - **Settings → Control** shows Orka's version and checks on request.
- **Fixed:** the usage bars and the plan's progress bar stayed empty, because the UI's content security policy blocks inline styles.

**For contributors**

- The chat UI's text sizes and radii are tokens (`packages/app/webview/styles/tokens.css`). The desktop's IDE layout (`webview/ide.css`) raises the base size and the radii.
- Shared parts of the UI moved out of `webview/main.ts`: the bridge, HTML helpers and formatting into `webview/core/`, and the in-app dialogs into `webview/features/dialogs.ts`. The IDE layout lives in `webview/ide/`.
- `@orka/app` has tests now (`npm test -w @orka/app`), with a fake shell for the controller. The desktop end-to-end tests cover the session list, the theme and the layout switch.
- The desktop theme moved to `packages/app/webview/desktop-theme.css`, so the UI preview shows the desktop window too (`npm run preview -w @orka/app`, then add `?ide`).

## 0.1.1

Security fixes found by code scanning after 0.1.0. Please update.

**Security**

- Pages and command output the agent reads can no longer stall Orka: turning HTML into text, removing terminal color codes and parsing Supervisor replies, lessons and inline scripts now take linear time. Before, a crafted 50 KB page took 1.3 s, and the time grew with the square of its size. The page text is the same as in 0.1.0, also for Turkish pages and pages without a closing `</head>`; only an unclosed `<script>` or `<style>` now hides the rest of the page, as in a browser.
- Windows: MCP servers started through a batch file (`npx.cmd` and the like) get their arguments quoted and escaped, so no argument can start another command. Servers found on the PATH as programs start directly.
- The chat UI escapes every value it gets from the app before showing it (statuses, numbers and token counts too) and only accepts messages from the app itself.
- The Claude Code provider's working folder is created with `mkdtemp`: it is private to your user (on macOS and Linux) and no longer sits in a shared `orka-claude-code` folder in the temp directory.
- Smaller fixes: `data:` and `vbscript:` links in fetched pages are no longer shown to the agent as links, the binary content-type check is anchored to the start of the header, selectors reach the headless browser URI-encoded, and three check-then-use file accesses became single steps.

**Requirements**

- Node.js 22 or newer (the provider SDKs and the browser tool need it) and VS Code 1.101 or newer for the extension.

**Distribution**

- The CLI is attached to the release as `orka-agent-<version>.tgz`: `npm install -g` it from the release URL.
- `orka-desktop.exe` shows up as *Orka Desktop* by Enophia Software, with Orka's icon, instead of as Node.js.
- The extension, the CLI package and the desktop app ship a `THIRD_PARTY_NOTICES.txt` with the licenses of the open-source software they include, and the release notes say how to install each app.
- Updated provider SDKs (Anthropic, OpenAI, Google Gen AI), `marked` 18 and the GitHub Actions used by CI and releases.

## 0.1.0 (first public release)

- Main agent, Supervisor and explore / review / worker sub-agents, each on its own provider and model.
- Providers: Claude API, OpenAI, Gemini, and any OpenAI-compatible endpoint (OpenRouter, DeepSeek, xAI, Mistral, Groq, Together AI, Ollama, LM Studio, ...). The local Claude Code CLI is available as an opt-in, unofficial provider.
- Three apps on one core: VS Code extension, desktop app (also as a single Windows executable, `orka-desktop.exe`) and the `orka` CLI.
- Hooks: your formatter or linter after each edit (`afterEdit`) and your checks before the agent finishes (`beforeFinish`), with failures sent back to the agent.
- Learning from tasks: lasting project lessons in `.project-ai/lessons.md`.
- Go back (rewind) to before any message of a task: the conversation and the files the agents changed since.
- Workers called together run side by side in their own copies of the project; their changes are merged three-way afterwards and overlapping edits are reported.
- Permission modes (Ask, Balanced, Autonomous) with per-category overrides; risky commands, downloads, inline scripts with file/network access and writes outside the workspace always ask.
- Change review: Changes panel, per-hunk revert, inline Keep / Revert in the editor, snapshots of files changed by terminal commands.
- Headless browser tool, background processes, web fetch.
- Skills (built-in and your own in `~/.orka/skills`) and MCP servers (stdio and Streamable HTTP).
- Task history, compaction with a handoff note, per-agent token usage and cost, token budget, fallback and light models.
- English and Turkish UI.
- Security hardening before release: settings that start programs, send API keys or loosen permissions can't come from a repository's own settings; workspace hooks and `.mcp.json` servers need your OK; no cloud-metadata or link-local fetches; git never runs programs named by a repository's own config without asking; `open_browser` never opens scripts or executables; the desktop start link works once.
