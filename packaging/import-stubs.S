/* Link-only stubs used to make import libraries with GNU ld when dlltool is unavailable. */
    .section .text
    .global GetModuleFileNameW
    .global GetCommandLineW
    .global SetEnvironmentVariableW
    .global SetCurrentDirectoryW
    .global CreateProcessW
    .global WaitForSingleObject
    .global GetExitCodeProcess
    .global CloseHandle
    .global ExitProcess
    .global MessageBoxW
GetModuleFileNameW:
GetCommandLineW:
SetEnvironmentVariableW:
SetCurrentDirectoryW:
CreateProcessW:
WaitForSingleObject:
GetExitCodeProcess:
CloseHandle:
ExitProcess:
MessageBoxW:
    ret
