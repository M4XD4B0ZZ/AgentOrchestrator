// The AO launch boundary — the process that creates and owns a productive
// agent process on Windows.
//
// Decided in docs/decisions/2026-08-19-adr-windows-launch-boundary.md, on the
// evidence of two measurement spikes. This file is the production component;
// the spike helper it descends from was throwaway measurement code, and what
// transferred is the contract and the numbers, not the file.
//
// ── What it does ────────────────────────────────────────────────────────────
//
//   create a strict Job Object (KILL_ON_JOB_CLOSE, neither breakaway flag)
//     -> arm the coupling to the AO process that asked for the launch
//     -> create pipes
//     -> create the target INSIDE the job
//     -> confirm membership before the target executes (JOBLIST: the kernel
//        placed it at creation, so the check confirms what is already true;
//        SUSPENDED: the check precedes the resume, so it precedes the target's
//        first instruction)
//     -> forward stdio, report a primitive status, and terminate the job when
//        the owner is lost or when this process ends, whichever comes first.
//
// ── What it deliberately does NOT do ────────────────────────────────────────
//
// Byte budgets, timeouts, stdin delivery vocabulary, result classification,
// task state, retries, PATH resolution, shells. All of that is AO's, stays in
// TypeScript, and is the reason this trusted computing base is one file: the
// smaller this component, the less of the system depends on native code being
// right.
//
// ── Fail closed, everywhere ─────────────────────────────────────────────────
//
// Every path that cannot establish or keep ownership refuses, and leaves
// nothing it created alive. A refusal does not promise that the target never
// executed — in JOBLIST mode it runs from its first instruction — which is
// what `targetStarted` in the status is for. There is no
// ordinary-spawn fallback, no attach-after-spawn path, no taskkill, and no
// request key that can weaken containment: an unknown key is a refusal, not an
// ignored option. The two weakening switches that the negative controls need
// exist only under AO_BOUNDARY_TEST_CONTROLS, a define the shipped build never
// sets, so the measurement that proves the guarantee is load-bearing cannot
// also be a bypass in production.
//
// ── The request and status format ───────────────────────────────────────────
//
// Both are `key=base64(utf8 value)`, one per line, in a file. Base64 because
// the values are paths, command-line arguments and environment entries — the
// exact material quoting bugs live in — and base64 has no quoting to get
// wrong, no escaping rules that differ between C# and TypeScript, and no
// parser dependency here. The keys are the other half of
// `src/boundary/launch-boundary.ts`.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Native
{
    internal const uint CREATE_SUSPENDED = 0x00000004;
    internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;

    internal const uint STARTF_USESTDHANDLES = 0x00000100;
    internal const uint STARTF_USESHOWWINDOW = 0x00000001;
    internal const ushort SW_HIDE = 0;

    internal const uint HANDLE_FLAG_INHERIT = 0x00000001;
    internal const uint INFINITE = 0xFFFFFFFF;
    internal const uint WAIT_OBJECT_0 = 0;

    // PROC_THREAD_ATTRIBUTE_INPUT (0x00020000) | number
    internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
    internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = (IntPtr)0x0002000D;

    internal const int JobObjectExtendedLimitInformation = 9;
    internal const int JobObjectBasicProcessIdList = 3;

    /// <summary>
    /// The strict job, and the whole guarantee: when the last handle to this
    /// job closes, every process still inside it is terminated by the kernel.
    /// No breakaway flag is ever set, so a member cannot leave.
    /// </summary>
    internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    internal const uint SYNCHRONIZE = 0x00100000;
    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;

    internal const uint MOVEFILE_REPLACE_EXISTING = 0x00000001;

    [StructLayout(LayoutKind.Sequential)]
    internal struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern IntPtr CreateJobObjectW(IntPtr sa, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES sa, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetHandleInformation(IntPtr handle, out uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr GetStdHandle(int stdHandle);

    /** The end of an anonymous pipe, as Windows reports it: a *failed* read. */
    internal const int ERROR_BROKEN_PIPE = 109;
    internal const int ERROR_HANDLE_EOF = 38;

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool ReadFile(IntPtr handle, byte[] buffer, uint toRead, out uint read, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool WriteFile(IntPtr handle, byte[] buffer, uint toWrite, out uint written, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern bool MoveFileExW(string existing, string replacement, uint flags);
}

/// <summary>The exit codes. The other half of BOUNDARY_HELPER_EXIT in TypeScript.</summary>
internal static class ExitCode
{
    internal const int ChildObserved = 0;
    internal const int Usage = 64;
    internal const int BoundaryFailure = 90;
    internal const int InternalError = 91;
    internal const int OwnerAlreadyGone = 92;
    internal const int OwnerLost = 93;
}

/// <summary>The request, read from a file so nothing has to survive a command line.</summary>
internal sealed class Request
{
    public string Mode;                            // SUSPENDED | JOBLIST
    public string File;                            // the canonical application path
    public readonly List<string> Args = new List<string>();
    public bool Verbatim;                          // join args untouched (the .cmd route)
    public string Cwd;                             // null = inherit
    public readonly List<string> Env = new List<string>();  // "K=V"; empty = inherit
    public int OwnerPid = -1;                      // the AO process this boundary serves
    public string StatusPath;
    /// <summary>
    /// A value the caller invents per launch and the status echoes back. It
    /// makes the status file's *identity* checkable: without it, a status left
    /// behind by an earlier run in a reused directory reads exactly like this
    /// run's, and the caller would accept another launch's evidence as this
    /// one's.
    /// </summary>
    public string Nonce;

#if AO_BOUNDARY_TEST_CONTROLS
    // Present ONLY in the build the negative controls use. See the file header:
    // a production binary that could be asked to weaken its own containment
    // would be a bypass wearing a test's clothes.
    public string FailAt = "";
    public bool InheritJobHandle;
    public bool NoHandleList;
#endif
}

internal static class Program
{
    private static IntPtr _job = IntPtr.Zero;
    private static readonly List<string> _status = new List<string>();
    private static readonly object _statusLock = new object();
    private static readonly object _ownershipGate = new object();
    private static string _statusPath = "";
    private static bool _noncePut;
    private static int _terminatedByOwnerLoss;

    private static int Main(string[] argv)
    {
        if (argv.Length != 1)
        {
            Console.Error.WriteLine("usage: ao-launch.exe <request-file>");
            return ExitCode.Usage;
        }

        Request request = null;
        try
        {
            try
            {
                request = ReadRequest(argv[0]);
            }
            finally
            {
                // The request carries the environment the caller substituted —
                // credentials included — and it sits in a directory the
                // contained process can read. Its lifetime ends here whether it
                // was accepted or refused: a refused request is not a reason to
                // leave one on disk until somebody remembers it.
                try { File.Delete(argv[0]); } catch { /* best effort */ }
            }
            _statusPath = request.StatusPath;
            Put("helperPid", CurrentProcessId.ToString(CultureInfo.InvariantCulture));
            Put("mode", request.Mode);
            return Run(request);
        }
        catch (BoundaryFailure failure)
        {
            // Fail closed. Every path that could not establish ownership ends
            // here, and nothing this boundary created is left running when it
            // does — the job is terminated on the paths that created anything.
            //
            // That is not the same as "the target never ran": in JOBLIST mode
            // the target executes from its first instruction, so a failure
            // after creation refuses a launch that had already started. Which
            // of the two it was is in `targetStarted`, and the caller reads it
            // there rather than inferring it from the refusal.
            Put("boundary", "FAILED");
            Put("failure", failure.Code);
            Put("win32", failure.Win32.ToString(CultureInfo.InvariantCulture));
            WriteStatus();
            return failure.Code == BoundaryFailure.OwnerGone
                ? ExitCode.OwnerAlreadyGone
                : ExitCode.BoundaryFailure;
        }
        catch (Exception error)
        {
            Put("boundary", "FAILED");
            Put("failure", "HELPER_INTERNAL_ERROR");
            Put("detail", error.GetType().Name);
            WriteStatus();
            return ExitCode.InternalError;
        }
    }

    private static int Run(Request request)
    {
        FailPoint(request, "BEFORE_JOB", "OWNED_CONTAINMENT_JOB_CREATE");

        _job = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (_job == IntPtr.Zero) throw new BoundaryFailure("OWNED_CONTAINMENT_JOB_CREATE");
        Put("jobCreated", "true");

        // The job handle must not be inheritable: a child holding a handle to
        // the job keeps it alive, and KILL_ON_JOB_CLOSE then never fires. The
        // handle list below is the second, independent line of defence, and it
        // takes BOTH being wrong to lose the tree — measured in this
        // repository, as a pair of control runs, rather than carried over as a
        // claim: an inheritable handle alone leaves 0 survivors, an
        // inheritable handle with no handle list leaves all 7.
        bool inheritJobHandle = false;
#if AO_BOUNDARY_TEST_CONTROLS
        inheritJobHandle = request.InheritJobHandle;
#endif
        if (!Native.SetHandleInformation(
                _job,
                Native.HANDLE_FLAG_INHERIT,
                inheritJobHandle ? Native.HANDLE_FLAG_INHERIT : 0))
        {
            throw new BoundaryFailure("OWNED_CONTAINMENT_JOB_HANDLE");
        }

        // Reported from the handle, not from the intent. Echoing the local
        // variable made the status a restatement of the request: a mutant that
        // set HANDLE_FLAG_INHERIT here would still have reported `false`, and
        // every case in both suites would still have passed.
        uint jobHandleFlags;
        if (!Native.GetHandleInformation(_job, out jobHandleFlags))
        {
            throw new BoundaryFailure("OWNED_CONTAINMENT_JOB_HANDLE");
        }
        Put(
            "jobHandleInheritable",
            (jobHandleFlags & Native.HANDLE_FLAG_INHERIT) != 0 ? "true" : "false");

        ConfigureJob();
        FailPoint(request, "AFTER_JOB", "OWNED_CONTAINMENT_JOB_CONFIGURE");

        // The owner coupling is armed BEFORE anything is created. An owner that
        // is already gone is a refusal, and an owner that dies during the
        // launch cannot leave a created-but-unowned process behind, because the
        // watcher and the creation share `_ownershipGate`.
        WatchOwner(request.OwnerPid);

        Pipes pipes = Pipes.Create(NoHandleList(request));
        FailPoint(request, "AFTER_PIPES", "OWNED_CONTAINMENT_PIPES");

        Native.PROCESS_INFORMATION info;
        bool assignedAtCreation;
        lock (_ownershipGate)
        {
            // Under the gate, and only here, the owner's state is stable. An
            // owner already lost means there is nothing left to launch for, and
            // creating anything now would be creating it for nobody.
            if (Interlocked.CompareExchange(ref _terminatedByOwnerLoss, 0, 0) == 1)
            {
                throw new BoundaryFailure(BoundaryFailure.OwnerGone, 0);
            }
            CreateTarget(request, pipes, out info, out assignedAtCreation);

            // In JOBLIST mode the target is a job member from its first
            // instruction, which also means it is already executing here: the
            // membership check below confirms what the kernel established, and
            // cannot precede it.
            //
            // Recorded under the gate, and that is not tidiness. The watcher
            // writes the status while holding this lock, so a `Put` made after
            // releasing it can be overtaken: the owner dies, the watcher
            // publishes a status with no `targetStarted`, and the caller reads
            // a definite "nothing ran" for a process that is executing. That is
            // the unsafe direction of exactly the field this exists to make
            // honest.
            if (assignedAtCreation) Put("targetStarted", "true");
        }

        // The child's ends of the pipes are closed here: while this process
        // still holds one, EOF never reaches the reader.
        pipes.CloseChildEnds();

        Put("childPid", info.dwProcessId.ToString(CultureInfo.InvariantCulture));
        Put("assignedAtCreation", assignedAtCreation ? "true" : "false");

        bool inJob;
        if (!Native.IsProcessInJob(info.hProcess, _job, out inJob) || !inJob)
        {
            // Verification failed: kill what was created rather than continue
            // with a process this boundary does not own.
            Native.TerminateJobObject(_job, 0xDEAD);
            throw new BoundaryFailure("OWNED_CONTAINMENT_VERIFY");
        }
#if AO_BOUNDARY_TEST_CONTROLS
        if (request.FailAt == "AFTER_VERIFY")
        {
            Native.TerminateJobObject(_job, 0xDEAD);
            throw new BoundaryFailure("OWNED_CONTAINMENT_VERIFY");
        }
#endif
        Put("verifiedInJob", "true");
        Put("jobMembersAtStart", JobMemberCount().ToString(CultureInfo.InvariantCulture));

        if (!assignedAtCreation)
        {
            // The resume, and the record of it, are both under the gate: the
            // instant the target may execute must not be separable from the
            // status that says so. Outside it, an owner lost in between
            // publishes "nothing ran" over a running process.
            lock (_ownershipGate)
            {
                // Only now may the target execute its first instruction. In
                // SUSPENDED mode membership is proven before the resume; in
                // JOBLIST mode the kernel established it at creation and the
                // check above confirmed it.
                if (Native.ResumeThread(info.hThread) == 0xFFFFFFFF)
                {
                    Native.TerminateJobObject(_job, 0xDEAD);
                    throw new BoundaryFailure("OWNED_CONTAINMENT_RESUME");
                }
                // A refusal after this point is still a refusal — the job is
                // terminated with it — but it is no longer one that can claim
                // nothing ran, and the caller is told which kind it got rather
                // than having to assume the safer one.
                Put("targetStarted", "true");
            }
        }
        Native.CloseHandle(info.hThread);
        Put("boundary", "OK");
        // An early status: the caller may read the child pid, and may know that
        // ownership holds, before a single byte of output arrives.
        WriteStatus();

        Thread pumpOut = Pump(pipes.StdoutRead, StandardHandles.Out);
        Thread pumpErr = Pump(pipes.StderrRead, StandardHandles.Error);
        PumpStdin(pipes.StdinWrite);

        uint waited = Native.WaitForSingleObject(info.hProcess, Native.INFINITE);

        // Drain: the child is gone, but its output may still be in the pipe.
        pumpOut.Join(5000);
        pumpErr.Join(5000);

        // The one place in this component where the evidence for a *completion*
        // is produced, so it is the one place that may not be produced from an
        // unchecked call. An unsatisfied wait leaves a running child and
        // `GetExitCodeProcess` then answers STILL_ACTIVE (259) — a value a
        // process may also legitimately exit with, which is why the wait's own
        // result decides this and a 259-guard would not. A failed call answers
        // 0, which would have been published as a clean success.
        //
        // When the exit cannot be proven, nothing is written: the absence of
        // `childExitCode` is exactly what the caller classifies as
        // BOUNDARY_LOST, which is the truthful answer here.
        uint exitCode;
        if (waited == Native.WAIT_OBJECT_0 && Native.GetExitCodeProcess(info.hProcess, out exitCode))
        {
            Put("childExitCode", unchecked((int)exitCode).ToString(CultureInfo.InvariantCulture));
        }
        else
        {
            Put("childExitUnobservable", "true");
        }
        Put("terminatedByOwnerLoss", _terminatedByOwnerLoss == 1 ? "true" : "false");
        // The job's own answer about what the child left behind. Anything still
        // counted here is killed by the close below, without a walk, a
        // taskkill, or a list of pids anyone had to keep.
        List<int> membersAtEnd;
        int countAtEnd = JobMembers(out membersAtEnd);
        Put("jobMembersAtEnd", countAtEnd.ToString(CultureInfo.InvariantCulture));
        Put("jobMemberPidsAtEnd", string.Join(",", membersAtEnd.ConvertAll(
            delegate(int pid) { return pid.ToString(CultureInfo.InvariantCulture); }).ToArray()));
        WriteStatus();

        Native.CloseHandle(info.hProcess);
        Native.CloseHandle(_job);

        // Owner loss ends this process from two directions: the watcher exits
        // 93 while holding the gate, and the main thread — woken by the child
        // dying inside the terminated job — walks out through here. The watcher
        // normally wins, but nothing enforces that, and this branch returning
        // "the child was observed to exit" would report a run the boundary
        // destroyed as one that finished. The exit code is evidence, and on the
        // path where the status write fails it is the *only* surviving
        // evidence, so it says the same thing whichever thread gets there.
        return _terminatedByOwnerLoss == 1 ? ExitCode.OwnerLost : ExitCode.ChildObserved;
    }

    private static void ConfigureJob()
    {
        Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // Exactly one flag, fixed here rather than taken from the request: the
        // strictness of the job is not a caller's option.
        limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!Native.SetInformationJobObject(_job, Native.JobObjectExtendedLimitInformation, buffer, (uint)size))
                throw new BoundaryFailure("OWNED_CONTAINMENT_JOB_CONFIGURE");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static bool NoHandleList(Request request)
    {
#if AO_BOUNDARY_TEST_CONTROLS
        return request.NoHandleList;
#else
        return false;
#endif
    }

    private static void CreateTarget(Request request, Pipes pipes, out Native.PROCESS_INFORMATION info, out bool assignedAtCreation)
    {
        bool noHandleList = NoHandleList(request);
        bool jobList = request.Mode == "JOBLIST";
        int attributeCount = (noHandleList ? 0 : 1) + (jobList ? 1 : 0);

        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleArray = IntPtr.Zero;
        IntPtr jobArray = IntPtr.Zero;
        Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
        startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES | Native.STARTF_USESHOWWINDOW;
        startup.StartupInfo.wShowWindow = Native.SW_HIDE;
        startup.StartupInfo.hStdInput = pipes.StdinRead;
        startup.StartupInfo.hStdOutput = pipes.StdoutWrite;
        startup.StartupInfo.hStdError = pipes.StderrWrite;

        try
        {
            if (attributeCount > 0)
            {
                IntPtr size = IntPtr.Zero;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
                attributeList = Marshal.AllocHGlobal(size);
                if (!Native.InitializeProcThreadAttributeList(attributeList, attributeCount, 0, ref size))
                    throw new BoundaryFailure("OWNED_CONTAINMENT_ATTRIBUTE_LIST");

                if (!noHandleList)
                {
                    // Exactly the three stdio handles reach the child. Nothing
                    // else this process holds — the job handle above all — is
                    // inheritable by it.
                    IntPtr[] handles = new IntPtr[] { pipes.StdinRead, pipes.StdoutWrite, pipes.StderrWrite };
                    handleArray = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
                    Marshal.Copy(handles, 0, handleArray, handles.Length);
                    if (!Native.UpdateProcThreadAttribute(attributeList, 0, Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                            handleArray, (IntPtr)(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero))
                        throw new BoundaryFailure("OWNED_CONTAINMENT_HANDLE_LIST");
                }

                if (jobList)
                {
                    IntPtr[] jobs = new IntPtr[] { _job };
                    jobArray = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.Copy(jobs, 0, jobArray, 1);
                    if (!Native.UpdateProcThreadAttribute(attributeList, 0, Native.PROC_THREAD_ATTRIBUTE_JOB_LIST,
                            jobArray, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                        throw new BoundaryFailure("OWNED_CONTAINMENT_JOB_LIST");
                }
                startup.lpAttributeList = attributeList;
            }

            string commandLine = CommandLine.Build(request.File, request.Args, request.Verbatim);

            uint flags = Native.CREATE_UNICODE_ENVIRONMENT | Native.EXTENDED_STARTUPINFO_PRESENT;
            // Not in JOBLIST mode: there the process is a job member from its
            // first instruction, so there is nothing to hold it back for.
            if (!jobList) flags |= Native.CREATE_SUSPENDED;

            IntPtr environment = IntPtr.Zero;
            GCHandle envPin = default(GCHandle);
            try
            {
                if (request.Env.Count > 0)
                {
                    byte[] block = EnvironmentBlock.Build(request.Env);
                    envPin = GCHandle.Alloc(block, GCHandleType.Pinned);
                    environment = envPin.AddrOfPinnedObject();
                }

                FailPoint(request, "BEFORE_CREATE", "OWNED_CONTAINMENT_CREATE");

                bool created = Native.CreateProcessW(
                    request.File,
                    new StringBuilder(commandLine),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    flags,
                    environment,
                    request.Cwd,
                    ref startup,
                    out info);

                if (!created) throw new BoundaryFailure("OWNED_CONTAINMENT_CREATE", Marshal.GetLastWin32Error());
            }
            finally
            {
                if (envPin.IsAllocated) envPin.Free();
            }

            if (jobList)
            {
                assignedAtCreation = true;
            }
            else
            {
                if (!Native.AssignProcessToJobObject(_job, info.hProcess))
                {
                    int error = Marshal.GetLastWin32Error();
                    // The child is suspended and has executed nothing, so
                    // killing it here cannot leave a descendant behind — but it
                    // is not a job member either, so the job cannot do it.
                    TerminateUnowned(info);
                    throw new BoundaryFailure("OWNED_CONTAINMENT_ASSIGN", error);
                }
                assignedAtCreation = false;
            }
        }
        finally
        {
            if (attributeList != IntPtr.Zero)
            {
                Native.DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (handleArray != IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
            if (jobArray != IntPtr.Zero) Marshal.FreeHGlobal(jobArray);
        }
    }

    /// <summary>
    /// Kills a process that was created but could not be brought inside the
    /// job. It is suspended and has run nothing, so it has no descendants —
    /// the one case in this component where a process is ended without the job
    /// doing it, and the only alternative would be leaking it forever.
    /// </summary>
    private static void TerminateUnowned(Native.PROCESS_INFORMATION info)
    {
        // Against the handle, never against the pid: the handle names this
        // process and cannot come to mean a different one.
        Native.TerminateProcess(info.hProcess, 0xDEAD);
    }

    /// <summary>
    /// The coupling to AO. A boundary that outlives the process it serves is
    /// exactly the failure the owner-death case measures, so this is
    /// mechanical: a wait on the owner's handle, and a job termination when it
    /// signals.
    ///
    /// It is armed before the target exists, and it takes `_ownershipGate`
    /// before terminating — and holds it across the exit. Without that gate, an
    /// owner dying inside the window between `CreateProcess` and
    /// `AssignProcessToJobObject` would leave a suspended, unowned process
    /// behind that nothing would ever resume or reap. Releasing the gate before
    /// exiting reopens exactly that window, which is why `Environment.Exit` is
    /// inside it.
    ///
    /// **This watch is not the only thing that couples the two lifetimes, and
    /// usually not the fastest.** Node puts every child it spawns into a
    /// kill-on-close job of its own (libuv does this on Windows), so when the
    /// AO process that spawned this helper dies, this process is killed by that
    /// job immediately — before this watcher can run, which is why an
    /// AO-death status usually stops at `boundary=OK` rather than recording
    /// `terminatedByOwnerLoss`. The tree still dies, twice over: this process's
    /// death closes the only handle to its own strict job. What the watch
    /// covers is the case where the owner is *not* the parent, where nothing
    /// else would notice at all.
    /// </summary>
    private static void WatchOwner(int ownerPid)
    {
        IntPtr owner = Native.OpenProcess(Native.SYNCHRONIZE | Native.PROCESS_QUERY_LIMITED_INFORMATION, false, ownerPid);
        if (owner == IntPtr.Zero)
        {
            // The owner is already gone, or unreachable. Either way this
            // boundary has no owner to serve, and nothing has been created.
            Put("ownerWatch", "OPEN_FAILED");
            throw new BoundaryFailure(BoundaryFailure.OwnerGone);
        }
        Put("ownerWatch", "ARMED");
        Thread watcher = new Thread(delegate ()
        {
            Native.WaitForSingleObject(owner, Native.INFINITE);
            lock (_ownershipGate)
            {
                Interlocked.Exchange(ref _terminatedByOwnerLoss, 1);
                Put("terminatedByOwnerLoss", "true");
                Native.TerminateJobObject(_job, 0xDEAD);
                WriteStatus();

                // The exit belongs INSIDE the gate. Released first, it lets the
                // main thread enter `CreateTarget` in the moment between the
                // release and the exit, and the exit then lands between
                // `CreateProcess` and `AssignProcessToJobObject` — leaving a
                // suspended process in no job, with no helper left to resume or
                // reap it. That is the orphan this gate exists to prevent, and
                // it was reachable while the exit sat outside.
                //
                // The boundary leaves with the tree it owned. Nothing of it
                // survives its owner, and no cleanup code had to run to make
                // that true: closing this process's handles closes the job.
                Environment.Exit(ExitCode.OwnerLost);
            }
        });
        watcher.IsBackground = true;
        watcher.Start();
    }

    private static Thread Pump(IntPtr from, IntPtr to)
    {
        Thread thread = new Thread(delegate ()
        {
            byte[] buffer = new byte[65536];
            while (true)
            {
                uint read;
                if (!Native.ReadFile(from, buffer, (uint)buffer.Length, out read, IntPtr.Zero) || read == 0) break;
                if (!WriteAll(to, buffer, read)) return;
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static void PumpStdin(IntPtr toChild)
    {
        Thread thread = new Thread(delegate ()
        {
            IntPtr from = StandardHandles.In;
            byte[] buffer = new byte[65536];
            while (true)
            {
                uint read;
                // A failed read and an end of file are different facts, and
                // collapsing them made this thread report EOF_FORWARDED for a
                // payload it had stopped reading halfway. "The whole stream was
                // forwarded" is not something this thread knows after a read
                // error, and it may not say it.
                //
                // The distinction costs a last-error check, and skipping that
                // check is not an option: on Windows the end of an anonymous
                // pipe is *itself* reported as a failed ReadFile with
                // ERROR_BROKEN_PIPE, so treating every failure as an error
                // turns every ordinary end of file into one. That was measured
                // the direct way — the first attempt at this did exactly that,
                // and every DELIVERED case in
                // `tests/dist-artifact/owned-command-dist-artifact.mjs` went
                // UNCONFIRMED at once. Those cases are what keeps the EOF half
                // of this honest; the error half is not reachable from any test
                // here, and is stated rather than claimed as a measured repair.
                if (!Native.ReadFile(from, buffer, (uint)buffer.Length, out read, IntPtr.Zero))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == Native.ERROR_BROKEN_PIPE || error == Native.ERROR_HANDLE_EOF) break;
                    Put("stdinForward", "SOURCE_READ_FAILED");
                    // Closed before the status is published, for the reason the
                    // end-of-file branch below gives: a child blocked on
                    // ReadFile must not be made to wait out a file write.
                    Native.CloseHandle(toChild);
                    WriteStatus();
                    return;
                }
                if (read == 0) break;
                if (!WriteAll(toChild, buffer, read))
                {
                    // The child closed its read end. That is data for the
                    // caller — a delivery state, not a boundary failure.
                    //
                    // Published here, and no test kills the publish: the same
                    // key still reaches the file through the main thread's
                    // final WriteStatus, because the list is append-only and
                    // the later writer writes a superset. What publishing here
                    // buys is that the key is readable before the child exits,
                    // which is what a caller polling a live run would need. The
                    // same disclosure applies to the EOF branch below.
                    Put("stdinForward", "BROKEN_PIPE");
                    WriteStatus();
                    Native.CloseHandle(toChild);
                    return;
                }
            }
            Put("stdinForward", "EOF_FORWARDED");
            // EOF must reach the child, or a reader waits forever. Closed
            // before the status is published, so the child never waits on a
            // file write.
            Native.CloseHandle(toChild);
            // Published here, as the BROKEN_PIPE branch above also publishes.
            // The two order the release and the publish oppositely, and only
            // this order matters: there the child has already closed its read
            // end, so nothing is waiting on the handle either way, while here a
            // reader is still blocked on it and must not be made to wait out a
            // file write.
            //
            // This is hardening, and it is labelled as such rather than sold as
            // a repair. Without it the key still reached the file, but only
            // because of an ordering nothing states: this runs on a background
            // thread, and the main thread's final WriteStatus happens after the
            // child exits — which is later, for any child that takes longer to
            // start than a pipe write takes to finish. The V3 slice 2 adapter's
            // DELIVERED rests on this key, and an ordering a caller's guarantee
            // rests on should be in the code rather than in the timing.
            //
            // Measured before changing it: with this call removed, a child that
            // never reads stdin and exits immediately still reported DELIVERED
            // 12 times out of 12 on the installed runtime. So the ordering was
            // real, not lucky — and nothing in this repository can currently
            // make it fail. That is the reason this is not claimed as a fixed
            // defect, and the reason no test here kills the mutant.
            //
            // Two WriteStatus calls cannot lose each other's work: each takes
            // its snapshot of the append-only list *inside* the lock it also
            // writes and renames the file under, so the two serialise and
            // whichever renames last renamed a superset.
            WriteStatus();
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static bool WriteAll(IntPtr to, byte[] buffer, uint length)
    {
        uint offset = 0;
        while (offset < length)
        {
            byte[] slice = buffer;
            if (offset > 0)
            {
                slice = new byte[length - offset];
                Array.Copy(buffer, offset, slice, 0, slice.Length);
            }
            uint written;
            if (!Native.WriteFile(to, slice, length - offset, out written, IntPtr.Zero)) return false;
            if (written == 0) return false;
            offset += written;
        }
        return true;
    }

    private static int JobMemberCount()
    {
        List<int> pids;
        return JobMembers(out pids);
    }

    /// <summary>
    /// The job's own membership, as a count and as the pids behind it.
    ///
    /// The pids are not decoration. A count that disagrees with what the caller
    /// can see running is unattributable — "five members, six processes" says
    /// nothing about *which* one, and therefore nothing about whether a process
    /// escaped the job or simply ended. The list makes that difference readable
    /// from the outside.
    /// </summary>
    private static int JobMembers(out List<int> pids)
    {
        pids = new List<int>();
        const int capacity = 1024;
        // JOBOBJECT_BASIC_PROCESS_ID_LIST is two DWORDs followed by the
        // ULONG_PTR array, and the array starts at offset 8 on x86 and x64
        // alike — 4 + 4 with no padding needed on either. A larger figure here
        // is harmless while only the count at offset 4 is read, and silently
        // wrong the moment the list itself is.
        const int headerSize = 8;
        int size = headerSize + IntPtr.Size * capacity;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteInt32(buffer, 0, capacity);
            if (!Native.QueryInformationJobObject(_job, Native.JobObjectBasicProcessIdList, buffer, (uint)size, IntPtr.Zero))
                return -1;
            int returned = Marshal.ReadInt32(buffer, 4);
            for (int i = 0; i < returned && i < capacity; i++)
            {
                pids.Add((int)(long)Marshal.ReadIntPtr(buffer, headerSize + IntPtr.Size * i));
            }
            return returned;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    [System.Diagnostics.Conditional("AO_BOUNDARY_TEST_CONTROLS")]
    private static void FailPoint(Request request, string point, string code)
    {
#if AO_BOUNDARY_TEST_CONTROLS
        if (request.FailAt == point) throw new BoundaryFailure(code);
#endif
    }

    private static void Put(string key, string value)
    {
        lock (_status)
        {
            _status.Add(key + "=" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? "")));
        }
    }

    /// <summary>
    /// How many times a publish may lose the rename race before it gives up,
    /// and how long it waits between attempts.
    ///
    /// The race is a reader's, not a writer's, and it is the caller's own: the
    /// caller polls this file to learn that ownership holds, and a file it has
    /// open for reading cannot be replaced — Windows answers the rename with a
    /// sharing violation, because a plain read handle carries no
    /// FILE_SHARE_DELETE. A single attempt therefore turned "the caller looked
    /// at the same moment" into "the child's exit code was never published",
    /// and the caller reads a status frozen at establishment as a lost
    /// boundary. Measured before this existed: 3 of 320 fast commands under
    /// eight-way concurrency, every one of them a run that had completed
    /// normally with exit code 0.
    ///
    /// The bound matters as much as the retry. A publish that cannot land is
    /// still not worth dying for, and the last status write happens just before
    /// this process exits — so an unbounded wait would hold a caller open on a
    /// contended directory rather than letting it read the truthful "no exit
    /// code was published" it had before.
    ///
    /// Two seconds, and the size is deliberate rather than a round number. The
    /// reader this loses to is a *scheduled* one — AO's own poll, or a scanner —
    /// so the window it holds the file for is decided by a loaded machine's
    /// scheduler, not by how long a read takes. A budget of a few hundred
    /// milliseconds is inside the jitter of a busy CI runner, and was: the
    /// counter-proof for this retry failed once in a parallel gate with the
    /// budget at 200ms, on the timer that was supposed to release the file.
    /// The cost of the larger bound is paid only under contention, and only by
    /// a helper that is about to exit anyway.
    /// </summary>
    private const int StatusPublishAttempts = 100;
    private const int StatusPublishRetryMs = 20;

    /// <summary>
    /// Publishes the status by atomic rename. A caller polls this file to learn
    /// that ownership holds; a torn read of a half-written one could be read as
    /// a boundary that never reported anything.
    /// </summary>
    private static void WriteStatus()
    {
        if (string.IsNullOrEmpty(_statusPath)) return;
        lock (_statusLock)
        {
            try
            {
                string[] lines;
                lock (_status) { lines = _status.ToArray(); }
                string staging = _statusPath + ".writing";
                File.WriteAllLines(staging, lines, new UTF8Encoding(false));
                for (int attempt = 1; ; attempt++)
                {
                    if (Native.MoveFileExW(staging, _statusPath, Native.MOVEFILE_REPLACE_EXISTING)) return;
                    if (attempt >= StatusPublishAttempts)
                    {
                        File.Delete(staging);
                        return;
                    }
                    Thread.Sleep(StatusPublishRetryMs);
                }
            }
            catch
            {
                /* a status this process cannot write is not worth dying for */
            }
        }
    }

    /// <summary>
    /// Reads the request, strictly.
    ///
    /// An unknown key, a missing required key, a repeated scalar key or a value
    /// that is not base64 is a refusal. That strictness is the reason the
    /// weakening switches cannot be smuggled into a production binary: they are
    /// not "ignored options" here, they are unreadable requests.
    /// </summary>
    private static Request ReadRequest(string path)
    {
        Request request = new Request();
        string[] lines;
        try
        {
            lines = File.ReadAllLines(path, Encoding.UTF8);
        }
        catch
        {
            throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
        }

        // First pass: structure only, plus the one key a refusal needs in
        // order to be able to report itself. Without this, a request refused
        // for an unknown key would have nowhere to say so, and the caller
        // would see an exit code with no reason attached to it.
        List<string[]> pairs = new List<string[]>();
        foreach (string line in lines)
        {
            if (line.Length == 0) continue;
            int at = line.IndexOf('=');
            if (at <= 0) throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
            string name = line.Substring(0, at);
            string decoded;
            try
            {
                decoded = Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(at + 1)));
            }
            catch
            {
                throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
            }
            // `statusPath` and `nonce` are taken in this first pass, before any
            // key is validated, because a refusal needs both: somewhere to
            // report itself, and the launch's own name so the caller can tell
            // that the report is *this* launch's. Recorded only after
            // validation, every OWNED_CONTAINMENT_REQUEST_INVALID would arrive
            // at a caller as a status of unknown provenance, and the real
            // failure code would be discarded with it.
            if (name == "statusPath" && _statusPath.Length == 0) _statusPath = decoded;
            if (name == "nonce" && decoded.Length > 0 && !_noncePut)
            {
                _noncePut = true;
                Put("nonce", decoded);
            }
            pairs.Add(new string[] { name, decoded });
        }

        HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string[] pair in pairs)
        {
            string key = pair[0];
            string value = pair[1];

            bool repeatable = key == "arg" || key == "env";
            if (!repeatable && !seen.Add(key))
                throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);

            switch (key)
            {
                case "mode":
                    if (value != "SUSPENDED" && value != "JOBLIST")
                        throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
                    request.Mode = value;
                    break;
                case "file": request.File = value; break;
                case "arg": request.Args.Add(value); break;
                case "verbatim":
                    if (value != "true" && value != "false")
                        throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
                    request.Verbatim = value == "true";
                    break;
                case "cwd": request.Cwd = value; break;
                case "env":
                    if (value.IndexOf('=') <= 0)
                        throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
                    request.Env.Add(value);
                    break;
                case "ownerPid":
                    if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out request.OwnerPid))
                        throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
                    break;
                case "statusPath": request.StatusPath = value; break;
                case "nonce":
                    if (value.Length == 0)
                        throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
                    request.Nonce = value;
                    break;
#if AO_BOUNDARY_TEST_CONTROLS
                case "failAt": request.FailAt = value; break;
                case "inheritJobHandle": request.InheritJobHandle = value == "true"; break;
                case "noHandleList": request.NoHandleList = value == "true"; break;
#endif
                default:
                    // Including — deliberately — every key that would weaken
                    // containment in a build that does not implement it.
                    throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
            }
        }

        if (request.Mode == null
            || string.IsNullOrEmpty(request.File)
            || string.IsNullOrEmpty(request.StatusPath)
            || string.IsNullOrEmpty(request.Nonce)
            || request.OwnerPid <= 0)
        {
            throw new BoundaryFailure("OWNED_CONTAINMENT_REQUEST_INVALID", 0);
        }
        return request;
    }

    private static readonly int CurrentProcessId = System.Diagnostics.Process.GetCurrentProcess().Id;
}

internal static class StandardHandles
{
    public static readonly IntPtr In = Native.GetStdHandle(-10);
    public static readonly IntPtr Out = Native.GetStdHandle(-11);
    public static readonly IntPtr Error = Native.GetStdHandle(-12);
}

internal sealed class BoundaryFailure : Exception
{
    public const string OwnerGone = "OWNED_CONTAINMENT_OWNER_GONE";

    public readonly string Code;
    public readonly int Win32;

    public BoundaryFailure(string code) : this(code, Marshal.GetLastWin32Error()) { }

    public BoundaryFailure(string code, int win32) : base(code)
    {
        Code = code;
        Win32 = win32;
    }
}

internal sealed class Pipes
{
    public IntPtr StdinRead, StdinWrite, StdoutRead, StdoutWrite, StderrRead, StderrWrite;

    public static Pipes Create(bool inheritAll)
    {
        Native.SECURITY_ATTRIBUTES sa = new Native.SECURITY_ATTRIBUTES();
        sa.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
        sa.bInheritHandle = true;
        sa.lpSecurityDescriptor = IntPtr.Zero;

        Pipes pipes = new Pipes();
        if (!Native.CreatePipe(out pipes.StdinRead, out pipes.StdinWrite, ref sa, 0)) throw new BoundaryFailure("OWNED_CONTAINMENT_PIPES");
        if (!Native.CreatePipe(out pipes.StdoutRead, out pipes.StdoutWrite, ref sa, 0)) throw new BoundaryFailure("OWNED_CONTAINMENT_PIPES");
        if (!Native.CreatePipe(out pipes.StderrRead, out pipes.StderrWrite, ref sa, 0)) throw new BoundaryFailure("OWNED_CONTAINMENT_PIPES");

        if (!inheritAll)
        {
            // Only the child's ends stay inheritable.
            Native.SetHandleInformation(pipes.StdinWrite, Native.HANDLE_FLAG_INHERIT, 0);
            Native.SetHandleInformation(pipes.StdoutRead, Native.HANDLE_FLAG_INHERIT, 0);
            Native.SetHandleInformation(pipes.StderrRead, Native.HANDLE_FLAG_INHERIT, 0);
        }
        return pipes;
    }

    public void CloseChildEnds()
    {
        Native.CloseHandle(StdinRead);
        Native.CloseHandle(StdoutWrite);
        Native.CloseHandle(StderrWrite);
    }
}

internal static class EnvironmentBlock
{
    public static byte[] Build(List<string> entries)
    {
        StringBuilder builder = new StringBuilder();
        foreach (string entry in entries)
        {
            builder.Append(entry);
            builder.Append('\0');
        }
        builder.Append('\0');
        return Encoding.Unicode.GetBytes(builder.ToString());
    }
}

/// <summary>
/// Command-line construction, mirroring what Node does today: verbatim for the
/// trusted `cmd.exe /d /s /c "…"` route, and MSVCRT-style quoting otherwise.
/// Ten differential cases against `child_process.spawn` — `.exe` and `.cmd`,
/// spaces, quotes, backslashes, Unicode, empty and shell-metacharacter
/// arguments — produced an identical argument vector in all ten.
/// </summary>
internal static class CommandLine
{
    public static string Build(string file, List<string> args, bool verbatim)
    {
        StringBuilder line = new StringBuilder();
        if (verbatim)
        {
            // Node's windowsVerbatimArguments: argv[0] quoted, the rest untouched.
            line.Append('"').Append(file).Append('"');
            foreach (string arg in args)
            {
                line.Append(' ').Append(arg);
            }
            return line.ToString();
        }

        line.Append(Quote(file));
        foreach (string arg in args)
        {
            line.Append(' ').Append(Quote(arg));
        }
        return line.ToString();
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;

        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                backslashes = 0;
                quoted.Append('"');
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(c);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }
}
