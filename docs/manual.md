# Synora user manual

Your guide to installing Synora, connecting a model and doing real work with files, tools and agents.

This manual covers the 67eed3d desktop source baseline and its aligned Linux, Windows and local web builds. Menu labels below use English. Platform support, provider access and available tools depend on your installation. Read the known limitations before relying on Synora for important work.

The repository also contains newer `0.2.0` source-candidate features described
below where explicitly marked. They are not yet an update to the published
foundation download packages.

## Start here

Synora is a workspace around Codex App Server. The app manages your conversations, files and controls; App Server manages model interactions and tool execution; your selected provider supplies the model. These are separate components. An active App Server connection does not by itself mean your model account or Axiom endpoint is ready.

1. Download the package for your operating system from the Downloads section of the Synora website.
2. Install and open Synora. Wait for the initial App Server and account checks to finish.
3. Open Models & accounts. Configure a provider you are entitled to use, then select an available model.
4. In Workspace, choose a project folder. Start with a disposable folder when trying file edits or commands for the first time.
5. Leave permissions at Ask for approval. Send a small request such as “Explain the files in this project. Do not change anything.”
6. Read the response and any tool results. Approve only actions you understand and intended to allow.

The presentation website is not a hosted chat service. Downloading Synora does not include a paid model subscription, cloud credits, an Axiom server or model weights.

## Install on macOS

The current Mac download is for Apple Silicon (ARM64), macOS 13 or later. It is not an Intel Mac package.

1. Download and extract the Mac ZIP.
2. Move Synora Harness Desktop.app to Applications, then open it from there.
3. If macOS asks for access to Synora's saved credentials in Keychain, approve locally only if you recognize the app you just installed. Never share your Mac password in chat.
4. If an older Synora instance is still open, quit it normally before launching the new copy. Keep one intended app copy to avoid opening an old build by mistake.

The current distributed Mac package has a local signing identity, not Apple Developer ID notarization. macOS may warn before opening it. Verify the download and publisher before using the OS's per-app approval flow. Do not disable Gatekeeper globally or remove security protections with a command copied from an unknown source.

Removing the application bundle is different from erasing its local conversations or credentials. Do not delete application data as an installation troubleshooting shortcut.

## Install on Windows

The current Windows download is an x64 installer. Download the EXE, run it and follow its installation prompts, then launch Synora from the installed shortcut.

The current installer is unsigned. Windows may display a publisher or SmartScreen warning. Check the package name, source and checksum before deciding whether to proceed. Do not disable system-wide protection. Administrator access is not a substitute for verifying the publisher.

Wait for Account checked before saving or verifying provider credentials. If the app reports that the engine is busy during initial checks, let those checks finish and retry once.

## Install on Linux

The current Linux download is an amd64 DEB for compatible Debian-based distributions. Use your distribution's graphical package installer or, from the directory containing the downloaded package:

```sh
sudo apt install ./Synora-67eed3d-linux-amd64.deb
```

Review the package manager's proposed changes before confirming. Launch Synora from your application menu after installation. This package is not an ARM build, RPM or universal Linux archive.

For source builds and local web development, see the repository's build instructions. Compiling source is separate from installing the downloadable release.

## Verify a download

Download SHA256SUMS.txt alongside your installer from the same Downloads section. Compare the entry for the exact package you downloaded with a locally computed SHA-256 digest.

On macOS:

```sh
shasum -a 256 Synora-67eed3d-macos-arm64.zip
```

On Linux:

```sh
sha256sum Synora-67eed3d-linux-amd64.deb
```

In Windows PowerShell:

```powershell
Get-FileHash .\Synora-67eed3d-windows-x64.exe -Algorithm SHA256
```

The full digest must match; letter case is not significant. A mismatch means you should not run the file. A matching checksum detects an unexpected or damaged download but is not a replacement for trusted distribution and signing.

## Connect a provider and select a model

Open Models & accounts. Synora includes configuration paths for Axiom, OpenAI, xAI, Anthropic, Gemini, DeepSeek, Mistral, OpenRouter and a configurable Responses-compatible endpoint. A listed provider is not a guarantee that every model, account or authentication method has been qualified.

Use the authentication method that Synora actually offers for that provider. A web chat subscription does not automatically grant API access. Browser login requires a supported provider flow; API keys require the corresponding API entitlement. Synora does not borrow another app's login.

After connecting, refresh or check the model catalog and select a model available to your account. Set reasoning effort and context only from the options advertised for that model. The same label on two providers does not guarantee the same behavior, cost or token allowance.

The custom endpoint adapter expects its supported Responses contract. A server that implements only Chat Completions is not automatically compatible.

Keep tokens out of conversation messages, screenshots and bug reports. Enter secrets only in the relevant credential control. Before sending confidential files, confirm which provider receives them and that its data policies suit your use.

## Connect Axiom through Codex App Server

If you run Axiom yourself, configure the server address in the Axiom provider settings. Use the endpoint supplied by the server operator; do not copy another person's private network address.

For a compatible Axiom server, the Codex provider base path is /codex/v1. The Responses route is /codex/v1/responses and discovery is /codex/v1/models. The separate /v1 path has stricter native tool rules and is not interchangeable when using Codex's namespaces and custom tools.

If the endpoint requires a Bearer token, enter it in the provider's token field, not in the URL or prompt. The server operator must provide a reachable, authenticated transport for remote access. A VPN or tunnel only provides connectivity; it does not automatically configure the provider or grant access.

Check these separately: server reachability, authentication, model catalog, a completed text request and an actual tool result. A health response or an initial streaming event is not proof that inference completed.

Synora, Codex App Server and the Axiom kernel have separate versions. Updating one does not automatically update the others. The public Axiom repository's documented scope determines which server components are included.

## Find your way around

Workspace is where you chat, choose project files and inspect ongoing work. Agents shows delegated activity. Bots stores reusable configurations. Browser provides an isolated browsing surface. Models & accounts manages providers and model access. Connectors handles supported service connections. Plugins & MCP handles tool integrations. Telemetry & backend shows engine observations. Settings controls application preferences.

Collapse navigation or secondary panels when you need more working space. The terminal and file panels operate on the selected workspace host, not necessarily the computer displaying the page in local web mode.

The home examples fill the composer with an editable starting request. They do not run automatically. Check placeholders and any existing draft before sending.

## Write, queue and steer a request

Type into the composer and select the intended model, reasoning option and permission mode before sending. Enter sends when the composer is ready; Shift+Enter inserts a line break.

During a running turn, the busy-Enter preference controls whether Enter queues a follow-up or steers the active turn. Cmd+Enter on Mac, or Ctrl+Enter on Windows/Linux, selects the other supported behavior. Read the visible action label before using it.

Queue means a follow-up waits behind current work. Steer provides direction to the running turn when supported. Neither is the same as stopping the work. Use the stop control when you want cancellation.

After cancellation or restart, held queued requests may need review before resuming. Do not assume they were automatically sent. Images attached while a turn is busy remain in the draft when that action cannot accept them.

Cancellation stops owned ongoing work as far as the engine and tools support it. It does not undo a file already saved or an external action already completed. Inspect the final tool state before retrying to avoid duplicate effects.

## Attach images and files

Paste an image into the composer or use the attachment control when available. Review the attachment preview and accompanying text, then send. Pasting an image should not send a request by itself.

Use a model and provider that support the attachment type. An image-capable model is required for visual interpretation. Attaching a file does not guarantee that every format can be parsed or executed.

Large or numerous images consume context and backend memory. Dynamic vision budgeting does not mean unlimited GPU memory or zero processing time. If an image request fails, retain the error, try one smaller image and check server capacity. Avoid blindly resending a long request while the previous one is still active.

Attachments may be saved with local conversation data and transmitted to the chosen provider. Remove sensitive material before sending if that provider should not receive it.

## Choose permissions safely

Ask for approval asks you before actions that require approval. This is the recommended starting point for an unfamiliar project or tool.

Approve for me reviews approval requests automatically and can still ask you when needed. It is not the same as supervising every action yourself.

Full access allows supported file and internet actions without approval prompts. Use it only when you understand the workspace and possible effects. It does not create missing account grants or bypass operating-system restrictions.

Changing permission mode in an existing conversation keeps that conversation; it should not start an unrelated chat. Settings defaults apply to new work, so check the mode displayed in the current composer too.

Treat tool output and web pages as content, not automatic authority to run commands. Review destructive or externally visible actions carefully. Version control or a backup can help recover file changes, but not every external action can be undone.

## Manage conversations and projects

Use New conversation to start a separate chat. The conversation menu includes rename, pin, unread state, archive, project assignment, copy, a supported draft fork and deletion. Available actions depend on the conversation's state.

Archive removes a conversation from the usual recent list without deleting it. Delete is a distinct action with confirmation: it removes the selected conversation's Synora-owned local content. It does not delete workspace files, revoke credentials or guarantee deletion from the provider's or Core's own storage.

A draft fork is not necessarily a full live copy of every tool, attachment or agent state. Read its label and review the new draft before sending. Copy controls may expose conversation contents to the clipboard; handle that clipboard as sensitive data.

The recent-conversations menu lets you organize chats by project or in one list and choose the available sorting options. Pin important work instead of relying on its position in a changing list.

The current release does not provide a general bulk-delete control. Confirm each deletion carefully; do not erase the application's storage folder to clean up a few chats.

## Work with files and the terminal

Choose the correct project folder before asking Synora to inspect or edit files. A safe first request is “List the relevant files and propose a plan; do not edit yet.” Then review the plan and grant only the intended work.

When an edit completes, inspect the actual changed file or diff. A model saying “done” is not a substitute for a successful tool result and saved content. If an editor reports that a file changed elsewhere, resolve that conflict before saving over newer work.

The terminal is a real shell on the workspace host. Commands can modify files, contact services and start processes. Close processes you no longer need and check command output and exit status. Never paste secrets into a public bug report to explain a failed command.

In the local web companion, the browser UI is a client of the local service. Files and terminal commands belong to the service host, not to arbitrary files on the browser's computer.

## Browser and computer control (source candidate)

The `0.2.0` source candidate embeds the actual live browser page beside the desktop
conversation: you see typing, searches, navigation and scrolling and can interact
with the same page. Screenshots are model observations, not the desktop display.
The local web edition uses an interactive frame preview instead. Synora can also
operate permitted application windows on the host running Synora. This is not
control of the inference server or an arbitrary visitor's computer in web mode.
Open **Computer & browser** to inspect availability and enable the intended
capabilities. Ask/Approve modes require scoped site/window and action consent.
Full access enables available controls without extra Synora approvals unless
you explicitly stopped or disabled them. OS permissions and protected-window
restrictions still apply; Synora cannot approve its own or the OS's dialogs.

For readable pages, the model can request text observations with actual controls
and coordinates. Native `computer_snapshot` also accepts `format=text` for real
accessibility labels, values and focus; `format=image` is used for graphics or
unreadable controls. The native default still includes an image. Both keep a
real local preview and the same fresh, one-use observation requirement. Missing
accessibility is reported, not invented. Take a new observation after each
action, navigation, layout or policy change.

Use **Stop control** or the available **Ctrl/Cmd+Shift+F12** emergency shortcut
to revoke control. Closing the preview panel alone does not stop it. Changing
permission mode keeps the conversation but invalidates prior read approvals and
observations. Already delivered clicks or text cannot be undone by stopping.

Desktop prerequisites differ: macOS needs Screen Recording and Accessibility;
Windows needs an interactive desktop and respects UAC boundaries; Linux native
control currently requires X11, a window manager, `xdotool` and `xprop`. The
internal browser remains a separate capability. See [Browser and computer
control](COMPUTER-USE.md) for exact supported actions and limitations.

## Inspect reasoning and tool activity

Synora can display reasoning content or summaries that a supported model and provider expose. Expand the available reasoning block to read it. Some providers return summaries, some return other supported reasoning output, and some return none.

This is not access to a model's hidden internal process, and visible reasoning is not proof that its conclusion is correct. Check sources, tool output and actual results when accuracy matters.

Inspect tool calls by their name, arguments, result, status and stable identifiers. A started call is not a successful call. Look for completion, an explicit failure, cancellation or an approval request before deciding what happened.

## Use agents and split views

Agents are delegated tasks with their own identity, instructions and progress. Inspect the assigned task and provider/model selection before launching work. Open available agent details or a side-by-side view to follow a worker without losing the parent conversation.

Track the original tool results and the worker's final status. An agent's completed response does not automatically mean its changes were reviewed or accepted by the supervisor.

Give concurrent workers separate file ownership or workspaces when possible. Two agents editing the same file can conflict. Review cancellation and error states on each child rather than assuming all workers stopped when one panel closed.

## Set up tutor mode

Use Set up tutor to configure the supervisor and the available workers. Choose actual provider/model combinations from their catalogs; a friendly worker name is not an API model identifier.

The supervisor plans and delegates work, observes progress and reviews results. A review may accept a result or ask for linked rework. Keep the parent task, worker result and review together when checking completion.

Each selected provider needs its own valid access. Local work sent to an external supervisor can leave your machine; decide whether that is appropriate before delegating confidential material. Tutor mode is orchestration, not training or transferring one model into another.

## Create and reuse bots

Bots are reusable task configurations. Create one with a clear name, purpose, instructions and supported model/tool choices. Save it, then select it for suitable new work.

Review imported bot configurations before using them. Importing a preset is not a reason to trust its commands or grant it broad permissions. Exported presets can contain your written instructions, so review them before sharing.

A saved bot is not automatically a running background service or a scheduled job. Confirm what is actually active in the UI. Keep defaults for new conversations separate from the choices already attached to existing work.

## Connect plugins, connectors and MCP tools

Browse Plugins & MCP or Connectors, inspect an integration and follow the supported setup flow. Install or configure only the integrations you intend to use, then connect the required account where prompted.

Catalog availability, installation, configuration and an authenticated connection are different states. “Account connection required” means additional setup is still needed. A model cannot use a tool merely because its card is visible.

Review OAuth scopes and account selection in the provider's authorization screen. Never paste provider credentials into a conversation as a substitute for connecting the integration. Revoking or removing a local integration may also require revoking the grant at the provider.

For a first test, choose a harmless read-only action on data you placed in scope. Verify an actual call and returned result. A missing grant, unsupported schema or unavailable tool must be treated as unavailable, not as a passed test.

MCP server commands can execute programs on your machine. Install trusted servers only and review their arguments and environment. The application does not give untrusted pages a generic privileged command interface.

## Use the browser

The Browser view is isolated from Synora's privileged application interfaces. Navigate to the intended site and confirm its address before logging in or entering sensitive information.

Some popup, download, permission and platform behaviors differ from a full standalone browser. Follow the capability message when an action is unavailable. Opening a page does not automatically make it a connected plugin or grant a model access to your account.

When a model uses a web tool, inspect the returned source and result separately from whatever page is open in the Browser view.

## Read telemetry correctly

Telemetry & backend and the status area separate local app observations from model/backend observations. App RAM is the app's memory, not the model's GPU allocation. PTY count refers to terminal sessions.

GPU utilization, temperature and VRAM describe the sampled device when a supported collector is connected. They are not necessarily attributable to the selected conversation: another task can use the same GPU. Device names are discovered rather than tied permanently to one graphics card.

Last-request VRAM, instantaneous GPU memory and KV/context statistics are different measurements. Context capacity is not the number of tokens already used. Token counts, time to first text and decode speed depend on what the provider actually reports.

Idle after a completed response can be normal while the model remains loaded in VRAM. If activity never changes during a long running turn, check collector connectivity and timestamps. Unavailable or stale measurements must not be read as zero usage or evidence that no work happened.

## Preferences, themes and updates

Settings includes appearance and language choices, defaults for new work and supported startup/notification options. Light, dark and system appearance adapt the application; changing language does not translate source code, original messages or protocol names.

Launch at login depends on the operating system's startup permissions. Check the OS setting if the app does not open after login. Being installed does not mean it can run while the computer is powered off or asleep.

The App Server update controls distinguish the installed version, an upstream available version and a qualified update. An available version is not necessarily a qualified version. Apply an offered qualified update only when the app is idle and follow the displayed result. Do not replace Core binaries manually inside an installed app.

App updates, App Server updates and an Axiom server update are separate. Keep important work saved before changing any component. Installing an update should not be used as an excuse to delete conversations or reset credentials.

## Local web companion

The local web build uses the shared Synora interface with a local service that owns workspaces, terminal processes and engine sessions. It is different from the public synora-ai.org presentation and download site.

Use the repository's instructions to build and start it on your own machine. The supported local configuration binds to loopback and validates browser origin and session requests. Do not bind it to all network interfaces or publish it on the internet just to make remote access easier.

A remotely hosted service would execute work on its host and needs a separately designed authentication and network boundary. The public website deliberately exposes no chat backend, file API, terminal API or upload endpoint.

## Troubleshooting

If Axiom is unavailable: check the configured host and /codex/v1 base path, network or VPN access when required, token validity and whether the backend has finished loading. Ask the operator for a safe status check. Do not disable TLS verification or authentication to make an error disappear.

If credentials cannot be saved: wait for the initial Account checked state, finish any active turn and retry. Handle Keychain or other OS prompts locally. Do not include the token in a bug report.

If a request seems stuck: inspect whether it is queued, awaiting approval, generating, running a tool or waiting on a provider. Large tool catalogs, cold models and large images can take longer. Inspect the final status before resending; an initial streaming event is not completion.

If pasting an image fails: confirm focus is in the composer, inspect the clipboard content and try the attachment picker. Confirm that the selected model supports images. Keep the exact error message but remove private paths or tokens before sharing it.

If the layout is cramped: collapse the navigation or secondary panels, reduce app zoom or enlarge the window. The current Linux/Windows build has a known layout defect at a small window with 150% zoom and an expanded update notice; this workaround is not a claim that the defect is fixed.

If switching permissions appears to lose a chat: do not delete it or clear app data. Look for the original conversation in the sidebar, retain the reproduction steps and report the issue with the exact app version.

If a plugin fails: distinguish missing account authorization, a rejected tool definition, a failed external service and a model choosing not to call it. Report the tool name and sanitized error; never report another user's private data.

## Known limitations and release status

The current packages are downloadable builds, not a blanket certification that every provider, plugin, OS combination and action has passed production acceptance.

The aligned Linux/Windows release has an open small-window/high-zoom layout defect and an initial-account-check feedback issue. External provider and plugin access depends on actual account grants and supported contracts. Large contexts, large images and all hardware combinations are not universally qualified.

Mac signing is local rather than Apple Developer ID notarization; Windows signing is not provided in the current installer. The current binary selection is macOS ARM64, Windows x64 and Linux amd64 only.

Upstream App Server and plugin capabilities can change. Synora retains versioned compatibility and qualification boundaries; a newer upstream version or a green connection indicator does not prove end-to-end compatibility.

## Report a bug or contribute

Use the Synora GitHub repository for source code, documentation and issue reporting. Ideas, clear bug reports and help are welcome. Synora-owned source is licensed under MIT; third-party components retain their own licenses and notices.

Include the app version, operating system and architecture, selected provider/model, a minimal sequence of actions, what you expected and what happened. If relevant, include the App Server version and whether the problem survives a normal restart. Label a test as blocked if it needs an account or service you do not have.

Remove API keys, Bearer tokens, login codes, passwords, private conversations and sensitive file paths from screenshots and logs. Use a disposable project for a reproduction whenever possible. Never attach full application storage or credential files to a public issue.

Synora: https://github.com/devid791/Synora

Axiom Kernel: https://github.com/devid791/axiom-kernel

Creator: https://x.com/ZenatiDavide

Thanks to OpenAI for making Codex App Server available. Synora is an independent project, not an OpenAI product or an endorsement by OpenAI. Upstream documentation: https://learn.chatgpt.com/docs/app-server
