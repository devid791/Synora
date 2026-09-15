# Browser and computer control

This document describes the current source release candidate, not the already
published download packages. See [release scope](RELEASE.md) for distribution
and qualification limitations.

## What it does

An enabled conversation can ask its model to open and read real websites in
Synora's isolated browser, click controls, type, press navigation keys and scroll.
The same primitives can operate an explicitly allowed application window on the
desktop running Synora. The inference server is **not** the computer being
controlled. The local web edition offers its service-owned browser, not control
of the computer visiting the web page.

The model receives actual page text and visible-control coordinates by default.
For graphics, canvas or ambiguous controls it can request an image snapshot.
For native desktop forms, `computer_snapshot` also accepts `format=text`: it
returns the application's real accessibility labels, values, focus and exact
click coordinates. Prefer this for readable controls; use `format=image` for
graphics, ambiguous controls or unavailable accessibility. Omitting the native
format still includes the image for backward compatibility. Both formats capture
the real local screenshot and enforce the same observation, permission and
freshness checks. Text mode never invents descriptions or silently sends an image
instead; unavailable accessibility is reported with instructions to request one.
This keeps readable work text-first without removing visual capabilities.
The side panel shows the browser's current frame and a readable activity trail;
for desktop apps it shows the **last observed window**, with a timestamp. This is
not a continuous desktop video feed. Open full browser expands the same real tab
when you need more room. Image tool results in chat render the actual screenshots
too; text observations still update the real local preview.

Example request after enabling the browser:

> Use the internal browser to research six-seat cars for sale in Lazio. Show me
> the pages you inspect, compare the listings and cite their URLs. Do not contact
> sellers, create accounts or submit personal information.

Results depend on the model, accessible websites and their restrictions. Synora
cannot guarantee an exhaustive list or that a model will interpret every site
correctly. A vision-capable, tool-calling model is needed for visual work; these
tools do not give a text-only model vision.

## Enable, approve and stop

1. Select or create a conversation. Finish any active turn first.
2. Open **Computer & browser** in the top bar.
3. In Ask/Approve for me, enable **Internal browser**, **Desktop applications**,
   or both. In **Full access**, available control is enabled for the conversation
   on its next live turn, unless you explicitly disabled/stopped it. Screen and
   page content will be sent to your selected model/provider.
4. Send your request. Approve only the websites and application windows needed
   for that task. Denying access or letting approval expire executes no input.
5. In Ask for approval and Approve for me, each click, text entry, key or scroll
   requires explicit control approval. **Full access executes without additional
   Synora site, window, action or MCP tool approval prompts**. OS permissions
   (Accessibility/Screen Recording), Plan-mode restrictions and protected-window
   exclusions still apply. Full access is never an OS permission bypass.
6. Use **Stop control** to revoke access and cancel pending control approvals.
   Desktop also registers **Ctrl/Cmd+Shift+F12**, including while another app is
   focused. If the OS cannot register it, Synora displays a notice. The top-bar
   stop remains available. Closing only the side panel does **not** revoke access.

Grants belong to one conversation and this running Synora instance. Restarting,
stopping, or changing the grant clears site/window approvals. Stop remains revoked
for that conversation in this running instance until explicitly re-enabled,
including in Full access. Re-enabling rotates
the private capability so an older Core process cannot reuse it. Changing the
conversation's permission mode clears cached site/window approvals, pending
decisions and observations; already enabled capabilities remain enabled. Ask and
Approve modes require fresh read/action consent under the new policy. Changing
defaults for a new conversation does not revoke another conversation's grant.
Enabling control
uses MCP, not a replacement dynamic-tool catalogue: existing thread/session IDs
and messages are retained.

Keep sensitive information out of shared windows. Website text and screenshots
are untrusted content, not permission to follow embedded instructions. Purchases,
submissions, uploads, deletion, credential entry and permission changes require
the user's explicit authorization. Synora/agent approval interfaces and OS consent
dialogs are not automation targets. Plan mode permits observations, but does not
permit browser navigation or computer/browser input in this implementation.

## Composer shortcuts

### Composer keyboard history

Press **Up** in an empty composer (or at the start of a single-line draft) to
recall the latest sent user message in the current conversation. Further Up/Down
presses move through that history; Down past the newest message restores your
draft. Clicking, typing or using other navigation keys leaves history mode so
you can edit. Normal arrows in existing multiline drafts, text selections and
IME input are not intercepted. Recall changes only the draft text: it never
resends a message, reattaches old files or switches conversations.

### Send while the model is working

While a live turn is active, **Send now** submits your text to that same turn
through Core's `turn/steer` operation. It does not create another conversation or
cancel the current turn. The model receives the guidance at its next supported
processing point; this is not a promise to preempt every running model/tool call.
**Queue** instead saves the message for a new turn after the current turn succeeds.
**Stop** remains separate and available during submission.

These buttons always perform their named action. The saved **Enter while working**
setting controls Enter; Ctrl/Cmd+Enter uses the other action, and Shift+Enter
inserts a line break. The UI confirms a submission only after acknowledgement.
Rejected messages and text typed while waiting remain in the draft. A changed or
cancelled turn is never silently replaced or replayed. Current busy submissions
accept text only; images stay in the draft for a normal send. Queued messages held
after cancellation/recovery require review rather than automatic replay.

## Platform prerequisites and present limits

| Environment | Prerequisites / limits |
| --- | --- |
| Desktop internal browser | Uses Synora-owned Electron pages; no external browser profile, generic script tool or debugging TCP port. |
| Local web browser | Requires the existing sandboxed Chromium runtime on the web service host. |
| Linux desktop | Requires an interactive X11 desktop, a window manager, `xdotool` and `xprop`. Wayland desktop control is not implemented; the internal browser remains usable. |
| macOS desktop | Requires the bundled native helper, Screen Recording and Accessibility permission in System Settings. macOS may require a restart after granting permission. Build requires Xcode command-line tools. Saved credentials require access to the OS Keychain under the actual signed app identity. |
| Windows desktop | Requires a logged-in interactive session and Windows PowerShell. Foreground restrictions and integrity/UAC boundaries are respected; elevated/secure desktops are not bypassed. Native file/command tools also require Core's Windows sandbox setup. |

Desktop control selects an already-open application window; it does not currently
provide application launching, drag-and-drop, clipboard/file transfer, unrestricted
hotkeys or double-click. Browser downloads, popups and website device permissions
retain the existing restrictions. User control can interrupt a sequence, but
cannot undo input already delivered. Do not operate the same target concurrently
with the model. Take a new observation after resizing or changing its contents.

Large multimodal layouts can take minutes and depend on the chosen model,
backend and context. Readable browser pages and native forms can use text
observations; image support remains available and is not silently disabled.
Full access does not replace macOS Keychain authorization. A local/ad-hoc signing
identity can cause the OS to request credential access again for a different
build. Consistent distribution signing is a separate release prerequisite, not
something Synora can replace by bypassing OS consent or weakening encryption.
See [Electron's Keychain and signing guidance](https://www.electronjs.org/docs/latest/api/safe-storage).

## Implementation and reproduction

The privileged service owns a strict, bounded set of eight MCP tools. Its HTTP
endpoint is process-owned loopback with an unpredictable rotating path, exact
Host validation and no browser-origin access. It is never exposed as a public
computer-control API. Input schemas reject executable scripts, unexpected fields,
arbitrary keys and invalid coordinates. Actions need a fresh, one-use observation
for the active conversation/turn. Changes of permission, navigation and
cancellation invalidate observations. After two minutes, a locally recaptured
frame must have exactly the same pixels and dimensions before input is allowed;
otherwise a new model observation is required. Concurrent actions are rejected.

The default live-turn budget measures inactivity, not total task duration. New
owned Core output/tool activity renews it; Axiom may also prove actual fresh work
for that exact model/session. A repeated status document or a generic heartbeat
does not suffice. If progress cannot be verified, the turn is cancelled and an
explicit timeout is shown. Host-configured overall deadlines remain absolute.

Electron browser input uses fixed Chromium Input operations; inspection uses a
host-authored read-only script. Native adapters use fixed OS executors, without a
model-controlled shell, Python, OS-approval automation or clipboard writes.
The macOS helper is unpacked from ASAR for packaging/signing; building its source
on Linux does not certify that helper.

The integration follows the official [App Server extension boundary](https://learn.chatgpt.com/docs/app-server)
and the browser/computer separation of [Codex browser use](https://learn.chatgpt.com/docs/browser)
and [computer use](https://learn.chatgpt.com/docs/computer-use). Synora supplies its
own execution and consent components; it does not claim access to Codex's private
desktop implementation. Native foreground behavior follows the OS, including
[Windows foreground restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).

```sh
npm run typecheck
npx tsx --test --test-concurrency=1 tests/*.test.ts tests/native-preparation.test.mjs
npx tsx --test tests/computer-control.integration.ts
npx tsx --test tests/busy-submissions.integration.ts
npm run build
npm run build:web
```

The integration test needs the qualified original Core on PATH, or
`SYNORA_TEST_CORE` set to its executable. It uses a disposable Core home and a
controlled loopback Responses provider, not real model inference. It verifies
actual Core MCP execution and screenshot transport, not model reasoning quality.
The busy-message integration holds a real Core response stream open, submits
guidance before completion, and verifies delivery upstream and persistence within
the same Core turn. Its upstream is also a controlled fixture, not live Qwen.

For the desktop test use a separate interactive test display with a window
manager. The optional `SYNORA_QA_WINDOW_MANAGER` must point to an installed `twm`
executable; it is used only on the explicitly selected QA display.

```sh
SYNORA_QA_WINDOW_MANAGER=/path/to/twm xvfb-run -a -s '-screen 0 1600x1100x24 -extension GLX' npx playwright test --config playwright.computer.config.ts
```

The GUI test creates isolated app data and a separate harmless target app. It
does not replace an installed Synora, access user accounts or control the real
desktop outside the QA display. Screenshots and JSON results are in
`test-results/computer-control/` and `test-results/computer-control.json`.
