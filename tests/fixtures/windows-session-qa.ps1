# Authorized QA only. Does not alter global policy, accounts, Core binaries,
# the interactive desktop, production, or the command's private sandbox.
# Supplies the bootstrap account access missing from this SSH Session0's
# own noninteractive GUI objects, then removes only the exact inserted ACEs.
param([ValidateSet('Probe','Live')][string]$Mode = 'Probe')
$ErrorActionPreference = 'Stop'
Set-Location 'C:\Synora_Production_QA_9cfc8ac'
if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -ne 'AXIOM-WIN-BUILD\axiom-builder') { throw 'Unexpected QA user' }
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) { throw 'Not the isolated SSH service session' }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
public sealed class SynoraQaDesktop : IDisposable {
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll",SetLastError=true)] static extern IntPtr GetThreadDesktop(uint id);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int n,StringBuilder b,uint len,out uint need);
  [DllImport("user32.dll",SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr h,ref uint n,byte[] b,uint len,out uint need);
  [DllImport("user32.dll",SetLastError=true)] static extern bool SetUserObjectSecurity(IntPtr h,ref uint n,byte[] b);
  readonly IntPtr station,desktop;
  readonly SecurityIdentifier sid;
  bool stationAdded,desktopAdded;
  public string StationName,DesktopName,StationBefore,DesktopBefore,StationAfter,DesktopAfter;
  public bool Restored;
  static string Name(IntPtr h) { var b = new StringBuilder(512); uint need; if(!GetUserObjectInformationW(h,2,b,1024,out need)) throw new Win32Exception(); return b.ToString(); }
  static byte[] Read(IntPtr h) { uint n=4,need; GetUserObjectSecurity(h,ref n,null,0,out need); if(need==0) throw new Win32Exception(); var b=new byte[need]; if(!GetUserObjectSecurity(h,ref n,b,need,out need)) throw new Win32Exception(); return b; }
  static string Hash(byte[] bytes) { using(var h=SHA256.Create()) return BitConverter.ToString(h.ComputeHash(bytes)).Replace("-",""); }
  static void Write(IntPtr h,RawSecurityDescriptor sd) { var b=new byte[sd.BinaryLength]; sd.GetBinaryForm(b,0); uint n=4; if(!SetUserObjectSecurity(h,ref n,b)) throw new Win32Exception(); }
  bool Match(GenericAce a,int mask) { var c=a as CommonAce; return c!=null && c.AceQualifier==AceQualifier.AccessAllowed && c.AccessMask==mask && c.SecurityIdentifier.Equals(sid) && c.AceFlags==AceFlags.None && !c.IsCallback; }
  void Add(IntPtr h,int mask) { var sd=new RawSecurityDescriptor(Read(h),0); if(sd.DiscretionaryAcl==null) throw new Exception("No DACL; refusing mutation"); foreach(GenericAce a in sd.DiscretionaryAcl) { var q=a as QualifiedAce; if(q!=null && q.SecurityIdentifier.Equals(sid)) throw new Exception("Sandbox account already has an ACE; not an owned baseline"); } sd.DiscretionaryAcl.InsertAce(sd.DiscretionaryAcl.Count,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,mask,sid,false,null)); Write(h,sd); }
  void Remove(IntPtr h,int mask) { var sd=new RawSecurityDescriptor(Read(h),0); int found=-1; for(int i=0;i<sd.DiscretionaryAcl.Count;i++) if(Match(sd.DiscretionaryAcl[i],mask)) { if(found>=0) throw new Exception("Ambiguous QA ACE"); found=i; } if(found<0) throw new Exception("QA ACE changed externally"); sd.DiscretionaryAcl.RemoveAce(found); Write(h,sd); }
  public SynoraQaDesktop() {
    station=GetProcessWindowStation(); desktop=GetThreadDesktop(GetCurrentThreadId());
    StationName=Name(station); DesktopName=Name(desktop);
    if(!StationName.StartsWith("Service-",StringComparison.OrdinalIgnoreCase) || DesktopName!="Default") throw new Exception("Refusing non-service or interactive GUI objects");
    sid=(SecurityIdentifier)new NTAccount(Environment.MachineName,"CodexSandboxOffline").Translate(typeof(SecurityIdentifier));
    StationBefore=Hash(Read(station)); DesktopBefore=Hash(Read(desktop));
  }
  public void Enable() { try { Add(station,0x000F006E); stationAdded=true; Add(desktop,0x000F00CF); desktopAdded=true; } catch { Dispose(); throw; } }
  public void Dispose() {
    try { if(desktopAdded) { Remove(desktop,0x000F00CF); desktopAdded=false; } }
    finally { if(stationAdded) { Remove(station,0x000F006E); stationAdded=false; } }
    StationAfter=Hash(Read(station)); DesktopAfter=Hash(Read(desktop));
    Restored=StationBefore==StationAfter && DesktopBefore==DesktopAfter;
    if(!Restored) throw new Exception("GUI-object DACL changed; unrelated ACEs preserved, review required");
  }
}
'@
$qaHome='C:\Users\axiom-builder\AppData\Local\Temp\synora-live-native-Mb5PPy'
$core=Join-Path $qaHome 'state\core-runtime\0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a\bin\codex.exe'
$guard=New-Object SynoraQaDesktop
$guard | Select-Object StationName,DesktopName,StationBefore,DesktopBefore | ConvertTo-Json -Compress
$exitCode=1
try {
  $guard.Enable()
  if ($Mode -eq 'Probe') {
    & node tests/fixtures/windows-helper-elevated.mjs $qaHome $core 'bootstrap-access'
  } else {
    $env:SYNORA_TEST_EXECUTABLE='C:\Synora_Production_QA_9cfc8ac\out\production-qa-windows-9cfc8ac\win-unpacked\Synora Harness Desktop.exe'
    $env:SYNORA_TEST_ENDPOINT='http://10.23.45.10:8015/codex/v1'
    $env:SYNORA_TEST_PREPARED_WINDOWS_QA=$qaHome
    & node node_modules/@playwright/test/cli.js test --config playwright.live-desktop.config.ts
  }
  $exitCode=$LASTEXITCODE
} finally {
  $guard.Dispose()
  $receipt=$guard | Select-Object StationName,DesktopName,StationBefore,DesktopBefore,StationAfter,DesktopAfter,Restored
  $receipt | ConvertTo-Json -Compress
  $destination=Join-Path (Get-Location) ('out\live-evidence\windows-bootstrap-'+$Mode+'-'+[Guid]::NewGuid().ToString('N')+'.json')
  [IO.File]::WriteAllText($destination,($receipt | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
}
exit $exitCode
