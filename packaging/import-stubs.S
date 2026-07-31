/* Link-only stubs used to make import libraries with GNU ld when dlltool is unavailable. */
    .section .text
    .global GetModuleFileNameW
    .global SetCurrentDirectoryW
    .global CreateProcessW
    .global WaitForSingleObject
    .global GetExitCodeProcess
    .global CloseHandle
    .global ExitProcess
    .global MessageBoxW
GetModuleFileNameW:
SetCurrentDirectoryW:
CreateProcessW:
WaitForSingleObject:
GetExitCodeProcess:
CloseHandle:
ExitProcess:
MessageBoxW:
    ret
