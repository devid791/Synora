import { desktopCapturer, systemPreferences } from "electron";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as settleInput } from "node:timers/promises";
import type { ComputerAdapter } from "../shared/computer-use";
import type { BrowserFrame, BrowserInput } from "../shared/contracts";
import { nativeInspection } from "./native-inspection";

/** Fixed executors only; arguments are never interpreted as a shell program.
 * Text travels on stdin (not in process listings), without using the clipboard. */
export function nativeCommand(
  file: string,
  args: string[],
  signal: AbortSignal,
  input = "",
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      signal,
    });
    let output = "",
      length = 0;
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", (b) => {
      length += b.length;
      if (length > 262144) child.kill();
      else output += b;
    });
    child.stderr.resume(); // Never echo typed input or script arguments in errors.
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("Native control executor unavailable or interrupted"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 && !signal.aborted
        ? resolve(output.trim())
        : reject(
            Error(
              "Native control failed. Check the active desktop, target window and OS permissions.",
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Host-owned C#/PowerShell, never a model-provided command. No execution-policy
// override, elevation, registry changes, clipboard or permission-dialog bypass.
const windowsProgram = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Threading;
public class SynoraInput {
 public static IntPtr Target;
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l,t,r,b; }
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
 [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk,scan; public uint flags,time; public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint data,flags,time; public UIntPtr extra; }
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern uint SendInput(uint n,INPUT[] i,int s);
 static void Send(INPUT i) { if(GetForegroundWindow()!=Target) throw new Exception("Target lost focus"); if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1) throw new Exception("Input rejected"); }
 public static void Key(ushort k,bool up) { var i=new INPUT(); i.type=1; i.U.ki.vk=k; i.U.ki.flags=up?2u:0u; Send(i); }
 public static void Text(string t) { foreach(char c in t) { var i=new INPUT(); i.type=1; i.U.ki.scan=c; i.U.ki.flags=4; Send(i); i.U.ki.flags=6; Send(i); } }
 public static void Mouse(uint f,int d) { var i=new INPUT(); i.U.mi.flags=f; i.U.mi.data=unchecked((uint)d); Send(i); }
}
'@
$v = [Console]::In.ReadToEnd() | ConvertFrom-Json
$h = [IntPtr]([long]$v.id)
if (-not [SynoraInput]::IsWindow($h)) { throw 'No window' }
$pidOfWindow = [uint32]0
[void][SynoraInput]::GetWindowThreadProcessId($h,[ref]$pidOfWindow)
$processName = (Get-Process -Id $pidOfWindow).ProcessName
if ($processName -match 'synora|codex|chatgpt|consent|credential|logonui') { throw 'Protected application' }
$r = New-Object SynoraInput+RECT
if (-not [SynoraInput]::GetWindowRect($h,[ref]$r)) { throw 'No bounds' }
if ($v.inspect) {
 Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
 $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
 $clock=[Diagnostics.Stopwatch]::StartNew()
 # Chromium/other lazy providers initialize their tree on the first UIA read.
 # Re-read once, within the SAME bounded window-only observation. No flags,
 # assistive-technology settings, focus/input, or provider policy are changed.
 for($pass=0;$pass -lt 2;$pass++){
 $root=[System.Windows.Automation.AutomationElement]::FromHandle($h)
 $queue=New-Object System.Collections.Queue
 $queue.Enqueue($root)
 $items=New-Object System.Collections.ArrayList
 $visited=0
 while($queue.Count -and $visited -lt 300 -and $items.Count -lt 100 -and $clock.ElapsedMilliseconds -lt 3000){
  $element=$queue.Dequeue();$visited++
  try {
   $c=$element.Current
   if($c.IsOffscreen){continue}
   $b=$c.BoundingRectangle
   if($b.Width -gt 0 -and $b.Height -gt 0 -and $b.Right -gt $r.l -and $b.Left -lt $r.r -and $b.Bottom -gt $r.t -and $b.Top -lt $r.b){
    $record=@{role=$c.ControlType.ProgrammaticName;name=$c.Name;focused=$c.HasKeyboardFocus;disabled=(-not $c.IsEnabled);bounds=@{left=($b.Left-$r.l)*$v.width/($r.r-$r.l);top=($b.Top-$r.t)*$v.height/($r.b-$r.t);width=$b.Width*$v.width/($r.r-$r.l);height=$b.Height*$v.height/($r.b-$r.t)}}
    if($c.IsPassword){$record.value_redacted=$true}
    else{ $pattern=$null;if($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)){$value=$pattern.Current.Value;$record.value=$value.Substring(0,[Math]::Min(2000,$value.Length))} }
    if($record.name.Length -gt 180){$record.name=$record.name.Substring(0,180)}
    [void]$items.Add($record)
   }
   if(-not $c.IsPassword){
    $child=$walker.GetFirstChild($element)
    while($null -ne $child -and $queue.Count -lt 300 -and $clock.ElapsedMilliseconds -lt 3000){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
   }
  }catch [System.Windows.Automation.ElementNotAvailableException]{}
 }
 if($pass -eq 0){if($clock.ElapsedMilliseconds -ge 2500){break};Start-Sleep -Milliseconds 150}
 }
 [Console]::Write((@{elements=@($items.ToArray())}|ConvertTo-Json -Depth 8 -Compress))
 exit 0
}
[void][SynoraInput]::SetForegroundWindow($h)
if ([SynoraInput]::GetForegroundWindow() -ne $h) { throw 'Focus denied' }
[SynoraInput]::Target = $h
$i=$v.input
if ($i.type -eq 'click' -or $i.type -eq 'scroll') {
 $x=$r.l+[int]($i.x*($r.r-$r.l)/$v.width); $y=$r.t+[int]($i.y*($r.b-$r.t)/$v.height)
 [void][SynoraInput]::SetCursorPos($x,$y)
}
if ($i.type -eq 'text') { [SynoraInput]::Text($i.text) }
elseif ($i.type -eq 'key') {
 $keys=@{Enter=13;Tab=9;Escape=27;Backspace=8;Delete=46;ArrowUp=38;ArrowDown=40;ArrowLeft=37;ArrowRight=39;Home=36;End=35;PageUp=33;PageDown=34;a=65}
 # PowerShell 5 does not define C#'s [ushort] alias. Keep the fixed script
 # compatible with the stock Windows host; Add-Type's C# still uses ushort.
 $parts=$i.key.Split('+'); $k=[System.UInt16]$keys[$parts[-1]]; if(!$k){throw 'Invalid key'}
 $modifier=0; if($parts.Length -gt 1){ if($parts[0] -eq 'Shift'){$modifier=16}else{$modifier=17} }
 try { if($modifier){[SynoraInput]::Key($modifier,$false)};[SynoraInput]::Key($k,$false);[SynoraInput]::Key($k,$true) }
 finally { if($modifier){[SynoraInput]::Key($modifier,$true)} }
} elseif ($i.type -eq 'click') {
 $down=2;$up=4;if($i.button -eq 'right'){$down=8;$up=16};if($i.button -eq 'middle'){$down=32;$up=64}
 [SynoraInput]::Mouse($down,0);[SynoraInput]::Mouse($up,0)
} elseif ($i.type -eq 'scroll') {
 if($i.deltaY){[SynoraInput]::Mouse(2048,-[int]$i.deltaY)};if($i.deltaX){[SynoraInput]::Mouse(4096,[int]$i.deltaX)}
} else { throw 'Invalid action' }
[Console]::Write('ok')
`;

export class NativeComputer implements ComputerAdapter {
  private macHelper = join(__dirname, "synora-computer-macos").replace(
    /app\.asar([/\\])/,
    "app.asar.unpacked$1",
  );
  async status() {
    if (process.platform === "darwin") {
      if (
        !systemPreferences.isTrustedAccessibilityClient(false) ||
        systemPreferences.getMediaAccessStatus("screen") !== "granted"
      )
        return {
          supported: false,
          reason:
            "Allow Synora in macOS System Settings → Privacy & Security → Accessibility and Screen Recording, then restart Synora.",
        };
      try {
        await access(this.macHelper);
      } catch {
        return {
          supported: false,
          reason: "The signed native macOS control helper is not packaged.",
        };
      }
    } else if (process.platform === "linux") {
      if (!process.env.DISPLAY || process.env.XDG_SESSION_TYPE === "wayland")
        return {
          supported: false,
          reason:
            "Native Linux control requires an X11 desktop. Wayland is not yet supported; internal browser control remains available.",
        };
      try {
        await nativeCommand("xdotool", ["version"], AbortSignal.timeout(3000));
      } catch {
        return {
          supported: false,
          reason:
            "Install xdotool for native X11 control. Internal browser control does not require it.",
        };
      }
    } else if (process.platform !== "win32")
      return { supported: false, reason: "Unsupported operating system" };
    return { supported: true };
  }
  private async sources(capture: boolean) {
    return desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: capture
        ? { width: 1280, height: 900 }
        : { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  }
  async windows(signal: AbortSignal) {
    signal.throwIfAborted();
    const entries = await this.sources(false);
    signal.throwIfAborted();
    return entries
      .filter(
        (e) =>
          !/synora|codex|chatgpt|securityagent|user account control/i.test(
            e.name,
          ),
      )
      .map((e) => ({ id: e.id, title: e.name, app: e.name }));
  }
  async capture(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const source = (await this.sources(true)).find((e) => e.id === id);
    signal.throwIfAborted();
    if (!source || source.thumbnail.isEmpty())
      throw Error(
        "Cannot capture this window; check visibility and Screen Recording permission",
      );
    return {
      dataURL: `data:image/jpeg;base64,${source.thumbnail.toJPEG(80).toString("base64")}`,
      ...source.thumbnail.getSize(),
    };
  }
  async inspect(id: string, frame: BrowserFrame, signal: AbortSignal) {
    if (process.platform !== "darwin" && process.platform !== "win32")
      return {available:false,reason:"Native accessibility descriptions are unavailable on this platform; use the screenshot.",elements:[]};
    if (!(await this.windows(signal)).some(w => w.id === id)) throw Error("Window is unavailable or protected");
    const match = /^window:(\d+):\d+$/.exec(id);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw Error("Invalid native window identity");
    try {
      const output = await nativeCommand(process.platform === "darwin" ? this.macHelper : "powershell.exe",
        process.platform === "darwin" ? [] : ["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(windowsProgram,"utf16le").toString("base64")],
        signal,JSON.stringify({id:match[1],inspect:true,width:frame.width,height:frame.height}));
      return nativeInspection(JSON.parse(output),frame);
    } catch {
      signal.throwIfAborted();
      return {available:false,reason:"The application did not expose a readable accessibility tree; the screenshot remains available.",elements:[]};
    }
  }
  async input(
    id: string,
    input: BrowserInput,
    frame: BrowserFrame,
    signal: AbortSignal,
  ) {
    if (!(await this.windows(signal)).some((w) => w.id === id))
      throw Error("Window is unavailable or protected");
    const match = /^window:(\d+):\d+$/.exec(id);
    if (!match || !Number.isSafeInteger(Number(match[1])))
      throw Error("Invalid native window identity");
    const windowId = match[1];
    if (process.platform === "darwin")
      await nativeCommand(
        this.macHelper,
        [],
        signal,
        JSON.stringify({
          id: windowId,
          input,
          width: frame.width,
          height: frame.height,
        }),
      );
    else if (process.platform === "win32")
      await nativeCommand(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(windowsProgram, "utf16le").toString("base64"),
        ],
        signal,
        JSON.stringify({
          id: windowId,
          input,
          width: frame.width,
          height: frame.height,
        }),
      );
    else {
      const property = await nativeCommand(
        "xprop",
        ["-id", windowId, "_NET_WM_PID"],
        signal,
      );
      if (property.includes(`= ${process.pid}`))
        throw Error("Synora cannot control its own permission interface");
      const geometry = await nativeCommand(
        "xdotool",
        ["getwindowgeometry", "--shell", windowId],
        signal,
      );
      const width = Number(/^WIDTH=(\d+)$/m.exec(geometry)?.[1]),
        height = Number(/^HEIGHT=(\d+)$/m.exec(geometry)?.[1]);
      if (!width || !height) throw Error("Window geometry unavailable");
      await nativeCommand(
        "xdotool",
        ["windowraise", windowId, "windowfocus", "--sync", windowId],
        signal,
      );
      const focus = await nativeCommand("xdotool", ["getwindowfocus"], signal);
      if (focus !== windowId)
        throw Error("Target window did not receive focus");
      if (input.type === "text")
        await nativeCommand(
          "xdotool",
          ["type", "--clearmodifiers", "--file", "-"],
          signal,
          input.text,
        );
      else if (input.type === "key") {
        const names: Record<string, string> = {
          Enter: "Return",
          ArrowUp: "Up",
          ArrowDown: "Down",
          ArrowLeft: "Left",
          ArrowRight: "Right",
          "Control+a": "ctrl+a",
          "Meta+a": "ctrl+a",
          "Shift+Tab": "shift+Tab",
        };
        await nativeCommand(
          "xdotool",
          ["key", "--clearmodifiers", names[input.key] ?? input.key],
          signal,
        );
      } else {
        await nativeCommand(
          "xdotool",
          [
            "mousemove",
            "--window",
            windowId,
            String(Math.round((input.x * width) / frame.width)),
            String(Math.round((input.y * height) / frame.height)),
          ],
          signal,
        );
        if (input.type === "click")
          await nativeCommand(
            "xdotool",
            [
              "click",
              input.button === "right"
                ? "3"
                : input.button === "middle"
                  ? "2"
                  : "1",
            ],
            signal,
          );
        else
          for (const [delta, negative, positive] of [
            [input.deltaY, "4", "5"],
            [input.deltaX, "6", "7"],
          ] as const)
            if (delta)
              await nativeCommand(
                "xdotool",
                [
                  "click",
                  "--repeat",
                  String(Math.max(1, Math.ceil(Math.abs(delta) / 100))),
                  "--delay",
                  "10",
                  delta < 0 ? negative : positive,
                ],
                signal,
              );
      }
    }
    // OS input posting is asynchronous. Allow the target event queue to drain
    // before a subsequent process refocuses it or a screenshot is requested.
    // This is not proof of the visible effect; the caller must still re-observe.
    await settleInput(150, undefined, { signal });
  }
}
