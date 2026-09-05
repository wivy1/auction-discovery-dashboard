param(
  [switch]$TaskOwned,
  [int]$OwnerProcessId = 0,
  [string]$OwnerProcessStartedAt = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot ".wrangler\logs"
$lockPath = Join-Path $logDirectory "runtime-supervisor.lock"
$generationScript = (Resolve-Path `
  (Join-Path $PSScriptRoot "dev.ps1")).Path
$powershell = (Get-Command powershell.exe).Source
$reloadExitCode = 75
$lockContendedExitCode = 76
$generationProcessId = 0
$generationJob = $null
$lock = $null
$taskOwnerProcess = $null

if (-not ("AuctionDiscovery.GenerationJob" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AuctionDiscovery {
  public sealed class GenerationJob : IDisposable {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint WAIT_FAILED = 0xffffffff;
    private const uint STILL_ACTIVE = 259;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private IntPtr handle;
    private IntPtr processHandle;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public IntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public uint cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public ushort wShowWindow;
      public ushort cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32 {
      public uint dwSize;
      public uint cntUsage;
      public uint th32ProcessID;
      public IntPtr th32DefaultHeapID;
      public uint th32ModuleID;
      public uint cntThreads;
      public uint th32ParentProcessID;
      public int pcPriClassBase;
      public uint dwFlags;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
      public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
      IntPtr job,
      int informationClass,
      IntPtr information,
      uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
      IntPtr job,
      int informationClass,
      IntPtr information,
      uint informationLength,
      IntPtr returnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      bool inheritHandles,
      uint creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
      IntPtr handle,
      uint milliseconds
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(
      IntPtr process,
      out uint exitCode
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    public GenerationJob() {
      handle = CreateJobObject(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) ThrowLastError("CreateJobObject");

      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
        new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int length = Marshal.SizeOf(limits);
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        Marshal.StructureToPtr(limits, buffer, false);
        if (!SetInformationJobObject(
          handle,
          JobObjectExtendedLimitInformation,
          buffer,
          (uint)length
        )) {
          ThrowLastError("SetInformationJobObject");
        }
      } catch {
        CloseHandle(handle);
        handle = IntPtr.Zero;
        throw;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    public static uint GetCurrentParentProcessId() {
      IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (snapshot == new IntPtr(-1)) {
        ThrowLastError("CreateToolhelp32Snapshot");
      }
      try {
        uint currentProcessId = (uint)Process.GetCurrentProcess().Id;
        PROCESSENTRY32 entry = new PROCESSENTRY32();
        entry.dwSize = (uint)Marshal.SizeOf(entry);
        if (!Process32First(snapshot, ref entry)) {
          ThrowLastError("Process32First");
        }
        do {
          if (entry.th32ProcessID == currentProcessId) {
            return entry.th32ParentProcessID;
          }
          entry.dwSize = (uint)Marshal.SizeOf(entry);
        } while (Process32Next(snapshot, ref entry));
        throw new InvalidOperationException(
          "The stable host could not resolve its direct parent process."
        );
      } finally {
        CloseHandle(snapshot);
      }
    }

    public uint StartSuspended(
      string applicationPath,
      string arguments,
      string workingDirectory
    ) {
      EnsureOpen();
      if (processHandle != IntPtr.Zero) {
        throw new InvalidOperationException(
          "GenerationJob already owns a process handle."
        );
      }
      STARTUPINFO startup = new STARTUPINFO();
      startup.cb = (uint)Marshal.SizeOf(startup);
      PROCESS_INFORMATION created;
      StringBuilder commandLine = new StringBuilder(
        "\"" + applicationPath + "\" " + arguments
      );
      if (!CreateProcessW(
        applicationPath,
        commandLine,
        IntPtr.Zero,
        IntPtr.Zero,
        false,
        CREATE_SUSPENDED,
        IntPtr.Zero,
        workingDirectory,
        ref startup,
        out created
      )) {
        ThrowLastError("CreateProcessW");
      }

      try {
        if (!AssignProcessToJobObject(handle, created.hProcess)) {
          ThrowLastError("AssignProcessToJobObject");
        }
        if (ResumeThread(created.hThread) == UInt32.MaxValue) {
          ThrowLastError("ResumeThread");
        }
        processHandle = created.hProcess;
        created.hProcess = IntPtr.Zero;
        return created.dwProcessId;
      } catch {
        if (created.hProcess != IntPtr.Zero) {
          TerminateProcess(created.hProcess, 1);
        }
        throw;
      } finally {
        CloseHandle(created.hThread);
        if (created.hProcess != IntPtr.Zero) {
          CloseHandle(created.hProcess);
        }
      }
    }

    public bool WaitForProcessExit(int timeoutMilliseconds) {
      EnsureProcessHandle();
      uint outcome = WaitForSingleObject(
        processHandle,
        checked((uint)timeoutMilliseconds)
      );
      if (outcome == WAIT_OBJECT_0) return true;
      if (outcome == WAIT_TIMEOUT) return false;
      if (outcome == WAIT_FAILED) ThrowLastError("WaitForSingleObject");
      throw new InvalidOperationException(
        "WaitForSingleObject returned an unexpected result."
      );
    }

    public uint GetProcessExitCode() {
      EnsureProcessHandle();
      uint exitCode;
      if (!GetExitCodeProcess(processHandle, out exitCode)) {
        ThrowLastError("GetExitCodeProcess");
      }
      if (exitCode == STILL_ACTIVE) {
        throw new InvalidOperationException(
          "The runtime generation has not exited."
        );
      }
      return exitCode;
    }

    public uint GetActiveProcessCount() {
      EnsureOpen();
      int length = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        if (!QueryInformationJobObject(
          handle,
          JobObjectBasicAccountingInformation,
          buffer,
          (uint)length,
          IntPtr.Zero
        )) {
          ThrowLastError("QueryInformationJobObject");
        }
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting =
          (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
            buffer,
            typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
          );
        return accounting.ActiveProcesses;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    public bool TerminateAndWait(int timeoutMilliseconds) {
      EnsureOpen();
      if (GetActiveProcessCount() == 0) return true;
      if (!TerminateJobObject(handle, 1)) {
        int error = Marshal.GetLastWin32Error();
        if (GetActiveProcessCount() == 0) return true;
        throw new Win32Exception(error, "TerminateJobObject failed");
      }
      Stopwatch timer = Stopwatch.StartNew();
      do {
        if (GetActiveProcessCount() == 0) return true;
        Thread.Sleep(25);
      } while (timer.ElapsedMilliseconds < timeoutMilliseconds);
      return GetActiveProcessCount() == 0;
    }

    public void Dispose() {
      if (processHandle != IntPtr.Zero) {
        CloseHandle(processHandle);
        processHandle = IntPtr.Zero;
      }
      if (handle != IntPtr.Zero) {
        CloseHandle(handle);
        handle = IntPtr.Zero;
      }
      GC.SuppressFinalize(this);
    }

    ~GenerationJob() {
      Dispose();
    }

    private void EnsureOpen() {
      if (handle == IntPtr.Zero) {
        throw new ObjectDisposedException("GenerationJob");
      }
    }

    private void EnsureProcessHandle() {
      EnsureOpen();
      if (processHandle == IntPtr.Zero) {
        throw new InvalidOperationException(
          "GenerationJob does not own a process handle."
        );
      }
    }

    private static void ThrowLastError(string operation) {
      throw new Win32Exception(
        Marshal.GetLastWin32Error(),
        operation + " failed"
      );
    }
  }
}
"@
}

function New-HostCapability {
  $bytes = [byte[]]::new(32)
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
  } finally {
    $generator.Dispose()
  }
  return [BitConverter]::ToString($bytes).Replace("-", "")
}

function Get-TaskOwnerProcess {
  if ($OwnerProcessId -le 0 -or [string]::IsNullOrWhiteSpace(
    $OwnerProcessStartedAt
  )) {
    throw "Task-owned runtime hosts require an exact owner process ID and start time."
  }

  $directParentProcessId = [AuctionDiscovery.GenerationJob]::GetCurrentParentProcessId()
  if ($directParentProcessId -ne $OwnerProcessId) {
    throw "The task-owned runtime host was not launched by its declared owner."
  }

  try {
    $owner = Get-Process -Id $OwnerProcessId -ErrorAction Stop
    $actualStartedAt = $owner.StartTime.ToUniversalTime().ToString("o")
    $owner.Refresh()
    if ($owner.HasExited -or $actualStartedAt -cne $OwnerProcessStartedAt) {
      throw "identity mismatch"
    }
    return $owner
  } catch {
    throw "The task-owned runtime host could not verify its exact owner identity."
  }
}

function Test-TaskOwnerIdentity {
  if (-not $TaskOwned) { return $true }
  if (-not $taskOwnerProcess) { return $false }
  try {
    $taskOwnerProcess.Refresh()
    if ($taskOwnerProcess.HasExited) { return $false }
    return $taskOwnerProcess.StartTime.ToUniversalTime().ToString("o") `
      -ceq $OwnerProcessStartedAt
  } catch {
    return $false
  }
}

function Assert-TaskOwnerActive {
  if (-not (Test-TaskOwnerIdentity)) {
    throw "The exact task owner exited; stopping the owned runtime generation."
  }
}

function Test-HostEndpointObserved {
  param([Parameter(Mandatory = $true)][string]$Uri)

  try {
    Invoke-WebRequest `
      -UseBasicParsing `
      -Method Get `
      -Uri $Uri `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec 1 | Out-Null
    return $true
  } catch {
    return $null -ne $_.Exception.Response
  }
}

function Wait-HostGenerationEndpointsReleased {
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    if ($TaskOwned) { Assert-TaskOwnerActive }
    $dashboardObserved = Test-HostEndpointObserved -Uri "http://localhost:3000/"
    $companionObserved = Test-HostEndpointObserved `
      -Uri "http://127.0.0.1:32110/v1/health"
    if (-not $dashboardObserved -and -not $companionObserved) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Stop-HostGenerationJob {
  param(
    [Parameter(Mandatory = $true)]
    [AuctionDiscovery.GenerationJob]$Job
  )

  try {
    if (-not $Job.TerminateAndWait(10000)) {
      $activeProcesses = $Job.GetActiveProcessCount()
      throw "The runtime generation job retained $activeProcesses active process(es) after bounded teardown."
    }
  } finally {
    $Job.Dispose()
  }
}

if ($TaskOwned) { $taskOwnerProcess = Get-TaskOwnerProcess }

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$supervisorInstanceId = [Guid]::NewGuid().ToString("N")
$processStartTime = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o")

try {
  try {
    $lock = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::Read
    )
  } catch [System.IO.IOException] {
    $nativeCode = $_.Exception.HResult -band 0xffff
    if ($nativeCode -in @(32, 33)) {
      Write-Warning "Another local runtime supervisor already owns this checkout."
      exit $lockContendedExitCode
    }
    throw
  }

  $receipt = [ordered]@{
    schemaVersion = "auction-discovery-runtime-supervisor-lock-v1"
    instanceId = $supervisorInstanceId
    processId = $PID
    startedAt = $processStartTime
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  $receiptBytes = $encoding.GetBytes(($receipt | ConvertTo-Json -Compress) + "`n")
  $lock.SetLength(0)
  $lock.Position = 0
  $lock.Write($receiptBytes, 0, $receiptBytes.Length)
  $lock.Flush($true)

  $env:AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID = $supervisorInstanceId
  $env:AUCTION_DISCOVERY_SUPERVISOR_PROCESS_ID = [string]$PID

  while ($true) {
    if ($TaskOwned) { Assert-TaskOwnerActive }
    $env:AUCTION_DISCOVERY_IMAGE_TOKEN = New-HostCapability
    $arguments = @(
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", "`"$generationScript`"",
      "-Generation"
    ) -join " "
    $generationJob = [AuctionDiscovery.GenerationJob]::new()
    try {
      $generationProcessId = $generationJob.StartSuspended(
        $powershell,
        $arguments,
        $projectRoot
      )
      while (-not $generationJob.WaitForProcessExit(1000)) {
        if ($TaskOwned) { Assert-TaskOwnerActive }
      }
      $generationExitCode = $generationJob.GetProcessExitCode()
    } finally {
      $jobToStop = $generationJob
      $generationJob = $null
      if ($jobToStop) { Stop-HostGenerationJob -Job $jobToStop }
      $generationProcessId = 0
    }

    if ($TaskOwned -and -not (Test-TaskOwnerIdentity)) {
      exit $generationExitCode
    }

    if ($generationExitCode -eq $reloadExitCode) {
      if (-not (Wait-HostGenerationEndpointsReleased)) {
        throw "The previous runtime generation did not release its owned endpoints; refusing to start a duplicate generation."
      }
      Remove-Item Env:AUCTION_DISCOVERY_IMAGE_TOKEN -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 250
      continue
    }

    if ($TaskOwned) {
      Write-Warning `
        "The task-owned runtime generation exited with code $generationExitCode; retaining exact ownership for scheduled cleanup."
      while (Test-TaskOwnerIdentity) { Start-Sleep -Seconds 1 }
      exit $generationExitCode
    }
    exit $generationExitCode
  }
} finally {
  if ($generationJob) {
    try { Stop-HostGenerationJob -Job $generationJob } catch {
      Write-Warning $_.Exception.Message
    }
  }
  Remove-Item Env:AUCTION_DISCOVERY_IMAGE_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID -ErrorAction SilentlyContinue
  Remove-Item Env:AUCTION_DISCOVERY_SUPERVISOR_PROCESS_ID -ErrorAction SilentlyContinue
  if ($taskOwnerProcess) { $taskOwnerProcess.Dispose() }
  if ($lock) { $lock.Dispose() }
}
